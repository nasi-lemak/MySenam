import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import {
  ANONYMOUS,
  eraseCustomer,
  exportCustomerData,
  pruneIfDue,
  pruneOldData,
  RETENTION,
  retentionDue,
  retentionLastRun,
} from "../src/lib/privacy";
import { registerUser } from "../src/lib/auth";
import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import {
  createBooking,
  issuePass,
  joinSlotWaitlist,
  listVenues,
  sellMembership,
  topUpWallet,
  voidPass,
} from "../src/lib/store";
import { getDb } from "../src/lib/db";
import { addDays, todayISO } from "../src/lib/time";

const VENUE = async () => (await listVenues())[0];
let adminId: number;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = (await listAdmins())[0].id;
});

async function customer(email: string, phone: string, name = "Data Subject") {
  const made = await registerUser({ name, email, phone, password: "correct horse battery" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

async function book(phone: string, date: string, hour: number, userId?: number) {
  const made = await createBooking({
    courtId: (await VENUE()).courts[0].id,
    date,
    hours: [hour],
    name: "Data Subject",
    phone,
    userId,
  });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
}

/** Push a row's timestamp into the past, the way a year of trading would. */
async function age(sql: string, ...args: unknown[]) {
  await getDb().prepare(sql).run(...args);
}

describe("showing somebody what is held about them", () => {
  it("gathers everything filed against the account and the phone number", async () => {
    const user = await customer("export@example.com", "0195000001");
    const booking = await book("0195000001", addDays(todayISO(), 3), 9, user.id);
    await topUpWallet({ userId: user.id, amount: 50, adminId, reason: "Counter top-up" });
    const pass = await issuePass({
      venueId: (await VENUE()).id,
      name: "10 hours",
      entries: 10,
      price: 150,
      holderName: "Data Subject",
      holderPhone: "0195000001",
      expiresOn: addDays(todayISO(), 90),
      adminId,
    });

    const dump = (await exportCustomerData(user.id))!;
    expect(dump.account.email).toBe("export@example.com");
    expect(dump.bookings.map((b) => (b as { code: string }).code)).toContain(booking.code);
    expect(dump.wallet.balance).toBe(50);
    expect(dump.wallet.entries).toHaveLength(1);
    expect(dump.takenAt).not.toBe("");
    // A pass sold across a counter is filed against a number, not this login,
    // so it is not in the file — and the file says so rather than pretending
    // to be complete.
    expect(dump.passes).toHaveLength(0);
    expect(dump.heldAtACounter).toContain("Ask the venue");
    expect(pass.ok).toBe(true);
  });

  it("does not leak a password hash", async () => {
    const user = await customer("hash@example.com", "0195000002");
    expect(JSON.stringify(await exportCustomerData(user.id))).not.toContain("password");
  });

  it("returns nothing for an account that is gone", async () => {
    expect(await exportCustomerData(999_999)).toBeNull();
  });
});

describe("a phone number is not proof of identity", () => {
  it("does not hand somebody else's history to whoever registers their number", async () => {
    const SHARED = "0195000099";
    // A walk-in books at the counter. No account, just a number.
    const walkIn = await book(SHARED, addDays(todayISO(), 6), 14);

    // Later, somebody registers an account claiming that same number. Nothing
    // in this system verifies a phone number, so this is trivial to do.
    const stranger = await customer("stranger@example.com", SHARED, "Stranger");
    const dump = (await exportCustomerData(stranger.id))!;

    expect(dump.bookings.map((b) => (b as { code: string }).code)).not.toContain(walkIn.code);
    expect(dump.bookings).toHaveLength(0);
  });

  it("does not cancel somebody else's court when that account closes", async () => {
    const SHARED = "0195000098";
    const walkIn = await book(SHARED, addDays(todayISO(), 7), 15);
    const stranger = await customer("stranger2@example.com", SHARED, "Stranger");

    const erased = await eraseCustomer(stranger.id);
    expect(erased.ok).toBe(true);

    const row = await getDb()
      .prepare("SELECT name, phone, status FROM bookings WHERE code = ?")
      .get(walkIn.code) as { name: string; phone: string; status: string };
    // Untouched: still named, still holding its court.
    expect(row.name).toBe("Data Subject");
    expect(row.phone).toBe(SHARED);
    expect(row.status).toBe("confirmed");
    expect(
      (
        await getDb()
          .prepare(
            "SELECT COUNT(*) AS n FROM claims c JOIN bookings b ON b.id = c.booking_id WHERE b.code = ? AND c.active"
          )
          .get(walkIn.code) as { n: number }
      ).n
      // Its claim on its court.
    ).toBe(1);
  });
});

describe("forgetting somebody", () => {
  it("keeps the venue's takings and drops the person", async () => {
    const user = await customer("erase@example.com", "0195000010");
    const past = await book("0195000010", addDays(todayISO(), 2), 10, user.id);
    expect((await exportCustomerData(user.id))!.bookings).toHaveLength(1);
    const price = past.totalPrice;

    // Stand a week later so that booking is history rather than upcoming.
    const erased = await eraseCustomer(user.id);
    expect(erased.ok).toBe(true);
    if (!erased.ok) return;

    const row = await getDb()
      .prepare("SELECT name, phone, email, user_id, total_price, status FROM bookings WHERE code = ?")
      .get(past.code) as {
      name: string;
      phone: string;
      email: string | null;
      user_id: number | null;
      total_price: number;
      status: string;
    };
    // The money and the hour are the venue's record and stay exactly as they were.
    expect(row.total_price).toBe(price);
    // The person does not.
    expect(row.name).toBe(ANONYMOUS);
    expect(row.phone).toBe("");
    expect(row.email).toBeNull();
    expect(row.user_id).toBeNull();
    // An upcoming booking is released rather than held for a ghost.
    expect(row.status).toBe("cancelled");
    expect(erased.cancelled).toBeGreaterThan(0);

    expect(await exportCustomerData(user.id)).toBeNull();
  });

  it("takes them off waiting lists rather than failing on them", async () => {
    const user = await customer("waiting@example.com", "0195000019");
    const date = addDays(todayISO(), 3);
    await book("0195000020", date, 14);
    const joined = await joinSlotWaitlist({
      courtId: (await VENUE()).courts[0].id,
      date,
      startHour: 14,
      endHour: 15,
      name: "Data Subject",
      phone: "0195000019",
      userId: user.id,
    });
    expect(joined.ok).toBe(true);

    expect((await eraseCustomer(user.id)).ok).toBe(true);
    const left = await getDb()
      .prepare("SELECT COUNT(*) AS n FROM waitlist WHERE user_id = ? OR phone = ?")
      .get(user.id, "0195000019") as { n: number };
    expect(Number(left.n)).toBe(0);
  });

  it("refuses while the customer is still owed credit", async () => {
    const user = await customer("owed@example.com", "0195000011");
    await topUpWallet({ userId: user.id, amount: 40, adminId, reason: "Counter top-up" });

    const refused = await eraseCustomer(user.id);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("RM40");
    // Still there, because nothing was erased.
    expect(await exportCustomerData(user.id)).not.toBeNull();
  });

  it("refuses while a pass is still live, and allows it once withdrawn", async () => {
    const user = await customer("pass@example.com", "0195000012");
    const pass = await issuePass({
      venueId: (await VENUE()).id,
      name: "10 hours",
      entries: 10,
      price: 150,
      holderName: "Data Subject",
      holderPhone: "0195000012",
      expiresOn: addDays(todayISO(), 90),
      adminId,
      userId: user.id,
    });
    if (!pass.ok) throw new Error(pass.error);

    const refused = await eraseCustomer(user.id);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("pass or membership");

    await voidPass(pass.pass.id);
    expect((await eraseCustomer(user.id)).ok).toBe(true);
  });

  it("refuses while a membership is running", async () => {
    const user = await customer("member@example.com", "0195000013");
    const sold = await sellMembership({
      venueId: (await VENUE()).id,
      holderName: "Data Subject",
      holderPhone: "0195000013",
      startsOn: todayISO(),
      expiresOn: addDays(todayISO(), 30),
      price: 120,
      adminId,
      userId: user.id,
    });
    expect(sold.ok).toBe(true);
    expect((await eraseCustomer(user.id)).ok).toBe(false);
  });

  it("leaves a counter-sold pass alone, because it was never account data", async () => {
    const user = await customer("counter@example.com", "0195000014");
    const pass = await issuePass({
      venueId: (await VENUE()).id,
      name: "10 hours",
      entries: 10,
      price: 150,
      holderName: "Data Subject",
      holderPhone: "0195000014",
      expiresOn: addDays(todayISO(), 90),
      adminId,
      // No userId: bought over a counter, filed against a number.
    });
    if (!pass.ok) throw new Error(pass.error);

    // Closing the account does not block on it, and does not break it: the
    // pass is still usable with its code and the number it was sold to.
    expect((await eraseCustomer(user.id)).ok).toBe(true);
    const row = await getDb()
      .prepare("SELECT holder_phone, status FROM passes WHERE code = ?")
      .get(pass.pass.code) as { holder_phone: string; status: string };
    expect(row.holder_phone).toBe("0195000014");
    expect(row.status).toBe("active");
  });

  it("says no twice rather than half-erasing", async () => {
    expect(await eraseCustomer(999_999)).toEqual({ ok: false, error: "Account not found." });
  });
});

describe("keeping nothing longer than it is needed", () => {
  it("lists what is due without touching it", async () => {
    const user = await customer("retain@example.com", "0195000020");
    const booking = await book("0195000020", addDays(todayISO(), 4), 11, user.id);
    await age("UPDATE bookings SET date = ? WHERE code = ?", addDays(todayISO(), -1000), booking.code);

    const due = await retentionDue();
    const bookings = due.find((l) => l.what.includes("old bookings"))!;
    expect(bookings.days).toBe(RETENTION.bookingIdentityDays);
    expect(bookings.action).toBe("anonymised");
    expect(bookings.affected).toBeGreaterThan(0);

    // Listing is not doing.
    const still = await getDb()
      .prepare("SELECT name FROM bookings WHERE code = ?")
      .get(booking.code) as { name: string };
    expect(still.name).not.toBe(ANONYMOUS);
  });

  it("anonymises an old booking but keeps what it was worth", async () => {
    const before = await getDb()
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total_price), 0) AS total FROM bookings")
      .get() as { n: number; total: number };

    await pruneOldData();

    const after = await getDb()
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total_price), 0) AS total FROM bookings")
      .get() as { n: number; total: number };
    // Not one booking row was lost, and not one ringgit.
    expect(after.n).toBe(before.n);
    expect(after.total).toBe(before.total);

    const old = await getDb()
      .prepare("SELECT name, phone FROM bookings WHERE date < ?")
      .get(addDays(todayISO(), -RETENTION.bookingIdentityDays)) as {
      name: string;
      phone: string;
    };
    expect(old.name).toBe(ANONYMOUS);
    expect(old.phone).toBe("");
  });

  it("clears a stale door-code log, which is the most sensitive thing here", async () => {
    const db = getDb();
    const booking = await book("0195000021", addDays(todayISO(), 5), 12);
    await db.prepare("INSERT INTO access_reveals (booking_id, revealed_at) VALUES (?, ?)").run(
      booking.id,
      `${addDays(todayISO(), -RETENTION.accessRevealDays - 1)} 12:00:00`
    );
    await db.prepare("INSERT INTO access_reveals (booking_id) VALUES (?)").run(booking.id);
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM access_reveals").get() as { n: number }).n
    ).toBe(2);

    await pruneOldData();
    // The recent one is still there; the old one is not.
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM access_reveals").get() as { n: number }).n
    ).toBe(1);
  });

  it("clears phone check codes after a day, whether or not anybody asks for another", async () => {
    const db = getDb();
    const user = await customer("codes@example.com", "0195000030");
    const insert = (createdAt: string | null) =>
      db
        .prepare(
          `INSERT INTO phone_codes (user_id, phone, number, code_hash, expires_at, created_at)
           VALUES (?, '0195000030', '60195000030', 'x', datetime('now'), COALESCE(?, datetime('now')))`
        )
        .run(user.id, createdAt);
    await insert(`${addDays(todayISO(), -3)} 12:00:00`);
    await insert(null);
    await pruneOldData();
    const left = (await db.prepare("SELECT COUNT(*)::int AS n FROM phone_codes WHERE user_id = ?").get(user.id)) as { n: number };
    expect(left.n).toBe(1);
  });

  it("clears old messages once sent, but never one still waiting to go", async () => {
    const db = getDb();
    const booking = await book("0195000022", addDays(todayISO(), 6), 13);
    const old = `${addDays(todayISO(), -RETENTION.messageDays - 1)} 09:00:00`;
    const message = (status: string, createdAt: string | null) =>
      db
        .prepare(
          `INSERT INTO messages (booking_id, venue_id, kind, channel, recipient, locale, body, status, created_at)
           SELECT ?, c.venue_id, 'booking_confirmed', 'whatsapp', '0195000022', 'en', 'Hi Aina', ?, COALESCE(?, datetime('now'))
             FROM courts c WHERE c.id = ?`
        )
        .run(booking.id, status, createdAt, booking.courtId);
    await message("sent", old);
    await message("abandoned", old);
    await message("queued", old);
    await message("sent", null);

    const due = (await retentionDue()).find((l) => l.what.startsWith("Messages"))!;
    expect(due.affected).toBe(2);
    await pruneOldData();
    const left = (await db
      .prepare("SELECT status FROM messages WHERE booking_id = ? ORDER BY id")
      .all(booking.id)) as { status: string }[];
    expect(left.map((m) => m.status)).toEqual(["queued", "sent"]);
  });

  it("runs at most once a day", async () => {
    await pruneOldData();
    expect(await retentionLastRun()).not.toBeNull();
    // Already run today, so there is nothing to do.
    expect(await pruneIfDue()).toBeNull();

    await getDb()
      .prepare("UPDATE settings SET value = ? WHERE key = 'retention_last_run'")
      .run("2020-01-01 00:00:00");
    expect(await pruneIfDue()).not.toBeNull();
  });
});
