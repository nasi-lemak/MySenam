/// <reference types="vite/client" />
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import type { CountedUnit } from "../src/lib/counted-performances";
import { getDb } from "../src/lib/db";
import { addOfficial, officialByToken, revokeOfficial } from "../src/lib/match-reports";
import { applyCorrectionRequest, declineCorrectionRequest, listCorrectionRequests, officialPerformances, officialPerformanceView, previewCorrectionRequest, requestCorrection } from "../src/lib/official-performances";
import { listActivity } from "../src/lib/activity";
import { MANAGER_ONLY, managerOnly } from "../src/lib/roles";
import { createCourt, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { createTournament, enter, makeDraw, recordPerformances, tournamentDetail, type PerformanceInput, type TournamentDetail, type TournamentInput } from "../src/lib/tournaments";
import * as officialRoute from "../src/app/api/officials/[token]/route";
import * as correctionRoute from "../src/app/api/admin/tournaments/[id]/correction-requests/[requestId]/route";
import * as staffEvent from "../src/app/api/admin/tournaments/[id]/route";

/**
 * Officials of a climbing event (docs/features/tournaments.md#officials-and-counted-results; lib/official-performances.ts; migration 0276):
 * an official assigned to one counted event enters its counts from their own page through the same save the dashboard uses, for rounds that
 * are still open, and asks for a correction to a finished one, which a manager reviews with a preview and applies against its token.
 */

vi.setConfig({ testTimeout: 90_000 });

const U = (unit: number, attempts: number, zone: number | null = null, top: number | null = null): CountedUnit => ({ unit, attempts, zone, top });
const sent = (units: CountedUnit[]): object[] => units.map((u) => ({ ...u }));

let ownerId: number;
let managerMail: string;
let deskMail: string;
let n = 0;
let dayOffset = 200;
const routes = import.meta.glob("../src/app/api/admin/**/route.ts");

async function player(name = "Climber"): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} Rope${n}`, email: `oc${n}@wall.my`, phone: `01370${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  return made.user;
}

async function venueWith(sport: string) {
  let venue = (await listVenues()).find((v) => v.courts.some((c) => c.sport === sport));
  if (!venue) {
    const made = await createCourt({ venueId: (await listVenues())[0].id, name: `${sport} wall`, sport, offPeakRate: 20, peakRate: 30 });
    if (!made.ok) throw new Error(made.error);
    venue = (await listVenues()).find((v) => v.courts.some((c) => c.sport === sport))!;
  }
  return { venueId: venue.id, courtIds: venue.courts.filter((c) => c.sport === sport).slice(0, 1).map((c) => c.id) };
}

const ok = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const RULES = { performance: { heatSize: 4, finalSize: 3, counted: { units: 3 } } };

/** A bouldering event with `count` climbers entered and drawn into groups of four. */
async function wall(count = 8, over: Partial<TournamentInput> = {}, sport = "bouldering", template = "bouldering_tops_zones_attempts") {
  const day = addDays(todayISO(), dayOffset++);
  const where = await venueWith(sport);
  const made = await createTournament(
    { ...where, name: `Official Cup ${dayOffset}`, format: "performance", teamSize: 1, level: null, entryFee: 0, maxEntries: 32, startsOn: day, endsOn: day, startHour: 8, endHour: 20, sport, template, rules: RULES, ...over } as TournamentInput,
    ownerId
  );
  const t = ok(made);
  const ids: number[] = [];
  for (let i = 0; i < count; i++) ids.push(ok(await enter(await player(), t.id)).id);
  const d = ok(await makeDraw(t.id, () => 0.3));
  return { t, ids, d };
}

