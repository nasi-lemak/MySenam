import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { notifyBookingConfirmed, notifyReminders } from "../src/lib/notify";
import {
  drainOutbox,
  dueMessages,
  emailPlain,
  enqueue,
  maxMessageAgeDays,
  messageById,
  messagesForBooking,
  retryFailedMessages,
  retryMessage,
  setTransport,
  urgentPerRecipientPerDay,
  type OutboxMessage,
} from "../src/lib/outbox";
import { PermanentSendError } from "../src/lib/send-errors";
import { recordConsent, sendCampaign, unsubscribe } from "../src/lib/marketing";
import { createBooking, createVenue, listVenues, rescheduleBooking } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as messagesPost } from "../src/app/api/admin/messages/route";

/**
 * Audit 9, G1, G7, G8 and G9: what the outbox does while a provider is down, with a reminder whose booking changed, with a campaign
 * ahead of a customer's confirmation, and with the day's limit per recipient.
 */
let venueId: number;
let courtId: number;
let n = 0;
const sent: OutboxMessage[] = [];

beforeAll(async () => {
  const v = (await listVenues()).find((x) => x.courts.some((c) => c.capacity === 1 && c.sport === "badminton"))!;
  venueId = v.id;
  courtId = v.courts.find((c) => c.capacity === 1 && c.sport === "badminton")!.id;
});
afterEach(() => {
  setTransport(null);
  sent.length = 0;
  vi.unstubAllEnvs();
});

const recorder = () => setTransport({ name: "recorder", async send(m) { sent.push(m); } });
const down = (why = "401 token expired") =>
  setTransport({ name: "down", async send() { throw new Error(why); } });
const everythingDue = () => getDb().prepare("UPDATE messages SET next_attempt_at = datetime('now', '-1 minute') WHERE status IN ('queued','failed')").run();

let seq = 0;
const email = (kind: Parameters<typeof enqueue>[0]["kind"], to: string, venue: number | null = venueId) =>
  enqueue({ venueId: venue, kind, channel: "email", recipient: to, subject: "msg.reminderSubject", body: "msg.reminder", vars: { name: "B", code: `C${++seq}`, where: "c", when: "w", link: "l" } });

