import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { eraseCustomer } from "../src/lib/privacy";
import {
  askForReviews,
  moderateReview,
  replyToReview,
  reportReview,
  reviewable,
  reviewToken,
  setReviewRequests,
  shownName,
  staffReviews,
  venueRating,
  venueReviews,
  writeReview,
} from "../src/lib/reviews";
import { venueJsonLd } from "../src/lib/seo";
import { createBooking, createCourt, createVenue, listUserBookings } from "../src/lib/store";
import { addDays, slotStartsAt, todayISO } from "../src/lib/time";
import { POST as postReview } from "../src/app/api/reviews/route";
import { POST as staffPost } from "../src/app/api/admin/reviews/route";

/**
 * Reviews from people who played: only after a booking that went ahead, one
 * per number per venue, a score only from three, the venue's reply and the
 * platform's decision, and one email asking, once.
 */

let venueId: number;
let courtId: number;
let n = 0;
const ZONE = "Asia/Kuala_Lumpur";

/** A booking at the venue, moved to the given day. */
async function played(daysAgo: number, opts: { name?: string; phone?: string; email?: string; userId?: number } = {}) {
  n++;
  const made = await createBooking({
    courtId,
    date: addDays(todayISO(), 1 + (n % 10)),
    hours: [8 + (n % 12)],
    name: opts.name ?? "Wei Ling Tan",
    phone: opts.phone ?? `01255${String(n).padStart(5, "0")}`,
    ...(opts.email ? { email: opts.email } : {}),
    ...(opts.userId ? { userId: opts.userId } : {}),
  });
  if (!made.ok) throw new Error(made.error);
  const date = addDays(todayISO(ZONE), -daysAgo);
  await getDb().prepare("UPDATE bookings SET date = ? WHERE id = ?").run(date, made.booking.id);
  return { ...made.booking, date };
}

const review = (code: string, rating: number, body?: string) => writeReview(code, reviewToken(code), { rating, body });

beforeAll(async () => {
  const made = await createVenue({ name: "Star Courts", area: "PJ", address: "x", phone: "0355550000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(venueId);
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
});

describe("who may review", () => {
  it("only once the booking is over, if it went ahead, and within 60 days", async () => {
    const coming = await played(-2);
    expect(await reviewable(coming.code)).toMatchObject({ ok: false, code: "REVIEW_NOT_YET" });
    const cancelled = await played(3);
    await getDb().prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(cancelled.id);
    expect(await reviewable(cancelled.code)).toMatchObject({ ok: false, code: "REVIEW_NOT_PLAYED" });
    const missed = await played(3);
    await getDb().prepare("UPDATE bookings SET no_show = 1 WHERE id = ?").run(missed.id);
    expect(await reviewable(missed.code)).toMatchObject({ ok: false, code: "REVIEW_NOT_PLAYED" });
    expect(await reviewable((await played(61)).code)).toMatchObject({ ok: false, code: "REVIEW_TOO_LATE" });
    expect(await reviewable((await played(1)).code)).toMatchObject({ ok: true });
  });

  it("through the booking's own signed link", async () => {
    const b = await played(1);
    const send = (t: string, body: Record<string, unknown>) =>
      postReview(
        new NextRequest("http://localhost/api/reviews", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
          body: JSON.stringify({ code: b.code, t, ...body }),
        })
      );
    expect((await send("forged", { rating: 5 })).status).toBe(404);
    expect(await (await send(reviewToken(b.code), { rating: 0 })).json()).toMatchObject({ code: "REVIEW_STARS" });
    expect(await (await send(reviewToken(b.code), { rating: 4, body: "Call me 012-345 6789" })).json()).toMatchObject({ code: "REVIEW_LINK" });
    expect(await (await send(reviewToken(b.code), { rating: 4, body: "Better at www.othercourts.com" })).json()).toMatchObject({ code: "REVIEW_LINK" });
    const ok = await send(reviewToken(b.code), { rating: 4, body: "Good floor, bright lights." });
    expect(ok.status).toBe(200);
    expect((await ok.json()).review).toMatchObject({ author: "Wei T.", rating: 4, body: "Good floor, bright lights." });
  });
});

describe("what is shown", () => {
  it("one per number: writing again replaces it", async () => {
    const first = await played(10, { phone: "0129990100" });
    const again = await played(2, { phone: "0129990100" });
    await review(first.code, 2, "Too hot.");
    await review(again.code, 5, "Aircon fixed!");
    const mine = (await staffReviews(venueId)).filter((r) => r.bookingCode === again.code || r.bookingCode === first.code);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ rating: 5, body: "Aircon fixed!" });
  });

  it("a score only from three reviews, hidden ones not counted", async () => {
    expect(await venueRating(venueId)).toBeNull();
    await review((await played(4)).code, 3);
    expect(await venueRating(venueId)).toEqual({ average: 4, count: 3 });
    const bad = await played(4);
    const written = await review(bad.code, 1, "Rubbish, the owner is a crook");
    if (!written.ok) throw new Error(written.error);
    expect((await venueRating(venueId))!.count).toBe(4);
    await reportReview(written.review.id, venueId, "Abuse of the owner");
    expect((await venueReviews(venueId)).some((r) => r.id === written.review.id)).toBe(true);
    await moderateReview(written.review.id, true, "Abusive");
    expect(await venueRating(venueId)).toEqual({ average: 4, count: 3 });
    expect((await venueReviews(venueId)).some((r) => r.id === written.review.id)).toBe(false);
    expect((await staffReviews(venueId)).find((r) => r.id === written.review.id)).toMatchObject({ hiddenReason: "Abusive" });
  });

  it("with the venue's reply, and a rating search engines can read", async () => {
    const [latest] = await venueReviews(venueId);
    expect(await replyToReview(latest.id, venueId, "Thanks for coming!")).toMatchObject({ ok: true, review: { reply: "Thanks for coming!" } });
    expect(await replyToReview(latest.id, venueId + 999, "x")).toMatchObject({ ok: false });
    const ld = venueJsonLd({
      name: "Star Courts", address: "x", area: "PJ", phone: "1", openHour: 7, closeHour: 23, lat: null, lng: null,
      url: "https://x", image: null, sports: ["badminton"], rating: await venueRating(venueId),
    });
    expect(ld.aggregateRating).toMatchObject({ "@type": "AggregateRating", ratingValue: 4, reviewCount: 3 });
  });

  it("names people by first name and initial", () => {
    expect(shownName("Ahmad bin Ismail")).toBe("Ahmad I.");
    expect(shownName("  Mei  ")).toBe("Mei");
  });
});

