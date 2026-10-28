import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { tellOwnersEach, tellVenueStaffEach } from "../src/lib/owner-alerts";
import { drainOutbox, listPlatformMessages, MESSAGES_PER_RECIPIENT_PER_DAY, retryMessage, setTransport, type OutboxMessage } from "../src/lib/outbox";
import { requestReset, settleResetRequests } from "../src/lib/password-reset";
import { listVenues } from "../src/lib/store";
import { GET as listRoute, POST as retryRoute } from "../src/app/api/admin/messages/route";

/**
 * Emails that belong to no venue's customers — to people applying to list a
 * venue, password reset links, alerts to the platform's owners and a venue's
 * staff — go through the outbox like every other message (known
 * limitations S11): retried when the mail server is down, listed with how
 * they went, and never sent once what they carry has run out.
 */

const sent: OutboxMessage[] = [];
let down = false;
let n = 0;

const db = () => getDb();
const row = async (id: number) =>
  (await db().prepare("SELECT status, attempts, body, last_error, venue_id FROM messages WHERE id = ?").get(id)) as {
    status: string;
    attempts: number;
    body: string;
    last_error: string | null;
    venue_id: number | null;
  };
/** Due now, as if the backoff had passed. */
const dueNow = () => db().prepare("UPDATE messages SET next_attempt_at = datetime('now', '-1 minutes') WHERE status IN ('queued', 'failed')").run();

beforeAll(async () => {
  await ensureBootstrapAdmin();
  setTransport({
    name: "test",
    send: async (m) => {
      if (down) throw new Error("connect ECONNREFUSED smtp");
      sent.push(m);
    },
  });
});

afterEach(() => {
  down = false;
  sent.length = 0;
});

describe("an alert to the platform's owners", () => {
  it("is queued for each owner, waits out a mail server that is down, and goes once it is back", async () => {
    down = true;
    await tellOwnersEach(() => ({ subject: "Courts piled up at Hall X", body: "Hall X added 40 courts today." }));
    const queued = (await db().prepare("SELECT id FROM messages WHERE kind = 'staff_alert' AND subject = 'Courts piled up at Hall X'").all()) as { id: number }[];
    expect(queued.length).toBeGreaterThan(0);
    const id = queued[0].id;
    expect((await row(id)).venue_id).toBeNull();
    await drainOutbox();
    expect(await row(id)).toMatchObject({ status: "failed", attempts: 1, last_error: expect.stringContaining("ECONNREFUSED") });

    down = false;
    await dueNow();
    await drainOutbox();
    expect(await row(id)).toMatchObject({ status: "sent", attempts: 2 });
    expect(sent.filter((m) => m.id === id)).toHaveLength(1);
    // Drained again: not sent twice.
    await dueNow();
    await drainOutbox();
    expect(sent.filter((m) => m.id === id)).toHaveLength(1);
  });

  it("is not held to the daily limit per recipient that protects customers", async () => {
    for (let i = 0; i < MESSAGES_PER_RECIPIENT_PER_DAY + 3; i++) {
      const subject = `Alert ${i} ${++n}`;
      await tellOwnersEach(() => ({ subject, body: "Something to know." }));
    }
    const owner = (await listAdmins()).find((a) => a.venueId === null && a.businessId === null)!;
    const abandoned = (await db()
      .prepare("SELECT COUNT(*)::int AS n FROM messages WHERE kind = 'staff_alert' AND recipient = ? AND status = 'abandoned'")
      .get(owner.email)) as { n: number };
    expect(abandoned.n).toBe(0);
  });

  it("to a venue's staff is that venue's, seen with its other messages", async () => {
    const venue = (await listVenues())[0];
    const desk = await createAdmin({ name: "Desk", email: `desk${++n}@alerts.my`, password: "desk-password", venueId: venue.id });
    if (!desk.ok) throw new Error(desk.error);
    await tellVenueStaffEach(venue.id, () => ({ subject: "Your venue is suspended", body: "Reason given." }));
    const m = (await db().prepare("SELECT venue_id FROM messages WHERE recipient = ? AND kind = 'staff_alert'").get(desk.admin.email)) as { venue_id: number };
    expect(m.venue_id).toBe(venue.id);
  });
});

