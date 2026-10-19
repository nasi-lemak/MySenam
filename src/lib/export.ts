import { getDb } from "./db";
import { PAID_VIA_LABELS, type PaidVia } from "./types";

/**
 * A venue's bookings and online payments as spreadsheets (CSV), for the
 * accountant: one row each, opened straight in Excel or Google Sheets.
 *
 * Excel is the reader to please: a byte-order mark so it reads Malay names
 * and "—" right, CRLF line ends, every field quoted, and a cell that would
 * start a formula (=, +, -, @) given a leading apostrophe, so a customer
 * named "=HYPERLINK(...)" is text, not a link.
 */

function cell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return "﻿" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

const hour = (h: number) => `${String(h).padStart(2, "0")}:00`;

/** Every booking played in the period, cancelled ones too, with what was paid and how. */
export async function bookingsCsv(venueId: number, from: string, to: string): Promise<string> {
  const rows = (await getDb()
    .prepare(
      `SELECT b.code, b.series_code, b.date, b.start_hour, b.end_hour, c.name AS court, c.sport,
              b.name, b.phone, b.email, b.status, b.released_unpaid, b.total_price, b.payment_status, b.paid_via, b.paid_at,
              (SELECT discount FROM promo_uses u WHERE u.booking_id = b.id) AS discount,
              (SELECT STRING_AGG(a.quantity || ' x ' || a.name, '; ') FROM booking_addons a WHERE a.booking_id = b.id) AS extras,
              ci.checked_in_at, b.no_show, b.class_id, b.created_at
         FROM bookings b JOIN courts c ON c.id = b.court_id
         LEFT JOIN check_ins ci ON ci.booking_id = b.id
        WHERE c.venue_id = ? AND b.date >= ? AND b.date <= ?
        ORDER BY b.date, b.start_hour, b.id`
    )
    .all(venueId, from, to)) as Record<string, unknown>[];
  return toCsv(
    [
      "Code", "Series", "Date", "Start", "End", "Court", "Sport", "Customer", "Phone", "Email", "Status",
      "Price (RM)", "Payment", "Paid by", "Paid at", "Promo discount (RM)", "Extras", "Checked in", "No-show", "Class", "Booked at",
    ],
    rows.map((r) => [
      r.code,
      r.series_code,
      r.date,
      hour(Number(r.start_hour)),
      hour(Number(r.end_hour)),
      r.court,
      r.sport,
      r.name,
      r.phone,
      r.email,
      r.status === "cancelled" && Number(r.released_unpaid) === 1 ? "released (unpaid)" : r.status,
      Number(r.total_price).toFixed(2),
      Number(r.total_price) === 0 ? "free" : r.payment_status,
      r.paid_via ? (PAID_VIA_LABELS[r.paid_via as PaidVia] ?? r.paid_via) : r.payment_status === "paid" ? "not recorded" : "",
      r.paid_at,
      r.discount === null || r.discount === undefined ? "" : Number(r.discount).toFixed(2),
      r.extras,
      r.checked_in_at ?? "",
      Number(r.no_show) === 1 ? "yes" : "",
      r.class_id === null ? "" : "yes",
      r.created_at,
    ])
  );
}

/** Money taken online into the venue's own account in the period, and what is owed back. */
export async function paymentsCsv(venueId: number, from: string, to: string): Promise<string> {
  const rows = (await getDb()
    .prepare(
      `SELECT p.bill_id, p.purpose, p.status, p.amount, p.refund_due, p.refunded, p.payer_name, p.payer_phone, p.created_at, p.paid_at,
              (SELECT STRING_AGG(b.code, ' ') FROM online_payment_bookings pb JOIN bookings b ON b.id = pb.booking_id WHERE pb.payment_id = p.id) AS codes
         FROM online_payments p
        WHERE p.venue_id = ? AND p.created_at >= ? AND p.created_at <= ? AND p.purpose <> 'invoice'
        ORDER BY p.id`
    )
    .all(venueId, `${from} 00:00:00`, `${to} 23:59:59`)) as Record<string, unknown>[];
  return toCsv(
    ["Bill", "For", "Bookings", "Status", "Amount (RM)", "Owed back (RM)", "Refunded (RM)", "Payer", "Phone", "Opened at", "Paid at"],
    rows.map((r) => [
      r.bill_id,
      r.purpose,
      r.codes,
      r.status,
      Number(r.amount).toFixed(2),
      Number(r.refund_due).toFixed(2),
      Number(r.refunded).toFixed(2),
      r.payer_name,
      r.payer_phone,
      r.created_at,
      r.paid_at,
    ])
  );
}