const detail = async (id: number) => (await tournamentDetail(id, { forStaff: true }))!;
const heats = (d: TournamentDetail) => d.matches.filter((m) => m.stage === "heat");
const finalOf = (d: TournamentDetail) => d.matches.find((m) => m.stage === "final")!;
const lineOf = (d: TournamentDetail, matchId: number, entryId: number) => d.performance!.lines[matchId].find((l) => l.entryId === entryId)!;
const url = (token: string) => `http://localhost/api/officials/${token}`;
const post = (token: string, body: unknown) => officialRoute.POST(new NextRequest(url(token), { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ token }) });
const get = (token: string) => officialRoute.GET(new NextRequest(url(token)), { params: Promise.resolve({ token }) });

async function official(tournamentId: number, name = "Judge Jamal") {
  const made = ok(await addOfficial(tournamentId, name, ownerId));
  return { token: made.token, id: made.official.id, name };
}

const inRound = (d: TournamentDetail, matchId: number) => d.performance!.lines[matchId].map((l) => l.entryId);

/** The groups' results for eight climbers, as in the counted-performance tests. */
const GROUPS: Record<number, CountedUnit[] | "dns"> = {
  0: [U(1, 2, 1, 2), U(2, 1, null, 1), U(3, 3)],
  1: [U(1, 1, 1, 1), U(2, 3, 2, 3), U(3, 2, 1)],
  2: [U(1, 1, 1, 1), U(2, 1, 1, 1), U(3, 5, 3, 5)],
  3: [U(1, 4, 2), U(2, 3)],
  4: [U(1, 3, 3, 3), U(2, 2, 1)],
  5: [U(1, 2, 1, 2), U(2, 2, 1)],
  6: [U(1, 1, 1, 1), U(2, 3, 2, 3), U(3, 2, 1)],
  7: "dns",
};
async function playGroups(d: TournamentDetail, ids: number[]) {
  let now = d;
  for (const h of heats(d)) {
    const lines = inRound(d, h.id).map((id): PerformanceInput => {
      const p = GROUPS[ids.indexOf(id)];
      return typeof p === "string" ? { entryId: id, status: p } : { entryId: id, counts: sent(p) };
    });
    now = ok(await recordPerformances(h.id, lines));
  }
  return now;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const where = await venueWith("bouldering");
  managerMail = `ofc-manager${Date.now()}@wall.my`;
  const manager = await createAdmin({ name: "Mona Manager", email: managerMail, password: "manager-pass-1", venueId: where.venueId });
  const desk = await createAdmin({ name: "Dee Desk", email: `ofc-desk${Date.now()}@wall.my`, password: "desk-password-1", venueId: where.venueId, role: "desk" });
  if (!manager.ok || !desk.ok) throw new Error("staff");
  deskMail = desk.admin.email;
});

describe("the link", () => {
  it("can be made for a climbing event, not for an event of marks; it works for that event only", async () => {
    const { t } = await wall(4);
    const made = await addOfficial(t.id, "Judge Jamal", ownerId);
    expect(made).toMatchObject({ ok: true });
    // A marks event's results stay with staff.
    const swim = await wall(4, { rules: undefined }, "swimming", "swimming_heats");
    expect(await addOfficial(swim.t.id, "Timekeeper", ownerId)).toMatchObject({ ok: false, error: expect.stringMatching(/entered by staff/) });
    const { token } = ok(made);
    expect(await officialByToken(token)).toMatchObject({ tournamentId: t.id, official: { name: "Judge Jamal" } });
    const seen = await (await get(token)).json();
    expect(seen).toMatchObject({ official: { name: "Judge Jamal" }, tournament: { id: t.id } });
    // Each round is open, and nothing is in their recent entries or requests yet.
    expect(seen.performance.rounds.every((r: { lock: string | null }) => r.lock === null)).toBe(true);
    expect(seen.performance.recent).toEqual([]);
    expect(seen.performance.requests).toEqual([]);
  });

  it("stops with the event, at its expiry day and when withdrawn", async () => {
    const { t } = await wall(4);
    const a = await official(t.id, "Short Lived");
    await getDb().prepare("UPDATE tournament_officials SET expires_on = ? WHERE id = ?").run(addDays(todayISO(), -1), a.id);
    expect(await officialByToken(a.token)).toBeNull();
    expect((await get(a.token)).status).toBe(404);
    const b = await official(t.id, "Withdrawn");
    expect(await revokeOfficial(t.id, b.id)).toBe(true);
    expect(await officialByToken(b.token)).toBeNull();
    expect((await post(b.token, { matchId: 1, performances: [] })).status).toBe(409);
    const c = await official(t.id, "Ends With It");
    await getDb().prepare("UPDATE tournaments SET status = 'finished' WHERE id = ?").run(t.id);
    expect(await officialByToken(c.token)).toBeNull();
  });
});

