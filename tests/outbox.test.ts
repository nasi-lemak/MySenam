import { afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import {
  drainOutbox,
  dueMessages,
  listMessages,
  messagesForBooking,
  outboxSummary,
  retryMessage,
  setTransport,
  transportName,
  MAX_ATTEMPTS,
} from "../src/lib/outbox";
import { emailPlayer, messageById } from "../src/lib/outbox";
import { createSession, getSessionUser, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { NextRequest } from "next/server";
import type { OutboxMessage, Transport, Written } from "../src/lib/outbox";
import {
  notifyBookingCancelled,
  notifyBookingConfirmed,
  notifyPendingOffers,
  tickOutbox,
} from "../src/lib/notify";
import {
  cancelBooking,
  createBooking,
  joinSlotWaitlist,
  listVenues,
} from "../src/lib/store";
import { getDb } from "../src/lib/db";
import { setWhatsappMode } from "../src/lib/whatsapp-credit";
import { addDays, todayISO } from "../src/lib/time";

let courtId: number;
let venueId: number;

beforeAll(async () => {
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courtId = venue.courts.find((c) => c.capacity === 1)!.id;
  // These customers give a phone number only: they hear on WhatsApp, which the venue has on.
  await setWhatsappMode(venueId, "all");
});

afterEach(() => setTransport(null));

/** A transport that records what it was given. */
function recorder(): Transport & { sent: OutboxMessage[] } {
  const sent: OutboxMessage[] = [];
  return {
    name: "recorder",
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}

async function book(date: string, hour: number, locale: "en" | "ms" = "en") {
  const made = await createBooking({
    courtId,
    date,
    hours: [hour],
    name: "Nurul Hana",
    phone: "0161234567",
  });
  if (!made.ok) throw new Error(made.error);
  await notifyBookingConfirmed([made.booking], locale, null);
  return made.booking;
}

describe("writing a message down", () => {
  it("queues a confirmation in the language the customer was reading", async () => {
    const booking = await book(addDays(todayISO(), 2), 10, "ms");
    const [message] = await messagesForBooking(booking.id);
    expect(message.kind).toBe("booking_confirmed");
    expect(message.status).toBe("queued");
    expect(message.locale).toBe("ms");
    expect(message.recipient).toBe("0161234567");
    expect(message.body).toContain("tempahan anda telah disahkan");
    expect(message.body).toContain(booking.code);
    // First name only — a message is not a form.
    expect(message.body).toContain("Hai Nurul,");
  });

  it("says it in English for an English customer", async () => {
    const booking = await book(addDays(todayISO(), 2), 11, "en");
    const [message] = await messagesForBooking(booking.id);
    expect(message.body).toContain("your booking is confirmed");
    expect(message.subject).toContain(booking.code);
  });

  it("keeps the text it was written with, not a template", async () => {
    const booking = await book(addDays(todayISO(), 2), 12);
    const [message] = await messagesForBooking(booking.id);
    // Everything needed to read it is in the row.
    expect(message.body).toContain(booking.date);
    expect(message.body).not.toContain("{");
  });

  it("writes a cancellation too", async () => {
    const booking = await book(addDays(todayISO(), 3), 10);
    const cancelled = await cancelBooking(booking.code, booking.phone);
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    await notifyBookingCancelled(cancelled.booking, "en");
    const kinds = (await messagesForBooking(booking.id)).map((m) => m.kind);
    expect(kinds).toContain("booking_cancelled");
  });
});

describe("telling somebody a place opened up", () => {
  it("writes one message per offer, however often the sweep runs", async () => {
    const date = addDays(todayISO(), 4);
    const mine = await book(date, 15);
    const queued = await joinSlotWaitlist({
      courtId,
      date,
      startHour: 15,
      endHour: 16,
      name: "Kumar Selvam",
      phone: "0177778888",
      locale: "ms",
    });
    expect(queued.ok).toBe(true);

    // Nothing is owed until the place is actually free.
    expect(await notifyPendingOffers()).toEqual([]);

    const cancelled = await cancelBooking(mine.code, mine.phone);
    expect(cancelled.ok).toBe(true);

    const first = await notifyPendingOffers();
    expect(first).toHaveLength(1);
    expect(first[0].kind).toBe("waitlist_offer");
    expect(first[0].locale).toBe("ms");
    expect(first[0].recipient).toBe("0177778888");
    expect(first[0].body).toContain("ada tempat kosong untuk");

    // The sweep is idempotent: the offer token is the key.
    expect(await notifyPendingOffers()).toEqual([]);
    expect(await notifyPendingOffers()).toEqual([]);
    const offers = (await listMessages(venueId, 200)).filter((m) => m.kind === "waitlist_offer");
    expect(offers).toHaveLength(1);
  });
});

describe("sending", () => {
  it("does nothing at all until a transport is configured", async () => {
    expect(transportName()).toBe(null);
    const before = (await dueMessages(100)).length;
    expect(before).toBeGreaterThan(0);
    const result = await drainOutbox();
    expect(result).toEqual({ sent: 0, failed: 0, abandoned: 0, transport: null });
    // Still queued, not quietly marked sent.
    expect((await dueMessages(100)).length).toBe(before);
  });

  it("sends what is due and marks it", async () => {
    const post = recorder();
    setTransport(post);
    const due = (await dueMessages(100)).length;
    const result = await drainOutbox(100);
    expect(result.sent).toBe(due);
    expect(post.sent).toHaveLength(due);
    expect(await dueMessages(100)).toEqual([]);
    const sent = (await listMessages(venueId, 200)).filter((m) => m.status === "sent");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0].sentAt).not.toBeNull();
  });

  it("retries with a delay, then gives up rather than spinning", async () => {
    const booking = await book(addDays(todayISO(), 5), 10);
    const [message] = await messagesForBooking(booking.id);
    setTransport({
      name: "broken",
      async send() {
        throw new Error("no route to host");
      },
    });

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      // Each failure pushes the next attempt into the future, so bring it back.
      await getDb()
        .prepare("UPDATE messages SET next_attempt_at = datetime('now') WHERE id = ?")
        .run(message.id);
      await drainOutbox(100);
    }

    const after = (await messagesForBooking(booking.id))[0];
    expect(after.status).toBe("abandoned");
    expect(after.attempts).toBe(MAX_ATTEMPTS);
    expect(after.lastError).toContain("no route to host");
    // An abandoned message stops being due, so it cannot spin forever.
    expect((await dueMessages(100)).map((m) => m.id)).not.toContain(message.id);
  });

  it("sends a message once when two drains run at the same moment", async () => {
    // Booking it writes the confirmation down.
    const b = await book(addDays(todayISO(), 9), 9);
    const ids: number[] = [];
    setTransport({
      name: "slow",
      async send(message) {
        ids.push(message.id);
        await new Promise((r) => setTimeout(r, 20));
      },
    });
    await Promise.all([drainOutbox(100), drainOutbox(100), drainOutbox(100)]);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect((await messagesForBooking(b.id)).every((m) => m.status === "sent")).toBe(true);
  });

  it("lets staff put a bad number right and try again", async () => {
    const abandoned = (await listMessages(venueId, 200)).find((m) => m.status === "abandoned")!;
    const retried = await retryMessage(abandoned.id, "0191112222");
    if (!retried?.ok) throw new Error("retry");
    const again = retried.message;
    expect(again.status).toBe("queued");
    expect(again.recipient).toBe("0191112222");
    expect(again.attempts).toBe(0);
    // Once it has gone, it is not sent again; nor is a number something else.
    expect(await retryMessage(abandoned.id, "not a number")).toMatchObject({ ok: false });

    const post = recorder();
    setTransport(post);
    await drainOutbox(100);
    expect(post.sent.map((m) => m.recipient)).toContain("0191112222");
  });

  it("counts what the venue can see", async () => {
    const summary = await outboxSummary(venueId);
    expect(summary.sent).toBeGreaterThan(0);
    expect(summary.transport).toBe(null);
  });
});