describe("the venue's staff", () => {
  it("reply as managers; the desk cannot, and only the platform hides", async () => {
    const desk = await createAdmin({ name: "Desk", email: "desk@star.my", password: "desk-password-1", venueId, role: "desk" });
    const mgr = await createAdmin({ name: "Mgr", email: "mgr@star.my", password: "mgr-password-12", venueId });
    if (!desk.ok || !mgr.ok) throw new Error("admins");
    const [r] = await venueReviews(venueId);
    const as = async (id: number, body: Record<string, unknown>) =>
      staffPost(
        new NextRequest("http://localhost/api/admin/reviews", {
          method: "POST",
          headers: { cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(id)).token}`, "content-type": "application/json" },
          body: JSON.stringify({ venueId, ...body }),
        })
      );
    expect((await as(desk.admin.id, { action: "reply", id: r.id, text: "Hi" })).status).toBe(403);
    expect((await as(mgr.admin.id, { action: "reply", id: r.id, text: "See you again" })).status).toBe(200);
    expect((await as(mgr.admin.id, { action: "hide", id: r.id, reason: "Do not like it" })).status).toBe(403);
  });
});

describe("asking for a review", () => {
  it("emails once, a few hours after a first visit, and never again for that venue", async () => {
    const b = await played(1, { phone: "0128880200", email: "first@example.my" });
    const after = new Date(slotStartsAt(b.date, b.endHour, ZONE).getTime() + 3 * 3_600_000);
    expect(await askForReviews(after)).toBeGreaterThanOrEqual(1);
    const sent = (await getDb().prepare("SELECT subject, body FROM messages WHERE kind = 'review_request' AND recipient = ?").all("first@example.my")) as {
      subject: string;
      body: string;
    }[];
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("How was Star Courts?");
    expect(sent[0].body).toContain(`/review/${b.code}?t=${reviewToken(b.code)}`);
    expect(sent[0].body).toContain("This is the only time");
    const again = await played(1, { phone: "0128880200", email: "first@example.my" });
    await askForReviews(new Date(slotStartsAt(again.date, again.endHour, ZONE).getTime() + 3 * 3_600_000));
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE kind = 'review_request' AND recipient = ?").get("first@example.my")) as { n: number }).toEqual({ n: 1 });
  });

  it("not where the venue has turned it off, nor before the booking is over", async () => {
    const b = await played(1, { phone: "0128880300", email: "off@example.my" });
    expect(await askForReviews(new Date(slotStartsAt(b.date, b.endHour, ZONE).getTime() - 3_600_000))).toBe(0);
    await setReviewRequests(venueId, false);
    expect(await askForReviews(new Date(slotStartsAt(b.date, b.endHour, ZONE).getTime() + 3 * 3_600_000))).toBe(0);
    await setReviewRequests(venueId, true);
  });
});

describe("an account", () => {
  it("is offered the link on past bookings, and its reviews go when it closes", async () => {
    const user = await registerUser({ name: "Siti Aminah", email: "siti@example.my", phone: "0137770001", password: "a long enough password" });
    if (!user.ok) throw new Error(user.error);
    const b = await played(3, { name: "Siti Aminah", phone: "0137770001", userId: user.user.id });
    const row = (await listUserBookings(user.user.id)).find((x) => x.id === b.id)!;
    expect(row.reviewUrl).toBe(`/review/${b.code}?t=${reviewToken(b.code)}`);
    await review(b.code, 5, "Lovely");
    expect((await staffReviews(venueId)).some((r) => r.author === "Siti A.")).toBe(true);
    expect(await eraseCustomer(user.user.id)).toMatchObject({ ok: true });
    expect((await staffReviews(venueId)).some((r) => r.author === "Siti A.")).toBe(false);
  });
});
