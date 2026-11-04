import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { readJsonObject, refusal } from "@/lib/api";
import { RATING_FORMATS, type RatingFormat } from "@/lib/rating-math";
import {
  applySeedProposal,
  eventVenue,
  excludeResult,
  ledgerCsv,
  liftExclusion,
  proposeSeeds,
  resetSubject,
  setBusinessBoard,
  setEventRated,
  setRankingPolicy,
  SOURCE_KINDS,
  staffRatings,
  type SourceKind,
  type SubjectKind,
} from "@/lib/ratings";
import { isActivity } from "@/lib/activities";

export const dynamic = "force-dynamic";

const isKind = (v: unknown): v is SourceKind => (SOURCE_KINDS as unknown[]).includes(v);
const isFormat = (v: unknown): v is RatingFormat => (RATING_FORMATS as unknown[]).includes(v);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/**
 * `?venueId=` (a manager's): the venue's ratings as its staff see them: which events count, everybody with a rating (provisional
 * ones too), the results in the ledger with whether each counts, and the exclusions and resets made. `&tournamentId=` adds the
 * seeding the ratings would propose for that tournament's draw, which nothing applies until a manager confirms it. The same private view
 * whether or not the venue's rankings are public: the policy (public, provisional section, counted results before a player is ranked)
 * and who changed what are in it. `&export=ledger` (with `&sport=&format=` for one pool) is the ledger as a CSV, logged.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  if (req.nextUrl.searchParams.get("export") === "ledger") {
    const sport = req.nextUrl.searchParams.get("sport");
    const format = req.nextUrl.searchParams.get("format");
    if ((sport && !(await isActivity(sport))) || (format && !isFormat(format))) return NextResponse.json({ error: "Which sport and format?" }, { status: 400 });
    const csv = await ledgerCsv(venueId, { sport: sport ?? undefined, format: (format as RatingFormat | null) ?? undefined });
    await logAction(admin, { venueId, action: "ratings.ledger_exported", detail: sport && format ? `${sport} ${format}` : "every pool" });
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="rating-ledger-venue-${venueId}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }
  const tournamentId = Number(req.nextUrl.searchParams.get("tournamentId"));
  let seeds = null;
  if (Number.isInteger(tournamentId) && tournamentId > 0) {
    const owner = await eventVenue("tournament", tournamentId);
    if (!owner || owner.venueId !== venueId) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const proposal = await proposeSeeds(tournamentId);
    seeds = proposal.ok ? proposal.value : { error: proposal.error, code: proposal.code };
  }
  return NextResponse.json({ ratings: await staffRatings(venueId), seeds });
}

/**
 * A manager's, each logged: `{ venueId, action }` with
 * `rated` (`kind`, `id`, `rated`): count an event's results in the ratings, until it starts;
 * `business` (`allowed`): list this venue's ratings beside its business's other branches;
 * `policy` (`publicRankings`, `showProvisional`, `rankAfter`: any of them; `rankAfter` 3 to 30, or null for the install's default): whether the venue's rankings are public
 * (off until a manager says so), whether players with fewer counted results are shown apart, and how many counted results rank a player;
 * `exclude` (`sourceKind`, `sourceId`, `sourceMatch`, `unitNo`, `reason`) / `lift` (`exclusionId`, `reason`): leave one result out, or put it back;
 * `reset` (`sport`, `format`, `subjectKind`, `subjectId`, `reason`): start a rating again;
 * `seeds` (`tournamentId`, `seeds`: the proposal shown): set the draw's seeds from ratings.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const b = await readJsonObject(req);
  if (b instanceof NextResponse) return b;
  const venueId = Number(b.venueId);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const by = admin.name || admin.email || "Staff";

  if (b.action === "rated") {
    const id = int(b.id);
    if (!isKind(b.kind) || id === null || typeof b.rated !== "boolean") return NextResponse.json({ error: "Which event, and rated or not?" }, { status: 400 });
    const owner = await eventVenue(b.kind, id);
    if (!owner || owner.venueId !== venueId) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const done = await setEventRated(b.kind, id, b.rated, by);
    if (!done.ok) return refusal(done, done.status ?? 409);
    await logAction(admin, { venueId, action: b.rated ? "ratings.event_rated" : "ratings.event_unrated", detail: `${b.kind} ${done.value.name}` });
    return NextResponse.json({ ratings: await staffRatings(venueId) });
  }
  if (b.action === "business") {
    if (typeof b.allowed !== "boolean") return NextResponse.json({ error: "Allowed or not?" }, { status: 400 });
    await setBusinessBoard(venueId, b.allowed, by);
    await logAction(admin, { venueId, action: "ratings.business_board", detail: b.allowed ? "listed beside the business's other branches" : "not listed beside the business's other branches" });
    return NextResponse.json({ ratings: await staffRatings(venueId) });
  }
  if (b.action === "policy") {
    // Public rankings, the provisional section and the number of counted results before a player is ranked. Each part that changes is logged
    // (who, when, from, to) and nothing else moves: no rating and no ledger row is touched.
    const change: { publicRankings?: boolean; showProvisional?: boolean; rankAfter?: number | null } = {};
    if (b.publicRankings !== undefined) {
      if (typeof b.publicRankings !== "boolean") return NextResponse.json({ error: "Public or not?" }, { status: 400 });
      change.publicRankings = b.publicRankings;
    }
    if (b.showProvisional !== undefined) {
      if (typeof b.showProvisional !== "boolean") return NextResponse.json({ error: "Show the provisional ones or not?" }, { status: 400 });
      change.showProvisional = b.showProvisional;
    }
    if (b.rankAfter !== undefined) {
      if (b.rankAfter !== null && typeof b.rankAfter !== "number") return NextResponse.json({ error: "How many results?" }, { status: 400 });
      change.rankAfter = b.rankAfter;
    }
    if (Object.keys(change).length === 0) return NextResponse.json({ error: "What should change?" }, { status: 400 });
    const done = await setRankingPolicy(venueId, change, by);
    if (!done.ok) return refusal(done, done.status ?? 409);
    const labels: Record<string, string> = { public_rankings: "ratings.public_rankings", show_provisional: "ratings.show_provisional", rank_after: "ratings.rank_after" };
    const now = done.value.policy;
    const details: Record<string, string> = {
      public_rankings: now.publicRankings ? "public rankings on" : "public rankings off",
      show_provisional: now.showProvisional ? "provisional players shown apart" : "provisional players not shown",
      rank_after: now.custom ? `ranked after ${now.rankAfter} counted results` : `ranked after the install's default (${now.rankAfter}) counted results`,
    };
    for (const kind of done.value.changed) await logAction(admin, { venueId, action: labels[kind], detail: details[kind] });
    return NextResponse.json({ ratings: await staffRatings(venueId) });
  }
  if (b.action === "exclude") {
    const sourceId = int(b.sourceId);
    const sourceMatch = int(b.sourceMatch);
    const unitNo = int(b.unitNo) ?? 0;
    if (!isKind(b.sourceKind) || sourceId === null || sourceMatch === null) return NextResponse.json({ error: "Which result?" }, { status: 400 });
    const owner = await eventVenue(b.sourceKind, sourceId);
    if (!owner || owner.venueId !== venueId) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const done = await excludeResult(venueId, { sourceKind: b.sourceKind, sourceId, sourceMatch, unitNo }, b.reason, by);
    if (!done.ok) return refusal(done, done.status ?? 409);
    await logAction(admin, { venueId, action: "ratings.result_excluded", detail: `${owner.name} (${b.sourceKind} result ${sourceMatch}${unitNo ? `.${unitNo}` : ""}): ${String(b.reason).trim()}` });
    return NextResponse.json({ ratings: await staffRatings(venueId) });
  }
  if (b.action === "lift") {
    const exclusionId = int(b.exclusionId);
    if (exclusionId === null) return NextResponse.json({ error: "Which exclusion?" }, { status: 400 });
    const done = await liftExclusion(venueId, exclusionId, b.reason, by);
    if (!done.ok) return refusal(done, done.status ?? 409);
    await logAction(admin, { venueId, action: "ratings.exclusion_lifted", detail: `exclusion ${exclusionId}: ${String(b.reason).trim()}` });
    return NextResponse.json({ ratings: await staffRatings(venueId) });
  }
  if (b.action === "reset") {
    const subjectId = int(b.subjectId);
    if (typeof b.sport !== "string" || !(await isActivity(b.sport)) || !isFormat(b.format) || (b.subjectKind !== "user" && b.subjectKind !== "participant" && b.subjectKind !== "team") || subjectId === null)
      return NextResponse.json({ error: "Whose rating, in which sport and format?" }, { status: 400 });
    const done = await resetSubject(venueId, { sport: b.sport, format: b.format }, { kind: b.subjectKind as SubjectKind, id: subjectId }, b.reason, by);
    if (!done.ok) return refusal(done, done.status ?? 409);
    await logAction(admin, { venueId, action: "ratings.rating_reset", detail: `${b.sport} ${b.format}, ${b.subjectKind} ${subjectId}: ${String(b.reason).trim()}` });
    return NextResponse.json({ ratings: await staffRatings(venueId) });
  }
  if (b.action === "seeds") {
    const tournamentId = int(b.tournamentId);
    if (tournamentId === null) return NextResponse.json({ error: "Which tournament?" }, { status: 400 });
    const owner = await eventVenue("tournament", tournamentId);
    if (!owner || owner.venueId !== venueId) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const done = await applySeedProposal(tournamentId, b.seeds);
    if (!done.ok) return refusal(done, done.status ?? 409);
    await logAction(admin, { venueId, action: "ratings.seeded", detail: `${owner.name}: ${done.value.seeds.length} seeds from ratings` });
    return NextResponse.json({ ratings: await staffRatings(venueId), seeds: done.value });
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
