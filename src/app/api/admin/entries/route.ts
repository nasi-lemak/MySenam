import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { jsonObject, refusal } from "@/lib/api";
import { getDb } from "@/lib/db";
import { admitEntry, checkOutEntry, entryCount, entryOptions, entryResource, entryResources, openEntries, type AdmitInput } from "@/lib/entries";
import { participantsForVenue } from "@/lib/participants";
import { phoneKey } from "@/lib/phone";

export const dynamic = "force-dynamic";

/**
 * Entry with no set time at the desk (lib/entries.ts;
 * docs/features/venue-operations.md#entry-with-no-set-time).
 *
 * `?venueId`: the venue's resources taking entries, each with how full it is
 * now (people in on entries, places bookings hold now, against its places),
 * and everybody in now. `?venueId&courtId&phone`: what could let the person
 * on that number in there (a membership that admits, passes and day passes,
 * a walk-in at the resource's price), for themself and for each participant
 * the venue knows with a guardian on it, and a name the venue already holds
 * for the number. Nothing is let in by a read.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  const courtParam = req.nextUrl.searchParams.get("courtId");
  const phone = (req.nextUrl.searchParams.get("phone") ?? "").trim();
  if (courtParam !== null) {
    const resource = await entryResource(Number(courtParam));
    if (!resource || resource.venueId !== venueId) return NextResponse.json({ error: "That resource takes no entries here." }, { status: 404 });
    if (phoneKey(phone).length < 6) return NextResponse.json({ error: "A phone number is required." }, { status: 400 });
    // A name the venue already holds for the number: its newest membership, pass or entry.
    const known = (await getDb()
      .prepare(
        `SELECT name FROM (
           SELECT holder_name AS name, created_at::text AS at FROM memberships WHERE venue_id = ? AND holder_kind = 'customer' AND phone_key(holder_phone) = phone_key(?)
           UNION ALL SELECT holder_name, created_at::text FROM passes WHERE venue_id = ? AND phone_key(holder_phone) = phone_key(?)
           UNION ALL SELECT name, admitted_at::text FROM entries WHERE venue_id = ? AND takes_part_as = 'customer' AND phone_key(phone) = phone_key(?)
         ) k ORDER BY at DESC LIMIT 1`
      )
      .get(venueId, phone, venueId, phone, venueId, phone)) as { name: string } | undefined;
    const customer = await entryOptions(resource, { participantId: null, name: known?.name ?? "", phone }, "desk");
    const participants = [];
    for (const p of await participantsForVenue(venueId, phone))
      participants.push({ id: p.id, name: p.displayName, options: await entryOptions(resource, { participantId: p.id, name: p.displayName, phone }, "desk") });
    return NextResponse.json({ resource, knownName: known?.name ?? null, customer, participants });
  }

  const resources = await entryResources(venueId);
  const counts = await Promise.all(resources.map((r) => entryCount(r)));
  return NextResponse.json({
    resources: resources.map((r, i) => ({ ...r, count: counts[i] })),
    inNow: resources.length > 0 ? await openEntries(venueId) : [],
  });
}

/**
 * `{ venueId, courtId, phone, name, participantId?, by: "membership" | "pass" | "walk_in", passId?, via?, agreeWaiver? }`:
 * let somebody in (a participant as themself, under their guardian's number); a walk-in is sold at the
 * resource's price and receipted as a counter sale, `via` saying how it was paid. `agreeWaiver`: the person
 * (or the guardian) agreed to the waiver on paper just now. Logged as `entry.admitted`.
 * `{ venueId, entryId, out: true }`: they left. Logged as `entry.checked_out`.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let body: Record<string, unknown>;
  try {
    body = await jsonObject(req);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const venueId = body.venueId;
  if (!Number.isInteger(venueId) || (venueId as number) <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId as number);
  if (denied) return denied;

  if (body.out === true) {
    if (!Number.isInteger(body.entryId)) return NextResponse.json({ error: "entryId is required." }, { status: 400 });
    const out = await checkOutEntry(venueId as number, body.entryId as number);
    if (!out.ok) return refusal(out);
    await logAction(admin, { venueId: venueId as number, action: "entry.checked_out", detail: `${out.name} (entry ${body.entryId})` });
    return NextResponse.json({ ok: true });
  }

  if (!Number.isInteger(body.courtId)) return NextResponse.json({ error: "courtId is required." }, { status: 400 });
  const resource = await entryResource(body.courtId as number);
  if (!resource || resource.venueId !== venueId) return NextResponse.json({ error: "That resource takes no entries here." }, { status: 404 });
  if (typeof body.phone !== "string" || typeof body.name !== "string") return NextResponse.json({ error: "phone and name are required." }, { status: 400 });
  const participantId = body.participantId === undefined || body.participantId === null ? null : body.participantId;
  if (participantId !== null && !Number.isInteger(participantId)) return NextResponse.json({ error: "participantId is a participant's id." }, { status: 400 });
  let by: AdmitInput["by"];
  if (body.by === "membership") by = { kind: "membership" };
  else if (body.by === "pass" && Number.isInteger(body.passId)) by = { kind: "pass", passId: body.passId as number };
  else if (body.by === "walk_in") by = { kind: "walk_in", via: body.via };
  else return NextResponse.json({ error: "by is membership, pass (with passId) or walk_in." }, { status: 400 });

  const admitted = await admitEntry({
    courtId: resource.courtId,
    person: { participantId: participantId as number | null, name: body.name, phone: body.phone },
    by,
    channel: "desk",
    agreeWaiver: body.agreeWaiver === true,
    staff: { id: admin.id, name: admin.name },
  });
  if (!admitted.ok) return refusal(admitted);
  const how =
    admitted.admittedBy === "membership"
      ? `membership ${admitted.membershipCode}`
      : admitted.admittedBy === "walk_in"
        ? `walk-in${admitted.receipt ? `, receipt ${admitted.receipt.number}` : ", free"}`
        : `${admitted.admittedBy === "day_pass" ? "day pass" : "pass"} ${admitted.pass?.code} (${admitted.pass?.remaining} left)`;
  await logAction(admin, {
    venueId: venueId as number,
    action: "entry.admitted",
    detail: `${admitted.name} into ${resource.name} on ${how}${body.agreeWaiver === true ? "; waiver agreed on paper" : ""}`,
  });
  return NextResponse.json({ admission: admitted }, { status: 201 });
}
