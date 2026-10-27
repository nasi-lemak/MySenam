import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { addManaged } from "../src/lib/managed-people";
import { participantAtVenue, participantsForVenue, visibleToVenue } from "../src/lib/participants";
import { createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as participantsRoute from "../src/app/api/admin/participants/route";

/**
 * Which venue knows a participant (lib/participants.ts `KNOWN_TO`): besides
 * being recorded there, or a booking, approval, sign-off, induction or
 * waiver there, a concession proof seen there, a membership or pass sold
 * there that they hold, and a family membership there that names them. Each
 * of those makes them known to that venue and its business's other
 * branches, and to no other venue.
 */

let n = 0;
const phone = () => `0177${String(++n).padStart(6, "0")}`;
let home: number;
let branch: number;
let elsewhere: number;
let homeManager: string;
let elsewhereManager: string;

async function staff(venueId: number, name: string) {
  const made = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}${++n}@known.test`, password: "a long enough password", venueId });
  if (!made.ok) throw new Error(made.error);
  return `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}`;
}

/** A child an adult manages from their own account, known to no venue yet. */
async function child() {
  const ph = phone();
  const made = await registerUser({ name: `Parent ${++n}`, email: `kp${n}@known.test`, phone: ph, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  const kid = await addManaged(made.user.id, { displayName: `Kid ${n}`, relationship: "parent", authority: true }, made.user.name);
  if (!kid.ok) throw new Error(kid.error);
  return { id: kid.person.id, phone: ph, name: made.user.name };
}

const lookup = (cookie: string, venueId: number, ph: string) =>
  participantsRoute.GET(
    new NextRequest(`http://localhost/api/admin/participants?venueId=${venueId}&phone=${encodeURIComponent(ph)}`, {
      headers: { cookie, "x-forwarded-for": `10.77.${++n % 250}.1` },
    })
  );

/** Known where, of the three venues. */
const knownAt = async (participantId: number) => ({
  home: await visibleToVenue(home, participantId),
  branch: await visibleToVenue(branch, participantId),
  elsewhere: await visibleToVenue(elsewhere, participantId),
});

beforeAll(async () => {
  const make = async (name: string, ph: string) => {
    const v = await createVenue({ name, area: "Cheras", address: "x", phone: ph, openMin: 7 * 60, closeMin: 23 * 60 });
    if (!v.ok) throw new Error("venue");
    return v.venue.id;
  };
  home = await make("Known Hall", "0312345501");
  branch = await make("Known Hall Two", "0312345502");
  elsewhere = await make("Other Hall", "0312345503");
  const business = ((await getDb().prepare("INSERT INTO businesses (name) VALUES ('Known Group') RETURNING id").get()) as { id: number }).id;
  await getDb().prepare("UPDATE venues SET business_id = ? WHERE id IN (?, ?)").run(business, home, branch);
  homeManager = await staff(home, "Hana Home");
  elsewhereManager = await staff(elsewhere, "Edi Elsewhere");
});

const until = () => addDays(todayISO(), 60);