describe("G1: a provider outage does not lose what is waiting", () => {
  it("keeps a confirmation, a venue's cancellation notice and the rest through hours of failures, and sends them when the provider is back", async () => {
    down();
    const messages = [];
    for (const [i, kind] of (["booking_confirmed", "booking_cancelled_by_venue", "waitlist_offer"] as const).entries())
      messages.push(await email(kind, `outage${i}@example.my`));
    // Far more tries than the five it used to have: every backoff falls due in turn.
    for (let i = 0; i < 12; i++) {
      await everythingDue();
      await drainOutbox();
    }
    for (const m of messages) expect(await messageById(m.id)).toMatchObject({ status: "failed", attempts: 12 });
    recorder();
    await everythingDue();
    await drainOutbox();
    for (const m of messages) expect((await messageById(m.id))!.status).toBe("sent");
    expect(sent).toHaveLength(3);
  });

  it("backs off to two hours and no further, whatever the number of failures", async () => {
    down();
    const m = await email("booking_confirmed", "backoff@example.my");
    for (let i = 0; i < 9; i++) {
      await everythingDue();
      await drainOutbox();
    }
    const row = (await getDb()
      .prepare("SELECT next_attempt_at > datetime('now', '+121 minutes') AS too_far, next_attempt_at > datetime('now', '+100 minutes') AS far_enough FROM messages WHERE id = ?")
      .get(m.id)) as { too_far: boolean; far_enough: boolean };
    // After nine failures the wait is the two hours it stops at: not minutes, and not growing on.
    expect(row).toEqual({ too_far: false, far_enough: true });
  });

  it("gives up at once only where the transport says sending again cannot help", async () => {
    setTransport({ name: "bad-number", async send() { throw new PermanentSendError("WhatsApp: recipient not reachable"); } });
    const m = await email("booking_confirmed", "gone@example.my");
    await everythingDue();
    const result = await drainOutbox();
    expect(result.failed).toBe(0);
    expect(await messageById(m.id)).toMatchObject({ status: "abandoned", attempts: 1, lastError: "WhatsApp: recipient not reachable" });
  });

  it("gives a message up after the longest it is kept trying, and tells the venue's managers (once a day) and the owners", async () => {
    const made = await createVenue({ name: "Aged Out Arena", area: "PJ", address: "1", phone: "0312345900" });
    if (!made.ok) throw new Error("venue");
    const aged = made.venue.id;
    const manager = await createAdmin({ name: "Aged Manager", email: "aged.manager@example.my", password: "a long enough password", venueId: aged });
    if (!manager.ok) throw new Error(manager.error);
    down("SES account suspended");
    const old = [await email("booking_confirmed", "aged1@example.my", aged), await email("booking_confirmed", "aged2@example.my", aged)];
    await getDb().prepare("UPDATE messages SET created_at = datetime('now', ?) WHERE id IN (?, ?)").run(`-${maxMessageAgeDays() + 1} days`, old[0].id, old[1].id);
    await everythingDue();
    await drainOutbox();
    for (const m of old) expect(await messageById(m.id)).toMatchObject({ status: "abandoned", lastError: expect.stringContaining("given up after 7 days") });
    // The manager has one email (not two) saying how many, in the outbox like any other.
    const told = (await getDb().prepare("SELECT subject, body, recipient FROM messages WHERE kind = 'staff_alert' AND dedupe_key LIKE ? ").all(`messages-aged:${aged}:%`)) as { subject: string; body: string; recipient: string }[];
    expect(told).toHaveLength(1);
    expect(told[0].recipient).toBe("aged.manager@example.my");
    expect(told[0].body).toContain("2 messages");
    // The owners' alert is raised.
    expect(await getDb().prepare("SELECT key FROM system_alerts WHERE key = 'messages-aged-out'").get()).toBeTruthy();
    // Another one given up the same day does not write a second email to the manager.
    const third = await email("booking_confirmed", "aged3@example.my", aged);
    await getDb().prepare("UPDATE messages SET created_at = datetime('now', ?) WHERE id = ?").run(`-${maxMessageAgeDays() + 1} days`, third.id);
    await everythingDue();
    await drainOutbox();
    expect(await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE kind = 'staff_alert' AND dedupe_key LIKE ?").get(`messages-aged:${aged}:%`)).toEqual({ n: 1 });
  });

  it("the longest age is configurable", async () => {
    vi.stubEnv("MYSENAM_MESSAGE_MAX_AGE_DAYS", "2");
    expect(maxMessageAgeDays()).toBe(2);
    vi.stubEnv("MYSENAM_MESSAGE_MAX_AGE_DAYS", "nonsense");
    expect(maxMessageAgeDays()).toBe(7);
  });

  it("an account email with a link keeps trying through an outage until its link runs out, and is then given up with the link wiped", async () => {
    down();
    const m = await emailPlain({ to: "reset@example.my", subject: "Reset", text: "https://book.example.my/reset-password?token=SECRET", kind: "account_email", expiresMinutes: 30 });
    for (let i = 0; i < 4; i++) {
      await everythingDue();
      await drainOutbox();
    }
    expect((await messageById(m.id))!.status).toBe("failed");
    // The link has run out meanwhile: not sent, and its text is not kept.
    await getDb().prepare("UPDATE messages SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(m.id);
    await everythingDue();
    recorder();
    await drainOutbox();
    const after = (await messageById(m.id))!;
    expect(after.status).toBe("abandoned");
    expect(after.body).not.toContain("SECRET");
    expect(sent.filter((x) => x.recipient === "reset@example.my")).toEqual([]);
    // And it cannot be put back by staff: the person asks for a new link.
    expect(await retryMessage(m.id)).toMatchObject({ ok: false });
  });
});

describe("G1: send again everything that failed", () => {
  it("puts back this venue's failed and given-up messages from the window, and not another venue's, an account email, or one too old", async () => {
    const mine = [];
    const own = await createVenue({ name: "Own Bulk Arena", area: "PJ", address: "1", phone: "0312345903" });
    if (!own.ok) throw new Error("venue");
    const ownId = own.venue.id;
    down();
    for (let i = 0; i < 3; i++) mine.push(await email("booking_confirmed", `bulk${i}@example.my`, ownId));
    const account = await emailPlain({ to: "acct@example.my", subject: "Confirm", text: "link", kind: "account_email", venueId: ownId });
    const other = await createVenue({ name: "Other Bulk Arena", area: "PJ", address: "1", phone: "0312345901" });
    if (!other.ok) throw new Error("venue");
    const elsewhere = await email("booking_confirmed", "bulk-other@example.my", other.venue.id);
    const tooOld = await email("booking_confirmed", "bulk-old@example.my", ownId);
    for (let i = 0; i < 2; i++) {
      await everythingDue();
      await drainOutbox();
    }
    // One of mine was given up for good; one is far older than the window.
    await getDb().prepare("UPDATE messages SET status = 'abandoned' WHERE id = ?").run(mine[0].id);
    await getDb().prepare("UPDATE messages SET created_at = datetime('now', '-30 days') WHERE id = ?").run(tooOld.id);
    recorder();
    const stamp = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
    const done = await retryFailedMessages(ownId, { since: stamp(Date.now() - 3 * 86_400_000), until: stamp(Date.now() + 60_000) });
    expect(done.requeued).toBe(3);
    for (const m of mine) expect((await messageById(m.id))!.status).toBe("queued");
    expect((await messageById(elsewhere.id))!.status).toBe("failed");
    expect((await messageById(tooOld.id))!.status).toBe("failed");
    expect((await messageById(account.id))!.status).not.toBe("queued");
    await drainOutbox(100);
    expect(sent.map((m) => m.recipient)).toEqual(expect.arrayContaining(["bulk0@example.my", "bulk1@example.my", "bulk2@example.my"]));
    // Not another venue's: it is still waiting for its own next try.
    expect((await messageById(elsewhere.id))!.status).toBe("failed");
  });

  it("the route is the venue's own staff's: another venue's manager is refused; the resend is audited; a bad window is refused", async () => {
    down();
    const m = await email("booking_confirmed", "route-bulk@example.my");
    await everythingDue();
    await drainOutbox();
    const made = await createVenue({ name: "Route Bulk Arena", area: "PJ", address: "1", phone: "0312345902" });
    if (!made.ok) throw new Error("venue");
    const cookieFor = async (venue: number, name: string) => {
      const a = await createAdmin({ name, email: `${name.replace(/\W/g, "").toLowerCase()}@bulkroute.test`, password: "a long enough password", venueId: venue });
      if (!a.ok) throw new Error(a.error);
      return `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(a.admin.id)).token}`;
    };
    const post = (cookie: string, body: unknown) =>
      messagesPost(new NextRequest("http://localhost/api/admin/messages", { method: "POST", headers: { cookie, "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body) }));
    const strangers = await cookieFor(made.venue.id, "Stranger Manager");
    expect((await post(strangers, { resendFailed: true, venueId, hours: 24 })).status).toBe(403);
    const own = await cookieFor(venueId, "Own Manager");
    expect((await post(own, { resendFailed: true, venueId, hours: 0 })).status).toBe(400);
    expect((await post(own, { resendFailed: true, venueId, hours: 24 * 90 })).status).toBe(400);
    expect((await post(own, { resendFailed: true, hours: 24 })).status).toBe(400);
    recorder();
    const res = await post(own, { resendFailed: true, venueId, hours: 24 });
    expect(res.status).toBe(200);
    expect((await res.json()).requeued).toBeGreaterThanOrEqual(1);
    expect((await messageById(m.id))!.status).toBe("sent");
    const log = (await getDb().prepare("SELECT action, detail FROM staff_actions WHERE venue_id = ? AND action = 'message.resent' ORDER BY id DESC LIMIT 1").get(venueId)) as { action: string; detail: string };
    expect(log.detail).toContain("all that failed in the last 24 hours");
  });
});

async function bookAhead(date: string, hour: number, to: string) {
  const made = await createBooking({ courtId, date, hours: [hour], name: "Reminder Person", phone: `0161${String(++n).padStart(6, "0")}`, email: to });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE bookings SET created_at = datetime('now', '-9 days') WHERE id = ?").run(made.booking.id);
  return made.booking;
}

/** "Ten hours before" the slot, as the venue's clock (UTC+8) reads it. */
const tenHoursBefore = (date: string, hour: number) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour - 8) - 10 * 3_600_000);
};

describe("G7: a reminder is for one booking at one time", () => {
  it("is not sent for a booking cancelled while the reminder waited for the provider", async () => {
    const date = addDays(todayISO(), 4);
    const b = await bookAhead(date, 20, "gone@example.my");
    expect(await notifyReminders(tenHoursBefore(date, 20))).toBe(1);
    down("SES unavailable");
    await drainOutbox();
    await getDb().prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(b.id);
    await everythingDue();
    recorder();
    await drainOutbox();
    expect(sent.filter((m) => m.kind === "booking_reminder")).toEqual([]);
    const row = (await messagesForBooking(b.id)).find((m) => m.kind === "booking_reminder")!;
    expect(row).toMatchObject({ status: "abandoned", lastError: expect.stringContaining("cancelled") });
  });

  it("is written again for the new time when the booking is moved after the first reminder went; none is written twice for one time", async () => {
    const date = addDays(todayISO(), 3);
    const b = await bookAhead(date, 19, "moved@example.my");
    expect(await notifyReminders(tenHoursBefore(date, 19))).toBe(1);
    // Running it again for the same time writes nothing.
    expect(await notifyReminders(tenHoursBefore(date, 19))).toBe(0);
    recorder();
    await drainOutbox();
    expect(sent.filter((m) => m.kind === "booking_reminder")).toHaveLength(1);

    const later = addDays(date, 2);
    const moved = await rescheduleBooking(b.code, { date: later, start: 19 * 60 }, "customer");
    if (!moved.ok) throw new Error(JSON.stringify(moved));
    expect(await notifyReminders(tenHoursBefore(later, 19))).toBe(1);
    expect(await notifyReminders(tenHoursBefore(later, 19))).toBe(0);
    expect((await messagesForBooking(b.id)).filter((m) => m.kind === "booking_reminder")).toHaveLength(2);
  });

  it("a reminder still waiting when the booking moves says the old time, so it is given up, and the new time's is the one sent", async () => {
    const date = addDays(todayISO(), 3);
    const b = await bookAhead(date, 18, "waiting@example.my");
    expect(await notifyReminders(tenHoursBefore(date, 18))).toBe(1);
    down();
    await drainOutbox();
    const later = addDays(date, 1);
    expect((await rescheduleBooking(b.code, { date: later, start: 18 * 60 }, "customer")).ok).toBe(true);
    expect(await notifyReminders(tenHoursBefore(later, 18))).toBe(1);
    await everythingDue();
    recorder();
    await drainOutbox();
    const reminders = (await messagesForBooking(b.id)).filter((m) => m.kind === "booking_reminder");
    expect(reminders.map((m) => m.status).sort()).toEqual(["abandoned", "sent"]);
    expect(reminders.find((m) => m.status === "abandoned")!.lastError).toContain("moved to another time");
    expect(sent.filter((m) => m.kind === "booking_reminder" && m.bookingId === b.id)).toHaveLength(1);
  });

  it("is not sent once the booking's time has begun", async () => {
    const date = addDays(todayISO(), 3);
    const b = await bookAhead(date, 17, "late@example.my");
    expect(await notifyReminders(tenHoursBefore(date, 17))).toBe(1);
    await getDb().prepare("UPDATE bookings SET starts_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), b.id);
    recorder();
    await drainOutbox();
    expect(sent.filter((m) => m.kind === "booking_reminder")).toEqual([]);
    expect((await messagesForBooking(b.id)).find((m) => m.kind === "booking_reminder")).toMatchObject({ status: "abandoned", lastError: expect.stringContaining("had begun") });
  });
});

describe("G8: the queue's order and consent at send time", () => {
  it("a customer's confirmation is not held behind a venue's campaign to hundreds of people", async () => {
    // Everything already waiting is sent first, so the campaign below is the whole queue.
    recorder();
    for (let i = 0; i < 20; i++) if ((await drainOutbox(100)).sent === 0) break;
    sent.length = 0;
    for (let i = 0; i < 60; i++) await recordConsent({ venueId, email: `fan${i}@example.my`, locale: "en", source: "account", confirmed: true, userId: null });
    expect((await sendCampaign(venueId, null, { subject: "Weekend offer", body: "Half price on Sunday mornings, come and play." })).ok).toBe(true);
    const made = await createBooking({ courtId, date: addDays(todayISO(), 2), hours: [11], name: "Waiting Customer", phone: "0162223333", email: "waiting@example.my" });
    if (!made.ok) throw new Error(made.error);
    await notifyBookingConfirmed([made.booking], "en", null);
    // The queue as the drain reads it: what somebody waits for first, the campaign after.
    const next = await dueMessages(25);
    expect(next[0].kind).toBe("booking_confirmed");
    await drainOutbox(); // one pass: 25 messages
    expect(sent.some((m) => m.kind === "booking_confirmed")).toBe(true);
    expect(sent.filter((m) => m.kind === "campaign").length).toBeLessThanOrEqual(24);
  });

  it("somebody who unsubscribes after the campaign was queued is not sent it, and nor is one whose consent was erased", async () => {
    const [first, second] = (await getDb().prepare("SELECT token, email FROM marketing_consents WHERE venue_id = ? ORDER BY id DESC LIMIT 2").all(venueId)) as { token: string; email: string }[];
    expect(await unsubscribe(first.token)).toBe(true);
    await getDb().prepare("DELETE FROM marketing_consents WHERE token = ?").run(second.token);
    recorder();
    for (let i = 0; i < 6; i++) await drainOutbox();
    expect(sent.filter((m) => m.kind === "campaign" && [first.email, second.email].includes(m.recipient))).toEqual([]);
    const rows = (await getDb().prepare("SELECT status, last_error FROM messages WHERE kind = 'campaign' AND lower(recipient) = ?").all(first.email.toLowerCase())) as { status: string; last_error: string }[];
    expect(rows[0]).toMatchObject({ status: "abandoned", last_error: expect.stringContaining("withdrew") });
    // The rest of the audience still got it.
    expect(sent.filter((m) => m.kind === "campaign").length).toBeGreaterThan(30);
  });
});

describe("G9: the day's limit per recipient and urgent news", () => {
  it("never writes off a venue's cancellation, a move, a waitlist offer, a guardian's notice or a refund notice as 'already 8 messages today'", async () => {
    const to = "busy.customer@example.my";
    for (let i = 0; i < 8; i++) await email("booking_reminder", to);
    const capped = await email("booking_reminder", to);
    expect(await messageById(capped.id)).toMatchObject({ status: "abandoned", lastError: expect.stringContaining("already 8 messages") });
    for (const kind of ["booking_cancelled_by_venue", "booking_moved", "booking_rescheduled", "waitlist_offer", "guardian_notice", "refund_notice", "safeguarding_notice"] as const) {
      const m = await email(kind, to);
      expect(await messageById(m.id), kind).toMatchObject({ status: "queued" });
    }
  });

  it("holds marketing and reminders to the limit as before", async () => {
    const to = "marketed@example.my";
    for (let i = 0; i < 8; i++) await email("campaign", to);
    for (const kind of ["campaign", "booking_reminder", "booking_confirmed", "payment_received"] as const) {
      const m = await email(kind, to);
      expect((await messageById(m.id))!.status, kind).toBe("abandoned");
    }
  });

  it("holds urgent news to a ceiling of its own, configurable, so the site still cannot be used to flood a number", async () => {
    vi.stubEnv("MYSENAM_URGENT_PER_RECIPIENT_PER_DAY", "10");
    expect(urgentPerRecipientPerDay()).toBe(10);
    const to = "flooded@example.my";
    for (let i = 0; i < 10; i++) expect((await email("waitlist_offer", to)).status).toBe("queued");
    const over = await email("waitlist_offer", to);
    expect(await messageById(over.id)).toMatchObject({ status: "abandoned", lastError: expect.stringContaining("10 urgent notices") });
    vi.stubEnv("MYSENAM_URGENT_PER_RECIPIENT_PER_DAY", "3");
    expect(urgentPerRecipientPerDay()).toBe(30);
  });

  it("a given-up urgent notice can be put back by staff past 8 a day; an ordinary one cannot", async () => {
    const to = "resend-cap@example.my";
    const urgent = await email("booking_cancelled_by_venue", to);
    for (let i = 0; i < 8; i++) await email("booking_reminder", to);
    await getDb().prepare("UPDATE messages SET status = 'abandoned' WHERE id = ?").run(urgent.id);
    expect(await retryMessage(urgent.id)).toMatchObject({ ok: true });
    const ordinary = (await getDb().prepare("SELECT id FROM messages WHERE lower(recipient) = ? AND kind = 'booking_reminder' ORDER BY id DESC LIMIT 1").get(to)) as { id: number };
    await getDb().prepare("UPDATE messages SET status = 'abandoned' WHERE id = ?").run(ordinary.id);
    expect(await retryMessage(ordinary.id)).toMatchObject({ ok: false, error: expect.stringContaining("Already 8 messages") });
  });
});
