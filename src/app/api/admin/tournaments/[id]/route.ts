import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { pairingName } from "@/lib/tournament-rules";
import { cancelTournament, changeTournament, closeEntries, makeDraw, makeFinal, setRules, tournamentById, tournamentChangeDetail, tournamentDetail } from "@/lib/tournaments";
import { tickOutbox } from "@/lib/notify";
import { saveVenueTemplate } from "@/lib/competition-templates";
import { staffTournament } from "@/lib/tournament-access";
import { listOfficials, openReports } from "@/lib/match-reports";
import { listCorrectionRequests } from "@/lib/official-performances";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffTournament(req, (await params).id);
  if (found instanceof NextResponse) return found;
  return NextResponse.json({
    tournament: await tournamentDetail(found.id, { forStaff: true }),
    // Results players reported and are waiting on, or dispute; and the officials' links.
    reports: await openReports(found.id),
    officials: await listOfficials(found.id),
    // What officials of a climbing event asked to have corrected, for a manager to review.
    correctionRequests: await listCorrectionRequests(found.id),
  });
}

/**
 * `{ name?, description?, entriesCloseOn?, maxEntries?, entryFee? }` — change
 * its details before the draw (lib/tournaments.ts `changeTournament`): the fee
 * for entries made from now on, never below those entered; more places take
 * entries off the waiting list. Logged as `tournament.changed`.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffTournament(req, (await params).id);
  if (found instanceof NextResponse) return found;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const result = await changeTournament(found.id, {
    name: body.name,
    description: body.description,
    entriesCloseOn: body.entriesCloseOn,
    maxEntries: body.maxEntries,
    entryFee: body.entryFee,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  const { before, after, promoted } = result.value;
  await logAction(found.admin, { venueId: after.venueId, action: "tournament.changed", detail: tournamentChangeDetail(before, after, promoted.length) });
  if (promoted.length > 0) await tickOutbox();
  return NextResponse.json({ tournament: await tournamentDetail(found.id, { forStaff: true }), promoted: promoted.length });
}

/**
 * `{ action: "close" | "draw" | "cancel" }`; `{ action: "rules", rules, confirmFeedIn? }` before the draw (choosing the feed-in consolation draw needs `confirmFeedIn: true`, else 409 `FEED_IN_CONFIRM`); `{ action: "final",
 * chosen }` — who takes the last places in a performance final where competitors are level; `{ action:
 * "save_template", name }` — keep its settings to start the next one from. A Swiss event's rounds: `{ action: "swiss_pair" }`
 * pairs the next round where it could not be paired by itself; `{ action: "swiss_close_round", round, resolutions: [{ matchId,
 * winner }] }` closes the latest round, each match still to play given a walkover to `winner` or, with a null `winner`, played by
 * nobody; `{ action: "swiss_end" }` ends it after the last round paired.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffTournament(req, (await params).id);
  if (found instanceof NextResponse) return found;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (body.action === "save_template") {
    const saved = await saveVenueTemplate(found.id, String(body.name ?? ""), found.admin.id);
    if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 400 });
    return NextResponse.json({ template: saved.value });
  }
  // A Swiss event's next round as it would be paired (lib/swiss.ts `previewNextRound`): each pairing with its reason; nothing is changed.
  if (body.action === "swiss_preview") {
    const preview = await (await import("@/lib/swiss")).previewNextRound(found.id);
    if (!preview.ok) return NextResponse.json({ error: preview.error, code: preview.code }, { status: 409 });
    return NextResponse.json({ preview: preview.value });
  }
  // A Swiss event's tie-break order (lib/swiss.ts, ADR 0038): `{ action: "swiss_tiebreaks", tiebreaks, preview: true }` shows what the table would
  // become; without `preview` it is saved: freely before the draw, from round 1's pairing only with `reason` and the preview's `token` (409 `TIEBREAKS_LOCKED`).
  if (body.action === "swiss_tiebreaks") {
    const swiss = await import("@/lib/swiss");
    if (body.preview === true) {
      const preview = await swiss.previewTiebreaks(found.id, body.tiebreaks);
      if (!preview.ok) return NextResponse.json({ error: preview.error }, { status: 409 });
      return NextResponse.json({ preview: preview.value });
    }
    const saved = await swiss.setTiebreaks(found.id, body.tiebreaks, typeof body.token === "string" ? { token: body.token, reason: String(body.reason ?? "") } : undefined);
    if (!saved.ok) return NextResponse.json({ error: saved.error, ...(saved.code ? { code: saved.code } : {}) }, { status: 409 });
    const t = saved.value.detail;
    await logAction(found.admin, {
      venueId: t.venueId,
      action: "tournament.swiss_tiebreaks",
      detail: `${t.name}: ${saved.value.before.join(", ")} -> ${saved.value.after.join(", ")}${typeof body.token === "string" ? `: ${String(body.reason ?? "").trim().slice(0, 300)}` : ""}`,
    });
    return NextResponse.json({ tournament: t });
  }
  // A counted event played in Swiss rounds (lib/swiss-performances.ts, ADR 0038): a round whose groups a correction put in doubt is grouped again
  // (`swiss_regroup`, previewed with `preview: true`, then confirmed with `token` and `reason`) or kept as it is (`swiss_keep_grouping`, with `reason`).
  if (body.action === "swiss_regroup" || body.action === "swiss_keep_grouping") {
    const perf = await import("@/lib/swiss-performances");
    const round = Number(body.round);
    if (body.action === "swiss_regroup" && body.preview === true) {
      const preview = await perf.previewRegroup(found.id, round);
      if (!preview.ok) return NextResponse.json({ error: preview.error, ...(preview.code ? { code: preview.code } : {}) }, { status: 409 });
      return NextResponse.json({ preview: preview.value });
    }
    const done =
      body.action === "swiss_regroup"
        ? await perf.regroupFrom(found.id, round, { token: String(body.token ?? ""), reason: String(body.reason ?? "") })
        : await perf.keepGrouping(found.id, round, String(body.reason ?? ""));
    if (!done.ok) return NextResponse.json({ error: done.error, ...(done.code ? { code: done.code } : {}) }, { status: 409 });
    await logAction(found.admin, {
      venueId: done.value.venueId,
      action: body.action === "swiss_regroup" ? "tournament.swiss_regrouped" : "tournament.swiss_grouping_kept",
      detail: `${done.value.name}, round ${round}: ${String(body.reason ?? "").trim().slice(0, 300)}`,
    });
    return NextResponse.json({ tournament: done.value });
  }
  // A Swiss event's rounds (lib/swiss.ts): paired again where one could not be, closed with matches undecided, or ended early.
  if (body.action === "swiss_pair" || body.action === "swiss_close_round" || body.action === "swiss_end") {
    const swiss = await import("@/lib/swiss");
    const resolutions = Array.isArray(body.resolutions)
      ? (body.resolutions as Record<string, unknown>[]).map((r) => ({ matchId: Number(r.matchId), winner: r.winner === null || r.winner === undefined ? null : Number(r.winner) }))
      : [];
    const done =
      body.action === "swiss_pair"
        ? await (async () => {
            // A counted event played in Swiss rounds groups its next round (lib/swiss-performances.ts); a head-to-head one pairs it.
            const grouping = (await tournamentById(found.id))?.format === "performance";
            const paired = grouping ? await (await import("@/lib/swiss-performances")).groupNextRound(found.id) : await swiss.pairNextRound(found.id);
            const round = "grouped" in paired ? paired.grouped : "paired" in paired ? paired.paired : null;
            return paired.ok ? ({ ok: true as const, value: round }) : ({ ok: false as const, error: paired.error });
          })()
        : body.action === "swiss_close_round"
          ? await swiss.closeRound(found.id, Number(body.round), resolutions)
          : await swiss.endSwiss(found.id);
    if (!done.ok) return NextResponse.json({ error: done.error }, { status: 409 });
    const t = await tournamentDetail(found.id, { forStaff: true });
    await logAction(found.admin, {
      venueId: t?.venueId ?? null,
      action: body.action === "swiss_pair" ? "tournament.swiss_paired" : body.action === "swiss_close_round" ? "tournament.swiss_round_closed" : "tournament.swiss_ended",
      detail: `${t?.name ?? `Tournament ${found.id}`}${body.action === "swiss_close_round" ? `, round ${Number(body.round)}` : ""}`,
    });
    return NextResponse.json({ tournament: t });
  }
  const result =
    body.action === "final"
      ? await makeFinal(found.id, Array.isArray(body.chosen) ? body.chosen.map(Number) : [])
      : body.action === "close"
      ? await closeEntries(found.id)
      : body.action === "draw"
        ? await makeDraw(found.id)
        : body.action === "cancel"
          ? await cancelTournament(found.id)
          : body.action === "rules"
            ? await setRules(found.id, body.rules, { confirmFeedIn: body.confirmFeedIn === true })
            : null;
  if (!result) return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (!result.ok) return NextResponse.json({ error: result.error, ...(result.code ? { code: result.code, vars: result.vars } : {}) }, { status: 409 });
  const t = await tournamentDetail(found.id, { forStaff: true });
  await logAction(found.admin, {
    venueId: t?.venueId ?? null,
    action:
      body.action === "close"
        ? "tournament.closed"
        : body.action === "draw"
          ? "tournament.drawn"
          : body.action === "rules"
            ? "tournament.rules"
            : body.action === "final"
              ? "tournament.final_chosen"
              : "tournament.cancelled",
    // Which Swiss pairing the event will use is a rule a manager sets before the draw: say what it was set to.
    detail: `${t?.name ?? `Tournament ${found.id}`}${body.action === "rules" && t?.format === "swiss" ? `, pairing ${pairingName(t.rules.swiss)}` : ""}`,
  });
  return NextResponse.json({ tournament: await tournamentDetail(found.id, { forStaff: true }) });
}
