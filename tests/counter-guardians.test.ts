import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { listActivity } from "../src/lib/activity";
import { apply, decide, saveRequirement } from "../src/lib/approvals";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { addGuardianAtVenue, createAtVenue, linkByStaff, participantHistory } from "../src/lib/participants";
import { createResources } from "../src/lib/resources";
import { createVenue } from "../src/lib/store";
import { setHouseRules } from "../src/lib/house-rules";
import { addDays, todayISO } from "../src/lib/time";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as participantRoute from "../src/app/api/admin/participants/[id]/route";
import * as guardiansRoute from "../src/app/api/admin/participants/[id]/guardians/route";
import * as peopleRoute from "../src/app/api/my/people/route";

/**
 * A second guardian at the counter (lib/participants.ts addGuardianAtVenue;
 * docs/features/venue-operations.md#a-second-guardian-at-the-counter): a
 * child the venue knows, whose recorded guardian is on another number, is
 * brought by an adult who is not on record. Staff record that adult's own
 * declaration on the existing participant (no second record of the child),
 * and the booking with the adult's number then goes through. A number typed
 * alone never makes anybody a guardian; another venue's staff reach nothing;
 * an account as guardian is a manager's, with a reason; an activity that
 * asks for the adult's authority to be reviewed still asks.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0188${String(++n).padStart(6, "0")}`;

type Staff = { id: number; name: string; cookie: string };

let venue: number;
let otherVenue: number;
let hall: number;
let lane: number;
let manager: Staff;
let desk: Staff;
let otherManager: Staff;

async function adult(name: string) {
  const made = await registerUser({ name, email: `cg${++n}@cg.test`, phone: phone(), password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

async function staffMember(venueId: number, name: string, role: "manager" | "desk" = "manager"): Promise<Staff> {
  const made = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}${++n}@cg.test`, password: "a long enough password", venueId, role });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, name, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}

const req = (url: string, method: string, cookie: string | null, body?: unknown) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.88.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

const addGuardian = (who: Staff, participantId: number, body: Record<string, unknown>) =>
  guardiansRoute.POST(req(`http://localhost/api/admin/participants/${participantId}/guardians`, "POST", who.cookie, body), ctx(participantId));

const patch = (who: Staff, participantId: number, body: Record<string, unknown>) =>
  participantRoute.PATCH(req(`http://localhost/api/admin/participants/${participantId}`, "PATCH", who.cookie, body), ctx(participantId));

const bookAtCounter = (who: Staff, body: Record<string, unknown>) => bookingsRoute.POST(req("http://localhost/api/bookings", "POST", who.cookie, body));

/** A child the venue added at the counter, with their mother on record by name and number. */
async function knownChild(displayName: string) {
  const mumPhone = phone();
  const made = await createAtVenue({
    venueId: venue,
    admin: { id: manager.id, name: manager.name },
    displayName,
    birthYear: 2016,
    guardian: { name: "Puan Aminah", phone: mumPhone, relationship: "parent", authority: true },
  });
  if (!made.ok) throw new Error(made.error);
  return { id: made.participant.id, mumPhone };
}

const count = async (sql: string, ...args: unknown[]) => ((await getDb().prepare(sql).get(...args)) as { n: number }).n;

beforeAll(async () => {
  const make = async (name: string, ph: string) => {
    const v = await createVenue({ name, area: "Bangsar", address: "x", phone: ph, openMin: at(7), closeMin: at(23) });
    if (!v.ok) throw new Error("venue");
    return v.venue.id;
  };
  venue = await make("Guardian Centre", "0312350501");
  otherVenue = await make("Elsewhere Centre", "0312350502");
  const r = await createResources({ venueId: venue, sport: "badminton", name: "Hall A", offPeakRate: 20, peakRate: 20, capacity: 1 });
  if (!r.ok) throw new Error(r.error);
  hall = r.courts[0].id;
  const l = await createResources({ venueId: venue, sport: "archery", name: "Lane A", offPeakRate: 20, peakRate: 20, capacity: 1 });
  if (!l.ok) throw new Error(l.error);
  lane = l.courts[0].id;
  expect(lane).toBeGreaterThan(0);
  const s = await saveRequirement(venue, { sport: "archery", declaration: "My child will follow the range officer's calls.", validDays: 365, guardianCheck: true });
  if (!s.ok) throw new Error(s.error);
  expect((await setHouseRules(venue, { aheadDays: 45 })).ok).toBe(true);
  manager = await staffMember(venue, "Mona Manager");
  desk = await staffMember(venue, "Dewi Desk", "desk");
  otherManager = await staffMember(otherVenue, "Omar Other");
});