describe("a password reset link", () => {
  async function resetFor() {
    const email = `reset${++n}@platform.my`;
    const made = await registerUser({ name: "Reset Person", email, phone: `0187${String(n).padStart(6, "0")}`, password: "a long enough password" });
    if (!made.ok) throw new Error(made.error);
    await requestReset("user", email);
    // Worked through after the reply, as is its first try at sending: wait for both.
    await settleResetRequests();
    const { id } = (await db().prepare("SELECT id FROM messages WHERE recipient = ? AND kind = 'account_email' ORDER BY id DESC").get(email)) as { id: number };
    // It is tried at once, in the background (the reply does not wait for it): wait for that try.
    for (let i = 0; i < 200 && (await row(id)).attempts === 0 && (await row(id)).status === "queued"; i++) await new Promise((r) => setTimeout(r, 10));
    return { id };
  }

  it("is sent, and then its link is not kept", async () => {
    const { id } = await resetFor();
    const sentOne = sent.find((m) => m.id === id)!;
    expect(sentOne.body).toMatch(/reset-password\?kind=user&token=/);
    const kept = await row(id);
    expect(kept.status).toBe("sent");
    expect(kept.body).not.toMatch(/token=/);
  });

  it("is given up, never sent, once the link has run out; and is not sent again to anybody", async () => {
    down = true;
    const { id } = await resetFor();
    expect((await row(id)).status).toBe("failed");
    // The mail server is back only after the link stopped working.
    down = false;
    await db().prepare("UPDATE messages SET expires_at = datetime('now', '-1 minutes') WHERE id = ?").run(id);
    await dueNow();
    await drainOutbox();
    expect(sent.find((m) => m.id === id)).toBeUndefined();
    const given = await row(id);
    expect(given.status).toBe("abandoned");
    expect(given.last_error).toMatch(/ran out/);
    expect(given.body).not.toMatch(/token=/);
    // Staff cannot put it back in the queue, to the same address or another.
    expect(await retryMessage(id)).toMatchObject({ ok: false });
    expect(await retryMessage(id, "someone.else@example.com")).toMatchObject({ ok: false });
  });

  it("does not keep its link even when the server dies straight after recording it sent", async () => {
    down = true;
    const { id } = await resetFor();
    down = false;
    await dueNow();
    // Any statement after the one saying it went fails, as if the process stopped there.
    const real = db().prepare.bind(db());
    let recorded = false;
    const spy = vi.spyOn(db(), "prepare").mockImplementation((sql: string) => {
      if (recorded && /UPDATE messages/.test(sql)) throw new Error("server stopped");
      if (/status = 'sent'/.test(sql)) recorded = true;
      return real(sql);
    });
    try {
      await drainOutbox().catch(() => undefined);
    } finally {
      spy.mockRestore();
    }
    expect(sent.find((m) => m.id === id)).toBeDefined();
    const kept = await row(id);
    expect(kept.status).toBe("sent");
    expect(kept.body).not.toMatch(/token=/);
  });

  it("is never shown in the owners' list, only that it went", async () => {
    const { id } = await resetFor();
    const listed = (await listPlatformMessages()).find((m) => m.id === id)!;
    expect(listed.kind).toBe("account_email");
    expect(listed.body).not.toMatch(/token=/);
  });
});

describe("who sees the platform's own messages", () => {
  it("the owners do; a venue's staff do not, and cannot resend them", async () => {
    const seen = `Seen by owners ${++n}`;
    await tellOwnersEach(() => ({ subject: seen, body: "x" }));
    const owner = (await listAdmins()).find((a) => a.venueId === null && a.businessId === null)!;
    const ownerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
    const venue = (await listVenues())[0];
    const desk = await createAdmin({ name: "Desk", email: `desk${++n}@platform.my`, password: "desk-password", venueId: venue.id });
    if (!desk.ok) throw new Error(desk.error);
    const deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    const get = (cookie: string) => listRoute(new NextRequest("http://localhost/api/admin/messages?platform=1", { headers: { cookie } }));

    const asOwner = await get(ownerCookie);
    expect(asOwner.status).toBe(200);
    const { messages } = (await asOwner.json()) as { messages: OutboxMessage[] };
    expect(messages.some((m) => m.subject?.startsWith("Seen by owners"))).toBe(true);
    expect((await get(deskCookie)).status).toBe(403);

    const platformId = messages[0].id;
    const resend = await retryRoute(
      new NextRequest("http://localhost/api/admin/messages", {
        method: "POST",
        headers: { cookie: deskCookie, "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ id: platformId }),
      })
    );
    expect(resend.status).toBe(403);
  });
});