describe("the tick", () => {
  it("catches up on offers and sends in one pass", async () => {
    const post = recorder();
    setTransport(post);
    const date = addDays(todayISO(), 6);
    const mine = await book(date, 15);
    await joinSlotWaitlist({
      courtId,
      date,
      startHour: 15,
      endHour: 16,
      name: "Aisyah binti Rahman",
      phone: "0123334444",
    });
    await cancelBooking(mine.code, mine.phone);

    const result = await tickOutbox();
    expect(result.transport).toBe("recorder");
    expect(post.sent.some((m) => m.kind === "waitlist_offer")).toBe(true);
  });
});

describe("a tournament, league or open-game email", () => {
  it("is queued like any other: in the venue's list, retried when the mail fails, sent once when it works", async () => {
    const made = await registerUser({ name: "Queued Player", email: "queued@player.my", phone: "0128880001", password: "a long enough password" });
    if (!made.ok) throw new Error(made.error);
    await emailPlayer({ venueId, userId: made.user.id, subject: () => "The draw is made: Cup", body: () => "You play first at 9.", link: "https://x.my/tournaments/1" });
    const queued = (await listMessages(venueId)).find((m) => m.kind === "programme" && m.recipient === "queued@player.my")!;
    expect(queued).toMatchObject({ channel: "email", status: "queued", subject: "The draw is made: Cup" });
    expect(queued.body).toContain("Hi Queued,");

    setTransport({
      name: "down",
      async send() {
        throw new Error("mail server down");
      },
    });
    await drainOutbox(100);
    // Failed once, kept to try again later: not lost, not abandoned.
    expect(await messageById(queued.id)).toMatchObject({ status: "failed", attempts: 1, lastError: expect.stringContaining("mail server down") });

    const delivered: number[] = [];
    setTransport({
      name: "up",
      async send(m) {
        delivered.push(m.id);
      },
    });
    await getDb().prepare("UPDATE messages SET next_attempt_at = datetime('now') WHERE id = ?").run(queued.id);
    await Promise.all([drainOutbox(100), drainOutbox(100)]);
    expect(delivered.filter((id) => id === queued.id)).toHaveLength(1);
    expect((await messageById(queued.id))?.status).toBe("sent");
  });
});

