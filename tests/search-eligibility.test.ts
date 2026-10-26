import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { createAdmin } from "../src/lib/admin-auth";
import { apply, decide, saveRequirement, type Reviewer } from "../src/lib/approvals";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { savePolicy } from "../src/lib/booking-policy";
import { getDb, resetTransactionStats, transactionStats, withTransaction } from "../src/lib/db";
import { eligibilityAt, readTaking, type EligibilityLine } from "../src/lib/eligibility";
import { addManaged } from "../src/lib/managed-people";
import { revokeGuardianship, guardianshipOf } from "../src/lib/participants";
import { createResources } from "../src/lib/resources";
import { addSignOff, revokeSignOff } from "../src/lib/sign-offs";
import { createBookingSeries, createVenue, searchAvailability, type SearchResult } from "../src/lib/store";
import { addDays, dayOfWeek, todayISO } from "../src/lib/time";
import * as searchRoute from "../src/app/api/search/route";
import * as availabilityRoute from "../src/app/api/availability/route";

/**
 * Who may book an activity that needs the venue's approval, as search shows
 * it (lib/eligibility.ts; docs/features/discovery.md#who-is-taking-part).
 * Anonymous: the requirement only. Signed in and somebody chosen: each one's
 * status, from what is recorded, with the same rule and scope booking uses;
 * never presented as eligible when anybody chosen is not. Informational:
 * booking checks again. One query for the page, none for anybody else, and
 * an answer no shared cache keeps.
 */

const AREA = "Elig Tengah";
let n = 0;
const phone = () => `0169${String(++n).padStart(6, "0")}`;

/** A weekday ahead, 10 AM. */
let date = addDays(todayISO(), 5);
while ([0, 6].includes(dayOfWeek(date))) date = addDays(date, 1);
const AT = 10 * 60;

let business: number;
/** X and Z: branches of one business. Y: unrelated. */
let X: number;
let Y: number;
let Z: number;
let laneX: number;
let laneY: number;
let laneZ: number;
let staff: { id: number; name: string };
const reviewer = (): Reviewer => ({ kind: "staff", admin: staff });

