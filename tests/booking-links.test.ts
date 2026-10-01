import { describe, expect, it } from "vitest";

import { googleCalendarUrl, icsContent, whatsappShareUrl } from "../src/lib/booking-links";
import type { BookingShareInfo } from "../src/lib/booking-links";

/**
 * These are the only things MySenam hands to software it does not control: a
 * calendar file, a Google URL, a WhatsApp message. All three fail silently —
 * a malformed .ics does not error, it just never appears in the diary, and
 * nobody finds out until somebody misses their court.
 */

const booking: BookingShareInfo = {
  code: "MS-7K2PQX",
  date: "2026-10-04",
  startHour: 20,
  endHour: 22,
  courtName: "Badminton Court 3",
  venueName: "Arena MySenam @ Petaling Jaya",
  venueAddress: "12 Jalan SS2/61, 47300 Petaling Jaya, Selangor",
  totalPrice: 50,
};

const lineOf = (ics: string, key: string) =>
  ics.split("\r\n").find((l) => l.startsWith(`${key}:`)) ?? "";

describe("the calendar file", () => {
  it("is a calendar a reader will accept", () => {
    const ics = icsContent(booking);
    // RFC 5545 wants CRLF, and only CRLF.
    expect(ics).toContain("\r\n");
    expect(ics.replace(/\r\n/g, "")).not.toContain("\n");
    const lines = ics.split("\r\n");
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines[lines.length - 1]).toBe("END:VCALENDAR");
    expect(lines).toContain("BEGIN:VEVENT");
    expect(lines).toContain("END:VEVENT");
    expect(lines).toContain("VERSION:2.0");
  });

  it("puts a Malaysian evening at the right moment in UTC", () => {
    // 8pm in Kuala Lumpur is 12:00 UTC the same day; 10pm is 14:00.
    const ics = icsContent(booking);
    expect(lineOf(ics, "DTSTART")).toBe("DTSTART:20261004T120000Z");
    expect(lineOf(ics, "DTEND")).toBe("DTEND:20261004T140000Z");
  });

  it("puts an early morning on the day before, in UTC", () => {
    // 7am in Kuala Lumpur is 23:00 UTC the previous day. Getting this wrong
    // puts the booking in the diary a whole day out.
    const ics = icsContent({ ...booking, startHour: 7, endHour: 8 });
    expect(lineOf(ics, "DTSTART")).toBe("DTSTART:20261003T230000Z");
    expect(lineOf(ics, "DTEND")).toBe("DTEND:20261004T000000Z");
  });

  it("identifies the event by the booking, so a re-import updates rather than doubles", () => {
    expect(lineOf(icsContent(booking), "UID")).toBe("UID:MS-7K2PQX@mysenam");
  });

  it("escapes the characters that would otherwise end a field early", () => {
    // RFC 5545 §3.3.11: comma, semicolon and backslash are separators inside a
    // text value, and a raw one truncates everything after it.
    const ics = icsContent({
      ...booking,
      courtName: "Court 1; the big one",
      venueName: "Arena, Petaling Jaya",
      venueAddress: "12 Jalan SS2/61, 47300 PJ; next to the bank",
    });
    const summary = lineOf(ics, "SUMMARY");
    expect(summary).toContain("\;");
    expect(summary).toContain("\\,");
    expect(summary).not.toMatch(/[^\\][,;]/);

    const location = lineOf(ics, "LOCATION");
    expect(location).toContain("\\,");
    expect(location).toContain("\;");
    expect(location).not.toMatch(/[^\\][,;]/);
  });

  it("leaves the location out when there is no address", () => {
    const ics = icsContent({ ...booking, venueAddress: undefined });
    expect(ics).not.toContain("LOCATION:");
  });

  it("wraps a long line rather than sending one a reader will reject", () => {
    const ics = icsContent({
      ...booking,
      venueName: "Pusat Sukan dan Rekreasi Majlis Bandaraya Petaling Jaya (Dewan Utama)",
      venueAddress:
        "Lot 4821, Jalan Profesor Diraja Ungku Aziz, Seksyen 13, 46200 Petaling Jaya, Selangor Darul Ehsan, Malaysia",
    });
    for (const line of ics.split("\r\n")) {
      expect(Buffer.from(line, "utf8").length, `too long: ${line}`).toBeLessThanOrEqual(75);
    }
    // Unfolding puts it back together exactly.
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain("Seksyen 13\\, 46200 Petaling Jaya");
  });

  it("does not split a line in the middle of a character", () => {
    const ics = icsContent({ ...booking, venueName: "Gelanggang Seri Nirwana — Bahagian Tenggara Kuala Lumpur" });
    // A broken split shows up as a replacement character once decoded.
    expect(ics).not.toContain("\uFFFD");
    expect(ics.replace(/\r\n /g, "")).toContain("Seri Nirwana — Bahagian");
  });

  it("says what it costs and where to pay", () => {
    expect(lineOf(icsContent(booking), "DESCRIPTION")).toContain("RM50");
    expect(lineOf(icsContent(booking), "DESCRIPTION")).toContain("MS-7K2PQX");
  });
});

describe("the Google Calendar link", () => {
  it("points at Google with the booking in the query", () => {
    const url = new URL(googleCalendarUrl(booking));
    expect(url.origin + url.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("text")).toBe("Badminton Court 3 @ Arena MySenam @ Petaling Jaya");
    expect(url.searchParams.get("dates")).toBe("20261004T120000Z/20261004T140000Z");
    expect(url.searchParams.get("location")).toBe(booking.venueAddress);
  });

  it("omits the location rather than sending an empty one", () => {
    const url = new URL(googleCalendarUrl({ ...booking, venueAddress: undefined }));
    expect(url.searchParams.has("location")).toBe(false);
  });

  it("encodes a venue name that would otherwise break the query", () => {
    const url = new URL(googleCalendarUrl({ ...booking, venueName: "A&B Sports #1" }));
    expect(url.searchParams.get("text")).toContain("A&B Sports #1");
  });
});

describe("the WhatsApp message", () => {
  it("carries the booking, encoded", () => {
    const url = new URL(whatsappShareUrl(booking));
    expect(url.origin + url.pathname).toBe("https://wa.me/");
    const text = url.searchParams.get("text")!;
    expect(text).toContain("MS-7K2PQX");
    expect(text).toContain("Badminton Court 3");
    expect(text).toContain("RM50");
    expect(text).toContain("8:00 PM – 10:00 PM");
  });

  it("writes midnight and noon the way a person reads them", () => {
    const midnight = new URL(whatsappShareUrl({ ...booking, startHour: 0, endHour: 1 }));
    expect(midnight.searchParams.get("text")).toContain("12:00 AM – 1:00 AM");

    const noon = new URL(whatsappShareUrl({ ...booking, startHour: 12, endHour: 13 }));
    expect(noon.searchParams.get("text")).toContain("12:00 PM – 1:00 PM");
  });

  it("does not call the last hour of the day midnight of the same day", () => {
    // A booking that runs to close finishes at hour 24, which is midnight.
    const url = new URL(whatsappShareUrl({ ...booking, startHour: 23, endHour: 24 }));
    expect(url.searchParams.get("text")).toContain("11:00 PM – 12:00 AM");
  });
});
