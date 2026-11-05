import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { addTideEntry, deleteTide, importTide } from "@/lib/launch-windows";
import { strandedByLaunch } from "@/lib/launch-worklist";
import { readJsonObject } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * The venue's own tide table (lib/launch-windows.ts, lib/tide-import.ts, ADR 0037). Nothing is fetched from a service and the
 * table is never shown to customers as a forecast. Every write answers the bookings and classes now outside their day's window
 * (`stranded`): none is changed.
 *
 * `{ venueId, action: "import", station, csv, times?: "venue" | "utc", preview? }` — a table as CSV (`date,time,type,height_m`).
 * Every row is checked and a table with any fault stores nothing: 400 with `errors`, each with its `line` and a `code`. With
 * `preview`, only what it would do.
 * `{ venueId, action: "add", station, date, time, kind: "high" | "low", heightM }` — one entry, by hand.
 * `{ venueId, action: "delete", id }` or `{ venueId, action: "delete", station, from, until }` — remove an entry, or a station's
 * between two dates.
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

  if (body.action === "import" || body.action === "add") {
    const done =
      body.action === "import"
        ? await importTide(venueId, { station: body.station, csv: body.csv, times: body.times, preview: body.preview === true }, admin.id)
        : await addTideEntry(venueId, { station: body.station, date: body.date, time: body.time, kind: body.kind, heightM: body.heightM }, admin.id);
    if (!done.ok) return NextResponse.json(done, { status: 400 });
    if (done.preview) return NextResponse.json(done);
    const worklist = await strandedByLaunch(venueId);
    await logAction(admin, {
      venueId,
      action: "settings.changed",
      detail: `Tide table ${done.station}: ${done.added} added, ${done.changed} changed, ${done.unchanged} unchanged (${done.from} to ${done.until}); ${worklist.stranded.length} booking(s) or class(es) now outside the launch window`,
    });
    return NextResponse.json({ ...done, ...worklist });
  }
  if (body.action === "delete") {
    const done = await deleteTide(venueId, { id: body.id, station: body.station, from: body.from, until: body.until });
    if (!done.ok) return NextResponse.json({ error: done.error }, { status: 400 });
    const worklist = await strandedByLaunch(venueId);
    await logAction(admin, {
      venueId,
      action: "settings.changed",
      detail: `Tide table ${done.station}: ${done.removed} entr${done.removed === 1 ? "y" : "ies"} removed; ${worklist.stranded.length} booking(s) or class(es) now outside the launch window`,
    });
    return NextResponse.json({ ok: true, removed: done.removed, ...worklist });
  }
  return NextResponse.json({ error: "Say what to do: import, add or delete." }, { status: 400 });
}
