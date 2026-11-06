import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

// One preparatory step of the outbox tick fails every time (a poison row it cannot work through), and so does another.
vi.mock("../src/lib/password-reset", async (orig) => ({
  ...((await orig()) as object),
  processResetRequests: async () => {
    throw new Error("poison reset request");
  },
}));
vi.mock("../src/lib/registration", async (orig) => ({
  ...((await orig()) as object),
  processRegistrationRequests: async () => {
    throw new Error("poison sign-up request");
  },
}));

import { getDb } from "../src/lib/db";
import { tickOutbox } from "../src/lib/notify";
import { enqueue, messageById, setTransport, type OutboxMessage } from "../src/lib/outbox";
import { listVenues } from "../src/lib/store";

/**
 * Audit 9, G10: `tickOutbox` runs preparatory steps before it drains. One that fails (a malformed row) used to stop every message on the
 * install and fail every route that awaited the tick after its own work was done. Each step is now on its own: logged, raised to the
 * owners, and the drain always runs.
 */
let venueId: number;
const sent: OutboxMessage[] = [];

beforeAll(async () => {
  venueId = (await listVenues())[0].id;
});
afterEach(() => {
  setTransport(null);
  sent.length = 0;
  vi.restoreAllMocks();
});

describe("tickOutbox when preparatory steps fail", () => {
  it("still sends what is waiting, does not throw, and raises an alert for each failing step", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setTransport({
      name: "recorder",
      async send(m) {
        sent.push(m);
      },
    });
    const m = await enqueue({
      venueId,
      kind: "booking_confirmed",
      channel: "email",
      recipient: "waiting@example.my",
      subject: "msg.reminderSubject",
      body: "msg.reminder",
      vars: { name: "B", code: "W", where: "c", when: "w", link: "l" },
    });
    const drained = await tickOutbox();
    expect((await messageById(m.id))!.status).toBe("sent");
    expect(drained.sent).toBeGreaterThanOrEqual(1);
    expect(log.mock.calls.some((c) => String(c[0]).includes('"password-resets" failed'))).toBe(true);
    const keys = ((await getDb().prepare("SELECT key FROM system_alerts WHERE key LIKE 'outbox-step:%' ORDER BY key").all()) as { key: string }[]).map((r) => r.key);
    expect(keys).toEqual(["outbox-step:password-resets", "outbox-step:sign-ups"]);
  });

  it("keeps draining on every later tick while the step still fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setTransport({
      name: "recorder",
      async send(m) {
        sent.push(m);
      },
    });
    for (const code of ["A", "B"]) {
      await enqueue({
        venueId,
        kind: "booking_confirmed",
        channel: "email",
        recipient: `later${code}@example.my`,
        subject: "msg.reminderSubject",
        body: "msg.reminder",
        vars: { name: "B", code, where: "c", when: "w", link: "l" },
      });
      await tickOutbox();
    }
    expect(sent.map((m) => m.recipient)).toEqual(expect.arrayContaining(["laterA@example.my", "laterB@example.my"]));
  });
});
