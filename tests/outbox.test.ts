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
import type { OutboxMessage, Transport } from "../src/lib/outbox";
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
import { addDays, todayISO } from "../src/lib/time";

let courtId: number;
let venueId: number;

beforeAll(() => {
  const venue = listVenues()[0];
  venueId = venue.id;
  courtId = venue.courts.find((c) => c.capacity === 1)!.id;
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

function book(date: string, hour: number, locale: "en" | "ms" = "en") {
  const made = createBooking({
    courtId,
    date,
    hours: [hour],
    name: "Nurul Hana",
    phone: "0161234567",
  });
  if (!made.ok) throw new Error(made.error);
  notifyBookingConfirmed([made.booking], locale, null);
  return made.booking;
}

describe("writing a message down", () => {
  it("queues a confirmation in the language the customer was reading", () => {
    const booking = book(addDays(todayISO(), 2), 10, "ms");
    const [message] = messagesForBooking(booking.id);
    expect(message.kind).toBe("booking_confirmed");
    expect(message.status).toBe("queued");
    expect(message.locale).toBe("ms");
    expect(message.recipient).toBe("0161234567");
    expect(message.body).toContain("tempahan anda telah disahkan");
    expect(message.body).toContain(booking.code);
    // First name only — a message is not a form.
    expect(message.body).toContain("Hai Nurul,");
  });

  it("says it in English for an English customer", () => {
    const booking = book(addDays(todayISO(), 2), 11, "en");
    const [message] = messagesForBooking(booking.id);
    expect(message.body).toContain("your booking is confirmed");
    expect(message.subject).toContain(booking.code);
  });

  it("keeps the text it was written with, not a template", () => {
    const booking = book(addDays(todayISO(), 2), 12);
    const [message] = messagesForBooking(booking.id);
    // Everything needed to read it is in the row.
    expect(message.body).toContain(booking.date);
    expect(message.body).not.toContain("{");
  });

  it("writes a cancellation too", () => {
    const booking = book(addDays(todayISO(), 3), 10);
    const cancelled = cancelBooking(booking.code, booking.phone);
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    notifyBookingCancelled(cancelled.booking, "en");
    const kinds = messagesForBooking(booking.id).map((m) => m.kind);
    expect(kinds).toContain("booking_cancelled");
  });
});

describe("telling somebody a place opened up", () => {
  it("writes one message per offer, however often the sweep runs", () => {
    const date = addDays(todayISO(), 4);
    const mine = book(date, 15);
    const queued = joinSlotWaitlist({
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
    expect(notifyPendingOffers()).toEqual([]);

    const cancelled = cancelBooking(mine.code, mine.phone);
    expect(cancelled.ok).toBe(true);

    const first = notifyPendingOffers();
    expect(first).toHaveLength(1);
    expect(first[0].kind).toBe("waitlist_offer");
    expect(first[0].locale).toBe("ms");
    expect(first[0].recipient).toBe("0177778888");
    expect(first[0].body).toContain("ada tempat kosong untuk");

    // The sweep is idempotent: the offer token is the key.
    expect(notifyPendingOffers()).toEqual([]);
    expect(notifyPendingOffers()).toEqual([]);
    const offers = listMessages(venueId, 200).filter((m) => m.kind === "waitlist_offer");
    expect(offers).toHaveLength(1);
  });
});

describe("sending", () => {
  it("does nothing at all until a transport is configured", async () => {
    expect(transportName()).toBe(null);
    const before = dueMessages(100).length;
    expect(before).toBeGreaterThan(0);
    const result = await drainOutbox();
    expect(result).toEqual({ sent: 0, failed: 0, abandoned: 0, transport: null });
    // Still queued, not quietly marked sent.
    expect(dueMessages(100).length).toBe(before);
  });

  it("sends what is due and marks it", async () => {
    const post = recorder();
    setTransport(post);
    const due = dueMessages(100).length;
    const result = await drainOutbox(100);
    expect(result.sent).toBe(due);
    expect(post.sent).toHaveLength(due);
    expect(dueMessages(100)).toEqual([]);
    const sent = listMessages(venueId, 200).filter((m) => m.status === "sent");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0].sentAt).not.toBeNull();
  });

  it("retries with a delay, then gives up rather than spinning", async () => {
    const booking = book(addDays(todayISO(), 5), 10);
    const [message] = messagesForBooking(booking.id);
    setTransport({
      name: "broken",
      async send() {
        throw new Error("no route to host");
      },
    });

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      // Each failure pushes the next attempt into the future, so bring it back.
      getDb()
        .prepare("UPDATE messages SET next_attempt_at = datetime('now') WHERE id = ?")
        .run(message.id);
      await drainOutbox(100);
    }

    const after = messagesForBooking(booking.id)[0];
    expect(after.status).toBe("abandoned");
    expect(after.attempts).toBe(MAX_ATTEMPTS);
    expect(after.lastError).toContain("no route to host");
    // An abandoned message stops being due, so it cannot spin forever.
    expect(dueMessages(100).map((m) => m.id)).not.toContain(message.id);
  });

  it("lets staff put a bad number right and try again", async () => {
    const abandoned = listMessages(venueId, 200).find((m) => m.status === "abandoned")!;
    const again = retryMessage(abandoned.id, "0191112222");
    expect(again?.status).toBe("queued");
    expect(again?.recipient).toBe("0191112222");
    expect(again?.attempts).toBe(0);

    const post = recorder();
    setTransport(post);
    await drainOutbox(100);
    expect(post.sent.map((m) => m.recipient)).toContain("0191112222");
  });

  it("counts what the venue can see", () => {
    const summary = outboxSummary(venueId);
    expect(summary.sent).toBeGreaterThan(0);
    expect(summary.transport).toBe(null);
  });
});

describe("the tick", () => {
  it("catches up on offers and sends in one pass", async () => {
    const post = recorder();
    setTransport(post);
    const date = addDays(todayISO(), 6);
    const mine = book(date, 15);
    joinSlotWaitlist({
      courtId,
      date,
      startHour: 15,
      endHour: 16,
      name: "Aisyah binti Rahman",
      phone: "0123334444",
    });
    cancelBooking(mine.code, mine.phone);

    const result = await tickOutbox();
    expect(result.transport).toBe("recorder");
    expect(post.sent.some((m) => m.kind === "waitlist_offer")).toBe(true);
  });
});