describe("a participant linked to a venue only by what it sold or saw (S20)", () => {
  it("is known to nobody before any link", async () => {
    const kid = await child();
    expect(await knownAt(kid.id)).toEqual({ home: false, branch: false, elsewhere: false });
    expect(await participantsForVenue(home, kid.phone)).toEqual([]);
  });

  it("a concession proof seen at the venue", async () => {
    const kid = await child();
    const concession = (await getDb()
      .prepare("INSERT INTO concessions (venue_id, name, percent, proof) VALUES (?, 'Junior', 20, 'school card') RETURNING id")
      .get(home)) as { id: number };
    await getDb()
      .prepare("INSERT INTO participant_concession_proofs (venue_id, participant_id, concession_id, seen_on, valid_until) VALUES (?, ?, ?, ?, ?)")
      .run(home, kid.id, concession.id, todayISO(), until());
    expect(await knownAt(kid.id)).toEqual({ home: true, branch: true, elsewhere: false });
  });

  it("a membership sold there that they hold", async () => {
    const kid = await child();
    await getDb()
      .prepare(
        `INSERT INTO memberships (code, venue_id, holder_name, holder_phone, starts_on, expires_on, price, holder_kind, holder_participant_id)
         VALUES (?, ?, ?, ?, ?, ?, 50, 'participant', ?)`
      )
      .run(`KM${n}`, home, kid.name, kid.phone, todayISO(), until(), kid.id);
    expect(await knownAt(kid.id)).toEqual({ home: true, branch: true, elsewhere: false });
  });

  it("a family membership sold there that names them", async () => {
    const kid = await child();
    const m = (await getDb()
      .prepare(
        `INSERT INTO memberships (code, venue_id, holder_name, holder_phone, starts_on, expires_on, price)
         VALUES (?, ?, ?, ?, ?, ?, 120) RETURNING id`
      )
      .get(`KF${n}`, home, kid.name, kid.phone, todayISO(), until())) as { id: number };
    await getDb().prepare("INSERT INTO membership_participants (membership_id, participant_id) VALUES (?, ?)").run(m.id, kid.id);
    expect(await knownAt(kid.id)).toEqual({ home: true, branch: true, elsewhere: false });
  });

  it("a pass sold there that they hold, found at the counter by the guardian's number", async () => {
    const kid = await child();
    // Before: the venue's staff find nobody on the number.
    let res = await lookup(homeManager, home, kid.phone);
    expect(res.status).toBe(200);
    expect((await res.json()).participants).toEqual([]);
    await getDb()
      .prepare(
        `INSERT INTO passes (code, venue_id, name, entries, price, holder_name, holder_phone, expires_on, holder_kind, holder_participant_id)
         VALUES (?, ?, 'Ten visits', 10, 80, ?, ?, ?, 'participant', ?)`
      )
      .run(`KP${n}`, home, kid.name, kid.phone, until(), kid.id);
    expect(await knownAt(kid.id)).toEqual({ home: true, branch: true, elsewhere: false });
    res = await lookup(homeManager, home, kid.phone);
    expect((await res.json()).participants.map((p: { id: number }) => p.id)).toEqual([kid.id]);
    expect((await participantAtVenue(home, kid.id))?.id).toBe(kid.id);
    // Another venue's staff: nothing at their own venue, and refused at this one.
    res = await lookup(elsewhereManager, elsewhere, kid.phone);
    expect((await res.json()).participants).toEqual([]);
    expect((await lookup(elsewhereManager, home, kid.phone)).status).toBe(403);
    expect(await participantAtVenue(elsewhere, kid.id)).toBeNull();
  });

  it("each link counts only for the venue it was made at: another venue's sale makes nobody known here", async () => {
    const kid = await child();
    const concession = (await getDb()
      .prepare("INSERT INTO concessions (venue_id, name, percent, proof) VALUES (?, 'Junior', 20, 'school card') RETURNING id")
      .get(elsewhere)) as { id: number };
    await getDb()
      .prepare("INSERT INTO participant_concession_proofs (venue_id, participant_id, concession_id, seen_on, valid_until) VALUES (?, ?, ?, ?, ?)")
      .run(elsewhere, kid.id, concession.id, todayISO(), until());
    await getDb()
      .prepare(
        `INSERT INTO passes (code, venue_id, name, entries, price, holder_name, holder_phone, expires_on, holder_kind, holder_participant_id)
         VALUES (?, ?, 'Ten visits', 10, 80, ?, ?, ?, 'participant', ?)`
      )
      .run(`KQ${n}`, elsewhere, kid.name, kid.phone, until(), kid.id);
    expect(await knownAt(kid.id)).toEqual({ home: false, branch: false, elsewhere: true });
    expect(await participantsForVenue(home, kid.phone)).toEqual([]);
    expect((await participantsForVenue(elsewhere, kid.phone)).map((p) => p.id)).toEqual([kid.id]);
  });
});
