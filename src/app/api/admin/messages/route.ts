import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin, requireOwner } from "@/lib/admin-auth";
import { RESEND_ALL_LIMIT, listMessages, listPlatformMessages, messageById, outboxSummary, retryFailedMessages, retryMessage } from "@/lib/outbox";
import { tickOutbox } from "@/lib/notify";
import { logAction } from "@/lib/activity";

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

/** The longest window "send again everything that failed" takes, in hours: the longest a message is kept trying (60 days). */
const RESEND_WINDOW_MAX_HOURS = 60 * 24;

/**
 * Put one message back in the queue, optionally at a corrected address; or, with `{ resendFailed: true, venueId, hours }`, every
 * message of the venue that did not go and was written in the last `hours` (the one click after a provider outage). The bulk
 * resend is the venue's own staff's (a manager or front desk of that venue) and is recorded in the activity log.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const body = await req.json().catch(() => ({}));
  const { id, recipient, resendFailed, venueId, hours } = (body ?? {}) as Record<string, unknown>;

  if (resendFailed === true) {
    if (!Number.isInteger(venueId) || (venueId as number) <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
    if (!Number.isInteger(hours) || (hours as number) <= 0)
      return NextResponse.json({ error: "Choose a start and an end for the messages to send again." }, { status: 400 });
    if ((hours as number) > RESEND_WINDOW_MAX_HOURS) return NextResponse.json({ error: "Choose a window of 60 days or less." }, { status: 400 });
    const denied = denyVenue(admin, venueId as number);
    if (denied) return denied;
    const stamp = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
    const now = Date.now();
    const done = await retryFailedMessages(venueId as number, { since: stamp(now - (hours as number) * 3_600_000), until: stamp(now) });
    await logAction(admin, {
      venueId: venueId as number,
      action: "message.resent",
      detail: `all that failed in the last ${hours} hours: ${done.requeued} put back in the queue, ${done.skipped.stale + done.skipped.refused} left out${done.more ? ` (more than ${RESEND_ALL_LIMIT}: some not yet looked at)` : ""}`,
    });
    await tickOutbox();
    return NextResponse.json({ requeued: done.requeued, left: done.skipped.stale + done.skipped.refused, more: done.more });
  }

  if (!Number.isInteger(id))
    return NextResponse.json({ error: "id is required." }, { status: 400 });
  if (recipient !== undefined && typeof recipient !== "string")
    return NextResponse.json({ error: "recipient must be text." }, { status: 400 });

  // A message belongs to a venue, and an operator may only touch their own.
  const existing = await messageById(id as number);
  // A safeguarding notice is not in these screens (lib/outbox.ts): nothing here may say that one exists.
  if (!existing || existing.kind === "safeguarding_notice") return NextResponse.json({ error: "Message not found." }, { status: 404 });
  const denied = existing.venueId === null ? requireOwner(admin) : denyVenue(admin, existing.venueId);
  if (denied) return denied;

  const retried = await retryMessage(id as number, recipient as string | undefined);
  if (!retried) return NextResponse.json({ error: "Message not found." }, { status: 404 });
  if (!retried.ok) return NextResponse.json({ error: retried.error }, { status: 409 });
  // Who sent it again, and where, when staff gave a corrected address or number.
  const redirected = typeof recipient === "string" && recipient.trim() !== "" && recipient.trim() !== existing.recipient;
  await logAction(admin, {
    venueId: existing.venueId,
    action: "message.resent",
    detail: `${existing.kind.replace(/_/g, " ")} (${existing.channel}) message ${existing.id}${redirected ? ` to ${retried.message.recipient}, not ${existing.recipient}` : ""}`,
  });
  await tickOutbox();
  return NextResponse.json({ message: retried.message });
}
