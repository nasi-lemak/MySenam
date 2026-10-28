import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { checkIn, checkOut, getVenueIdForBookingCode, markPlace } from "@/lib/store";
import { logAction } from "@/lib/activity";
import { getDb } from "@/lib/db";
import { participationLapses, type MemberCover } from "@/lib/entitlements";

export const dynamic = "force-dynamic";

/**
 * `{ code }` checks a booking in, `{ code, out: true }` out. `{ code, placeId,
 * mark }` records one person a booking names (lib/participant-bookings.ts):
 * `arrived`, `no_show`, or `clear`; who recorded it is kept, and logged.
 * Somebody on a members' session whose membership no longer covers its date
 * is a warning (`MV6_DESK_WARNING`, 409, with `warnings`); staff decide, and
 * `admit: true` (with a `note`) checks them in all the same, kept and logged
 * (`checkin.membership_admitted`).
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { code, out, placeId, mark, admit, note } = (body ?? {}) as Record<string, unknown>;
  if (typeof code !== "string" || code.trim() === "")
    return NextResponse.json({ error: "code is required." }, { status: 400 });

  const venueId = await getVenueIdForBookingCode(code);
  if (venueId === null) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  // Admitting somebody whose membership no longer covers the session: staff decided, on the record.
  const admitting = admit === true ? { admit: { adminId: admin.id, adminName: admin.name, note: typeof note === "string" ? note : null } } : {};
  const why = typeof note === "string" && note.trim() !== "" ? `: ${note.trim().slice(0, 300)}` : "";
  const admitted = (warnings: MemberCover[]) =>
    warnings
      .map(
        (w) =>
          `${w.name} (${
            w.lapse?.kind === "ended"
              ? `membership ended ${w.lapse.until}`
              : w.lapse?.kind === "cancelled"
                ? "membership cancelled"
                : w.lapse?.kind === "suspended"
                  ? "membership suspended"
                  : "no membership"
          } for ${w.date})`
      )
      .join(", ");

  if (placeId !== undefined) {
    if (!Number.isInteger(placeId) || (mark !== "arrived" && mark !== "no_show" && mark !== "clear"))
      return NextResponse.json({ error: "placeId and mark (arrived, no_show or clear) are required." }, { status: 400 });
    const lapsed = mark === "arrived" && admit === true ? (await lapsesForCode(code)).filter((w) => w.placeId === placeId) : [];
    const marked = await markPlace(code, placeId as number, mark, { id: admin.id, name: admin.name }, mark === "arrived" ? admitting : {});
    if (!marked.ok) return warned(marked);
    const who = marked.places.find((p) => p.placeId === placeId);
    await logAction(admin, { venueId, action: `attendance.${mark}`, bookingCode: marked.booking.code, detail: `${who?.name ?? "Somebody"} (place ${placeId})` });
    if (lapsed.length > 0)
      await logAction(admin, { venueId, action: "checkin.membership_admitted", bookingCode: marked.booking.code, detail: `Admitted ${admitted(lapsed)}${why}` });
    return NextResponse.json({ booking: marked.booking, people: marked.places });
  }

  const lapsed = out !== true && admit === true ? await lapsesForCode(code) : [];
  const result = out === true ? await checkOut(code) : await checkIn(code, admitting);
  if (!result.ok) return warned(result);
  if (lapsed.length > 0)
    await logAction(admin, { venueId, action: "checkin.membership_admitted", bookingCode: result.booking.code, detail: `Admitted ${admitted(lapsed)}${why}` });
  return NextResponse.json({ booking: result.booking });
}

/** The people on a booking its members' session no longer covers, before it is checked in. */
async function lapsesForCode(code: string): Promise<MemberCover[]> {
  const row = (await getDb().prepare("SELECT id FROM bookings WHERE UPPER(code) = UPPER(?)").get(code.trim())) as { id: number } | undefined;
  return row ? participationLapses(row.id) : [];
}

/**
 * A refusal, or the warning staff decide on: `MV6_DESK_WARNING` with `warnings`
 * (each person's `name`, `date` and `lapse`), to send again with `admit: true`
 * (and a `note`) to check them in all the same, on the record.
 */
function warned(r: { error: string; code?: string; vars?: Record<string, string | number>; warnings?: MemberCover[] }): NextResponse {
  return NextResponse.json(
    { error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.vars ? { vars: r.vars } : {}), ...(r.warnings ? { warnings: r.warnings } : {}) },
    { status: 409 }
  );
}