describe("entering counts", () => {
  it("saves a round through the same path as the dashboard, under the official's name, with each line's new and previous counts; the page lists their recent entries", async () => {
    const { t, d } = await wall(8);
    const a = await official(t.id);
    const h = heats(d)[0];
    const [first, second] = inRound(d, h.id);
    // Only some lines: the round stays open, and an overwrite of a line is kept with what it replaced.
    const one = await post(a.token, { matchId: h.id, performances: [{ entryId: first, counts: sent([U(1, 2, 1, 2), U(2, 1, null, 1), U(3, 3)]) }] });
    expect(one.status).toBe(200);
    const body = await one.json();
    expect(lineOf(await detail(t.id), h.id, first)).toMatchObject({ status: "ok", shown: "2T 2Z 3 2" });
    expect(body.performance.rounds.find((r: { matchId: number }) => r.matchId === h.id).lock).toBeNull();
    // Re-entered while open: allowed, and the log keeps both.
    const again = await post(a.token, { matchId: h.id, performances: [{ entryId: first, counts: sent([U(1, 1, 1, 1), U(2, 1, 1, 1), U(3, 3)]) }, { entryId: second, status: "dns" }] });
    expect(again.status).toBe(200);
    const now = await detail(t.id);
    expect(lineOf(now, h.id, first)).toMatchObject({ shown: "2T 2Z 2 2" });
    expect(lineOf(now, h.id, second)).toMatchObject({ status: "dns" });
    const logs = ((await getDb().prepare("SELECT admin_id, admin_name, action, detail FROM staff_actions WHERE action = 'tournament.performances' AND admin_name = 'Official: Judge Jamal' ORDER BY id").all()) as { admin_id: number | null; admin_name: string; action: string; detail: string }[]);
    expect(logs).toHaveLength(2);
    expect(logs[0].admin_id).toBeNull();
    expect(logs[0].detail).toMatch(/2T 2Z 3 2/);
    expect(logs[1].detail).toMatch(/2T 2Z 2 2 \(was 2T 2Z 3 2\)/);
    // And per line, the counts as entered and what they replaced.
    const marks = (await getDb().prepare("SELECT entry_id, was_shown, now_shown, was_counts, now_counts FROM tournament_official_marks WHERE official_id = ? ORDER BY id").all(a.id)) as { entry_id: number; was_shown: string | null; now_shown: string | null; was_counts: string | null; now_counts: string }[];
    expect(marks).toHaveLength(3);
    expect(marks[0]).toMatchObject({ entry_id: first, was_shown: null, now_shown: "2T 2Z 3 2", was_counts: null });
    expect(marks[1]).toMatchObject({ entry_id: first, was_shown: "2T 2Z 3 2", now_shown: "2T 2Z 2 2" });
    expect(JSON.parse(marks[1].was_counts!)[0]).toMatchObject({ unit: 1, attempts: 2, top: 2 });
    expect(JSON.parse(marks[1].now_counts)[0]).toMatchObject({ unit: 1, attempts: 1, top: 1 });
    // Their page lists the recent entries, newest first.
    const view = await officialPerformanceView(a.token);
    expect(view!.recent.map((r) => r.now)).toEqual(["dns", "2T 2Z 2 2", "2T 2Z 3 2"].map((x) => (x === "dns" ? "dns" : x)));
    expect(view!.recent[1]).toMatchObject({ was: "2T 2Z 3 2" });
  });

  it("is checked exactly as the dashboard's save is, and writes nothing when one line is wrong", async () => {
    const { t, d } = await wall(8);
    const a = await official(t.id);
    const h = heats(d)[0];
    const [first, second] = inRound(d, h.id);
    const bad = await post(a.token, { matchId: h.id, performances: [{ entryId: first, counts: sent([U(1, 1, 1, 1)]) }, { entryId: second, counts: [{ unit: 9, attempts: 1 }] }] });
    expect(bad.status).toBe(409);
    expect((await bad.json()).error).toMatch(/numbered 1 to 3/);
    expect(lineOf(await detail(t.id), h.id, first).status).toBe("pending");
    // A zone after the top, attempts for marks, somebody not in the round.
    const zoneAfterTop = await post(a.token, { matchId: h.id, performances: [{ entryId: first, counts: [{ unit: 1, attempts: 3, zone: 3, top: 2 }] }] });
    expect(zoneAfterTop.status).toBe(409);
    const marksInstead = await post(a.token, { matchId: h.id, performances: [{ entryId: first, attempts: ["7.1"] }] });
    expect(marksInstead.status).toBe(409);
    const otherRound = heats(d)[1];
    const stranger = inRound(d, otherRound.id)[0];
    expect((await post(a.token, { matchId: h.id, performances: [{ entryId: stranger, counts: sent([U(1, 1, 1, 1)]) }] })).status).toBe(409);
    expect(await getDb().prepare("SELECT 1 FROM tournament_official_marks WHERE official_id = ?").get(a.id)).toBeUndefined();
    // A preview says what it would change and changes nothing.
    const previewed = await post(a.token, { matchId: h.id, performances: [{ entryId: first, counts: sent([U(1, 1, 1, 1)]) }], preview: true });
    expect(previewed.status).toBe(200);
    expect((await previewed.json()).preview).toMatchObject({ consequential: false, token: expect.any(String) });
    expect(lineOf(await detail(t.id), h.id, first).status).toBe("pending");
    expect(await getDb().prepare("SELECT 1 FROM tournament_official_marks WHERE official_id = ?").get(a.id)).toBeUndefined();
    // Nothing to save, or a body that is not lines.
    expect((await post(a.token, { matchId: h.id, performances: [] })).status).toBe(409);
  });

  it("finishing the last group fills the final as the dashboard's save does; the final's own round is the official's to enter too", async () => {
    const { t, ids, d } = await wall(8);
    const a = await official(t.id);
    let now = d;
    for (const h of heats(d)) {
      const lines = inRound(d, h.id).map((id) => {
        const p = GROUPS[ids.indexOf(id)];
        return typeof p === "string" ? { entryId: id, status: p } : { entryId: id, counts: sent(p) };
      });
      const res = await post(a.token, { matchId: h.id, performances: lines });
      expect(res.status).toBe(200);
      now = await detail(t.id);
    }
    expect(now.performance!.lines[finalOf(now).id].length).toBe(3);
    const final = finalOf(now);
    const finalIds = inRound(now, final.id);
    expect((await officialPerformanceView(a.token))!.rounds.find((r) => r.matchId === final.id)!.lock).toBeNull();
    const res = await post(a.token, { matchId: final.id, performances: [{ entryId: finalIds[0], counts: sent([U(1, 1, 1, 1)]) }] });
    expect(res.status).toBe(200);
    expect(lineOf(await detail(t.id), final.id, finalIds[0]).shown).toBe("1T 1Z 1 1");
  });
});

