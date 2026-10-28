import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { accountById, chargeToAccount, closeAccount, issueInvoice, listAccounts, saveAccount } from "../src/lib/accounts";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { withdrawPlace, type WithdrawBy } from "../src/lib/place-withdrawals";
import { createResources } from "../src/lib/resources";
import { createBookingSeries, createVenue } from "../src/lib/store";
import { setHouseRules } from "../src/lib/house-rules";
import { addDays, todayISO } from "../src/lib/time";
import * as creditsRoute from "../src/app/api/admin/accounts/credits/route";

/**
 * Credit on a company or school account paid back by hand
 * (lib/accounts.ts `settleAccountCredit`): a place taken off a booking already
 * invoiced leaves a credit note waiting for the account's next invoice; an
 * account closed (or with nothing more to invoice) is still listed for it,
 * and a manager records it paid back some other way, after which it never
 * comes off an invoice. The front desk cannot; another venue's manager
 * cannot; an invoice issued at the same moment takes it or leaves it, never
 * both (on Postgres too).
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;

let venue: number;
let pool: number;
let staff: WithdrawBy & { kind: "staff" };
let managerCookie: string;
let deskCookie: string;
let strangerCookie: string;

const settle = (cookie: string, body: Record<string, unknown>) =>
  creditsRoute.POST(
    new NextRequest("http://localhost/api/admin/accounts/credits", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    })
  );

/** An account with a booking of three places, invoiced, and one place then taken off: 10 of credit waiting. */
async function accountWithCredit(name: string, date: string) {
  const made = await saveAccount(venue, { name, email: `${name.toLowerCase().replace(/\W/g, "")}${++n}@school.test` });
  if (!made.ok) throw new Error(made.error);
  const acct = made.account.id;
  const b = await createBookingSeries({ weeks: 1, name: "Cikgu Lim", phone: `0179900${String(++n).padStart(3, "0")}`, by: "staff", date, start: at(9), end: at(10), courtId: pool, players: 3 } as Parameters<typeof createBookingSeries>[0]);
  if (!b.ok) throw new Error(b.error);
  const booking = b.bookings[0];
  expect((await chargeToAccount(venue, acct, [booking.id])).ok).toBe(true);
  // The morning of the session: it is invoiced (this month so far), not yet played.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${date}T07:00:00+08:00`));
  expect((await issueInvoice(acct, date.slice(0, 7), { email: false }))!.total).toBe(30);
  expect(await withdrawPlace(booking.id, { unnamed: 1 }, staff)).toMatchObject({ ok: true, withdrawal: { refund: 10, how: "account" } });
  expect((await accountById(acct))!.credit).toBe(10);
  return { acct, booking };
}

