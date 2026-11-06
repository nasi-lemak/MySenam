import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { authenticateAdmin, createAdmin } from "../src/lib/admin-auth";
import { authenticate, registerUser } from "../src/lib/auth";
import { getDb, transactionStats } from "../src/lib/db";
import { processResetRequests, requestReset, settleResetRequests } from "../src/lib/password-reset";
import { requestRegistration, settleRegistrationRequests } from "../src/lib/registration";

/**
 * How long signing in or asking for a password reset takes must not say
 * whether an account holds the address (the owner's decision of 27 October
 * 2026; docs/architecture/security.md#no-account-enumeration).
 *
 * Measured in this container before the change, as medians of 15 tries:
 * signing in with a wrong password 73–84 ms, with an unknown address
 * 1.1–1.3 ms (about 65 times faster); asking for a reset for an account
 * 17.8–18.3 ms, for no account 0.8 ms (about 23 times faster). After it:
 * 41.0 and 43.2 ms signing in, 0.91 and 0.93 ms asking for a reset. The bounds
 * below are generous so a busy machine does not fail them: the unknown path
 * may not be more than three times faster than the known one, plus a few
 * milliseconds' slack, which the old code failed by far.
 */

const TRIES = 11;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function took(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

/** The same calls taken in turn, so a slower moment on the machine falls on both. */
async function race(known: () => Promise<unknown>, unknown: (i: number) => Promise<unknown>, between?: () => Promise<unknown>) {
  const a: number[] = [];
  const b: number[] = [];
  // Once each first, so nothing measured pays for warming up.
  await known();
  await unknown(-1);
  await between?.();
  for (let i = 0; i < TRIES; i++) {
    a.push(await took(known));
    await between?.();
    b.push(await took(() => unknown(i)));
    await between?.();
  }
  return { known: median(a), unknown: median(b) };
}

beforeAll(async () => {
  const made = await registerUser({ name: "Timed Person", email: "timed@timing.my", phone: "0123334444", password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  // An account made with Google has no password: it must not answer faster either.
  await getDb().prepare("INSERT INTO users (name, email, phone, password_hash) VALUES ('Google Person', 'google@timing.my', '0123335555', '')").run();
  const admin = await createAdmin({ name: "Timed Staff", email: "staff@timing.my", password: "a long enough password", venueId: null });
  if (!admin.ok) throw new Error(admin.error);
});

describe("signing in", () => {
  it("takes about as long for an unknown address as for a wrong password", async () => {
    const t = await race(
      () => authenticate("timed@timing.my", "not the password"),
      (i) => authenticate(`nobody${i}@timing.my`, "not the password")
    );
    expect(t.known).toBeLessThan(3 * t.unknown + 5);
    expect(await authenticate("nobody@timing.my", "x")).toBeNull();
    expect(await authenticate("timed@timing.my", "a long enough password")).toMatchObject({ email: "timed@timing.my" });
  }, 60_000);

  it("takes about as long for an account without a password", async () => {
    const t = await race(
      () => authenticate("timed@timing.my", "not the password"),
      () => authenticate("google@timing.my", "not the password")
    );
    expect(t.known).toBeLessThan(3 * t.unknown + 5);
    expect(await authenticate("google@timing.my", "")).toBeNull();
  }, 60_000);

  it("takes about as long for staff with an unknown address", async () => {
    const t = await race(
      () => authenticateAdmin("staff@timing.my", "not the password"),
      (i) => authenticateAdmin(`nobody${i}@timing.my`, "not the password")
    );
    expect(t.known).toBeLessThan(3 * t.unknown + 5);
    expect(await authenticateAdmin("staff@timing.my", "a long enough password")).toMatchObject({ email: "staff@timing.my" });
  }, 60_000);
});

describe("asking for a password reset", () => {
  const forget = () => getDb().prepare("DELETE FROM password_resets").run();

  it("does the same awaited work whether or not an account holds the address", async () => {
    await settleResetRequests();
    const counted = async (email: string) => {
      const before = transactionStats().queries;
      const answer = await requestReset("user", email);
      // Read on the turn the reply comes back, before the background work (which starts on the next) can add a statement.
      const statements = transactionStats().queries - before;
      await settleResetRequests();
      return { answer, statements };
    };
    await forget();
    const known = await counted("timed@timing.my");
    const unknown = await counted("nobody-reset@timing.my");
    // The reply: the same answer, one statement (the request written down; finding the account, making the link and
    // queuing the email are not among the awaited work), either way. What the background work did is checked below, once settled.
    expect(known).toEqual({ answer: { ok: true }, statements: 1 });
    expect(unknown).toEqual(known);
    // Afterwards, the account's address has its link; the other has nothing.
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE recipient = 'timed@timing.my'").get()) as { n: number }).toEqual({ n: 1 });
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE recipient = 'nobody-reset@timing.my'").get()) as { n: number }).toEqual({ n: 0 });
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM password_reset_requests").get()) as { n: number }).toEqual({ n: 0 });
  });

  it("takes about as long either way", async () => {
    await forget();
    const t = await race(
      () => requestReset("user", "timed@timing.my"),
      (i) => requestReset("user", `nobody-reset${i}@timing.my`),
      async () => {
        await settleResetRequests();
        await forget();
      }
    );
    expect(t.known).toBeLessThan(3 * t.unknown + 3);
  }, 60_000);

  it("drops a request not worked through within a link's life, and the scheduler works through the rest", async () => {
    await settleResetRequests();
    await forget();
    await getDb()
      .prepare("INSERT INTO password_reset_requests (kind, email, locale, created_at) VALUES ('user', 'timed@timing.my', 'en', datetime('now', '-31 minutes'))")
      .run();
    expect(await processResetRequests()).toBe(0);
    await getDb().prepare("INSERT INTO password_reset_requests (kind, email, locale) VALUES ('user', 'timed@timing.my', 'en')").run();
    expect(await processResetRequests()).toBe(1);
    expect(await processResetRequests()).toBe(0);
  });
});

describe("asking to sign up", () => {
  // Each address may be sent only a few emails an hour; what is measured here is the reply, not the email.
  const forget = () => getDb().prepare("DELETE FROM registration_links").run();

  it("does the same awaited work for an account's address, a new one and one with a link already out", async () => {
    await settleRegistrationRequests();
    await forget();
    await requestRegistration("pending-signup@timing.my");
    await settleRegistrationRequests();
    const mails = async (email: string) => ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE recipient = ?").get(email)) as { n: number }).n;
    const counted = async (email: string) => {
      const had = await mails(email);
      const before = transactionStats().queries;
      const answer = await requestRegistration(email);
      const statements = transactionStats().queries - before;
      const queued = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM registration_requests WHERE email = ?").get(email)) as { n: number };
      const messages = (await mails(email)) - had;
      await settleRegistrationRequests();
      return { answer, statements, queued: queued.n, messages };
    };
    const known = await counted("timed@timing.my");
    const unknown = await counted("nobody-signup@timing.my");
    const pending = await counted("pending-signup@timing.my");
    // The reply: the same answer, one statement (the request written down), nothing sent yet, whichever address.
    expect(known).toEqual({ answer: { ok: true }, statements: 1, queued: 1, messages: 0 });
    expect(unknown).toEqual(known);
    expect(pending).toEqual(known);
    // Afterwards: the account's address is told it has one, the others are sent a link.
    const subjects = async (email: string) =>
      ((await getDb().prepare("SELECT subject FROM messages WHERE recipient = ? AND subject NOT LIKE 'Set a new password%' ORDER BY id").all(email)) as { subject: string }[]).map(
        (m) => m.subject
      );
    expect(await subjects("timed@timing.my")).toEqual(["You already have a MySenam account"]);
    expect(await subjects("nobody-signup@timing.my")).toEqual(["Finish creating your MySenam account"]);
    expect(await subjects("pending-signup@timing.my")).toEqual(["Finish creating your MySenam account", "Finish creating your MySenam account"]);
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM registration_requests").get()) as { n: number }).toEqual({ n: 0 });
  });

  it("takes about as long either way", async () => {
    await settleRegistrationRequests();
    await forget();
    const between = async () => {
      await settleRegistrationRequests();
      await forget();
    };
    const t = await race(
      () => requestRegistration("timed@timing.my"),
      (i) => requestRegistration(`nobody-signup${i}@timing.my`),
      between
    );
    expect(t.known).toBeLessThan(3 * t.unknown + 3);
    // Nor is an account's address answered faster, though no link is made for it.
    expect(t.unknown).toBeLessThan(3 * t.known + 3);
  }, 60_000);
});