describe("a second guardian at the counter, on the existing participant", () => {
  it("front desk records the adult's declaration; the booking with their number then goes through; no new participant", async () => {
    const kid = await knownChild("Irfan");
    const dadPhone = phone();
    const booking = { courtId: hall, date: day(5), start: at(9), end: at(10), name: "Encik Rahman", phone: dadPhone, participantIds: [kid.id] };
    // Before: the father's number is nobody's guardian here.
    const before = await bookAtCounter(desk, booking);
    expect(before.status).toBe(409);
    expect(((await before.json()) as { code: string }).code).toBe("PBK_NOT_GUARDIAN");

    const participants = await count("SELECT COUNT(*)::int AS n FROM participants");
    const messages = await count("SELECT COUNT(*)::int AS n FROM messages");
    const res = await addGuardian(desk, kid.id, { venueId: venue, guardianName: "Encik Rahman", guardianPhone: dadPhone, relationship: "parent", authority: true });
    expect(res.status).toBe(201);

    // The same child, now with two guardians; nobody new.
    expect(await count("SELECT COUNT(*)::int AS n FROM participants")).toBe(participants);
    const rows = (await getDb()
      .prepare(
        "SELECT contact_name, contact_phone, user_id, relationship, provenance, recorded_by_admin_id, recorded_by_name, venue_id, revoked_at FROM participant_guardians WHERE participant_id = ? ORDER BY id"
      )
      .all(kid.id)) as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ contact_name: "Puan Aminah", revoked_at: null });
    expect(rows[1]).toMatchObject({
      contact_name: "Encik Rahman",
      contact_phone: dadPhone,
      user_id: null,
      relationship: "parent",
      provenance: "counter",
      recorded_by_admin_id: desk.id,
      recorded_by_name: "Dewi Desk",
      venue_id: venue,
      revoked_at: null,
    });

    // On record: the participant's history and the activity log name the member of staff, the participant and the venue.
    const history = await participantHistory(kid.id);
    expect(history.find((e) => e.action === "guardian.added")).toMatchObject({ actorName: "Dewi Desk", venueId: venue });
    expect(history.find((e) => e.action === "guardian.added")?.detail).toContain("Encik Rahman declared parent");
    const log = await listActivity([venue], {});
    const entry = log.find((e) => e.action === "participant.guardian_added" && (e.detail ?? "").includes(`participant ${kid.id}`));
    expect(entry).toMatchObject({ adminName: "Dewi Desk", venueId: venue });
    expect(entry?.detail).toContain("Irfan");
    expect(entry?.detail).toContain("1 other guardian(s) on record");
    // The first guardian is not told: nothing in the product tells a guardian about a relationship change.
    expect(await count("SELECT COUNT(*)::int AS n FROM messages")).toBe(messages);

    // Now the booking with the father's number goes through, for the same child.
    const after = await bookAtCounter(desk, booking);
    expect(after.status).toBe(201);
    const { booking: made } = (await after.json()) as { booking: { id: number; participantName: string } };
    expect(made.participantName).toBe("Irfan");
    expect(await count("SELECT COUNT(*)::int AS n FROM booking_participants WHERE booking_id = ? AND participant_id = ?", made.id, kid.id)).toBe(1);
    // And the mother's still does.
    const mum = await bookAtCounter(desk, { ...booking, start: at(11), end: at(12), name: "Puan Aminah", phone: kid.mumPhone });
    expect(mum.status).toBe(201);
  });

  it("is refused without the adult's declaration, without a name or number, and twice on one number", async () => {
    const kid = await knownChild("Jannah");
    const dadPhone = phone();
    const base = { venueId: venue, guardianName: "Encik Salleh", guardianPhone: dadPhone, relationship: "parent" };
    for (const [body, code] of [
      [base, "PTC_COUNTER_AUTHORITY"],
      [{ ...base, authority: false }, "PTC_COUNTER_AUTHORITY"],
      [{ ...base, authority: true, relationship: "uncle" }, "GUARD_RELATIONSHIP_NEEDED"],
      [{ ...base, authority: true, guardianName: "" }, "PTC_GUARDIAN_NAME"],
      [{ ...base, authority: true, guardianPhone: "12" }, "PTC_GUARDIAN_PHONE"],
    ] as const) {
      const res = await addGuardian(desk, kid.id, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe(code);
    }
    expect(await count("SELECT COUNT(*)::int AS n FROM participant_guardians WHERE participant_id = ?", kid.id)).toBe(1);
    // Still nobody's guardian: the booking is refused.
    const res = await bookAtCounter(desk, { courtId: hall, date: day(6), start: at(9), end: at(10), name: "Encik Salleh", phone: dadPhone, participantIds: [kid.id] });
    expect(((await res.json()) as { code: string }).code).toBe("PBK_NOT_GUARDIAN");
    // Somebody on the number already acts for her: nothing to add.
    const again = await addGuardian(desk, kid.id, { ...base, guardianPhone: kid.mumPhone, authority: true });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe("PTC_GUARDIAN_ON_NUMBER");
  });

  it("another venue's staff reach nothing", async () => {
    const kid = await knownChild("Khalid");
    const body = { guardianName: "Encik Tan", guardianPhone: phone(), relationship: "parent", authority: true };
    // Not their venue.
    const notTheirs = await addGuardian(otherManager, kid.id, { ...body, venueId: venue });
    expect(notTheirs.status).toBe(403);
    // Their own venue does not know him.
    const unknown = await addGuardian(otherManager, kid.id, { ...body, venueId: otherVenue });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { code: string }).code).toBe("PTC_NOT_FOUND");
    expect(await count("SELECT COUNT(*)::int AS n FROM participant_guardians WHERE participant_id = ?", kid.id)).toBe(1);
  });
});

