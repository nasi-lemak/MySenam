import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { getDb } from "../src/lib/db";
import { savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import { createBookingSeries, createCourt, createVenue, paySeries } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * A weekly series marked paid at the counter while an online payment for one
 * of its weeks lands: whichever comes first is the payment, and the other is
 * not lost. Money that came online for a week the counter also took is owed
 * back, never quietly kept.
 */

let courtId: number;
let n = 0;

beforeAll(async () => {
  const made = await createVenue({ name: "Series Hall", area: "PJ", address: "x", phone: "0300000077" });
  if (!made.ok) throw new Error("venue");
  const court = await createCourt({ venueId: made.venue.id, name: "Court 1", sport: "badminton", offPeakRate: 30, peakRate: 30 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
  const saved = await savePaymentSettings(made.venue.id, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
});

afterEach(() => vi.unstubAllGlobals());

describe("a series paid at the counter while a week is paid online", () => {
  for (let round = 0; round < 3; round++)
    it(`never keeps money for a week paid twice (round ${round + 1})`, async () => {
      const phone = `01933${String(++n).padStart(5, "0")}`;
      const series = await createBookingSeries({ courtId, date: addDays(todayISO(), 1 + round), hours: [9 + round], weeks: 2, name: "Liga", phone });
      if (!series.ok) throw new Error(series.error);
      const week = series.bookings[0];
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: `series${n}`, url: `https://www.billplz-sandbox.com/bills/series${n}` })));
      const started = await startBookingPayment({ codes: [week.code], phone });
      if (!started.ok) throw new Error("payment");

      await Promise.all([settleBill({ billId: `series${n}`, paid: true, paidAt: null }), paySeries(series.seriesCode!, "cash")]);

      const booking = (await getDb().prepare("SELECT paid_via FROM bookings WHERE id = ?").get(week.id)) as { paid_via: string };
      const payment = (await getDb()
        .prepare("SELECT amount::float AS amount, refund_due::float AS due FROM online_payments WHERE bill_id = ?")
        .get(`series${n}`)) as { amount: number; due: number };
      // Online first: the booking says so. Counter first: the online money is owed back.
      if (booking.paid_via === "online") expect(payment.due).toBe(0);
      else expect({ via: booking.paid_via, due: payment.due }).toEqual({ via: "cash", due: payment.amount });
    });
});
