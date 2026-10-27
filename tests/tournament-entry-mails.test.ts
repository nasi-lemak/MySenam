import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { guardianEntrant, isEntrantRefusal } from "../src/lib/competition-entrants";
import { getDb } from "../src/lib/db";
import { addManaged } from "../src/lib/managed-people";
import { createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { reportResult } from "../src/lib/match-reports";
import { cancelTournament, createTournament, enter, enterAs, makeDraw, moveMatch, tournamentDetail, withdraw, type TournamentInput } from "../src/lib/tournaments";

/**
 * A tournament's emails about an entry a guardian made for somebody they act
 * for say whose entry it is (*This entry is for Aina.*), as the entry's own
 * confirmation and a league's emails do: the draw, a match moved, a place
 * come free, the tournament called off, a result the other side reported to
 * confirm. The guardian's own entry is told as
 * before; each in the account's language.
 */

let ownerId: number;
let venueId: number;
let courts: number[];
let n = 0;
let dayOffset = 3;

async function adult(name: string, locale?: "ms"): Promise<User> {
  n++;
  const made = await registerUser({ name, email: `tem${n}@mails.test`, phone: `01371${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  if (locale) await getDb().prepare("UPDATE users SET locale = ? WHERE id = ?").run(locale, made.user.id);
  return made.user;
}

async function entered(parent: User, tournamentId: number, displayName: string): Promise<number> {
  const made = await addManaged(parent.id, { displayName, relationship: "parent", authority: true }, parent.name);
  if (!made.ok) throw new Error(made.error);
  const entrant = await guardianEntrant(parent, made.person.id);
  if (isEntrantRefusal(entrant)) throw new Error(entrant.error);
  const e = await enterAs(entrant, tournamentId);
  if (!e.ok) throw new Error(e.error);
  return e.value.id;
}

async function tournament(maxEntries = 16, format: "knockout" | "round_robin" = "knockout", over: Partial<TournamentInput> = {}) {
  const day = addDays(todayISO(), dayOffset++);
  const made = await createTournament(
    {
      venueId,
      name: `Family Cup ${dayOffset}`,
      sport: "badminton",
      format,
      teamSize: 1,
      level: null,
      entryFee: 0,
      maxEntries,
      startsOn: day,
      endsOn: day,
      startHour: 9,
      endHour: 21,
      courtIds: courts,
      ...over,
    } as TournamentInput,
    ownerId
  );
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

const mail = async (to: string, after = 0) =>
  (await getDb().prepare("SELECT id, subject, body, locale FROM messages WHERE kind = 'programme' AND recipient = ? AND id > ? ORDER BY id").all(to, after)) as {
    id: number;
    subject: string;
    body: string;
    locale: string;
  }[];
const lastId = async () => ((await getDb().prepare("SELECT COALESCE(MAX(id), 0) AS id FROM messages").get()) as { id: number }).id;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const v = await createVenue({ name: "Dewan Keluarga", area: "Cheras", address: "x", phone: "0391110000" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  courts = [];
  for (const name of ["Court 1", "Court 2"]) {
    const c = await createCourt({ venueId, name, sport: "badminton", offPeakRate: 20, peakRate: 30 });
    if (!c.ok) throw new Error("court");
    courts.push(c.court.id);
  }
});

describe("a tournament's emails about an entry made for somebody", () => {
  it("the draw, a match moved and the tournament called off each say whose entry it is; the guardian's own as before", async () => {
    const t = await tournament(16, "round_robin");
    const mum = await adult("Puan Siti");
    const dad = await adult("Encik Rahim", "ms");
    expect(await enter(mum, t.id)).toMatchObject({ ok: true });
    const aina = await entered(mum, t.id, "Aina");
    await entered(mum, t.id, "Hana");
    await entered(dad, t.id, "Zara");

    const before = await lastId();
    expect(await makeDraw(t.id, () => 0.3)).toMatchObject({ ok: true });
    const drawn = (await mail(mum.email, before)).filter((m) => m.subject.startsWith("The draw is made"));
    expect(drawn).toHaveLength(3);
    expect(drawn.filter((m) => m.body.includes("This entry is for Aina.")).length).toBe(1);
    expect(drawn.filter((m) => m.body.includes("This entry is for Hana.")).length).toBe(1);
    // Her own entry: nobody named.
    expect(drawn.filter((m) => !m.body.includes("This entry is for")).length).toBe(1);
    // Whose it is comes first, then what the draw means for it.
    expect(drawn.find((m) => m.body.includes("Aina."))!.body).toMatch(/This entry is for Aina\.\s+(Your first match|You have a bye|The draw for)/);
    const hisDraw = (await mail(dad.email, before)).filter((m) => m.locale === "ms");
    expect(hisDraw).toHaveLength(1);
    expect(hisDraw[0].body).toContain("Penyertaan ini untuk Zara.");

    // Aina's match moved: her guardian is told it is hers.
    const d = (await tournamentDetail(t.id, { forStaff: true }))!;
    const hers = d.matches.find((m) => m.status === "scheduled" && (m.a === aina || m.b === aina) && m.date !== null)!;
    const moving = await lastId();
    const moved = await moveMatch(hers.id, { courtId: hers.courtId === courts[0] ? courts[1] : courts[0], date: hers.date!, startMin: 20 * 60 });
    expect(moved).toMatchObject({ ok: true });
    const told = (await mail(mum.email, moving)).filter((m) => m.subject.startsWith("Your match has moved"));
    expect(told.some((m) => /This entry is for Aina\.\s+.+ is now on .+ at 8:00 PM/.test(m.body))).toBe(true);

    // Called off: one email for each entry, each saying whose.
    const calling = await lastId();
    expect(await cancelTournament(t.id)).toMatchObject({ ok: true });
    const off = (await mail(mum.email, calling)).filter((m) => m.subject.endsWith("is called off"));
    expect(off).toHaveLength(3);
    expect(off.map((m) => (m.body.match(/This entry is for (\w+)\./) ?? [])[1] ?? "own").sort()).toEqual(["Aina", "Hana", "own"]);
  });

  it("a place come free from the waiting list says whose it is", async () => {
    const t = await tournament(2);
    const mum = await adult("Puan Lim");
    const other = await adult("Encik Tan");
    const first = await enter(other, t.id);
    if (!first.ok) throw new Error(first.error);
    expect(await enter(mum, t.id)).toMatchObject({ ok: true });
    await entered(mum, t.id, "Mei");
    const waiting = await lastId();
    expect(await withdraw(first.value.id)).toMatchObject({ ok: true });
    const promoted = (await mail(mum.email, waiting)).filter((m) => m.subject.startsWith("You're in"));
    expect(promoted).toHaveLength(1);
    expect(promoted[0].body).toMatch(/This entry is for Mei\.\s+A place came free/);
  });

  it("a result the other side reported, to confirm, says whose match it is", async () => {
    const t = await tournament(2, "knockout", { resultsBy: "players" } as Partial<TournamentInput>);
    const mum = await adult("Puan Wong");
    const other = await adult("Encik Ong");
    const ali = await entered(mum, t.id, "Ali");
    const theirs = await enter(other, t.id);
    if (!theirs.ok) throw new Error(theirs.error);
    expect(await makeDraw(t.id, () => 0.3)).toMatchObject({ ok: true });
    const final = (await tournamentDetail(t.id))!.matches.find((m) => m.a !== null && m.b !== null)!;
    const reporting = await lastId();
    expect(await reportResult(other.id, final.id, { winner: theirs.value.id, score: "21-15, 21-18" })).toMatchObject({ ok: true });
    const ask = (await mail(mum.email, reporting)).filter((m) => m.subject.startsWith("Confirm your result"));
    expect(ask).toHaveLength(1);
    expect(ask[0].body).toContain("This entry is for Ali.");
    expect([final.a, final.b]).toContain(ali);
  });
});