describe("a guardian's account, added at the counter by a manager", () => {
  it("front desk may not; a manager with a reason may; the account then acts for the child online", async () => {
    const kid = await knownChild("Lina");
    const dad = await adult("Encik Lim");
    const body = { venueId: venue, action: "addGuardian", email: dad.email, relationship: "parent", authority: true, reason: "Her father, at the counter with her" };
    const byDesk = await patch(desk, kid.id, body);
    expect(byDesk.status).toBe(403);
    expect(((await byDesk.json()) as { code: string }).code).toBe("MANAGER_ONLY");
    const noReason = await patch(manager, kid.id, { ...body, reason: "" });
    expect(((await noReason.json()) as { code: string }).code).toBe("PTC_REASON_NEEDED");
    const noDeclaration = await patch(manager, kid.id, { ...body, authority: undefined });
    expect(((await noDeclaration.json()) as { code: string }).code).toBe("PTC_COUNTER_AUTHORITY");
    const nobody = await patch(manager, kid.id, { ...body, email: "nobody@cg.test" });
    expect(((await nobody.json()) as { code: string }).code).toBe("PTC_NO_ACCOUNT");
    // Not yet his: not among the people he manages.
    const peopleBefore = (await (await peopleRoute.GET(req("http://localhost/api/my/people", "GET", dad.cookie))).json()) as { people: { id: number }[] };
    expect(peopleBefore.people.map((p) => p.id)).not.toContain(kid.id);

    const res = await patch(manager, kid.id, body);
    expect(res.status).toBe(201);
    const row = (await getDb()
      .prepare("SELECT user_id, contact_name, contact_phone, provenance, recorded_by_name, venue_id, note FROM participant_guardians WHERE participant_id = ? AND user_id = ?")
      .get(kid.id, dad.id)) as Record<string, unknown>;
    expect(row).toMatchObject({ user_id: dad.id, contact_name: null, contact_phone: null, provenance: "counter", recorded_by_name: "Mona Manager", venue_id: venue, note: body.reason });
    const peopleAfter = (await (await peopleRoute.GET(req("http://localhost/api/my/people", "GET", dad.cookie))).json()) as { people: { id: number }[] };
    expect(peopleAfter.people.map((p) => p.id)).toContain(kid.id);
    const log = await listActivity([venue], {});
    expect(log.some((e) => e.action === "participant.guardian_added" && e.adminName === "Mona Manager" && (e.detail ?? "").includes("Lina"))).toBe(true);
    // Twice: refused.
    const twice = await patch(manager, kid.id, body);
    expect(((await twice.json()) as { code: string }).code).toBe("PTC_GUARDIAN_ALREADY");

    // An activity that asks staff to review the adult's authority still asks: a counter declaration is not that review.
    const applied = await apply(dad, { venueId: venue, sport: "archery", declaration: true, forPerson: kid.id, authority: true });
    if (!applied.ok) throw new Error(applied.error);
    expect(applied.request.guardianCheck).toBe(true);
    expect(await decide({ kind: "staff", admin: { id: manager.id, name: manager.name } }, applied.request.id, "approve", { venueId: venue })).toMatchObject({
      ok: false,
      code: "APR_CHILD_AUTHORITY_UNREVIEWED",
    });
  });

  it("never the participant's own login", async () => {
    const kid = await knownChild("Maya");
    const own = await adult("Maya Own");
    const linked = await linkByStaff({ venueId: venue, participantId: kid.id, email: own.email, admin: { id: manager.id, name: manager.name }, reason: "Her own login, she asked" });
    expect(linked.ok).toBe(true);
    const res = await patch(manager, kid.id, { venueId: venue, action: "addGuardian", email: own.email, relationship: "other", authority: true, reason: "Trying it on" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("PTC_GUARDIAN_OWN_LOGIN");
  });
});

describe("at the same moment (real concurrency on Postgres)", () => {
  it("the same adult recorded from two counters at once: one relationship, never two", async () => {
    const kid = await knownChild("Nadia");
    const dadPhone = phone();
    const dad = await adult("Encik Nordin");
    const admin = { id: desk.id, name: desk.name };
    const byNumber = await Promise.all(
      Array.from({ length: 6 }, () =>
        addGuardianAtVenue({ venueId: venue, participantId: kid.id, admin, guardian: { name: "Encik Nordin", phone: dadPhone, relationship: "parent", authority: true } })
      )
    );
    expect(byNumber.filter((r) => r.ok)).toHaveLength(1);
    expect(byNumber.every((r) => r.ok || r.code === "PTC_GUARDIAN_ON_NUMBER")).toBe(true);
    const byAccount = await Promise.all(
      Array.from({ length: 6 }, () =>
        addGuardianAtVenue({ venueId: venue, participantId: kid.id, admin, guardian: { email: dad.email, relationship: "parent", authority: true }, reason: "Father, in person" })
      )
    );
    expect(byAccount.filter((r) => r.ok)).toHaveLength(1);
    expect(byAccount.every((r) => r.ok || r.code === "PTC_GUARDIAN_ALREADY")).toBe(true);
    // The mother, the father by number, the father's account.
    expect(await count("SELECT COUNT(*)::int AS n FROM participant_guardians WHERE participant_id = ? AND revoked_at IS NULL", kid.id)).toBe(3);
  });
});
