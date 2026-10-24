import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin, requireOwner } from "@/lib/admin-auth";
import { listMessages, listPlatformMessages, messageById, outboxSummary, retryMessage } from "@/lib/outbox";
import { tickOutbox } from "@/lib/notify";

export const dynamic = "force-dynamic";

/** What this venue has told its customers, and what is still waiting; or, for owners, what the platform itself sent (`?platform=1`). */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  // The platform's own: to applicants, password resets, alerts to staff. Owners only.
  if (req.nextUrl.searchParams.get("platform") === "1") {
    const refused = requireOwner(admin);
    if (refused) return refused;
    await tickOutbox();
    return NextResponse.json({ messages: await listPlatformMessages(), summary: null }, { headers: { "Cache-Control": "no-store" } });
  }

  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  // Opening the page is as good a moment as any to catch up.
  await tickOutbox();

  return NextResponse.json(
    { messages: await listMessages(venueId), summary: await outboxSummary(venueId) },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/** Put one message back in the queue, optionally at a corrected address. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const body = await req.json().catch(() => ({}));
  const { id, recipient } = (body ?? {}) as Record<string, unknown>;
  if (!Number.isInteger(id))
    return NextResponse.json({ error: "id is required." }, { status: 400 });
  if (recipient !== undefined && typeof recipient !== "string")
    return NextResponse.json({ error: "recipient must be text." }, { status: 400 });

  // A message belongs to a venue, and an operator may only touch their own.
  const existing = await messageById(id as number);
  if (!existing) return NextResponse.json({ error: "Message not found." }, { status: 404 });
  const denied = existing.venueId === null ? requireOwner(admin) : denyVenue(admin, existing.venueId);
  if (denied) return denied;

  const retried = await retryMessage(id as number, recipient as string | undefined);
  if (!retried) return NextResponse.json({ error: "Message not found." }, { status: 404 });
  if (!retried.ok) return NextResponse.json({ error: retried.error }, { status: 409 });
  await tickOutbox();
  return NextResponse.json({ message: retried.message });
}
