import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { readJsonObject, refusal } from "@/lib/api";
import { RATING_FORMATS, type RatingFormat } from "@/lib/rating-math";
import {
  applySeedProposal,
  eventVenue,
  excludeResult,
  liftExclusion,
  proposeSeeds,
  resetSubject,
  setBusinessBoard,
  setEventRated,
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
 * seeding the ratings would propose for that tournament's draw, which nothing applies until a manager confirms it.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
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
    const done = await setEventRated(b.kind, id, b.rated);
    if (!done.ok) return refusal(done, done.status ?? 409);
    await logAction(admin, { venueId, action: b.rated ? "ratings.event_rated" : "ratings.event_unrated", detail: `${b.kind} ${done.value.name}` });
    return NextResponse.json({ ratings: await staffRatings(venueId) });
  }
  if (b.action === "business") {
    if (typeof b.allowed !== "boolean") return NextResponse.json({ error: "Allowed or not?" }, { status: 400 });
    await setBusinessBoard(venueId, b.allowed);
    await logAction(admin, { venueId, action: "ratings.business_board", detail: b.allowed ? "listed beside the business's other branches" : "not listed beside the business's other branches" });
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
