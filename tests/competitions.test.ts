import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { saveVenueTemplate, templateByKey, templateFor, templatesFor, venueTemplates } from "../src/lib/competition-templates";
import { aggregate, centreOutLanes, formatMark, parseMark, rankPerformances, seedHeats } from "../src/lib/performance-math";
import { createCourt, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { parseRules, readRules } from "../src/lib/tournament-rules";
import {
  createTournament,
  enter,
  makeDraw,
  makeFinal,
  previewTakeOut,
  recordPerformances,
  recordResult,
  takeOut,
  tournamentDetail,
  type TournamentInput,
} from "../src/lib/tournaments";

/**
 * The competition framework (ADR 0013): sport templates as data, formats
 * beyond knockouts — a round robin, performance events with heats and a
 * final — teams with rosters, and the confirmation a consequential change
 * needs.
 */

let ownerId: number;
let n = 0;
let dayOffset = 3;

async function player(): Promise<User> {
  n++;
  const made = await registerUser({ name: `Swimmer ${n}`, email: `c${n}@comp.my`, phone: `01350${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

async function venueWith(sport: string) {
  let venue = (await listVenues()).find((v) => v.courts.some((c) => c.sport === sport));
  if (!venue) {
    // Not in the demo data (archery): a range of its own at the first venue.
    const made = await createCourt({ venueId: (await listVenues())[0].id, name: `${sport} range`, sport, offPeakRate: 20, peakRate: 30 });
    if (!made.ok) throw new Error(made.error);
    venue = (await listVenues()).find((v) => v.courts.some((c) => c.sport === sport))!;
  }
  return { venueId: venue.id, courtIds: venue.courts.filter((c) => c.sport === sport).slice(0, 1).map((c) => c.id) };
}

async function competition(over: Partial<TournamentInput> & { sport: string }) {
  const day = addDays(todayISO(), dayOffset++);
  const where = await venueWith(over.sport);
  const made = await createTournament(
    {
      ...where,
      name: `Gala ${dayOffset}`,
      format: "performance",
      teamSize: 1,
      level: null,
      entryFee: 0,
      maxEntries: 32,
      startsOn: day,
      endsOn: day,
      startHour: 9,
      endHour: 17,
      ...over,
    } as TournamentInput,
    ownerId
  );
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
});

describe("the arithmetic of performances", () => {
  it("reads times and distances as written, and a foul as no mark", () => {
    expect(parseMark("1:02.35", "time")).toBe(62.35);
    expect(parseMark("62.35", "time")).toBe(62.35);
    expect(parseMark("1:01:02.3", "time")).toBe(3662.3);
    expect(parseMark("1:75.00", "time")).toBeUndefined();
    expect(parseMark("X", "distance")).toBeNull();
    expect(parseMark("7.42", "distance")).toBe(7.42);
    expect(parseMark("seven", "distance")).toBeUndefined();
    expect(formatMark(62.35, "time")).toBe("1:02.35");
    expect(formatMark(9.5, "time")).toBe("9.50");
    expect(formatMark(null, "distance")).toBe("X");
  });

  it("adds up a total only when every attempt is in; takes the best otherwise", () => {
    expect(aggregate([50, 52, 48], { aggregate: "total", better: "higher" })).toBe(150);
    expect(aggregate([50, null, 48], { aggregate: "total", better: "higher" })).toBeNull();
    expect(aggregate([7.1, null, 7.4], { aggregate: "best", better: "higher" })).toBe(7.4);
    expect(aggregate([62.1, 61.9], { aggregate: "best", better: "lower" })).toBe(61.9);
  });

  it("ranks the better first, splits a level best on the next best, and shares a rank still level", () => {
    const ranked = rankPerformances(
      [
        { entryId: 1, status: "ok", attempts: [7.4, 7.0, null], result: 7.4 },
        { entryId: 2, status: "ok", attempts: [7.4, 7.2, 6.0], result: 7.4 },
        { entryId: 3, status: "ok", attempts: [7.1], result: 7.1 },
        { entryId: 4, status: "dns", attempts: [], result: null },
        { entryId: 5, status: "ok", attempts: [7.1], result: 7.1 },
      ],
      { aggregate: "best", better: "higher" }
    );
    expect(ranked.map((r) => [r.entryId, r.rank])).toEqual([
      [2, 1],
      [1, 2],
      [3, 3],
      [5, 3],
      [4, null],
    ]);
  });

  it("lanes the best in the middle, and seeds the best into the last heat, never leaving one alone", () => {
    expect(centreOutLanes(8)).toEqual([4, 5, 3, 6, 2, 7, 1, 8]);
    const heats = seedHeats([1, 2, 3, 4, 5, 6, 7, 8, 9], 8);
    expect(heats.filter((h) => h.heat === 2).map((h) => h.entry)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(heats.filter((h) => h.heat === 1).map((h) => h.entry)).toEqual([9, 8]);
    expect(heats.find((h) => h.entry === 1)!.lane).toBe(4);
  });
});

describe("sport templates", () => {
  it("start each sport from its usual scoring, and stored rules without scoring read as the old defaults", () => {
    expect(templateFor("futsal").key).toBe("goals_league");
    expect(templateFor("table_tennis").rules.scoring.bestOf).toBe(5);
    expect(templateFor("swimming").rules.performance).toMatchObject({ measure: "time", better: "lower" });
    expect(templateFor("an_unknown_activity").key).toBe("custom");
    expect(templatesFor("futsal")[0].key).toBe("goals_league");
    // A tournament stored before scoring was configurable: ranked exactly as then.
    expect(readRules(JSON.stringify({ groupResultsOnWithdrawal: "stand" })).scoring).toEqual({
      kind: "sets",
      bestOf: 3,
      draws: false,
      tablePoints: { win: 1, draw: 0, loss: 0 },
      setPoints: null,
      rankBy: ["wins", "set_diff", "point_diff", "head_to_head"],
      retired: "win_only",
    });
    // An organiser's change is laid over the template, and checked.
    const basketball = templateByKey("basketball_points")!.rules;
    const changed = parseRules({ scoring: { tablePoints: { loss: 0 } } }, basketball);
    expect(changed.ok && changed.rules.scoring.tablePoints).toEqual({ win: 2, draw: 0, loss: 0 });
    expect(parseRules({ scoring: { rankBy: ["luck"] } }, basketball).ok).toBe(false);
    expect(parseRules({ scoring: { bestOf: 4 } }, basketball).ok).toBe(false);
  });

  it("are refused for the wrong kind of event", async () => {
    const where = await venueWith("swimming");
    const made = await createTournament(
      { ...where, name: "Wrong kind", sport: "swimming", format: "knockout", teamSize: 1, level: null, entryFee: 0, maxEntries: 8, startsOn: addDays(todayISO(), 40), endsOn: addDays(todayISO(), 40), startHour: 9, endHour: 12, template: "swimming_heats" },
      ownerId
    );
    expect(made).toMatchObject({ ok: false, error: "That template is for a performance event." });
  });

  it("can be a venue's own: a tournament's settings kept to start the next from", async () => {
    const t = await competition({ sport: "swimming", rules: { performance: { finalSize: 4 } } });
    const saved = await saveVenueTemplate(t.id, "Club gala, final of four", ownerId);
    if (!saved.ok) throw new Error(saved.error);
    expect(saved.value.rules.performance?.finalSize).toBe(4);
    expect((await venueTemplates(t.venueId)).map((v) => v.name)).toContain("Club gala, final of four");
    // Saving under the same name replaces it, never a second.
    await saveVenueTemplate(t.id, "Club gala, final of four", ownerId);
    expect((await venueTemplates(t.venueId)).filter((v) => v.name === "Club gala, final of four")).toHaveLength(1);
  });
});

describe("a swimming gala: timed heats and a final", () => {
  async function gala(count: number, over: Partial<TournamentInput> = {}) {
    const t = await competition({ sport: "swimming", ...over });
    expect(t.template).toBe("swimming_heats");
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      // Entry times 60.00, 60.50, ... : the first entered is the fastest.
      const made = await enter(await player(), t.id, { entryMark: (60 + i * 0.5).toFixed(2) });
      if (!made.ok) throw new Error(made.error);
      ids.push(made.value.id);
    }
    const drawn = await makeDraw(t.id, () => 0.3);
    if (!drawn.ok) throw new Error(drawn.error);
    return { t, ids, d: drawn.value };
  }

  it("seeds the heats by entry time, ranks the heats, fills the final with the fastest in the middle lanes, and finishes on the final", async () => {
    const { t, ids, d } = await gala(10);
    const heats = d.matches.filter((m) => m.stage === "heat");
    const final = d.matches.find((m) => m.stage === "final")!;
    expect(heats).toHaveLength(2);
    expect(final.courtId).not.toBeNull();
    // Each heat and the final has its own court time, the final after the heats.
    expect(heats.every((h) => h.minute! < final.minute!)).toBe(true);
    const lastHeat = heats.find((h) => h.position === 2)!;
    expect(d.performance!.lines[lastHeat.id].find((l) => l.entryId === ids[0])!.lane).toBe(4);
    // Results: a bad mark refused, one swimmer did not start.
    const first = heats.find((h) => h.position === 1)!;
    expect(await recordPerformances(first.id, [{ entryId: d.performance!.lines[first.id][0].entryId, attempts: ["fast"] }])).toMatchObject({ ok: false });
    for (const h of heats) {
      const lines = d.performance!.lines[h.id].map((l) => {
        const k = ids.indexOf(l.entryId);
        return k === 9 ? { entryId: l.entryId, status: "dns" as const } : { entryId: l.entryId, attempts: [`1:0${Math.floor(k / 2)}.${10 + k}`] };
      });
      const r = await recordPerformances(h.id, lines);
      if (!r.ok) throw new Error(r.error);
    }
    let now = (await tournamentDetail(t.id))!;
    expect(now.matches.filter((m) => m.stage === "heat").every((m) => m.status === "done")).toBe(true);
    const inFinal = now.performance!.lines[final.id];
    expect(inFinal).toHaveLength(8);
    // The fastest in the heats swims in lane 4; the one who did not start is not in it.
    expect(inFinal.find((l) => l.lane === 4)!.entryId).toBe(ids[0]);
    expect(inFinal.map((l) => l.entryId)).not.toContain(ids[9]);
    expect(now.status).toBe("drawn");
    // The final: the slowest in the heats wins it.
    const r = await recordPerformances(
      final.id,
      inFinal.map((l) => ({ entryId: l.entryId, attempts: [l.entryId === ids[7] ? "59.90" : `1:0${ids.indexOf(l.entryId) % 5}.50`] }))
    );
    if (!r.ok) throw new Error(r.error);
    now = r.value;
    expect(now.status).toBe("finished");
    expect(now.performance!.ranking[0]).toMatchObject({ entryId: ids[7], rank: 1, shown: "59.90", stage: "final" });
    // After the eight finalists, the rest by their heats; the one who did not start has no rank.
    expect(now.performance!.ranking.slice(8).map((x) => [x.entryId, x.rank])).toEqual([
      [ids[8], 9],
      [ids[9], null],
    ]);
  });

  it("asks the organiser to choose when swimmers are level for the final's last place", async () => {
    const { t, ids, d } = await gala(10, { rules: { performance: { finalSize: 4 } } });
    const heats = d.matches.filter((m) => m.stage === "heat");
    // Fourth and fifth fastest swim the same time.
    const time = (k: number) => (k === 3 || k === 4 ? "1:01.00" : `1:0${k < 3 ? 0 : 2}.${10 + k}`);
    for (const h of heats) {
      const r = await recordPerformances(h.id, d.performance!.lines[h.id].map((l) => ({ entryId: l.entryId, attempts: [time(ids.indexOf(l.entryId))] })));
      if (!r.ok) throw new Error(r.error);
    }
    const now = (await tournamentDetail(t.id))!;
    const final = now.matches.find((m) => m.stage === "final")!;
    expect(now.performance!.lines[final.id]).toHaveLength(0);
    expect(now.performance!.tieForFinal?.sort()).toEqual([ids[3], ids[4]].sort());
    expect(await makeFinal(t.id, [ids[3], ids[4]])).toMatchObject({ ok: false });
    const chosen = await makeFinal(t.id, [ids[4]]);
    if (!chosen.ok) throw new Error(chosen.error);
    expect(chosen.value.performance!.lines[final.id].map((l) => l.entryId).sort()).toEqual([ids[0], ids[1], ids[2], ids[4]].sort());
  });

  it("a swimmer who withdraws does not start what is left; one disqualified keeps a record but no rank", async () => {
    const { t, ids, d } = await gala(10);
    const out = await takeOut(ids[2], "withdrawn");
    if (!out.ok) throw new Error(out.error);
    let now = (await tournamentDetail(t.id, { forStaff: true }))!;
    const heatOf = (id: number) => now.matches.find((m) => m.stage === "heat" && now.performance!.lines[m.id].some((l) => l.entryId === id))!;
    expect(now.performance!.lines[heatOf(ids[2]).id].find((l) => l.entryId === ids[2])!.status).toBe("dns");
    // Results in; then one is disqualified: their time stays on the record, unranked, under the default rule.
    for (const h of d.matches.filter((m) => m.stage === "heat")) {
      const lines = now.performance!.lines[h.id].filter((l) => l.status === "pending").map((l) => ({ entryId: l.entryId, attempts: [`1:0${ids.indexOf(l.entryId) % 9}.00`] }));
      const r = await recordPerformances(h.id, lines);
      if (!r.ok) throw new Error(r.error);
    }
    const dq = await takeOut(ids[0], "disqualified", "False start in the heat, seen by the referee");
    if (!dq.ok) throw new Error(dq.error);
    now = (await tournamentDetail(t.id, { forStaff: true }))!;
    const line = now.performance!.lines[heatOf(ids[0]).id].find((l) => l.entryId === ids[0])!;
    expect(line).toMatchObject({ status: "dq", rank: null });
    expect(line.attempts).toEqual([60]);
  });

  it("an archery round adds up its ends, and a total needs every end", async () => {
    const t = await competition({ sport: "archery" });
    expect(t.template).toBe("archery_ranking");
    const a = await enter(await player(), t.id);
    const b = await enter(await player(), t.id);
    if (!a.ok || !b.ok) throw new Error("entry");
    const drawn = await makeDraw(t.id, () => 0.5);
    if (!drawn.ok) throw new Error(drawn.error);
    const session = drawn.value.matches.find((m) => m.stage === "heat")!;
    expect(drawn.value.matches.some((m) => m.stage === "final")).toBe(false);
    expect(await recordPerformances(session.id, [{ entryId: a.value.id, attempts: ["50", "52"] }])).toMatchObject({ ok: false, error: expect.stringMatching(/all 6/) });
    const r = await recordPerformances(session.id, [
      { entryId: a.value.id, attempts: ["50", "52", "48", "51", "49", "53"] },
      { entryId: b.value.id, attempts: ["55", "50", "50", "50", "50", "48"] },
    ]);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.status).toBe("finished");
    expect(r.value.performance!.ranking.map((x) => [x.entryId, x.result, x.rank])).toEqual([
      [b.value.id, 303, 1],
      [a.value.id, 303, 1],
    ].sort((x, y) => (x[0] as number) - (y[0] as number)));
  });
});

describe("teams", () => {
  it("enter with a name and a roster within the template's size; a name used twice is refused", async () => {
    const where = await venueWith("futsal");
    const made = await createTournament(
      { ...where, name: "Futsal Cup", sport: "futsal", format: "knockout", teamSize: 1, entryKind: "team", level: null, entryFee: 0, maxEntries: 8, startsOn: addDays(todayISO(), 45), endsOn: addDays(todayISO(), 45), startHour: 10, endHour: 20 },
      ownerId
    );
    if (!made.ok) throw new Error(made.error);
    expect(made.value.roster).toEqual({ min: 5, max: 14 });
    const five = ["Ali Bin", "Bala Raj", "Chong Wei", "Dev Nair", "Eng Hock"];
    expect(await enter(await player(), made.value.id, { teamName: "Short FC", roster: five.slice(0, 3) })).toMatchObject({ ok: false, error: "A roster of 5 to 14 names." });
    expect(await enter(await player(), made.value.id, { teamName: "Twice FC", roster: [...five.slice(0, 4), "Ali Bin"] })).toMatchObject({ ok: false });
    const ok = await enter(await player(), made.value.id, { teamName: "Kampung FC", roster: five });
    if (!ok.ok) throw new Error(ok.error);
    expect(ok.value).toMatchObject({ name: "Kampung FC", roster: five });
    expect(await enter(await player(), made.value.id, { teamName: "kampung fc", roster: five })).toMatchObject({ ok: false, error: "A team of that name has entered already." });
    // The public sees the team, not its roster.
    const publicView = (await tournamentDetail(made.value.id))!;
    expect(publicView.entries[0].roster).toBeUndefined();
  });
});

describe("taking somebody out after the draw", () => {
  it("is confirmed against its preview through the route; a disqualification says why and is a manager's", async () => {
    const where = await venueWith("badminton");
    const made = await createTournament(
      { ...where, name: "Confirm Cup", sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 0, maxEntries: 8, startsOn: addDays(todayISO(), 50), endsOn: addDays(todayISO(), 50), startHour: 9, endHour: 20 },
      ownerId
    );
    if (!made.ok) throw new Error(made.error);
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      const e = await enter(await player(), made.value.id);
      if (!e.ok) throw new Error(e.error);
      ids.push(e.value.id);
    }
    const drawn = await makeDraw(made.value.id, () => 0.4);
    if (!drawn.ok) throw new Error(drawn.error);
    const owner = (await listAdmins())[0];
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
    const route = await import("../src/app/api/admin/tournaments/[id]/entries/[entryId]/route");
    const post = (entryId: number, body: object, as = cookie) =>
      route.POST(
        new NextRequest(`http://localhost/api/admin/tournaments/${made.value.id}/entries/${entryId}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: as, origin: "http://localhost" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: String(made.value.id), entryId: String(entryId) }) }
      );
    // Without having seen what it changes: refused.
    const blind = await post(ids[0], { withdraw: true, reason: "withdrawn" });
    expect(blind.status).toBe(409);
    expect((await blind.json()).code).toBe("CONFIRM");
    // A disqualification without a reason: refused.
    expect((await post(ids[0], { withdraw: true, reason: "disqualified", token: "x" })).status).toBe(400);
    // Front desk staff cannot disqualify at all.
    const desk = await createAdmin({ name: "Desk", email: `desk${Date.now()}@comp.my`, password: "desk-password", venueId: made.value.venueId, role: "desk" });
    if (!desk.ok) throw new Error(desk.error);
    const deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    expect((await post(ids[0], { withdraw: true, reason: "disqualified", note: "Abusive to the umpire", preview: true }, deskCookie)).status).toBe(403);
    // Previewed, then something else changes: the preview is stale.
    const preview = await previewTakeOut(ids[0], "disqualified");
    if (!preview.ok) throw new Error(preview.error);
    expect(preview.value.consequential).toBe(true);
    const m = drawn.value.matches.find((x) => x.round === 1 && ![x.a, x.b].includes(ids[0]))!;
    expect((await recordResult(m.id, { winner: m.a!, score: "21-10, 21-10" })).ok).toBe(true);
    const stale = await post(ids[0], { withdraw: true, reason: "disqualified", note: "Abusive to the umpire", token: preview.value.token });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("CHANGED");
    // Previewed afresh and confirmed: made, with the reason kept on the entry.
    const fresh = await previewTakeOut(ids[0], "disqualified");
    if (!fresh.ok) throw new Error(fresh.error);
    const done = await post(ids[0], { withdraw: true, reason: "disqualified", note: "Abusive to the umpire", token: fresh.value.token });
    expect(done.status).toBe(200);
    const { getDb } = await import("../src/lib/db");
    expect(await getDb().prepare("SELECT out_reason, out_note FROM tournament_entries WHERE id = ?").get(ids[0])).toEqual({ out_reason: "disqualified", out_note: "Abusive to the umpire" });
  });
});