type Adult = Awaited<ReturnType<typeof adult>>;
async function adult(name = "Adult") {
  const made = await registerUser({ name: `${name} ${++n}`, email: `el${n}@elig.test`, phone: phone(), password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now') WHERE id = ?").run(made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

async function child(parent: Adult, displayName: string) {
  const made = await addManaged(parent.id, { displayName, relationship: "parent", authority: true }, parent.name);
  if (!made.ok) throw new Error(`${made.code}: ${made.error}`);
  return made.person.id;
}

const signOff = async (venueId: number, who: Adult, extra: Partial<Parameters<typeof addSignOff>[0]> = {}) => {
  const made = await addSignOff({ venueId, sport: "archery", phone: who.phone, name: who.name, adminId: staff.id, ...extra });
  if (!made.ok) throw new Error(made.error);
  return made.signOff.id;
};

const search = (taking?: { userId: number; self?: boolean; participants?: number[] }) =>
  searchAvailability({
    sport: "archery",
    date,
    area: AREA,
    fromMin: AT,
    toMin: AT,
    ...(taking ? { taking: { userId: taking.userId, self: taking.self ?? false, participants: taking.participants ?? [] } } : {}),
  });
const at = async (venueId: number, taking?: Parameters<typeof search>[0]): Promise<SearchResult> => (await search(taking)).find((r) => r.venue.id === venueId)!;
const me = async (who: Adult, venueId = X): Promise<EligibilityLine[] | undefined> => (await at(venueId, { userId: who.id, self: true })).eligibility;

beforeAll(async () => {
  business = ((await getDb().prepare("INSERT INTO businesses (name) VALUES ('Elig Archery Group') RETURNING id").get()) as { id: number }).id;
  const make = async (name: string, ph: string, inBusiness: boolean) => {
    const v = await createVenue({ name, area: AREA, address: "x", phone: ph, openMin: 7 * 60, closeMin: 23 * 60 });
    if (!v.ok) throw new Error("venue");
    if (inBusiness) await getDb().prepare("UPDATE venues SET business_id = ? WHERE id = ?").run(business, v.venue.id);
    return v.venue.id;
  };
  X = await make("Range X", "0312347101", true);
  Z = await make("Range Z", "0312347102", true);
  Y = await make("Range Y", "0312347103", false);
  const lane = async (venueId: number, name: string, rate = 20) => {
    const r = await createResources({ venueId, sport: "archery", name, offPeakRate: rate, peakRate: rate, capacity: 1 });
    if (!r.ok) throw new Error(r.error);
    return r.courts[0].id;
  };
  laneX = await lane(X, "Lane X");
  laneY = await lane(Y, "Lane Y");
  laneZ = await lane(Z, "Lane Z");
  for (const c of [laneX, laneY, laneZ]) await savePolicy({ court: c }, { signOff: true });
  const admin = await createAdmin({ name: "Rina Range", email: "rina@elig.test", password: "a long enough password", venueId: X });
  if (!admin.ok) throw new Error(admin.error);
  staff = { id: admin.admin.id, name: "Rina Range" };
  // Applications at X: a declaration, then an in-person briefing.
  const req = await saveRequirement(X, { sport: "archery", declaration: "I will follow the range officer's calls.", inPerson: "A range briefing", validDays: 365 });
  if (!req.ok) throw new Error(req.error);
});

describe("anonymous", () => {
  it("shows the requirement only, and nothing worked out for anybody", async () => {
    const r = await at(X);
    expect(r.needs).toBe("signOff");
    expect(r).not.toHaveProperty("eligibility");
  });
});

describe("a signed-in adult booking for themself", () => {
  it("is eligible with their own sign-off in force", async () => {
    const a = await adult();
    await signOff(X, a);
    expect(await me(a)).toEqual([{ participant: null, status: "eligible" }]);
  });

  it("needs approval without one", async () => {
    const a = await adult();
    expect(await me(a)).toEqual([{ participant: null, status: "required" }]);
  });

  it("follows their application: pending, more information asked, the in-person step due", async () => {
    const a = await adult();
    const made = await apply(a, { venueId: X, sport: "archery", declaration: true, adult: true });
    if (!made.ok) throw new Error(made.error);
    expect(await me(a)).toEqual([{ participant: null, status: "pending" }]);
    expect(await decide(reviewer(), made.request.id, "ask", { venueId: X, reason: "Where did you shoot before?" })).toMatchObject({ ok: true });
    expect(await me(a)).toEqual([{ participant: null, status: "info" }]);
    // Answered, then the online part accepted: the briefing is still to come.
    await getDb().prepare("UPDATE approval_requests SET status = 'pending' WHERE id = ?").run(made.request.id);
    expect(await decide(reviewer(), made.request.id, "approve", { venueId: X })).toMatchObject({ ok: true, request: { status: "in_person_due" } });
    expect(await me(a)).toEqual([{ participant: null, status: "inPerson" }]);
    // The briefing recorded: approved, and the sign-off it writes counts.
    expect(await decide(reviewer(), made.request.id, "in_person", { venueId: X })).toMatchObject({ ok: true, request: { status: "approved" } });
    expect(await me(a)).toEqual([{ participant: null, status: "eligible" }]);
    // An application at X says nothing at Y.
    expect(await me(a, Y)).toEqual([{ participant: null, status: "required" }]);
  });

  it("says expired once it ran out before the day, and required once it was taken back", async () => {
    const a = await adult();
    await signOff(X, a, { expiresOn: addDays(todayISO(), 1) });
    expect(await me(a)).toEqual([{ participant: null, status: "expired" }]);
    const b = await adult();
    const id = await signOff(X, b);
    expect(await me(b)).toEqual([{ participant: null, status: "eligible" }]);
    expect(await revokeSignOff(X, id, { adminId: staff.id, reason: "Unsafe at the line" })).toBe(true);
    expect(await me(b)).toEqual([{ participant: null, status: "required" }]);
  });

  it("is never eligible for another activity on this one's sign-off", async () => {
    const a = await adult();
    await signOff(X, a, { sport: "climbing" });
    expect(await me(a)).toEqual([{ participant: null, status: "required" }]);
  });
});

describe("recognition stays the venue's", () => {
  it("counts a branch's sign-off at that branch alone, and a business's at every branch, never at an unrelated venue", async () => {
    const a = await adult();
    await signOff(X, a);
    expect(await me(a, X)).toEqual([{ participant: null, status: "eligible" }]);
    expect(await me(a, Z)).toEqual([{ participant: null, status: "required" }]);
    expect(await me(a, Y)).toEqual([{ participant: null, status: "required" }]);
    const b = await adult();
    await signOff(X, b, { wholeBusiness: true });
    expect(await me(b, X)).toEqual([{ participant: null, status: "eligible" }]);
    expect(await me(b, Z)).toEqual([{ participant: null, status: "eligible" }]);
    expect(await me(b, Y)).toEqual([{ participant: null, status: "required" }]);
  });

  it("asks a certification for a resource that needs one: a sign-off is not one", async () => {
    const a = await adult();
    await signOff(X, a);
    const status = await eligibilityAt({ taking: { userId: a.id, self: true, participants: [] }, sport: "archery", date, venueIds: [X] });
    expect(status.lines(X, "signOff")).toEqual([{ participant: null, status: "eligible" }]);
    expect(status.lines(X, "certification")).toEqual([{ participant: null, status: "required" }]);
    expect(status.lines(X, null)).toBeUndefined();
    // Nor is a venue it was not asked about answered.
    expect(status.lines(Y, "signOff")).toBeUndefined();
    await signOff(X, a, { kind: "certification", reference: "WA-2231 (World Archery)", expiresOn: addDays(todayISO(), 90) });
    const again = await eligibilityAt({ taking: { userId: a.id, self: true, participants: [] }, sport: "archery", date, venueIds: [X] });
    expect(again.lines(X, "certification")).toEqual([{ participant: null, status: "eligible" }]);
  });
});

describe("a guardian choosing who is taking part", () => {
  let mum: Adult;
  let aisha: number;
  let ben: number;

  beforeAll(async () => {
    mum = await adult("Mum");
    aisha = await child(mum, "Aisha");
    ben = await child(mum, "Ben");
    // Aisha was briefed at X, on her mother's number; Ben was not; the mother has nothing of her own.
    await signOff(X, mum, { name: "Aisha", managedPersonId: aisha });
  });

  it("shows the chosen child's own status, child A or child B", async () => {
    expect((await at(X, { userId: mum.id, participants: [aisha] })).eligibility).toEqual([{ participant: aisha, status: "eligible" }]);
    expect((await at(X, { userId: mum.id, participants: [ben] })).eligibility).toEqual([{ participant: ben, status: "required" }]);
  });

  it("shows each of several, and never the booking as eligible when one is not", async () => {
    const lines = (await at(X, { userId: mum.id, participants: [aisha, ben] })).eligibility!;
    expect(lines).toEqual([
      { participant: aisha, status: "eligible" },
      { participant: ben, status: "required" },
    ]);
    expect(lines.every((l) => l.status === "eligible")).toBe(false);
    // With herself too: a child's sign-off is not the mother's, on her number or not.
    expect((await at(X, { userId: mum.id, self: true, participants: [aisha] })).eligibility).toEqual([
      { participant: null, status: "required" },
      { participant: aisha, status: "eligible" },
    ]);
  });

  it("follows a child's application, and keeps the mother's own apart", async () => {
    const made = await apply(mum, { venueId: X, sport: "archery", declaration: true, forPerson: ben, authority: true });
    if (!made.ok) throw new Error(made.error);
    expect((await at(X, { userId: mum.id, self: true, participants: [ben] })).eligibility).toEqual([
      { participant: null, status: "required" },
      { participant: ben, status: "pending" },
    ]);
    await getDb().prepare("UPDATE approval_requests SET status = 'withdrawn' WHERE id = ?").run(made.request.id);
  });

  it("says nothing about somebody the account does not act for", async () => {
    const stranger = await adult("Stranger");
    expect((await at(X, { userId: stranger.id, participants: [aisha] })).eligibility).toEqual([]);
    expect((await at(X, { userId: stranger.id, self: true, participants: [aisha] })).eligibility).toEqual([{ participant: null, status: "required" }]);
    // A guardian whose relationship was revoked acts for nobody.
    const dad = await adult("Dad");
    const kid = await child(dad, "Chen");
    await signOff(X, dad, { name: "Chen", managedPersonId: kid });
    expect((await at(X, { userId: dad.id, participants: [kid] })).eligibility).toEqual([{ participant: kid, status: "eligible" }]);
    const g = await guardianshipOf(dad.id, kid);
    expect(await revokeGuardianship(g!.guardianship.id, { venueId: X, participantId: kid, admin: { id: staff.id, name: staff.name } }, "Court order")).toMatchObject({ ok: true });
    expect((await at(X, { userId: dad.id, participants: [kid] })).eligibility).toEqual([]);
  });
});

describe("informational only: booking checks again", () => {
  const book = (who: Adult, courtId: number, participants?: { id: number; name: string }[]) =>
    createBookingSeries({ by: "customer", courtId, date, start: AT, end: AT + 60, weeks: 1, name: who.name, phone: who.phone, userId: who.id, ...(participants ? { participants } : {}) });

  it("refuses a booking once the sign-off behind an 'eligible' badge is taken back", async () => {
    const a = await adult();
    const id = await signOff(Y, a);
    expect(await me(a, Y)).toEqual([{ participant: null, status: "eligible" }]);
    await revokeSignOff(Y, id, { adminId: staff.id, reason: "Taken back" });
    expect(await book(a, laneY)).toMatchObject({ ok: false, code: "SIGN_OFF_NEEDED" });
  });

  it("refuses a booking once the sign-off behind an 'eligible' badge has run out", async () => {
    const mum = await adult("Mum");
    const kid = await child(mum, "Dina");
    const id = await signOff(Z, mum, { name: "Dina", managedPersonId: kid, expiresOn: addDays(date, 10) });
    expect((await at(Z, { userId: mum.id, participants: [kid] })).eligibility).toEqual([{ participant: kid, status: "eligible" }]);
    // Time passes: it ran out yesterday.
    await getDb().prepare("UPDATE sign_offs SET expires_on = ? WHERE id = ?").run(addDays(todayISO(), -1), id);
    expect(await book(mum, laneZ, [{ id: kid, name: "Dina" }])).toMatchObject({ ok: false, code: "SIGN_OFF_NEEDED_FOR", vars: { name: "Dina" } });
  });
});

describe("cost", () => {
  it("adds exactly one query for the page when personalised, and none for anybody else", async () => {
    const a = await adult();
    const kid = await child(a, "Eli");
    resetTransactionStats();
    await search();
    const anonymous = transactionStats().queries;
    resetTransactionStats();
    const found = await search({ userId: a.id, self: true, participants: [kid] });
    expect(transactionStats().queries).toBe(anonymous + 1);
    // Every result asked about, from that one query.
    expect(found.filter((r) => r.needs).every((r) => r.eligibility?.length === 2)).toBe(true);
    resetTransactionStats();
    await search();
    expect(transactionStats().queries).toBe(anonymous);
    // Nothing on the page asks for anything (archery asks for a sign-off unless the venue says otherwise): no query at all.
    for (const c of [laneX, laneY, laneZ]) await savePolicy({ court: c }, { signOff: false });
    try {
      await search();
      resetTransactionStats();
      await search();
      const nothingAsked = transactionStats().queries;
      resetTransactionStats();
      const plain = await search({ userId: a.id, self: true, participants: [kid] });
      expect(transactionStats().queries).toBe(nothingAsked);
      expect(plain.some((r) => r.eligibility)).toBe(false);
    } finally {
      for (const c of [laneX, laneY, laneZ]) await savePolicy({ court: c }, { signOff: true });
    }
  });

  it("finds sign-offs and applications by index, not by reading the tables", async () => {
    const a = await adult();
    const kid = await child(a, "Faiz");
    const db = getDb();
    // A busy marketplace: thousands of other people's sign-offs and applications at these venues.
    await db
      .prepare(
        `INSERT INTO sign_offs (venue_id, sport, phone, name, kind, expires_on)
         SELECT (ARRAY[?, ?, ?]::integer[])[1 + g % 3], 'archery', '0170' || lpad(g::text, 6, '0'), 'Other ' || g, 'operational', NULL
           FROM generate_series(1, 3000) g`
      )
      .run(X, Y, Z);
    await db.prepare("ANALYZE sign_offs").run();
    await db.prepare("ANALYZE approval_requests").run();
    const prepare = db.prepare;
    const seen: { sql: string; params: unknown[] }[] = [];
    db.prepare = ((sql: string) => {
      const real = prepare.call(db, sql);
      return { get: real.get, run: real.run, all: (...p: unknown[]) => (seen.push({ sql, params: p }), real.all(...p)) };
    }) as typeof db.prepare;
    try {
      await eligibilityAt({ taking: { userId: a.id, self: true, participants: [kid] }, sport: "archery", date, venueIds: [X, Y, Z] });
    } finally {
      db.prepare = prepare;
    }
    expect(seen).toHaveLength(1);
    const steps = await withTransaction(async () => {
      await db.prepare("SET LOCAL enable_seqscan = off").run();
      const [row] = (await db.prepare(`EXPLAIN (FORMAT JSON) ${seen[0].sql}`).all(...seen[0].params)) as { "QUERY PLAN": { Plan: Plan }[] }[];
      const out: string[] = [];
      const bitmapReads = (node: Plan): Plan[] => (node["Node Type"] === "Bitmap Index Scan" ? [node] : (node.Plans ?? []).flatMap(bitmapReads));
      // Each read of either table: by an index condition on the person (a person's rows), never the whole table or
      // the whole index. The venue's unique index starts with the venue, so a number found through it reads all of it.
      const walk = (node: Plan) => {
        const table = node["Relation Name"];
        if (table && ["sign_offs", "approval_requests"].includes(table)) {
          const reads = node["Node Type"] === "Bitmap Heap Scan" ? (node.Plans ?? []).flatMap(bitmapReads) : [node];
          const whole = reads.some((r) => !r["Index Cond"] || r["Index Name"] === "uq_sign_offs_live");
          out.push(`${table}: ${node["Node Type"]}${whole ? " (whole)" : ""}`);
        }
        node.Plans?.forEach(walk);
      };
      walk(row["QUERY PLAN"][0].Plan);
      return out;
    });
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.filter((s) => s.includes("Seq Scan") || s.includes("(whole)"))).toEqual([]);
  });
});

type Plan = { "Node Type": string; "Relation Name"?: string; "Index Name"?: string; "Index Cond"?: string; Plans?: Plan[] };

describe("the routes", () => {
  const get = (route: typeof searchRoute | typeof availabilityRoute, url: string, cookie?: string) =>
    route.GET(new NextRequest(url, { headers: { "x-forwarded-for": `10.88.${++n % 250}.1`, ...(cookie ? { cookie } : {}) } }));
  const searchUrl = (extra = "") => `http://localhost/api/search?sport=archery&date=${date}&from=10:00&to=10:00&area=${encodeURIComponent(AREA)}${extra}`;

  it("answers a personalised search privately, and an anonymous one after it with nothing personal", async () => {
    const a = await adult();
    await signOff(X, a);
    const mine = await get(searchRoute, searchUrl("&taking=self"), a.cookie);
    expect(mine.status).toBe(200);
    expect(mine.headers.get("cache-control")).toBe("private, no-store");
    expect(mine.headers.get("vary")).toContain("Cookie");
    const body = await mine.json();
    expect(body.results.find((r: SearchResult) => r.venue.id === X).eligibility).toEqual([{ participant: null, status: "eligible" }]);
    // Somebody else, signed out, asking the very same address: the requirement only.
    const theirs = await get(searchRoute, searchUrl("&taking=self"));
    expect(theirs.headers.get("cache-control")).toBe("private, no-store");
    const text = await theirs.text();
    expect(text).not.toContain("eligibility");
    expect(JSON.parse(text).results.find((r: SearchResult) => r.venue.id === X).needs).toBe("signOff");
    // The public search is as it always was: not marked private.
    const plain = await get(searchRoute, searchUrl());
    expect(plain.headers.get("cache-control") ?? "").not.toContain("private");
    expect(await plain.text()).not.toContain("eligibility");
    // Signed in, nobody chosen: nothing worked out either.
    expect(await (await get(searchRoute, searchUrl(), a.cookie)).text()).not.toContain("eligibility");
  });

  it("refuses nothing for a malformed choice, and works nothing out from it", async () => {
    const a = await adult();
    const res = await get(searchRoute, searchUrl("&taking=everyone"), a.cookie);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("eligibility");
    expect(readTaking("self,12,12", 1)).toEqual({ userId: 1, self: true, participants: [12] });
    expect(readTaking("", 1)).toBeNull();
    expect(readTaking("-3", 1)).toBeNull();
  });

  it("labels the venue's grid for who is taking part, privately", async () => {
    const mum = await adult("Mum");
    const kid = await child(mum, "Gita");
    await signOff(X, mum, { name: "Gita", managedPersonId: kid });
    const url = `http://localhost/api/availability?venueId=${X}&date=${date}&sport=archery`;
    const res = await get(availabilityRoute, `${url}&taking=self,${kid}`, mum.cookie);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.eligibility).toEqual({
      signOff: [
        { participant: null, status: "required" },
        { participant: kid, status: "eligible" },
      ],
    });
    expect(body.availability.find((a: { court: { id: number } }) => a.court.id === laneX).policy.needs).toBe("signOff");
    const anon = await get(availabilityRoute, `${url}&taking=self,${kid}`);
    expect(await anon.text()).not.toContain("eligibility");
  });

  it("keeps any signed-in answer out of shared caches, with or without who is taking part", async () => {
    // A signed-in account's grid can carry its member rates; a shared cache must never hand it to somebody else.
    const mum = await adult("Mum");
    const url = `http://localhost/api/availability?venueId=${X}&date=${date}&sport=archery`;
    const signedIn = await get(availabilityRoute, url, mum.cookie);
    expect(signedIn.headers.get("cache-control")).toBe("private, no-store");
    expect(signedIn.headers.get("vary")).toContain("Cookie");
    const signedOut = await get(availabilityRoute, url);
    expect(signedOut.headers.get("cache-control")).not.toBe("private, no-store");
    expect(signedOut.headers.get("vary")).toContain("Cookie");
  });
});