describe("a finished round is the organiser's", () => {
  it("is refused to the official, who asks for a correction instead; nothing changes until a manager applies it", async () => {
    const { t, ids, d } = await wall(8);
    const a = await official(t.id);
    const played = await playGroups(d, ids);
    const h0 = heats(played).find((h) => inRound(played, h.id).includes(ids[0]))!;
    const better = [{ entryId: ids[0], counts: sent([U(1, 1, 1, 1), U(2, 1, 1, 1), U(3, 1, 1, 1)]) }];
    // Direct entry on a finished round: refused, written nowhere.
    const refused = await post(a.token, { matchId: h0.id, performances: better });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "OFC_ROUND_FINAL" });
    expect(lineOf(await detail(t.id), h0.id, ids[0])).toMatchObject({ shown: "2T 2Z 3 2" });
    expect((await officialPerformanceView(a.token))!.rounds.find((r) => r.matchId === h0.id)!.lock).toBe("finalised");

    // A request: why, and the counts it should have, checked as a save would be.
    const bad = await post(a.token, { action: "correction_request", matchId: h0.id, reason: "ok", performances: better });
    expect(bad.status).toBe(409);
    expect(await bad.json()).toMatchObject({ code: "OFC_REASON" });
    const invalid = await post(a.token, { action: "correction_request", matchId: h0.id, reason: "Judge miscounted boulder 3", performances: [{ entryId: ids[0], counts: [{ unit: 9, attempts: 1 }] }] });
    expect(invalid.status).toBe(409);
    expect((await invalid.json()).error).toMatch(/numbered 1 to 3/);
    const made = await post(a.token, { action: "correction_request", matchId: h0.id, reason: "Judge miscounted boulder 3: it was topped first go.", performances: better });
    expect(made.status).toBe(200);
    const { request } = await made.json();
    expect(request).toMatchObject({ status: "open", officialName: "Judge Jamal", matchId: h0.id });
    // It changed nothing: results, ranking, the final's field.
    const after = await detail(t.id);
    expect(lineOf(after, h0.id, ids[0])).toMatchObject({ shown: "2T 2Z 3 2" });
    expect(inRound(after, finalOf(after).id).sort()).toEqual(inRound(played, finalOf(played).id).sort());
    // One waiting request per round and official; a round still open takes none.
    expect((await post(a.token, { action: "correction_request", matchId: h0.id, reason: "Another thought", performances: better })).status).toBe(409);
    const open = await wall(8);
    const o2 = await official(open.t.id);
    const refusedOpen = await post(o2.token, { action: "correction_request", matchId: heats(open.d)[0].id, reason: "Not finished yet", performances: [{ entryId: inRound(open.d, heats(open.d)[0].id)[0], counts: sent([U(1, 1, 1, 1)]) }] });
    expect(await refusedOpen.json()).toMatchObject({ code: "OFC_ROUND_OPEN" });
    // The managers are told, not the desk; the log names the official.
    const alerted = async (to: string) => (await getDb().prepare("SELECT 1 FROM messages WHERE kind = 'staff_alert' AND recipient = ? AND params LIKE '%Judge Jamal asks for a correction%'").get(to)) !== undefined;
    expect(await alerted(managerMail)).toBe(true);
    expect(await alerted(deskMail)).toBe(false);
    expect((await listActivity([t.venueId])).find((x) => x.action === "tournament.correction_requested")).toMatchObject({ adminName: "Official: Judge Jamal" });
    // They see it, and may take it back; then ask again.
    expect((await officialPerformanceView(a.token))!.requests[0]).toMatchObject({ id: request.id, status: "open" });
    const gone = await post(a.token, { action: "correction_withdraw", requestId: request.id });
    expect(gone.status).toBe(200);
    expect((await listCorrectionRequests(t.id))[0].status).toBe("withdrawn");
    expect((await post(a.token, { action: "correction_withdraw", requestId: request.id })).status).toBe(409);
    expect((await post(a.token, { action: "correction_request", matchId: h0.id, reason: "Judge miscounted boulder 3: it was topped first go.", performances: better })).status).toBe(200);
  });

  it("is reviewed by a manager through the correction flow: a preview of what it changes, applied only against its token; the desk may not", async () => {
    const { t, ids, d } = await wall(8);
    const a = await official(t.id);
    const played = await playGroups(d, ids);
    const h0 = heats(played).find((h) => inRound(played, h.id).includes(ids[0]))!;
    const better = [{ entryId: ids[0], counts: sent([U(1, 1, 1, 1), U(2, 1, 1, 1), U(3, 1, 1, 1)]) }];
    const req = ok(await requestCorrection(a.token, h0.id, "Judge miscounted boulder 3: it was topped first go.", better));
    const manager = await createAdmin({ name: "Mira Manager", email: `mira${Date.now()}@wall.my`, password: "manager-pass-1", venueId: t.venueId });
    const desk = await createAdmin({ name: "Dev Desk", email: `dev${Date.now()}@wall.my`, password: "desk-password-1", venueId: t.venueId, role: "desk" });
    if (!manager.ok || !desk.ok) throw new Error("staff");
    const cookieOf = async (id: number) => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(id)).token}`;
    const [managerCookie, deskCookie] = [await cookieOf(manager.admin.id), await cookieOf(desk.admin.id)];
    const route = (cookie: string, body: unknown, requestId = req.id) =>
      correctionRoute.POST(new NextRequest(`http://localhost/api/admin/tournaments/${t.id}/correction-requests/${requestId}`, { method: "POST", headers: { "content-type": "application/json", cookie, origin: "http://localhost" }, body: JSON.stringify(body) }), {
        params: Promise.resolve({ id: String(t.id), requestId: String(requestId) }),
      });
    // The desk is turned away from every action on it, as for any manager-only route; staff read the list.
    expect(managerOnly("POST", `/api/admin/tournaments/${t.id}/correction-requests/${req.id}`)).toBe(true);
    expect(MANAGER_ONLY.some((r) => r.path.test(`/api/admin/tournaments/1/correction-requests/1`))).toBe(true);
    for (const body of [{ action: "preview" }, { action: "apply", token: "x" }, { action: "decline", note: "No." }]) {
      const res = await route(deskCookie, body);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "MANAGER_ONLY" });
    }
    const listed = await staffEvent.GET(new NextRequest(`http://localhost/api/admin/tournaments/${t.id}`, { headers: { cookie: deskCookie } }), { params: Promise.resolve({ id: String(t.id) }) });
    expect((await listed.json()).correctionRequests[0]).toMatchObject({ id: req.id, status: "open", officialName: "Judge Jamal", reason: expect.stringMatching(/boulder 3/) });

    // Previewed: the result, the placing, and the final's field, and a token. Nothing changed.
    const previewed = (await (await route(managerCookie, { action: "preview" })).json()).preview as { changes: string[]; consequential: boolean; token: string };
    expect(previewed.changes.join(" ")).toMatch(/2T 2Z 3 2 becomes 3T 3Z 3 3/);
    expect(previewed.consequential).toBe(true);
    expect(lineOf(await detail(t.id), h0.id, ids[0])).toMatchObject({ shown: "2T 2Z 3 2" });
    // Without the token, or against another look, it is not made.
    expect(await (await route(managerCookie, { action: "apply" })).json()).toMatchObject({ code: "OFC_NEEDS_PREVIEW" });
    expect(await (await route(managerCookie, { action: "apply", token: "0".repeat(32) })).json()).toMatchObject({ code: "CHANGED" });
    expect((await listCorrectionRequests(t.id))[0].status).toBe("open");
    // The event moved since the look: refused, still open.
    const other = heats(played).find((h) => h.id !== h0.id)!;
    ok(await recordPerformances(other.id, [{ entryId: inRound(played, other.id)[0], counts: sent([U(1, 1, 1, 1)]) }]));
    expect(await (await route(managerCookie, { action: "apply", token: previewed.token })).json()).toMatchObject({ code: "CHANGED" });
    expect((await listCorrectionRequests(t.id))[0].status).toBe("open");
    // Looked at again, applied against that.
    const again = (await (await route(managerCookie, { action: "preview" })).json()).preview as { token: string };
    const applied = await route(managerCookie, { action: "apply", token: again.token });
    expect(applied.status).toBe(200);
    const now = await detail(t.id);
    expect(lineOf(now, h0.id, ids[0])).toMatchObject({ shown: "3T 3Z 3 3" });
    expect((await listCorrectionRequests(t.id))[0]).toMatchObject({ status: "applied", decidedBy: "Mira Manager" });
    expect((await listActivity([t.venueId])).find((x) => x.action === "tournament.correction_applied")).toMatchObject({ adminName: "Mira Manager" });
    // A decided request is decided.
    expect(await (await route(managerCookie, { action: "apply", token: again.token })).json()).toMatchObject({ code: "OFC_REQ_GONE" });
    expect(await (await route(managerCookie, { action: "decline", note: "Too late" })).json()).toMatchObject({ code: "OFC_REQ_GONE" });
  });

  it("can be declined with a reason, which the official sees; nothing changes", async () => {
    const { t, ids, d } = await wall(8);
    const a = await official(t.id);
    const played = await playGroups(d, ids);
    const h = heats(played)[1];
    const target = inRound(played, h.id)[0];
    const before = lineOf(await detail(t.id), h.id, target).shown;
    const req = ok(await requestCorrection(a.token, h.id, "I think boulder 1 was topped.", [{ entryId: target, counts: sent([U(1, 1, 1, 1)]) }]));
    const admin = { id: ownerId, name: "Owner" };
    expect(await declineCorrectionRequest(t.id, req.id, admin, "")).toMatchObject({ ok: false, code: "OFC_REASON" });
    expect(await declineCorrectionRequest(t.id, req.id, admin, "The video shows a fall.")).toMatchObject({ ok: true });
    expect(lineOf(await detail(t.id), h.id, target).shown).toBe(before);
    expect((await officialPerformanceView(a.token))!.requests[0]).toMatchObject({ status: "declined", decisionNote: "The video shows a fall." });
    // A request of another event is not this event's to decide.
    const other = await wall(4);
    expect(await previewCorrectionRequest(other.t.id, req.id)).toMatchObject({ ok: false });
    expect(await applyCorrectionRequest(other.t.id, req.id, admin, "x")).toMatchObject({ ok: false });
    expect(await declineCorrectionRequest(other.t.id, req.id, admin, "Not yours")).toMatchObject({ ok: false });
  });

  it("a group is also closed to them once the final has results, even if it were open", async () => {
    const { t, ids, d } = await wall(8);
    const a = await official(t.id);
    const played = await playGroups(d, ids);
    const final = finalOf(played);
    ok(await recordPerformances(final.id, [{ entryId: inRound(played, final.id)[0], counts: sent([U(1, 1, 1, 1)]) }]));
    // A group put back to "still to come" (by whatever means): the final has begun, so it is advanced, not open.
    const h = heats(played)[0];
    await getDb().prepare("UPDATE tournament_matches SET status = 'scheduled' WHERE id = ?").run(h.id);
    expect((await officialPerformanceView(a.token))!.rounds.find((r) => r.matchId === h.id)!.lock).toBe("advanced");
    expect(await officialPerformances(a.token, h.id, [{ entryId: inRound(played, h.id)[0], counts: sent([U(1, 1, 1, 1)]) }])).toMatchObject({ ok: false, code: "OFC_ROUND_FINAL" });
  });
});

