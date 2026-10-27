// Client-safe helpers for sharing/exporting a booking. Court times are local
// to the install (lib/region.ts); calendar formats want UTC.
import { DEFAULT_SITE_NAME } from "./site";
import { money } from "./region";
import { formatHour, slotStartsAt } from "./time";

export interface BookingShareInfo {
  /** The venue's time zone, which the times are in; the install's if not given. */
  timeZone?: string;
  /** What the install is called, for the text that names it. */
  siteName?: string;
  code: string;
  date: string; // YYYY-MM-DD, local
  startHour: number;
  endHour: number;
  courtName: string;
  venueName: string;
  venueAddress?: string;
  totalPrice: number;
}

/** A venue's wall-clock time as a calendar's UTC stamp, in the venue's zone (the install's if not given). */
export function toUtcStamp(date: string, localHour: number, zone?: string): string {
  return slotStartsAt(date, localHour, zone).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * A value as a calendar file may carry it.
 *
 * Comma, semicolon and backslash separate things inside an iCalendar text
 * value (RFC 5545 §3.3.11), so a venue called "Arena, Petaling Jaya" ends the
 * field at the comma and a reader takes whatever follows as another property.
 * The backslash goes first: escaping it after the others would escape the
 * escapes.
 */
export function icsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * Wrap a long line the way the format wants it.
 *
 * A content line may not exceed 75 octets; longer ones are continued on the
 * next line beginning with a space. An address plus a long venue name goes past
 * that easily, and a strict reader rejects the whole file rather than the line.
 */
export function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let at = 0;
  let limit = 75;
  while (at < bytes.length) {
    // Never split inside a multi-byte character.
    let take = Math.min(limit, bytes.length - at);
    while (take > 1 && (bytes[at + take] & 0xc0) === 0x80) take--;
    parts.push(bytes.subarray(at, at + take).toString("utf8"));
    at += take;
    limit = 74; // a continuation line spends one octet on its leading space
  }
  return parts.join("\r\n ");
}

/** One booking as a calendar file. */
export function icsContent(b: BookingShareInfo): string {
  return icsCalendar([b]);
}

/** Several bookings — each week of a series — as one calendar file. */
export function icsCalendar(list: BookingShareInfo[]): string {
  const site = list[0]?.siteName ?? DEFAULT_SITE_NAME;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${icsText(site)}//Booking//EN`,
    "METHOD:PUBLISH",
    ...list.flatMap((b) => [
      "BEGIN:VEVENT",
      `UID:${b.code}@mysenam`,
      `DTSTAMP:${toUtcStamp(b.date, b.startHour, b.timeZone)}`,
      `DTSTART:${toUtcStamp(b.date, b.startHour, b.timeZone)}`,
      `DTEND:${toUtcStamp(b.date, b.endHour, b.timeZone)}`,
      `SUMMARY:${icsText(`${b.courtName} @ ${b.venueName}`)}`,
      `DESCRIPTION:${icsText(`${b.siteName ?? DEFAULT_SITE_NAME} booking ${b.code}. Total ${money(b.totalPrice)}.`)}`,
      ...(b.venueAddress ? [`LOCATION:${icsText(b.venueAddress)}`] : []),
      // A reminder an hour before, on whatever calendar it lands in.
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${icsText(`${b.courtName} @ ${b.venueName}`)}`,
      "TRIGGER:-PT1H",
      "END:VALARM",
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n");
}

export function downloadIcs(b: BookingShareInfo) {
  const blob = new Blob([icsContent(b)], { type: "text/calendar" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mysenam-${b.code}.ics`;
  a.click();
  URL.revokeObjectURL(url);
}

export function googleCalendarUrl(b: BookingShareInfo): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `${b.courtName} @ ${b.venueName}`,
    dates: `${toUtcStamp(b.date, b.startHour, b.timeZone)}/${toUtcStamp(b.date, b.endHour, b.timeZone)}`,
    details: `${b.siteName ?? DEFAULT_SITE_NAME} booking ${b.code}. Total ${money(b.totalPrice)}.`,
    ...(b.venueAddress ? { location: b.venueAddress } : {}),
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function whatsappShareUrl(b: BookingShareInfo): string {
  const text =
    `🏸 Court booked on ${b.siteName ?? DEFAULT_SITE_NAME}!\n\n` +
    `${b.courtName} @ ${b.venueName}\n` +
    `📅 ${b.date}, ${formatHour(b.startHour)} – ${formatHour(b.endHour)}\n` +
    `💰 ${money(b.totalPrice)}\n` +
    `🎟️ Code: ${b.code}\n\nSee you there!`;
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}
