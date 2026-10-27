import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { mayShowVenue } from "@/lib/listing";
import { listVenueWaitlist } from "@/lib/store";
import { isValidDateString } from "@/lib/time";
import { joinAtVenue, removeAtVenue } from "@/lib/waitlist-venue";

export const dynamic = "force-dynamic";

/**
 * The waiting list at the counter (lib/waitlist-venue.ts;
 * docs/features/booking.md#at-the-counter-and-through-the-api): the desk or a
 * manager, at a venue they work at, sees the day's queues, puts a caller on
 * one on their word, and takes off an entry the venue made.
 */

async function staffAt(req: NextRequest, venueId: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  if (!Number.isInteger(venueId) || (venueId as number) <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId as number) ?? admin;
}

/** `?venueId=&date=` → the venue's queues that day, court time and classes, each with who made it. */
export async function GET(req: NextRequest) {
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  const admin = await staffAt(req, venueId);
  if (admin instanceof NextResponse) return admin;
  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!isValidDateString(date)) return NextResponse.json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });
  return NextResponse.json({ entries: await listVenueWaitlist(venueId, date) });
}

/**
 * `{ venueId, classId }` or `{ venueId, courtId, date, start, end }`, with
 * `name`, `phone`, `email?`, `participantIds?`, `customerTakesPart?`,
 * `confirmWho?`, `locale?` → the entry and its place in the queue.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const admin = await staffAt(req, body.venueId);
  if (admin instanceof NextResponse) return admin;
  const venueId = body.venueId as number;
  const made = await joinAtVenue(venueId, { channel: "staff", adminId: admin.id, name: admin.name }, body, {
    preview: (await mayShowVenue(venueId, admin)).preview,
  });
  if (!made.ok) return NextResponse.json({ error: made.error, code: made.code, vars: made.vars }, { status: made.status });
  return NextResponse.json({ entry: made.entry, position: made.position }, { status: 201 });
}

/** `{ venueId, entryId }` → an entry the venue made (at the counter or through its API) taken off. */
export async function DELETE(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const admin = await staffAt(req, body.venueId);
  if (admin instanceof NextResponse) return admin;
  const done = await removeAtVenue(body.venueId as number, { channel: "staff", adminId: admin.id, name: admin.name }, body.entryId);
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: done.status });
  return NextResponse.json({ ok: true, entry: done.entry });
}
