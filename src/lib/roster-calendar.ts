import { fold, icsText } from "./booking-links";
import { getDb } from "./db";
import { translator, type Locale } from "./i18n";
import { ownShifts, type OwnShift, type PersonKind } from "./rosters";
import { siteName } from "./site";
import { venueBaseUrl } from "./storefront";
import { addDays, todayISO } from "./time";
import { venueZoneOf } from "./zones";

/**
 * A person's own rostered shifts as calendar events (lib/rosters.ts `ownShifts`): on a coach's own calendar link
 * (lib/coach-schedule.ts), and on a member of staff's own link (`/api/roster-calendar/<token>.ics`). Only the person's own
 * shifts, only on their own link: nobody else's shifts, no customer's name or number. What people read is in `locale`;
 * what calendar apps read is as iCalendar has it.
 */

/** From a week back to as far ahead as anybody can book. */
const DAYS_BACK = 7;
const DAYS_AHEAD = 90;

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** The built-in roles in the reader's language; a role of the venue's own as it named it. */
function roleWords(t: ReturnType<typeof translator>, s: Pick<OwnShift, "roleKey" | "roleName">): string {
  const phrase = ({ range_officer: "sv1.role.range_officer", lifeguard: "sv1.role.lifeguard", instructor: "sv1.role.instructor" } as const)[s.roleKey as "range_officer"];
  return phrase ? t(phrase) : s.roleName;
}

/** The VEVENT lines of a person's shifts at a venue, newest to come last. */
export async function shiftEvents(venueId: number, person: { kind: PersonKind; id: number }, locale: Locale, zone: string): Promise<string[]> {
  const t = translator(locale);
  const today = todayISO(zone);
  const host = new URL(await venueBaseUrl(venueId)).host;
  const shifts = await ownShifts(venueId, person, addDays(today, -DAYS_BACK), DAYS_BACK + DAYS_AHEAD);
  const now = stamp(Date.now());
  return shifts.flatMap((s) => [
    "BEGIN:VEVENT",
    `UID:shift-${venueId}-${person.kind}${person.id}-${s.from}@${host}`,
    `DTSTAMP:${now}`,
    `DTSTART:${stamp(s.from)}`,
    `DTEND:${stamp(s.to)}`,
    `SUMMARY:${icsText(t("sv1.cal.shift", { role: roleWords(t, s) }))}`,
    "END:VEVENT",
  ]);
}

/** A member of staff's own shifts as a calendar file. */
export async function staffShiftCalendar(admin: { id: number; name: string; venueId: number | null }, locale: Locale): Promise<string> {
  const t = translator(locale);
  const row = admin.venueId === null ? undefined : ((await getDb().prepare("SELECT name, time_zone, lat, lng FROM venues WHERE id = ?").get(admin.venueId)) as { name: string; time_zone: string | null; lat: number | null; lng: number | null } | undefined);
  const zone = row ? venueZoneOf(row) : "UTC";
  const events = row && admin.venueId !== null ? await shiftEvents(admin.venueId, { kind: "staff", id: admin.id }, locale, zone) : [];
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${icsText(siteName())}//Staff shifts//EN`,
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(t("sv1.cal.name", { venue: row?.name ?? "" }))}`,
    `X-WR-TIMEZONE:${zone}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT30M",
    "X-PUBLISHED-TTL:PT30M",
    ...events,
    "END:VCALENDAR",
  ]
    .map(fold)
    .join("\r\n");
}