describe("a programme email in the player's language", () => {
  const drawMade: { subject: Written; body: Written } = { subject: (tr) => tr("mail.tour.draw.s", { t: "Piala" }), body: (tr) => tr("mail.tour.draw.made", { t: "Piala" }) };
  const latest = async (email: string) =>
    (await getDb().prepare("SELECT subject, body, locale FROM messages WHERE recipient = ? AND kind = 'programme' ORDER BY id DESC").get(email)) as {
      subject: string;
      body: string;
      locale: string;
    };

  it("is written in the language the account last used the site in, greeting and all, and in the install's first before it has one", async () => {
    const made = await registerUser({ name: "Siti Aminah", email: "siti@lang.my", phone: "0128880051", password: "a long enough password" });
    if (!made.ok) throw new Error(made.error);
    // No language yet: the install's first.
    await emailPlayer({ venueId, userId: made.user.id, ...drawMade, link: "https://x.my/t/1" });
    expect(await latest("siti@lang.my")).toMatchObject({ subject: "The draw is made: Piala", locale: "en" });

    // Signed in and using the site in Malay: the account remembers it, and the next email is in Malay.
    const { token } = await createSession(made.user.id);
    const req = new NextRequest("http://localhost/api/my/games", { headers: { cookie: `${SESSION_COOKIE}=${token}; ms_lang=ms` } });
    expect((await getSessionUser(req))?.id).toBe(made.user.id);
    await emailPlayer({ venueId, userId: made.user.id, ...drawMade, link: "https://x.my/t/1" });
    const malay = await latest("siti@lang.my");
    expect(malay).toMatchObject({ subject: "Cabutan telah dibuat: Piala", locale: "ms" });
    expect(malay.body).toMatch(/^Hai Siti,\n\nCabutan untuk Piala telah dibuat\./);

    // Switched to Chinese: followed.
    await getSessionUser(new NextRequest("http://localhost/api/my/games", { headers: { cookie: `${SESSION_COOKIE}=${token}; ms_lang=zh` } }));
    await emailPlayer({ venueId, userId: made.user.id, ...drawMade, link: "https://x.my/t/1" });
    expect(await latest("siti@lang.my")).toMatchObject({ subject: "抽签已完成：Piala", locale: "zh" });
  });

  it("ignores a language the install does not offer, or that is not a language at all", async () => {
    const made = await registerUser({ name: "Arun Kumar", email: "arun@lang.my", phone: "0128880052", password: "a long enough password" });
    if (!made.ok) throw new Error(made.error);
    const { token } = await createSession(made.user.id);
    await getSessionUser(new NextRequest("http://localhost/api/my/games", { headers: { cookie: `${SESSION_COOKIE}=${token}; ms_lang=xx` } }));
    expect(((await getDb().prepare("SELECT locale FROM users WHERE id = ?").get(made.user.id)) as { locale: string | null }).locale).toBeNull();
    // Stored but no longer offered (the install changed its languages): the install's first.
    await getDb().prepare("UPDATE users SET locale = 'fr' WHERE id = ?").run(made.user.id);
    await emailPlayer({ venueId, userId: made.user.id, ...drawMade, link: "https://x.my/t/1" });
    expect(await latest("arun@lang.my")).toMatchObject({ locale: "en", subject: "The draw is made: Piala" });
  });
});