beforeAll(async () => {
  const v = await createVenue({ name: "Credit Pool", area: "Bangsar", address: "x", phone: "0312380801", openMin: at(7), closeMin: at(23) });
  const other = await createVenue({ name: "Other Pool", area: "Bangsar", address: "x", phone: "0312380802", openMin: at(7), closeMin: at(23) });
  if (!v.ok || !other.ok) throw new Error("venue");
  venue = v.venue.id;
  const r = await createResources({ venueId: venue, sport: "swimming", name: "School pool", offPeakRate: 10, peakRate: 10, capacity: 6, maxPlayers: 6 });
  if (!r.ok) throw new Error(r.error);
  pool = r.courts[0].id;
  expect((await setHouseRules(venue, { aheadDays: 45 })).ok).toBe(true);
  const cookieOf = async (name: string, venueId: number, role: "manager" | "desk") => {
    const made = await createAdmin({ name, email: `acs${++n}@acs.test`, password: "a long enough password", venueId, role });
    if (!made.ok) throw new Error(made.error);
    return { id: made.admin.id, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
  };
  const manager = await cookieOf("Mira", venue, "manager");
  staff = { kind: "staff", adminId: manager.id, name: "Mira" };
  managerCookie = manager.cookie;
  deskCookie = (await cookieOf("Dina Desk", venue, "desk")).cookie;
  strangerCookie = (await cookieOf("Other Manager", other.venue.id, "manager")).cookie;
});

afterEach(() => vi.useRealTimers());

describe("an account's credit paid back by hand", () => {
  it("a closed account is still listed while credit waits; recorded by a manager, it is gone and never comes off an invoice", async () => {
    const { acct } = await accountWithCredit("SK Tutup", day(3));
    expect(await closeAccount(venue, acct)).toBe(true);
    const listed = (await listAccounts(venue)).find((a) => a.id === acct)!;
    expect(listed).toMatchObject({ closed: true, credit: 10 });

    // Not the desk's, nor another venue's manager's, to record.
    expect((await settle(deskCookie, { venueId: venue, accountId: acct })).status).toBe(403);
    expect((await settle(strangerCookie, { venueId: venue, accountId: acct })).status).toBe(403);
    expect((await accountById(acct, true))!.credit).toBe(10);

    const res = await settle(managerCookie, { venueId: venue, accountId: acct, note: "DuitNow transfer ref 8812" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ amount: 10, account: { id: acct, credit: 0, closed: true } });
    const row = (await getDb().prepare("SELECT settled_by_name, settled_note, applied_invoice_id FROM account_credits WHERE account_id = ?").get(acct)) as Record<string, unknown>;
    expect(row).toEqual({ settled_by_name: "Mira", settled_note: "DuitNow transfer ref 8812", applied_invoice_id: null });
    // No longer listed, and nothing left to pay back twice.
    expect((await listAccounts(venue)).some((a) => a.id === acct)).toBe(false);
    expect((await settle(managerCookie, { venueId: venue, accountId: acct })).status).toBe(409);
    const logged = (await listActivity([venue])).filter((a) => a.action === "account.credit_settled");
    expect(logged.map((a) => a.detail)).toEqual([expect.stringContaining("DuitNow transfer ref 8812")]);
  });

  it("on an open account: paid back by hand, the next invoice charges in full", async () => {
    const date = day(4);
    const { acct } = await accountWithCredit("SK Buka", date);
    expect((await settle(managerCookie, { venueId: venue, accountId: acct })).status).toBe(200);
    const more = await createBookingSeries({ weeks: 1, name: "Cikgu Lim", phone: `0179911${String(++n).padStart(3, "0")}`, by: "staff", date, start: at(12), end: at(13), courtId: pool, players: 2 } as Parameters<typeof createBookingSeries>[0]);
    if (!more.ok) throw new Error(more.error);
    expect((await chargeToAccount(venue, acct, [more.bookings[0].id])).ok).toBe(true);
    const next = (await issueInvoice(acct, date.slice(0, 7), { email: false }))!;
    expect(next).toMatchObject({ total: 20, credited: 0, due: 20 });
  });

  it("settled while the next invoice is issued: the credit is taken off it or paid back, never both (real concurrency on Postgres)", async () => {
    const date = day(5);
    const { acct } = await accountWithCredit("SK Serentak", date);
    const more = await createBookingSeries({ weeks: 1, name: "Cikgu Lim", phone: `0179922${String(++n).padStart(3, "0")}`, by: "staff", date, start: at(14), end: at(15), courtId: pool, players: 2 } as Parameters<typeof createBookingSeries>[0]);
    if (!more.ok) throw new Error(more.error);
    expect((await chargeToAccount(venue, acct, [more.bookings[0].id])).ok).toBe(true);
    const [settled, invoice] = await Promise.all([settle(managerCookie, { venueId: venue, accountId: acct }), issueInvoice(acct, date.slice(0, 7), { email: false })]);
    const rows = (await getDb().prepare("SELECT settled_at IS NOT NULL AS settled, applied_invoice_id IS NOT NULL AS applied FROM account_credits WHERE account_id = ?").all(acct)) as { settled: boolean; applied: boolean }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].settled !== rows[0].applied).toBe(true);
    expect(settled.status === 200).toBe(rows[0].settled);
    expect(invoice!.credited).toBe(rows[0].applied ? 10 : 0);
  });
});
