import { NextRequest, NextResponse } from "next/server";
import { apiCaller } from "@/lib/api-keys";
import { listVenueWaitlist } from "@/lib/store";
import { isValidDateString } from "@/lib/time";
import type { WaitlistEntry } from "@/lib/types";
import { joinAtVenue, removeAtVenue } from "@/lib/waitlist-venue";
import { asksStaffPowers } from "@/lib/policy-overrides";
import { errorText, translator } from "@/lib/i18n";

export const dynamic = "force-dynamic";

/**
 * The venue's waiting lists through its own API key
 * (docs/integrations/external-api.md, waiting lists; lib/waitlist-venue.ts):
 * read keys see the key's venue's queues on a day; write keys queue somebody
 * and take off an entry the venue made, as its counter does.
 */

/** An entry as the API gives it: never an offer's token, which is only ever the customer's. */
function apiEntry(e: WaitlistEntry): Record<string, unknown> {
  return {
    id: e.id,
    classId: e.classId,
    courtId: e.courtId,
    date: e.date,
    start: e.startMin,
    end: e.endMin,
    label: e.label ?? null,
    name: e.name,
    phone: e.phone,
    status: e.status,
    places: e.places ?? 1,
    customerTakesPart: e.customerTakesPart !== false,
    participants: e.participantNames ?? [],
    madeBy: e.madeBy ?? "customer",
    // The language the offer goes in.
    locale: e.locale,
    createdAt: e.createdAt,
  };
}

/** `?date=YYYY-MM-DD` → the venue's queues that day. */
export async function GET(req: NextRequest) {
  const caller = await apiCaller(req);
  if (caller instanceof NextResponse) return caller;
  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!isValidDateString(date)) return NextResponse.json({ error: "date (YYYY-MM-DD) is required." }, { status: 400 });
  return NextResponse.json({ entries: (await listVenueWaitlist(caller.venueId, date)).map(apiEntry) });
}

/**
 * `{ classId }` or `{ courtId, date, start, end }`, with `name`, `phone`,
 * `email?`, `participantIds?`, `customerTakesPart?`, `confirmWho?`,
 * `locale?` (write keys) → the entry and its place in the queue.
 */
export async function POST(req: NextRequest) {
  const caller = await apiCaller(req, "write");
  if (caller instanceof NextResponse) return caller;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  // A key never overrides the venue's policies, nor takes payment: refused, never ignored (lib/policy-overrides.ts).
  if (asksStaffPowers(body) || body.override !== undefined)
    return NextResponse.json({ error: errorText(translator("en"), "R9_API_NO_OVERRIDE"), code: "R9_API_NO_OVERRIDE" }, { status: 400 });
  const made = await joinAtVenue(caller.venueId, { channel: "api", apiKeyId: caller.keyId, name: `API key ${caller.keyId}` }, body);
  if (!made.ok) return NextResponse.json({ error: made.error, code: made.code, vars: made.vars }, { status: made.status });
  return NextResponse.json({ entry: apiEntry(made.entry), position: made.position }, { status: 201 });
}

/** `{ entryId }` (write keys) → an entry the venue made, at its counter or through its API, taken off. */
export async function DELETE(req: NextRequest) {
  const caller = await apiCaller(req, "write");
  if (caller instanceof NextResponse) return caller;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const done = await removeAtVenue(caller.venueId, { channel: "api", apiKeyId: caller.keyId, name: `API key ${caller.keyId}` }, body.entryId);
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: done.status });
  return NextResponse.json({ ok: true, entry: apiEntry(done.entry) });
}
