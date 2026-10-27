import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { chargeToAccount, issueInvoice, saveAccount } from "../src/lib/accounts";
import { journalCsv } from "../src/lib/accounting";
import { createAdmin } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { saveCoach, type Coach } from "../src/lib/coaching";
import { saveConcession } from "../src/lib/concessions";
import { getDb } from "../src/lib/db";
import { documentById, keepBookingReceipt, linePhrase, lineText, type Line } from "../src/lib/documents";
import { reapplyErasures } from "../src/lib/erasure-ledger";
import { translator } from "../src/lib/i18n";
import { addManaged } from "../src/lib/managed-people";
import { eraseParticipant } from "../src/lib/participants";
import { savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import { withdrawPlace } from "../src/lib/place-withdrawals";
import { ANONYMOUS, eraseCustomer, pruneOldData, retentionDue } from "../src/lib/privacy";
import { receiptFor, receiptLineText, receiptToken } from "../src/lib/receipts";
import { createResources } from "../src/lib/resources";
import { englishOf } from "../src/lib/staff-text";
import { adminCancelBooking, createCourt, createVenue, rescheduleBooking, sellMembership, setPaymentStatus } from "../src/lib/store";
import { setHoldPolicy } from "../src/lib/holds";
import { setHouseRules } from "../src/lib/house-rules";
import { addDays, todayISO } from "../src/lib/time";
import * as bookingsRoute from "../src/app/api/bookings/route";
import ReceiptPage from "../src/app/receipt/[code]/page";

/**
 * The people a receipt or credit note names are cleared with the rest of it
 * (lib/receipt-names.ts; docs/architecture/privacy.md#receipts-and-credit-notes):
 * a guardian's receipt for two children, a place taken off a booking (by
 * hand, and from a deposit paid online), a credit note on a school's account,
 * a lesson given to a cheaper coach and a family membership. After the
 * retention period, after the guardian's erasure and after a child's, no
 * child's name is left anywhere in `receipts` (the whole row as text), the
 * amounts and tax are as they were, and the receipt page and the accounting
 * export still render; applied again after a restore, an erasure gives the
 * same rows. On PGlite, and on Postgres with TEST_DATABASE_URL. Online
 * payments against a stand-in gateway (fetch stubbed).
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;

let poolVenue: number;
let pool: number;
let childPrice: number;
let acctVenue: number;
let acctPool: number;
let coachVenue: number;
let ana: Coach;
let cara: Coach;
let manager: { kind: "staff"; adminId: number; name: string };

const req = (cookie: string, body: unknown) =>
  new NextRequest("http://localhost/api/bookings", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.71.${++n % 250}.${n % 200}`, cookie },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  const venue = async (name: string, phone: string) => {
    const v = await createVenue({ name, area: "Bangsar", address: "x", phone, openMin: at(7), closeMin: at(22) });
    if (!v.ok) throw new Error("venue");
    expect((await setHouseRules(v.venue.id, { aheadDays: 45 })).ok).toBe(true);
    return v.venue.id;
  };
  const swim = async (venueId: number, name: string) => {
    const r = await createResources({ venueId, sport: "swimming", name, offPeakRate: 10, peakRate: 10, capacity: 6, maxPlayers: 6 });
    if (!r.ok) throw new Error(r.error);
    return r.courts[0].id;
  };
  poolVenue = await venue("Kolam Nama", "0312370801");
  pool = await swim(poolVenue, "Pool");
  const c = await saveConcession(poolVenue, { name: "Child (under 12)", percent: 50, proof: "your child's MyKid", preset: "child", scope: "participant" });
  if (!c.ok) throw new Error(c.error);
  childPrice = c.concession.id;
  const saved = await savePaymentSettings(poolVenue, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
  expect((await setHoldPolicy(poolVenue, { on: true, depositPercent: 50 })).ok).toBe(true);

  acctVenue = await venue("Kolam Sekolah", "0312370802");
  acctPool = await swim(acctVenue, "School pool");
  const made = await createAdmin({ name: "Mira", email: "rn-mgr@names.test", password: "a long enough password", venueId: acctVenue, role: "manager" });
  if (!made.ok) throw new Error(made.error);
  manager = { kind: "staff", adminId: made.admin.id, name: "Mira" };

  coachVenue = await venue("Kelab Jurulatih", "0312370803");
  const court = await createCourt({ venueId: coachVenue, name: "Court 1", sport: "tennis", offPeakRate: 20, peakRate: 20 });
  if (!court.ok) throw new Error("court");
  const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: at(8), until: at(20) }));
  const coach = async (name: string, rate: number) => {
    const s = await saveCoach(coachVenue, { name, sports: ["tennis"], rate, hours });
    if (!s.ok) throw new Error(s.error);
    return s.coach;
  };
  ana = await coach("Ana Lim", 80);
  cara = await coach("Cara Ong", 60);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface World {
  guardian: { id: number; name: string; phone: string; cookie: string };
  kids: { id: number; name: string }[];
  bookings: number[];
  receipts: number[];
}

/**
 * One guardian and three children, and every kind of receipt and credit note
 * that names them: the court time for two (one at the child price) kept as a
 * receipt and credited on cancelling; a child taken off a booking paid at the
 * counter after a deposit paid online (a credit note by hand, and the
 * deposit's part credited); a child taken off a school's booking after its
 * invoice (a credit note on the account); a child's lesson given to a cheaper
 * coach (a credit note for the difference); a family membership covering two.
 */
async function world(names: [string, string, string], hour: number): Promise<World> {
  const phone = `0179${String(++n).padStart(6, "0")}`;
  const made = await registerUser({ name: `Puan Guardian ${++n}`, email: `g${n}@names.test`, phone, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  const guardian = { id: made.user.id, name: made.user.name, phone, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
  const kids: World["kids"] = [];
  for (const displayName of names) {
    const k = await addManaged(guardian.id, { displayName, relationship: "parent", authority: true }, guardian.name);
    if (!k.ok) throw new Error(k.error);
    kids.push({ id: k.person.id, name: k.person.displayName });
  }
  const book = async (body: Record<string, unknown>) => {
    const res = await bookingsRoute.POST(req(guardian.cookie, { name: guardian.name, phone, ...body }));
    const out = (await res.json()) as { booking: { id: number; code: string } };
    if (res.status !== 201) throw new Error(JSON.stringify(out));
    return out.booking;
  };
  const bookings: number[] = [];

  // Two children, one at the child price: paid, kept as a receipt (as a lost chargeback does), then cancelled.
  const two = await book({ courtId: pool, date: day(3), start: at(hour), end: at(hour + 1), participantIds: [kids[0].id, kids[1].id], placeConcessions: [{ participantId: kids[1].id, concessionId: childPrice }] });
  bookings.push(two.id);
  expect((await setPaymentStatus(two.code, true, "cash")).ok).toBe(true);
  expect(await keepBookingReceipt(two.id, `booking-paid:${two.id}:kept`, null)).not.toBeNull();
  expect((await adminCancelBooking(two.code)).ok).toBe(true);

  // Three children, a deposit paid online, the rest at the counter; two of them taken off.
  const three = await book({ courtId: pool, date: day(4), start: at(hour), end: at(hour + 1), participantIds: kids.map((k) => k.id) });
  bookings.push(three.id);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ id: `rnbill${++n}`, url: `https://www.billplz-sandbox.com/bills/rnbill${n}` }))
  );
  const started = await startBookingPayment({ codes: [three.code], phone, deposit: true });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const bill = (await getDb().prepare("SELECT bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { bill_id: string };
  await settleBill({ billId: bill.bill_id, paid: true, paidAt: null });
  vi.unstubAllGlobals();
  expect((await setPaymentStatus(three.code, true, "cash")).ok).toBe(true);
  const by = { kind: "customer" as const, userId: guardian.id, name: guardian.name };
  expect(await withdrawPlace(three.id, { participantId: kids[0].id }, by)).toMatchObject({ ok: true, withdrawal: { refund: 10, deposit: 0 } });
  expect(await withdrawPlace(three.id, { participantId: kids[1].id }, by)).toMatchObject({ ok: true, withdrawal: { refund: 10, deposit: 5 } });

  // A school's booking for them, invoiced the morning of the session; one child taken off at the counter after it.
  const account = await saveAccount(acctVenue, { name: `SK Nama ${n}`, email: `school${n}@names.test` });
  if (!account.ok) throw new Error(account.error);
  const date = day(2);
  const school = await book({ courtId: acctPool, date, start: at(hour), end: at(hour + 1), participantIds: kids.map((k) => k.id) });
  bookings.push(school.id);
  expect((await chargeToAccount(acctVenue, account.account.id, [school.id])).ok).toBe(true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${date}T07:00:00+08:00`));
  expect(await issueInvoice(account.account.id, date.slice(0, 7), { email: false })).not.toBeNull();
  expect(await withdrawPlace(school.id, { participantId: kids[2].id }, manager, "Unwell")).toMatchObject({ ok: true, withdrawal: { how: "account" } });
  vi.useRealTimers();

  // A lesson for one child, paid, given to a cheaper coach with the difference back by hand.
  const lesson = await book({ venueId: coachVenue, sport: "tennis", date: day(5), start: at(hour), end: at(hour + 1), coachId: ana.id, participantIds: [kids[0].id] });
  bookings.push(lesson.id);
  expect((await setPaymentStatus(lesson.code, true, "cash")).ok).toBe(true);
  const moved = await rescheduleBooking(lesson.code, { date: day(5), start: at(hour), coachId: cara.id, coachMoney: "adjust", changedBy: { adminId: null, name: "Mira" } }, "staff");
  expect(moved).toMatchObject({ ok: true });

  // A family membership covering two of them, lapsed since.
  const family = await sellMembership({
    venueId: poolVenue,
    holderName: guardian.name,
    holderPhone: phone,
    userId: guardian.id,
    startsOn: day(0),
    expiresOn: day(30),
    price: 100,
    covers: [kids[0].id, kids[2].id],
  });
  if (!family.ok) throw new Error(family.error);
  // Lapsed since.
  await getDb().prepare("UPDATE memberships SET starts_on = ?, expires_on = ? WHERE id = ?").run(day(-400), day(-40), family.membership.id);

  const receipts = await receiptsOf(bookings, guardian.id);
  return { guardian, kids, bookings, receipts };
}

/** Every receipt and credit note about these bookings or this account. */
async function receiptsOf(bookings: number[], userId: number): Promise<number[]> {
  const ids = new Set<number>();
  for (const b of bookings) {
    const rows = (await getDb()
      .prepare(
        `SELECT id FROM receipts WHERE source = ? OR source LIKE ? OR source LIKE ?
            OR source IN (SELECT 'account-credit:' || id FROM account_credits WHERE booking_id = ?)
            OR source IN (SELECT 'payment:' || payment_id FROM online_payment_bookings WHERE booking_id = ?)`
      )
      .all(`booking:${b}`, `booking:${b}:%`, `booking-paid:${b}:%`, b, b)) as { id: number }[];
    for (const r of rows) ids.add(Number(r.id));
  }
  for (const r of (await getDb().prepare("SELECT id FROM receipts WHERE user_id = ?").all(userId)) as { id: number }[]) ids.add(Number(r.id));
  for (const id of [...ids])
    for (const r of (await getDb().prepare("SELECT id FROM receipts WHERE credits_id = ?").all(id)) as { id: number }[]) ids.add(Number(r.id));
  return [...ids].sort((a, b) => a - b);
}

/** The whole of each row, as text: anything in any column. */
async function rowText(ids: number[]): Promise<string> {
  const rows = (await getDb().prepare(`SELECT row_to_json(r)::text AS t FROM receipts r WHERE id IN (${ids.join(",")}) ORDER BY id`).all()) as { t: string }[];
  return rows.map((r) => r.t).join("\n");
}

/** What the books need: numbers, kinds, totals, tax, each line's amount. */
async function books(ids: number[]) {
  const rows = (await getDb()
    .prepare(
      `SELECT id, number, kind, credits_id, credits_ref, total::float AS total, tax_name, tax_rate::float AS tax_rate, tax_amount::float AS tax_amount,
              paid_via, issued_at, lines FROM receipts WHERE id IN (${ids.join(",")}) ORDER BY id`
    )
    .all()) as (Record<string, unknown> & { lines: string })[];
  return rows.map(({ lines, ...r }) => ({ ...r, amounts: (JSON.parse(lines) as Line[]).map((l) => l.amount) }));
}

/** Each document as its page shows it, in English and Malay, and the lines as the books and staff screens say them. */
async function rendered(ids: number[]): Promise<string> {
  const out: string[] = [];
  for (const id of ids) {
    const doc = (await documentById(id))!;
    const page = await ReceiptPage({ params: Promise.resolve({ code: doc.ref }), searchParams: Promise.resolve({ t: receiptToken(doc.ref) }) });
    const html = renderToStaticMarkup(page);
    expect(html).toContain(doc.number);
    out.push(html);
    const receipt = (await receiptFor(doc.ref, receiptToken(doc.ref)))!;
    for (const line of receipt.lines) {
      out.push(receiptLineText(translator("en"), line), receiptLineText(translator("ms"), line), lineText(line));
      const phrase = linePhrase(line);
      if (phrase) out.push(englishOf(phrase));
    }
  }
  return out.join("\n");
}

const has = (text: string, name: string) => new RegExp(`(?<![\\p{L}])${name}(?![\\p{L}])`, "iu").test(text);

describe("a guardian's receipts, once the period for keeping names has passed", () => {
  it("name nobody: not the guardian, not a child, in any column; what was sold and the tax on it stay", async () => {
    const w = await world(["Zahirah", "Qairul", "Wardina"], 9);
    const before = await rowText(w.receipts);
    // Every kind named the children to begin with.
    for (const kid of w.kids) expect(has(before, kid.name)).toBe(true);
    expect(before).toContain("{who}");
    const sold = await books(w.receipts);
    // Two years and more ago.
    await getDb().prepare(`UPDATE receipts SET issued_at = '2023-03-01 02:00:00' WHERE id IN (${w.receipts.join(",")})`).run();
    const due = (await retentionDue()).find((l) => l.what === "Names and numbers on old receipts")!;
    expect(due.affected).toBeGreaterThanOrEqual(w.receipts.length);

    await pruneOldData();
    const after = await rowText(w.receipts);
    for (const name of [...w.kids.map((k) => k.name), w.guardian.name, w.guardian.phone]) expect(has(after, name), name).toBe(false);
    expect(await books(w.receipts)).toEqual(sold.map((r) => ({ ...r, issued_at: "2023-03-01 02:00:00" })));
    // The page and the books still read: each says a name was there.
    const shown = await rendered(w.receipts);
    for (const kid of w.kids) expect(has(shown, kid.name)).toBe(false);
    expect(shown).toContain(ANONYMOUS);
    const csv = await journalCsv(poolVenue, "2023-03-01", "2023-03-01");
    for (const kid of w.kids) expect(has(csv, kid.name)).toBe(false);
    expect(csv.split("\n").length).toBeGreaterThan(1);
    // Done once: none of them is due again.
    expect(((await getDb().prepare(`SELECT COUNT(*)::int AS n FROM receipts WHERE id IN (${w.receipts.join(",")}) AND names_cleared_at IS NULL`).get()) as { n: number }).n).toBe(0);
  });

  it("and one written before names were kept apart: each name taken out where it stands, the booking's people's names wherever they appear", async () => {
    const w = await world(["Nurfarah", "Haziq", "Batrisyia"], 11);
    const [alya, haziq] = w.kids;
    const db = getDb();
    const credited = w.receipts[0];
    const write = async (seq: number, source: string, customer: string, lines: unknown[], issued = "2023-03-02 02:00:00") =>
      Number(
        ((await db
          .prepare(
            `INSERT INTO receipts (venue_id, kind, seq, number, source, credits_id, user_id, customer_name, lines, total, issued_at)
             VALUES (?, 'credit_note', ?, ?, ?, NULL, NULL, ?, ?, 10, ?) RETURNING id`
          )
          .get(poolVenue, seq, `CN-OLD${seq}`, source, customer, JSON.stringify(lines), issued)) as { id: number }).id
      );
    const old = [
      await write(900001, "booking:999001:place:1", w.guardian.name, [{ description: `${alya.name}, taken off BK-OLD1`, amount: 10 }]),
      await write(900002, `credit:${credited}:BK-OLD2, ${alya.name}`, w.guardian.name, [{ description: `Part of R-000001, BK-OLD2, ${alya.name}`, amount: 5 }]),
      await write(900003, `credit:${credited}:BK-OLD2, ${haziq.name}`, w.guardian.name, [{ description: `Part of R-000001, BK-OLD2, ${haziq.name}`, amount: 5 }]),
      await write(900004, "membership:999003", w.guardian.name, [
        {
          description: `Membership MB-OLD for ${w.guardian.name}, ${alya.name}, 2023-01-01 to 2023-12-31`,
          amount: 10,
          phrase: { key: "srv.mbo.line", vars: { code: "MB-OLD", who: `${w.guardian.name}, ${alya.name}`, from: "2023-01-01", to: "2023-12-31" } },
        },
      ]),
      await write(900005, "booking:999004", w.guardian.name, [
        { description: "Pool (Swimming), 2023-01-01 9:00 AM–10:00 AM", amount: 20, slot: { court: "Pool", sport: "swimming", date: "2023-01-01", startMin: 540, endMin: 600, players: 2, for: [alya.name, haziq.name] } },
        { description: `Member price, ${alya.name}`, amount: -10, place: { kind: "membership", name: alya.name } },
      ]),
      // A shape nothing here knows, about a booking whose places still name them: their names wherever they stand.
      await write(900006, `booking-paid:${w.bookings[0]}:old`, w.guardian.name, [{ description: `Swimming lesson (${haziq.name} and ${alya.name})`, amount: 10 }]),
      // Anonymised by an erasure before migration 0207, the names in its lines left: cleared now, whatever its date.
      await write(900007, "booking:999005:place:2", ANONYMOUS, [{ description: `${haziq.name}, taken off BK-OLD5`, amount: 10 }], `${todayISO()} 01:00:00`),
    ];
    await pruneOldData();
    const after = await rowText(old);
    for (const kid of w.kids) expect(has(after, kid.name), kid.name).toBe(false);
    expect(has(after, w.guardian.name)).toBe(false);
    const lines = async (id: number) => ((await documentById(id))!).lines;
    expect((await lines(old[0]))[0].description).toBe(`${ANONYMOUS}, taken off BK-OLD1`);
    expect((await lines(old[1]))[0].description).toBe(`Part of R-000001, BK-OLD2, ${ANONYMOUS}`);
    // The two deposit parts' keys stay one of a kind, and say whose credit they are by number only.
    const sources = (await db.prepare(`SELECT source FROM receipts WHERE id IN (${old[1]}, ${old[2]}) ORDER BY id`).all()) as { source: string }[];
    expect(sources.map((s) => s.source)).toEqual([`credit:${credited}:BK-OLD2, ${ANONYMOUS} ${old[1]}`, `credit:${credited}:BK-OLD2, ${ANONYMOUS} ${old[2]}`]);
    const membership = (await lines(old[3]))[0];
    expect(membership.description).toBe(`Membership MB-OLD for ${ANONYMOUS}, 2023-01-01 to 2023-12-31`);
    expect(englishOf(linePhrase(membership)!)).toBe(`Membership MB-OLD for ${ANONYMOUS}, 2023-01-01 to 2023-12-31`);
    const [slot, member] = await lines(old[4]);
    expect(slot.slot?.for).toEqual([ANONYMOUS]);
    expect(member).toEqual({ description: `Member price, ${ANONYMOUS}`, amount: -10, place: { kind: "membership", name: null } });
    expect((await lines(old[5]))[0].description).toBe(`Swimming lesson (${ANONYMOUS} and ${ANONYMOUS})`);
    expect((await lines(old[6]))[0].description).toBe(`${ANONYMOUS}, taken off BK-OLD5`);
    expect(((await db.prepare(`SELECT COUNT(*)::int AS n FROM receipts WHERE id IN (${old.join(",")}) AND names_cleared_at IS NOT NULL`).get()) as { n: number }).n).toBe(old.length);
  });
});

/** What an erasure leaves in the receipts: each row's words, key and customer. */
async function cleared(ids: number[]) {
  return (await getDb()
    .prepare(`SELECT id, source, customer_name, customer_phone, user_id, lines FROM receipts WHERE id IN (${ids.join(",")}) ORDER BY id`)
    .all()) as Record<string, unknown>[];
}

/** A table's rows as a backup taken now holds them, kept aside (as tests/erasure-ledger.test.ts does). */
let asides = 0;
async function aside(table: string, where: string) {
  const name = `rn_aside_${++asides}`;
  await getDb().prepare(`CREATE TABLE ${name} AS SELECT * FROM ${table} WHERE ${where}`).run();
  return name;
}
/** Put rows back as they were: inserted again where they went, or their columns set back. */
async function putBack(table: string, from: string, columns?: string[]) {
  if (!columns) await getDb().prepare(`INSERT INTO ${table} SELECT * FROM ${from} ON CONFLICT DO NOTHING`).run();
  else await getDb().prepare(`UPDATE ${table} t SET ${columns.map((c) => `${c} = s.${c}`).join(", ")} FROM ${from} s WHERE s.id = t.id`).run();
}

/** Everything about this world a backup taken now would bring back, and how to bring it back. */
async function backup(w: World) {
  const kids = w.kids.map((k) => k.id).join(",");
  const bookings = w.bookings.join(",");
  const saved = {
    users: await aside("users", `id = ${w.guardian.id}`),
    participants: await aside("participants", `id IN (${kids})`),
    guardians: await aside("participant_guardians", `participant_id IN (${kids})`),
    bookings: await aside("bookings", `id IN (${bookings})`),
    places: await aside("booking_participants", `booking_id IN (${bookings})`),
    withdrawals: await aside("place_withdrawals", `booking_id IN (${bookings})`),
    benefits: await aside("place_benefits", `booking_id IN (${bookings})`),
    memberships: await aside("memberships", `user_id = ${w.guardian.id}`),
    covers: await aside("membership_participants", `participant_id IN (${kids})`),
    coverChanges: await aside("membership_cover_changes", `participant_id IN (${kids})`),
    receipts: await aside("receipts", `id IN (${w.receipts.join(",")})`),
  };
  return async () => {
    await putBack("users", saved.users);
    await putBack("participants", saved.participants);
    await putBack("participant_guardians", saved.guardians);
    await putBack("bookings", saved.bookings, ["name", "phone", "email", "user_id", "check_in_token", "participant_name"]);
    await putBack("booking_participants", saved.places, ["participant_id", "name"]);
    await putBack("place_withdrawals", saved.withdrawals, ["participant_id", "name"]);
    await putBack("place_benefits", saved.benefits, ["participant_id"]);
    await putBack("memberships", saved.memberships, ["holder_name", "holder_phone", "user_id"]);
    await putBack("membership_participants", saved.covers);
    await putBack("membership_cover_changes", saved.coverChanges, ["participant_id"]);
    await putBack("receipts", saved.receipts, ["source", "customer_name", "customer_phone", "user_id", "lines", "names_cleared_at"]);
  };
}

describe("a guardian's account erased", () => {
  it("their receipts and their bookings' name nobody, the children erased with them included; applied again after a restore, the same", async () => {
    const w = await world(["Yasmeen", "Khairil", "Ummairah"], 13);
    const sold = await books(w.receipts);
    // Played since: nothing upcoming for the erasure to cancel.
    await getDb().prepare(`UPDATE bookings SET date = ? WHERE id IN (${w.bookings.join(",")})`).run(day(-20));
    const restore = await backup(w);

    expect(await eraseCustomer(w.guardian.id)).toMatchObject({ ok: true });
    const text = await rowText(w.receipts);
    for (const name of [...w.kids.map((k) => k.name), w.guardian.name, w.guardian.phone]) expect(has(text, name), name).toBe(false);
    expect(await books(w.receipts)).toEqual(sold);
    // The school keeps its own name on its credit note.
    expect(text).toContain("SK Nama");
    const shown = await rendered(w.receipts);
    for (const kid of w.kids) expect(has(shown, kid.name)).toBe(false);
    // The school's credit note is dated the morning of the session it was written on.
    const csv = await journalCsv(acctVenue, day(-1), day(5));
    for (const kid of w.kids) expect(has(csv, kid.name)).toBe(false);
    expect(csv).toContain("CN-");
    const first = await cleared(w.receipts);

    // A backup from before it is restored; the erasures recorded are applied again.
    await restore();
    expect(has(await rowText(w.receipts), w.kids[0].name)).toBe(true);
    const again = await reapplyErasures();
    expect(again.refused).toEqual([]);
    expect(again.erasedAgain).toBeGreaterThanOrEqual(1 + w.kids.length);
    expect(await cleared(w.receipts)).toEqual(first);
    expect(await books(w.receipts)).toEqual(sold);
  });
});

describe("a child erased", () => {
  it("their name comes off every receipt and credit note about them; their brother's and sister's stay; applied again after a restore, the same", async () => {
    const w = await world(["Xandria", "Jazlan", "Tihani"], 15);
    const [xandria, jazlan, tihani] = w.kids;
    const sold = await books(w.receipts);
    const restore = await backup(w);

    await getDb().transaction(async () => {
      await eraseParticipant(xandria.id, "Asked to be forgotten");
    })();
    const text = await rowText(w.receipts);
    expect(has(text, xandria.name)).toBe(false);
    // Only theirs: the others it names, and the guardian it was sold to, stay.
    expect(has(text, jazlan.name)).toBe(true);
    expect(has(text, tihani.name)).toBe(true);
    expect(text).toContain(w.guardian.name);
    expect(await books(w.receipts)).toEqual(sold);
    // The court time for two now reads "for (removed), Jazlan"; the deposit's part for Jazlan still names him.
    const shown = await rendered(w.receipts);
    expect(has(shown, xandria.name)).toBe(false);
    expect(shown).toContain(`for ${ANONYMOUS}, ${jazlan.name}`);
    expect(shown).toContain(`Part of R-`);
    const csv = await journalCsv(poolVenue, day(-1), day(1));
    expect(has(csv, xandria.name)).toBe(false);
    const first = await cleared(w.receipts);

    await restore();
    expect(has(await rowText(w.receipts), xandria.name)).toBe(true);
    const again = await reapplyErasures();
    expect(again.refused).toEqual([]);
    expect(await cleared(w.receipts)).toEqual(first);
    expect(await books(w.receipts)).toEqual(sold);
  });
});

describe("written from now on", () => {
  it("keeps the names apart from the words, and every reader says them while they are there", async () => {
    const w = await world(["Inara", "Luqman", "Safiya"], 17);
    const docs = await Promise.all(w.receipts.map(async (id) => (await documentById(id))!));
    const allLines = docs.flatMap((d) => d.lines);
    // No name in any line's words: each in `who`, `slot.for` or `place.name`.
    for (const line of allLines) for (const kid of w.kids) expect(has(line.description, kid.name), line.description).toBe(false);
    const taken = allLines.find((l) => l.who && l.description.includes("taken off"))!;
    expect(taken).toMatchObject({ description: expect.stringMatching(/^\{who\}, taken off /), who: [w.kids[0].name] });
    expect(lineText(taken)).toMatch(new RegExp(`^${w.kids[0].name}, taken off `));
    const membership = allLines.find((l) => l.phrase?.key === "srv.mbo.line")!;
    expect(membership.who).toEqual([w.guardian.name, w.kids[0].name, w.kids[2].name]);
    expect(lineText(membership)).toContain(`for ${w.guardian.name}, ${w.kids[0].name}, ${w.kids[2].name}, `);
    expect(englishOf(linePhrase(membership)!)).toBe(lineText(membership));
    // The deposit's part: keyed by the withdrawal, its words naming nobody.
    const part = docs.find((d) => d.lines[0].description.startsWith("Part of R-"))!;
    expect(part.source).toMatch(/^credit:\d+:[A-Z0-9-]+:place:\d+$/);
    expect(lineText(part.lines[0])).toMatch(new RegExp(`, ${w.kids[1].name}$`));
    // The receipt page and the books say them.
    const shown = await rendered(w.receipts);
    for (const kid of w.kids) expect(has(shown, kid.name), kid.name).toBe(true);
    const csv = await journalCsv(poolVenue, day(-1), day(1));
    expect(has(csv, w.kids[1].name)).toBe(true);
  });
});

describe("a deposit's part credited for places nobody was named on", () => {
  it("is a credit note of its own for each withdrawal, keyed by the withdrawal, not by its words", async () => {
    const phone = `0179${String(++n).padStart(6, "0")}`;
    const made = await registerUser({ name: `Encik Lima ${n}`, email: `five${n}@names.test`, phone, password: "a long enough password" });
    if (!made.ok) throw new Error(made.error);
    const cookie = `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}`;
    const res = await bookingsRoute.POST(req(cookie, { name: made.user.name, phone, courtId: pool, date: day(6), start: at(9), end: at(10), players: 5 }));
    const b = ((await res.json()) as { booking: { id: number; code: string } }).booking;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ id: `rnbill${++n}`, url: `https://www.billplz-sandbox.com/bills/rnbill${n}` }))
    );
    expect((await startBookingPayment({ codes: [b.code], phone, deposit: true })).ok).toBe(true);
    const bill = (await getDb().prepare("SELECT id, bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { id: number; bill_id: string };
    await settleBill({ billId: bill.bill_id, paid: true, paidAt: null });
    vi.unstubAllGlobals();
    // RM50: RM25 deposit online, RM25 at the counter.
    expect((await setPaymentStatus(b.code, true, "cash")).ok).toBe(true);
    const by = { kind: "customer" as const, userId: made.user.id, name: made.user.name };
    const deposits: number[] = [];
    for (let i = 0; i < 4; i++) {
      const done = await withdrawPlace(b.id, { unnamed: 1 }, by);
      if (!done.ok) throw new Error(done.error);
      deposits.push(done.withdrawal.deposit);
    }
    // The counter's RM25 first (10, 10, 5), then the deposit's: RM5 and RM10, each with its own credit note.
    expect(deposits).toEqual([0, 0, 5, 10]);
    const notes = (await getDb()
      .prepare("SELECT c.source, c.total::float AS total, c.lines FROM receipts c JOIN receipts r ON r.id = c.credits_id WHERE r.source = ? ORDER BY c.id")
      .all(`payment:${bill.id}`)) as { source: string; total: number; lines: string }[];
    expect(notes.map((x) => x.total)).toEqual([5, 10]);
    for (const note of notes) {
      expect(note.source).toMatch(new RegExp(`^credit:\\d+:${b.code}:place:\\d+$`));
      expect(lineText((JSON.parse(note.lines) as Line[])[0])).toMatch(new RegExp(`, ${b.code}, 1 place$`));
    }
    expect(((await getDb().prepare("SELECT refund_due::float AS due FROM online_payments WHERE id = ?").get(bill.id)) as { due: number }).due).toBe(15);
  });
});
