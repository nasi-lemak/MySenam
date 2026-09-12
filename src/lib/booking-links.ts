// Client-safe helpers for sharing/exporting a booking. Court times are in
// Malaysia time (UTC+8); calendar formats want UTC.

export interface BookingShareInfo {
  code: string;
  date: string; // YYYY-MM-DD (MYT)
  startHour: number;
  endHour: number;
  courtName: string;
  venueName: string;
  venueAddress?: string;
  totalPrice: number;
}

const MYT_OFFSET_HOURS = 8;

function toUtcStamp(date: string, hourMYT: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d, hourMYT - MYT_OFFSET_HOURS));
  return utc.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function icsContent(b: BookingShareInfo): string {
  const uid = `${b.code}@mudahtempah`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MudahTempah//Booking//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${toUtcStamp(b.date, b.startHour)}`,
    `DTSTART:${toUtcStamp(b.date, b.startHour)}`,
    `DTEND:${toUtcStamp(b.date, b.endHour)}`,
    `SUMMARY:${b.courtName} @ ${b.venueName}`,
    `DESCRIPTION:MudahTempah booking ${b.code}. Total RM${b.totalPrice}\\, pay at counter.`,
    ...(b.venueAddress ? [`LOCATION:${b.venueAddress.replace(/,/g, "\\,")}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n");
}

export function downloadIcs(b: BookingShareInfo) {
  const blob = new Blob([icsContent(b)], { type: "text/calendar" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mudahtempah-${b.code}.ics`;
  a.click();
  URL.revokeObjectURL(url);
}

export function googleCalendarUrl(b: BookingShareInfo): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `${b.courtName} @ ${b.venueName}`,
    dates: `${toUtcStamp(b.date, b.startHour)}/${toUtcStamp(b.date, b.endHour)}`,
    details: `MudahTempah booking ${b.code}. Total RM${b.totalPrice}, pay at counter.`,
    ...(b.venueAddress ? { location: b.venueAddress } : {}),
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function formatHour12(hour: number): string {
  const h = hour % 24;
  const suffix = h >= 12 ? "PM" : "AM";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:00 ${suffix}`;
}

export function whatsappShareUrl(b: BookingShareInfo): string {
  const text =
    `🏸 Court booked on MudahTempah!\n\n` +
    `${b.courtName} @ ${b.venueName}\n` +
    `📅 ${b.date}, ${formatHour12(b.startHour)} – ${formatHour12(b.endHour)}\n` +
    `💰 RM${b.totalPrice} (pay at counter)\n` +
    `🎟️ Code: ${b.code}\n\nSee you there!`;
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}
