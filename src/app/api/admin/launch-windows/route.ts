import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { deleteRule, listRules, listTide, ruleById, saveRule, tideStations } from "@/lib/launch-windows";
import { keepStranded, monthPreview, strandedByLaunch } from "@/lib/launch-worklist";
import { readJsonObject } from "@/lib/api";
import { getCourt } from "@/lib/store";
import { isValidDateString } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * `?venueId=` — the venue's launch and tide window rules, the tide stations it keeps a table for, and the bookings and
 * classes to come that fall outside their day's window (`stranded`, and `kept` for those staff left as booked): lib/launch-windows.ts,
 * lib/launch-worklist.ts, ADR 0037.
 * `&preview=<rule id>&month=YYYY-MM` — a month of that rule's windows as bookings would meet them.
 * `&station=<name>&from=YYYY-MM-DD` — that station's tide entries from a date, on the venue's clock.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const q = req.nextUrl.searchParams;
  const venueId = Number(q.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const preview = q.get("preview");
  if (preview !== null) {
    const done = await monthPreview(venueId, Number(preview), q.get("month") ?? "");
    return done.ok ? NextResponse.json(done) : NextResponse.json({ error: done.error }, { status: 400 });
  }
  const station = q.get("station");
  if (station !== null) {
    const from = q.get("from") ?? "";
    return NextResponse.json({ entries: await listTide(venueId, station, isValidDateString(from) ? from : "") });
  }
  return NextResponse.json({ rules: await listRules(venueId), stations: await tideStations(venueId), ...(await strandedByLaunch(venueId)) });
}

/**
 * `{ venueId, courtId, sport?, source: "weekly" | "tide" | "both", weekly?, station?, tide?, minWindowMin?, returnBufferMin?, id? }` — set a
 * resource's window rule (for one activity, or all it offers). Answers the rule and, as it now stands, the bookings and classes outside
 * their day's window: none is changed.
 * `{ venueId, keep: "<booking code>" }` — leave that booking as booked, outside its window as it is now.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const venueId = body.venueId;
  if (typeof venueId !== "number" || !Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  if (body.keep !== undefined) {
    const kept = await keepStranded(venueId, body.keep, admin.id);
    if (!kept.ok) return NextResponse.json({ error: kept.error }, { status: 409 });
    await logAction(admin, { venueId, action: "settings.changed", bookingCode: kept.item.ref, detail: `Booking ${kept.item.ref} on ${kept.item.date} left as booked, outside the launch window` });
    return NextResponse.json({ ok: true, ...(await strandedByLaunch(venueId)) });
  }

  const saved = await saveRule(venueId, body, admin.id);
  if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 400 });
  const court = await getCourt(saved.rule.courtId);
  const worklist = await strandedByLaunch(venueId);
  await logAction(admin, {
    venueId,
    action: "settings.changed",
    detail: `Launch window for ${court?.name ?? `court ${saved.rule.courtId}`}${saved.rule.sport ? ` (${saved.rule.sport})` : ""}: ${saved.rule.source}${saved.rule.station ? `, tide table ${saved.rule.station}` : ""}; ${worklist.stranded.length} booking(s) or class(es) now outside the window`,
  });
  return NextResponse.json({ rule: saved.rule, ...worklist }, { status: 201 });
}

/** `?venueId=&id=` — take a rule away: the resource is limited by its opening hours alone again. Nothing booked is touched. */
export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const id = Number(req.nextUrl.searchParams.get("id"));
  const rule = Number.isInteger(id) ? await ruleById(venueId, id) : null;
  if (!rule) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await deleteRule(venueId, id);
  const court = await getCourt(rule.courtId);
  await logAction(admin, { venueId, action: "settings.changed", detail: `Launch window for ${court?.name ?? `court ${rule.courtId}`}${rule.sport ? ` (${rule.sport})` : ""} removed` });
  return NextResponse.json({ ok: true, ...(await strandedByLaunch(venueId)) });
}