describe("what the link cannot do", () => {
  it("is refused another event's round and anything that is not entering counts or asking for a correction", async () => {
    const mine = await wall(8);
    const theirs = await wall(8);
    const a = await official(mine.t.id);
    const foreign = heats(theirs.d)[0];
    const foreignLine = inRound(theirs.d, foreign.id)[0];
    // Another event's round: not found for this link; nothing written there.
    expect(await (await post(a.token, { matchId: foreign.id, performances: [{ entryId: foreignLine, counts: sent([U(1, 1, 1, 1)]) }] })).json()).toMatchObject({ code: "OFC_NOT_HERE" });
    expect(await (await post(a.token, { action: "correction_request", matchId: foreign.id, reason: "Not mine to ask", performances: [{ entryId: foreignLine, counts: sent([U(1, 1, 1, 1)]) }] })).json()).toMatchObject({ code: "OFC_NOT_HERE" });
    expect(lineOf(await detail(theirs.t.id), foreign.id, foreignLine).status).toBe("pending");
    // Their own round, but a competitor of the other event.
    const own = heats(mine.d)[0];
    expect((await post(a.token, { matchId: own.id, performances: [{ entryId: foreignLine, counts: sent([U(1, 1, 1, 1)]) }] })).status).toBe(409);
    // The page shows this event and no other.
    expect((await (await get(a.token)).json()).tournament.id).toBe(mine.t.id);
    // A link for an ordinary tournament cannot enter counts, and a climbing event's cannot enter a match result or run the day.
    const ko = await official(mine.t.id, "Match Judge");
    expect(await (await post(ko.token, { matchId: own.id, winner: mine.ids[0], score: "21-5, 21-5" })).json()).toMatchObject({ code: "OFC_PERF_ONLY" });
    for (const action of ["call", "start", "release"]) expect(await (await post(ko.token, { matchId: own.id, action })).json()).toMatchObject({ code: "OFC_PERF_ONLY" });
    // No other action exists for a link: drawing, ending, choosing who goes through, changing settings, taking somebody out.
    for (const action of ["draw", "final", "cancel", "rules", "close", "swiss_pair", "take_out", "settings"]) {
      const res = await post(a.token, { action, chosen: [mine.ids[0]], matchId: own.id });
      expect(res.status, action).toBe(400);
    }
    // And the same for the unknown link.
    expect((await post("not-a-link", { matchId: own.id, performances: [] })).status).toBe(409);
    expect((await get("not-a-link")).status).toBe(404);
  });

  it("is no key to the dashboard: every staff route refuses a request that carries it however it is sent", async () => {
    const { t, d } = await wall(8);
    const a = await official(t.id);
    const h = heats(d)[0];
    const anyParam = new Proxy({}, { get: () => "1" });
    const sentAs: Record<string, string>[] = [
      { authorization: `Bearer ${a.token}` },
      { cookie: `${ADMIN_SESSION_COOKIE}=${a.token}` },
      { cookie: `official=${a.token}; token=${a.token}`, "x-official-token": a.token },
    ];
    let checked = 0;
    for (const [file, load] of Object.entries(routes)) {
      // Signing in and out are not staff actions on a venue: they answer anybody (and say nothing a link could use).
      if (/\/api\/admin\/auth\//.test(file)) continue;
      const mod = (await load()) as Record<string, unknown>;
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        const handler = mod[method] as ((req: NextRequest, ctx: { params: Promise<unknown> }) => Response | Promise<Response>) | undefined;
        if (typeof handler !== "function") continue;
        for (const headers of sentAs) {
          const path = file.replace("../src/app", "").replace("/route.ts", "").replace(/\[[^\]]+\]/g, "1");
          const res = await handler(
            new NextRequest(`http://localhost${path}?token=${a.token}&matchId=${h.id}`, { method, headers: { "content-type": "application/json", origin: "http://localhost", ...headers }, ...(method === "GET" ? {} : { body: JSON.stringify({ token: a.token, matchId: h.id, performances: [] }) }) }),
            { params: Promise.resolve(anyParam) }
          );
          expect(res.status, `${method} ${path} with ${Object.keys(headers)[0]}`).toBeGreaterThanOrEqual(400);
          expect([401, 403, 404, 405].includes(res.status) || res.status === 400, `${method} ${path}: ${res.status}`).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    // Nothing in the event moved.
    const now = await detail(t.id);
    expect(now.status).toBe("drawn");
    expect(lineOf(now, h.id, inRound(d, h.id)[0]).status).toBe("pending");
  });
});
