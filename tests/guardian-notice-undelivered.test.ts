import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { noticeContactGuardians, openNoticeTasks, taskUndeliveredNotices } from "../src/lib/contact-guardians";
import { getDb } from "../src/lib/db";
import { tickOutbox } from "../src/lib/notify";
import { MAX_ATTEMPTS, MESSAGES_PER_RECIPIENT_PER_DAY, recordDelivery, setTransport } from "../src/lib/outbox";
import { createAtVenue, participantHistory } from "../src/lib/participants";
import { phoneNumber } from "../src/lib/phone-check";
import { createVenue } from "../src/lib/store";
import * as attentionRoute from "../src/app/api/admin/attention/route";

/**
 * A WhatsApp notice to a guardian recorded by name and number that never
 * reached them (lib/contact-guardians.ts taskUndeliveredNotices): given up
 * by the outbox (over the day's limit, out of tries) or reported undelivered later, it
 * becomes the venue's task to tell them, as when nothing could be sent at
 * all, once per notice; one that went is no task.
 */

let n = 0;
const phone = () => `0178${String(++n).padStart(6, "0")}`;
let venue: number;
let otherVenue: number;
let manager: { id: number; name: string; cookie: string };
let otherManager: { id: number; name: string; cookie: string };

async function staff(venueId: number, name: string) {
  const made = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}${++n}@undelivered.test`, password: "a long enough password", venueId });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, name, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}

/** A child added at the counter, their mother recorded by name and a number proved to reach her. */
async function walkIn(displayName: string) {
  const mumPhone = phone();
  const made = await createAtVenue({
    venueId: venue,
    admin: { id: manager.id, name: manager.name },
    displayName,
    birthYear: 2015,
    guardian: { name: "Puan Salmah", phone: mumPhone, relationship: "parent", authority: true },
  });
  if (!made.ok) throw new Error(made.error);
  await getDb()
    .prepare("UPDATE participant_guardians SET contact_verified_at = now(), contact_verified_number = ? WHERE id = ?")
    .run(phoneNumber(mumPhone), made.guardianshipId);
  return { id: made.participant.id, mumPhone, guardianshipId: made.guardianshipId };
}

/** Tell the child's guardians of a change (as a new request for them would). */
async function notice(kid: { id: number }, about: number) {
  return noticeContactGuardians(kid.id, "request", { venueId: venue, about, exceptGuardianshipIds: [] });
}

const messageFor = async (mumPhone: string) =>
  (await getDb()
    .prepare("SELECT id, status, provider_id FROM messages WHERE kind = 'guardian_notice' AND phone_key(recipient) = phone_key(?) ORDER BY id DESC LIMIT 1")
    .get(mumPhone)) as { id: number; status: string; provider_id: string | null };

beforeAll(async () => {
  const make = async (name: string, ph: string) => {
    const v = await createVenue({ name, area: "Setapak", address: "x", phone: ph, openMin: 7 * 60, closeMin: 23 * 60 });
    if (!v.ok) throw new Error("venue");
    return v.venue.id;
  };
  venue = await make("Notice Centre", "0312350801");
  otherVenue = await make("Elsewhere Notice", "0312350802");
  manager = await staff(venue, "Mira Manager");
  otherManager = await staff(otherVenue, "Oki Other");
});

function whatsappOn() {
  vi.stubEnv("WHATSAPP_TOKEN", "test-token");
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "1");
}

afterEach(() => {
  vi.unstubAllEnvs();
  setTransport(null);
});

describe("a guardian notice that did not reach the guardian", () => {
  it("given up at once, over the day's limit for that number: the venue's task, once, closed by staff", async () => {
    whatsappOn();
    const kid = await walkIn("Aina");
    const sends: string[] = [];
    setTransport({ name: "test", send: async (m) => void sends.push(m.recipient) });
    // That number has had the day's messages already.
    for (let i = 0; i < MESSAGES_PER_RECIPIENT_PER_DAY; i++)
      await getDb()
        .prepare("INSERT INTO messages (venue_id, kind, channel, recipient, locale, body, status) VALUES (?, 'booking_confirmation', 'whatsapp', ?, 'en', 'x', 'sent')")
        .run(venue, kid.mumPhone);
    expect(await notice(kid, 9001)).toBe(1);
    expect((await messageFor(kid.mumPhone)).status).toBe("abandoned");
    // The venue's task straight away, not at the next look.
    expect(await openNoticeTasks([venue], [kid.id])).toHaveLength(1);
    await tickOutbox();
    expect(sends).toEqual([]);
    const tasks = await openNoticeTasks([venue], [kid.id]);
    expect(tasks).toEqual([expect.objectContaining({ guardianName: "Puan Salmah", change: "request", why: "not_delivered", venueId: venue })]);
    expect(
      await getDb().prepare("SELECT message_id FROM guardian_notice_tasks WHERE id = ?").get(tasks[0].id)
    ).toEqual({ message_id: (await messageFor(kid.mumPhone)).id });
    // However often it looks again: one task.
    expect(await taskUndeliveredNotices()).toBe(0);
    await tickOutbox();
    expect(await openNoticeTasks([venue], [kid.id])).toHaveLength(1);
    expect((await participantHistory(kid.id)).map((e) => e.action)).toContain("guardian.notice_undelivered");
    // Another venue's staff neither see it nor close it; this venue's do.
    const other = await attentionRoute.POST(
      new NextRequest("http://localhost/api/admin/attention", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: otherManager.cookie },
        body: JSON.stringify({ action: "guardianTold", taskId: tasks[0].id, how: "told" }),
      })
    );
    expect(other.status).toBe(404);
    const done = await attentionRoute.POST(
      new NextRequest("http://localhost/api/admin/attention", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: manager.cookie },
        body: JSON.stringify({ action: "guardianTold", taskId: tasks[0].id, how: "told" }),
      })
    );
    expect(done.status).toBe(200);
    expect(await openNoticeTasks([venue], [kid.id])).toEqual([]);
    // Closed stays closed: looking again makes no new one for that notice.
    await tickOutbox();
    expect(await openNoticeTasks([venue], [kid.id])).toEqual([]);
  });

  it("given up after its last try at the gateway: a task; one queued or sent: none", async () => {
    whatsappOn();
    const failing = await walkIn("Badrul");
    const fine = await walkIn("Citra");
    setTransport({
      name: "test",
      send: async (m) => {
        if (phoneNumber(m.recipient) === phoneNumber(failing.mumPhone)) throw new Error("WhatsApp: recipient not reachable");
        return { providerId: `wamid.${m.id}` };
      },
    });
    await notice(failing, 9002);
    await notice(fine, 9003);
    // Queued, not yet given up: no task.
    expect(await taskUndeliveredNotices()).toBe(0);
    // The failing one on its last try.
    await getDb().prepare("UPDATE messages SET attempts = ? WHERE id = ?").run(MAX_ATTEMPTS - 1, (await messageFor(failing.mumPhone)).id);
    await tickOutbox();
    expect((await messageFor(failing.mumPhone)).status).toBe("abandoned");
    expect((await messageFor(fine.mumPhone)).status).toBe("sent");
    expect(await openNoticeTasks([venue], [failing.id])).toEqual([expect.objectContaining({ why: "not_delivered", change: "request" })]);
    expect(await openNoticeTasks([venue], [fine.id])).toEqual([]);
  });

  it("sent, then reported undelivered by WhatsApp: a task", async () => {
    whatsappOn();
    const kid = await walkIn("Dahlia");
    setTransport({ name: "test", send: async (m) => ({ providerId: `wamid.d${m.id}` }) });
    await notice(kid, 9004);
    await tickOutbox();
    const sent = await messageFor(kid.mumPhone);
    expect(sent.status).toBe("sent");
    expect(await openNoticeTasks([venue], [kid.id])).toEqual([]);
    expect(await recordDelivery({ id: sent.provider_id!, status: "failed", error: "Not a WhatsApp number" })).toBe(true);
    await tickOutbox();
    expect(await openNoticeTasks([venue], [kid.id])).toEqual([expect.objectContaining({ why: "not_delivered" })]);
  });

  it("for a guardian whose relationship has since ended: no task", async () => {
    whatsappOn();
    const kid = await walkIn("Elina");
    setTransport({
      name: "test",
      send: async () => {
        throw new Error("WhatsApp: recipient not reachable");
      },
    });
    await notice(kid, 9005);
    await getDb().prepare("UPDATE messages SET attempts = ? WHERE id = ?").run(MAX_ATTEMPTS - 1, (await messageFor(kid.mumPhone)).id);
    await getDb().prepare("UPDATE participant_guardians SET revoked_at = now() WHERE id = ?").run(kid.guardianshipId);
    await tickOutbox();
    expect((await messageFor(kid.mumPhone)).status).toBe("abandoned");
    expect(await getDb().prepare("SELECT COUNT(*)::int AS n FROM guardian_notice_tasks WHERE participant_id = ?").get(kid.id)).toEqual({ n: 0 });
  });
});
