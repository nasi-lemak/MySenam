"use client";

import { readJson } from "@/lib/read-response";
import { courtOffers } from "@/lib/court-activities";
import { activityKeys } from "@/lib/activity-registry";
import { useCallback, useEffect, useState } from "react";
import { todayLocal } from "./shared";
import type { ManagedVenue } from "./shared";
import { addDays } from "@/lib/time";
import { formatMinute } from "@/lib/interval";
import { ClockField } from "@/components/ClockField";
import { type Sport } from "@/lib/types";
import type { CorrectionPreview, IssueReview, Match, ResultInput, Tournament, TournamentDetail } from "@/lib/tournaments";
import { RANK_KEYS, type CompetitionRules, type OutReason, type RankKey } from "@/lib/tournament-rules";
import type { CompetitionTemplate, VenueTemplate } from "@/lib/competition-templates";
import type { Competition } from "@/lib/competitions";
import type { MatchReport, Official } from "@/lib/match-reports";
import { currencySymbol, money } from "@/lib/region";
import type { RefusalBody } from "@/lib/i18n";
import type { StaffT } from "@/lib/staff-i18n";
import { useStaffClock, useStaffT } from "./StaffLanguage";
import { LoadFailed } from "./place";
import { CounterEntry } from "./CounterEntry";
import { CountedHeat, FieldCounts } from "./CountedGrid";
import { TournamentDetailsEditor } from "./TournamentDetailsEditor";
import { TournamentDay } from "./TournamentDay";
import { SwissPanel } from "./SwissPanel";
import { sportLabel } from "@/lib/i18n";
import type { StaffText } from "@/lib/staff-text";
import { PayMark } from "./CounterMethod";
import { ManagerOnly, useStaffMay } from "./StaffMay";

/** A sentence the server wrote: its English, and its phrase for the staff language where it sent one. */
type Said = { text: string; phrase?: StaffText };

/** What a change said, from a response's `changes` and `changePhrases`. */
function changesSaid(data: Record<string, unknown>): Said[] {
  const phrases = (data.changePhrases as StaffText[] | undefined) ?? [];
  return ((data.changes as string[] | undefined) ?? []).map((text, i) => ({ text, phrase: phrases[i] }));
}

const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
const LEVELS = ["", "beginner", "intermediate", "advanced", "competitive"];

/** A level as staff read it; anything else as stored. Leagues use the same words (LeaguesTab.tsx). */
export function levelLabel(t: StaffT, level: string): string {
  const known: Record<string, string> = {
    beginner: t("tn.level.beginner"),
    intermediate: t("tn.level.intermediate"),
    advanced: t("tn.level.advanced"),
    competitive: t("tn.level.competitive"),
  };
  return known[level] ?? level;
}

/** First and last day, or the one day. */
const dates = (t: StaffT, from: string, to: string) => (to !== from ? t("tn.dateRange", { from, to }) : from);

const statusLabel = (t: StaffT, status: Tournament["status"] | Competition["status"]): string =>
  ({
    open: t("tn.status.open"),
    closed: t("tn.status.closed"),
    drawn: t("tn.status.drawn"),
    finished: t("tn.status.finished"),
    cancelled: t("tn.status.cancelled"),
  })[status] ?? status;

const outLabel = (t: StaffT, reason: OutReason): string =>
  ({ withdrawn: t("tn.out.withdrawn"), retired: t("tn.out.retired"), disqualified: t("tn.out.disqualified") })[reason] ?? reason;

/**
 * A venue's tournaments: set one up, holding its courts; take entries; seed
 * and make the draw; and enter results as they come in.
 *
 * Setting up, the draw and rules, calling off and a correction's knock-on are
 * a manager's (lib/roles.ts): front desk reads them and runs entries, check-in,
 * payments, officials and results.
 */
export function TournamentsTab({ venues }: { venues: ManagedVenue[] }) {
  const t = useStaffT();
  const may = useStaffMay();
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [list, setList] = useState<Tournament[]>([]);
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [catalog, setCatalog] = useState<{ templates: CompetitionTemplate[]; venueTemplates: VenueTemplate[] }>({ templates: [], venueTemplates: [] });
  const [open, setOpen] = useState<TournamentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The list could not be read: said so, with Try again, never "None yet" (audit R8 X2-7).
  const [loadError, setLoadError] = useState<string | null>(null);
  const venue = venues.find((v) => v.id === venueId);

  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      const res = await fetch(`/api/admin/tournaments?venueId=${venueId}`, { cache: "no-store" });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("q8b.loadFailed")));
      setList(data.tournaments);
      setCompetitions(data.competitions ?? []);
      setCatalog({ templates: data.templates ?? [], venueTemplates: data.venueTemplates ?? [] });
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("q8b.loadFailed"));
    }
  }, [venueId, t]);
  useEffect(() => {
    void load();
  }, [load]);

  async function show(id: number) {
    setError(null);
    try {
      const res = await fetch(`/api/admin/tournaments/${id}`, { cache: "no-store" });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("q8b.loadFailed")));
      setOpen(data.tournament);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("q8b.loadFailed"));
    }
  }

  /** A request whose answer the caller reads (previews, corrections); errors shown as for `post`. */
  async function call(url: string, body: object): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    setError(null);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await readJson(res).catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) setError(t.err(data as RefusalBody));
    else {
      if (data.tournament && typeof data.tournament === "object" && "entries" in data.tournament) setOpen(data.tournament as TournamentDetail);
      await load();
    }
    return { ok: res.ok, data };
  }

  async function post(url: string, body: object): Promise<boolean> {
    setError(null);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await readJson(res);
    if (!res.ok) {
      setError(t.err(data));
      return false;
    }
    if (data.tournament && "entries" in data.tournament) setOpen(data.tournament);
    await load();
    return true;
  }

  async function callOff(c: Competition) {
    if (!confirm(t("tn.callOffCompetitionConfirm", { name: c.name }))) return;
    setError(null);
    const res = await fetch(`/api/admin/competitions/${c.id}`, { method: "DELETE" });
    const data = await readJson(res).catch(() => ({}));
    if (!res.ok) setError(t.err(data));
    await load();
  }

  if (!venue) return <p className="text-sm text-slate-500">{t("tn.noVenue")}</p>;
  return (
    <div className="space-y-4">
      {venues.length > 1 && (
        <select aria-label={t("q8b.l.venue")} value={venueId} onChange={(e) => { setVenueId(Number(e.target.value)); setOpen(null); }} className={input}>
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      )}
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {open ? (
        <Manage tn={open} venue={venue} post={post} call={call} close={() => setOpen(null)} replace={(tn) => { setOpen(tn); void load(); }} />
      ) : (
        <>
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="font-semibold">{t("tn.title")}</h2>
            {loadError ? (
              <LoadFailed message={loadError} onRetry={() => void load()} />
            ) : list.length === 0 ? (
              <p className="mt-1 text-sm text-slate-500">{t("tn.noneYet")}</p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-100 text-sm">
                {list.map((x) => (
                  <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <span className="font-medium">{x.name}</span>
                      {x.competition && <span className="text-slate-500"> ({x.competition.name})</span>} · {dates(t, x.startsOn, x.endsOn)} ·{" "}
                      {x.waitlisted > 0
                        ? t("tn.enteredWaiting", { n: x.entered, max: x.maxEntries, waiting: x.waitlisted })
                        : t("tn.entered", { n: x.entered, max: x.maxEntries })}{" "}
                      · <span className="text-slate-500">{statusLabel(t, x.status)}</span>
                    </span>
                    <button onClick={() => void show(x.id)} className="text-sm font-medium text-teal-700 underline">
                      {t("tn.open")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {competitions.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="font-semibold">{t("tn.competitions")}</h2>
              <p className="mt-0.5 text-xs text-slate-500">{t("tn.competitionsIntro")}</p>
              <ul className="mt-2 divide-y divide-slate-100 text-sm">
                {competitions.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <span className="font-medium">{c.name}</span> · {dates(t, c.startsOn, c.endsOn)}, {formatMinute(c.startMin, t.locale)}–{formatMinute(c.endMin, t.locale)} ·{" "}
                      {t("tn.divisionCount", { n: list.filter((x) => x.competition?.id === c.id).length })}
                      {c.maxDivisionsPerPlayer !== null && ` · ${t("tn.upToPerPlayer", { n: c.maxDivisionsPerPlayer })}`} · <span className="text-slate-500">{statusLabel(t, c.status)}</span>
                    </span>
                    {c.status === "open" && may("competitionCancel") && (
                      <button onClick={() => void callOff(c)} className="text-sm text-red-700 underline">
                        {t("tn.callOff")}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {catalog.templates.length > 0 && (
            <ManagerOnly may="tournaments">
              <Create venue={venue} post={post} catalog={catalog} competitions={competitions.filter((c) => c.status === "open")} />
            </ManagerOnly>
          )}
          {/* Said once, above the first form the desk reads. */}
          <ManagerOnly may="competitions" note={catalog.templates.length === 0}>
            <CreateCompetition venue={venue} post={post} />
          </ManagerOnly>
        </>
      )}
    </div>
  );
}

const formatLabel = (t: StaffT, format: string): string =>
  ({
    knockout: t("tn.format.knockout"),
    groups: t("tn.format.groups"),
    round_robin: t("tn.format.roundRobin"),
    performance: t("tn.format.performance"),
    swiss: t("tn.format.swiss"),
  })[format] ?? format;

function Create({
  venue,
  post,
  catalog,
  competitions,
}: {
  venue: ManagedVenue;
  post: (url: string, body: object) => Promise<boolean>;
  catalog: { templates: CompetitionTemplate[]; venueTemplates: VenueTemplate[] };
  competitions: Competition[];
}) {
  const t = useStaffT();
  const sports = activityKeys().filter((s) => venue.courts.some((c) => c.sport === s));
  const start = addDays(todayLocal(), 14);
  /** The template a sport starts from: its own, else the general one. */
  const templateFor = (sport: string) => catalog.templates.find((x) => x.sports.includes(sport)) ?? catalog.templates.find((x) => x.key === "custom")!;
  const first = templateFor(sports[0] ?? "badminton");
  const [f, setF] = useState({
    name: "",
    sport: (sports[0] ?? "badminton") as Sport,
    template: first.key,
    format: first.formats[0] as string,
    teamSize: 1,
    entryKind: first.entryKinds[0] as string,
    roster: first.roster ?? { min: 2, max: 20 },
    category: "open",
    level: "",
    entryFee: "20",
    maxEntries: "16",
    groupSize: "4",
    advance: "2",
    startsOn: start,
    endsOn: start,
    // Each day's time, in minutes of the day, and how long each match is given on court.
    startMin: Math.max(venue.openMin, 9 * 60),
    endMin: Math.min(venue.closeMin, 18 * 60),
    matchMinutes: String(first.matchMinutes),
    courtIds: [] as number[],
    description: "",
    rules: first.rules as CompetitionRules,
    // A division of a competition (its days, hours and courts), and who may enter.
    competitionId: "",
    entriesCloseOn: "",
    ageMin: "",
    ageMax: "",
    membersOnly: false,
    resultsBy: "staff",
    // Match lengths by stage (blank: the length above), and a third-place match.
    stageMinutes: { group: "", knockout: "", final: "", heat: "" } as Record<"group" | "knockout" | "final" | "heat", string>,
    thirdPlace: false,
    // A Swiss event: its rounds (blank: the default for the number entered) and what a bye is worth (blank: a win's points).
    swissRounds: "",
    swissByePoints: "",
  });
  const partOf = competitions.find((c) => String(c.id) === f.competitionId) ?? null;
  const courts = venue.courts.filter((c) => courtOffers(c, f.sport));
  const label = "flex flex-col text-xs font-medium text-slate-500";
  const template = catalog.templates.find((x) => x.key === f.template) ?? first;
  /** Start from a template: its formats, who enters, the match length and its rules. */
  const startFrom = (tpl: CompetitionTemplate, sport = f.sport) =>
    setF({
      ...f,
      sport,
      template: tpl.key,
      format: tpl.formats.includes(f.format as never) ? f.format : tpl.formats[0],
      entryKind: tpl.entryKinds.includes(f.entryKind as never) ? f.entryKind : tpl.entryKinds[0],
      teamSize: tpl.entryKinds.includes("pair") && f.teamSize === 2 ? 2 : 1,
      roster: tpl.roster ?? f.roster,
      matchMinutes: String(tpl.matchMinutes),
      rules: tpl.rules,
      courtIds: sport === f.sport ? f.courtIds : [],
    });

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await post("/api/admin/tournaments", {
          ...f,
          competitionId: partOf ? partOf.id : null,
          entriesCloseOn: f.entriesCloseOn || null,
          ageMin: f.ageMin === "" ? null : Number(f.ageMin),
          ageMax: f.ageMax === "" ? null : Number(f.ageMax),
          teamSize: f.entryKind === "pair" ? 2 : 1,
          roster: f.entryKind === "team" ? f.roster : undefined,
          venueId: venue.id,
          entryFee: Number(f.entryFee),
          maxEntries: Number(f.maxEntries),
          groupSize: Number(f.groupSize),
          advance: Number(f.advance),
          matchMinutes: Number(f.matchMinutes),
          stageMinutes: Object.fromEntries(Object.entries(f.stageMinutes).filter(([, v]) => v !== "").map(([k, v]) => [k, Number(v)])),
          thirdPlace: f.thirdPlace && (f.format === "knockout" || f.format === "groups"),
          rules:
            f.format === "swiss"
              ? { ...f.rules, swiss: { rounds: f.swissRounds === "" ? null : Number(f.swissRounds), byePoints: f.swissByePoints === "" ? null : Number(f.swissByePoints), tiebreaks: null } }
              : f.rules,
          courtIds: f.courtIds.length ? f.courtIds : courts.map((c) => c.id),
        });
        if (ok) setF({ ...f, name: "", description: "" });
      }}
      className="space-y-3 rounded-xl border border-dashed border-slate-300 bg-white p-4"
    >
      <h2 className="font-semibold">{t("tn.setUp")}</h2>
      {competitions.length > 0 && (
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("tn.partOf")}
          <select
            value={f.competitionId}
            onChange={(e) => {
              const c = competitions.find((x) => String(x.id) === e.target.value);
              if (c)
                setF({ ...f, competitionId: e.target.value, sport: c.sport as Sport, template: templateFor(c.sport).key, rules: templateFor(c.sport).rules, matchMinutes: String(c.matchMinutes) });
              else setF({ ...f, competitionId: "" });
            }}
            className={`w-72 ${input}`}
          >
            <option value="">{t("tn.onItsOwn")}</option>
            {competitions.map((c) => (
              <option key={c.id} value={c.id}>
                {t("tn.divisionOf", { name: c.name })}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="text-sm text-slate-500">{t("tn.setUpIntro")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className={label}>
          {t("c.name")}
          <input required minLength={3} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={`w-64 ${input}`} placeholder={t("tn.namePlaceholder")} />
        </label>
        <label className={label}>
          {t("tn.sport")}
          <select value={f.sport} onChange={(e) => startFrom(templateFor(e.target.value), e.target.value as Sport)} className={input}>
            {sports.map((s) => (
              <option key={s} value={s}>
                {t.locale === "en" ? s : sportLabel(t.customer, s)}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          {t("tn.startingFrom")}
          <select
            value={f.template}
            onChange={(e) => {
              const own = catalog.venueTemplates.find((v) => `venue:${v.id}` === e.target.value);
              if (own)
                setF({
                  ...f,
                  sport: own.sport as Sport,
                  format: own.format,
                  entryKind: own.entryKind,
                  teamSize: own.entryKind === "pair" ? 2 : 1,
                  roster: own.roster ?? f.roster,
                  matchMinutes: String(own.matchMinutes),
                  groupSize: String(own.groupSize),
                  advance: String(own.advance),
                  rules: own.rules,
                  template: templateFor(own.sport).key,
                });
              else startFrom(catalog.templates.find((x) => x.key === e.target.value)!);
            }}
            className={`w-72 ${input}`}
          >
            {catalog.templates
              .filter((x) => x.sports.includes(f.sport) || x.sports.length === 0 || x.formats.some((fm) => fm !== "performance"))
              .map((x) => (
                <option key={x.key} value={x.key}>
                  {t.known(`srv.tpl.${x.key}`) ?? x.label}
                </option>
              ))}
            {catalog.venueTemplates.length > 0 && (
              <optgroup label={t("tn.yourOwn")}>
                {catalog.venueTemplates.map((v) => (
                  <option key={v.id} value={`venue:${v.id}`}>
                    {v.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <label className={label}>
          {t("tn.format")}
          <select value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })} className={input}>
            {template.formats.map((fm) => (
              <option key={fm} value={fm}>
                {formatLabel(t, fm)}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          {t("tn.whoEnters")}
          <select
            value={f.entryKind}
            onChange={(e) => setF({ ...f, entryKind: e.target.value, teamSize: e.target.value === "pair" ? 2 : 1, category: e.target.value !== "pair" && f.category === "mixed" ? "open" : f.category })}
            className={input}
          >
            {template.entryKinds.map((k) => (
              <option key={k} value={k}>
                {k === "player" ? t("tn.entryKind.player") : k === "pair" ? t("tn.entryKind.pair") : t("tn.entryKind.team")}
              </option>
            ))}
          </select>
        </label>
        {f.entryKind === "team" && (
          <label className={label}>
            {t("tn.roster")}
            <span className="flex gap-1">
              <input type="number" min={1} max={40} value={f.roster.min} onChange={(e) => setF({ ...f, roster: { ...f.roster, min: Number(e.target.value) } })} className={`w-16 ${input}`} />
              <input type="number" min={1} max={40} value={f.roster.max} onChange={(e) => setF({ ...f, roster: { ...f.roster, max: Number(e.target.value) } })} className={`w-16 ${input}`} />
            </span>
          </label>
        )}
        <label className={label}>
          {t("tn.category")}
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value, entryKind: e.target.value === "mixed" ? "pair" : f.entryKind, teamSize: e.target.value === "mixed" ? 2 : f.teamSize })} className={input}>
            <option value="open">{t("tn.openToAll")}</option>
            <option value="women">{t("tn.cat.women")}</option>
            <option value="men">{t("tn.cat.men")}</option>
            {template.entryKinds.includes("pair") && <option value="mixed">{t("tn.cat.mixed")}</option>}
          </select>
        </label>
        <label className={label}>
          {t("tn.level")}
          <select value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })} className={input}>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l ? levelLabel(t, l) : t("tn.openToAll")}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          {t("tn.entryFee", { cur: currencySymbol() })}
          <input type="number" min={0} step={0.01} value={f.entryFee} onChange={(e) => setF({ ...f, entryFee: e.target.value })} className={`w-24 ${input}`} />
        </label>
        <label className={label}>
          {t("tn.maxEntries")}
          <input type="number" min={2} max={128} value={f.maxEntries} onChange={(e) => setF({ ...f, maxEntries: e.target.value })} className={`w-20 ${input}`} />
        </label>
        {f.format === "swiss" && (
          <>
            <label className={label}>
              {t("sw.setRounds")}
              <input type="number" min={1} max={127} placeholder={t("sw.setRoundsDefault")} value={f.swissRounds} onChange={(e) => setF({ ...f, swissRounds: e.target.value })} className={`w-24 ${input}`} />
            </label>
            <label className={label}>
              {t("sw.setByePoints")}
              <input type="number" min={0} max={10} placeholder={t("sw.setByePointsDefault")} value={f.swissByePoints} onChange={(e) => setF({ ...f, swissByePoints: e.target.value })} className={`w-24 ${input}`} />
            </label>
          </>
        )}
        {f.format === "groups" && (
          <>
            <label className={label}>
              {t("tn.groupSize")}
              <input type="number" min={3} max={6} value={f.groupSize} onChange={(e) => setF({ ...f, groupSize: e.target.value })} className={`w-20 ${input}`} />
            </label>
            <label className={label}>
              {t("tn.throughFromEach")}
              <select value={f.advance} onChange={(e) => setF({ ...f, advance: e.target.value })} className={input}>
                <option value="1">1</option>
                <option value="2">2</option>
              </select>
            </label>
          </>
        )}
      </div>
      {partOf ? (
        <div className="flex flex-wrap items-end gap-3">
          <p className="text-sm text-slate-600">
            {t("tn.playedIn", {
              name: partOf.name,
              dates: dates(t, partOf.startsOn, partOf.endsOn),
              from: formatMinute(partOf.startMin, t.locale),
              until: formatMinute(partOf.endMin, t.locale),
              minutes: partOf.matchMinutes,
            })}
          </p>
          <label className={label}>
            {t("tn.divisionMinutes")}
            <input type="number" min={5} max={600} value={f.matchMinutes} onChange={(e) => setF({ ...f, matchMinutes: e.target.value })} className={`w-24 ${input}`} />
          </label>
        </div>
      ) : (
      <div className="flex flex-wrap items-end gap-3">
        <label className={label}>
          {t("tn.firstDay")}
          <input type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value, endsOn: e.target.value > f.endsOn ? e.target.value : f.endsOn })} className={input} />
        </label>
        <label className={label}>
          {t("tn.lastDay")}
          <input type="date" min={f.startsOn} value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} className={input} />
        </label>
        <label className={label}>
          {t("c.from")}
          <ClockField label={t("c.from")} value={f.startMin} onChange={(m) => setF({ ...f, startMin: m })} className={input} />
        </label>
        <label className={label}>
          {t("c.until")}
          <ClockField label={t("c.until")} value={f.endMin} after={f.startMin} onChange={(m) => setF({ ...f, endMin: m })} className={input} />
        </label>
        <label className={label}>
          {f.format === "performance" ? t("tn.eachHeat") : t("tn.eachMatch")}
          <input type="number" min={5} max={600} value={f.matchMinutes} onChange={(e) => setF({ ...f, matchMinutes: e.target.value })} className={input} />
        </label>
        <fieldset className="text-sm">
          <legend className="text-xs font-medium text-slate-500">{t("tn.courtsAll")}</legend>
          <div className="flex flex-wrap gap-3 pt-1">
            {courts.map((c) => (
              <label key={c.id} className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={f.courtIds.includes(c.id)}
                  onChange={() =>
                    setF({ ...f, courtIds: f.courtIds.includes(c.id) ? f.courtIds.filter((x) => x !== c.id) : [...f.courtIds, c.id] })
                  }
                />
                {c.name}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className={label}>
          {t("tn.entriesClose")}
          <input type="date" value={f.entriesCloseOn} onChange={(e) => setF({ ...f, entriesCloseOn: e.target.value })} className={input} />
        </label>
        <label className={label}>
          {t("tn.ages")}
          <span className="flex items-center gap-1">
            <input type="number" min={3} max={99} placeholder={t("tn.ageFrom")} aria-label={t("tn.youngest")} value={f.ageMin} onChange={(e) => setF({ ...f, ageMin: e.target.value })} className={`w-16 ${input}`} />
            –
            <input type="number" min={3} max={99} placeholder={t("tn.ageTo")} aria-label={t("tn.oldest")} value={f.ageMax} onChange={(e) => setF({ ...f, ageMax: e.target.value })} className={`w-16 ${input}`} />
          </span>
        </label>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={f.membersOnly} onChange={(e) => setF({ ...f, membersOnly: e.target.checked })} />
          {t("tn.membersOnly")}
        </label>
        {f.format !== "performance" && (
          <label className={label}>
            {t("tn.resultsBy")}
            <select value={f.resultsBy} onChange={(e) => setF({ ...f, resultsBy: e.target.value })} className={input}>
              <option value="staff">{t("tn.resultsBy.staff")}</option>
              <option value="players">{t("tn.resultsBy.players")}</option>
            </select>
          </label>
        )}
      </div>
      {(f.ageMin || f.ageMax) && (
        <p className="text-xs text-slate-500">{t("tn.ageNote")}</p>
      )}
      <textarea placeholder={t("tn.aboutPlaceholder")} aria-label={t("tn.aboutPlaceholder")} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} rows={2} className={`w-full ${input}`} />
      <p className="text-xs text-slate-500">
        {t.known(`srv.tpl.${template.key}.note`) ?? template.note} {t("tn.templateCaveat")}
      </p>
      {f.format !== "performance" && <RulesFields rules={f.rules} onChange={(rules) => setF({ ...f, rules })} />}
      <details className="rounded-lg border border-slate-200 p-3">
        <summary className="cursor-pointer text-sm font-medium text-slate-700">{f.format === "knockout" || f.format === "groups" ? t("tn.stageLengthsThird") : t("tn.stageLengths")}</summary>
        <p className="mt-2 text-xs text-slate-500">{t("tn.stageLengthsNote", { minutes: f.matchMinutes })}</p>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          {(f.format === "performance" ? (["heat", "final"] as const) : f.format === "knockout" ? (["knockout", "final"] as const) : f.format === "groups" ? (["group", "knockout", "final"] as const) : (["group"] as const)).map((k) => (
            <label key={k} className={label}>
              {k === "group" ? t("tn.stage.group") : k === "knockout" ? t("tn.stage.knockout") : k === "heat" ? t("tn.stage.heat") : t("tn.stage.final")}
              <input type="number" min={5} max={600} placeholder={f.matchMinutes} value={f.stageMinutes[k]} onChange={(e) => setF({ ...f, stageMinutes: { ...f.stageMinutes, [k]: e.target.value } })} className={`w-24 ${input}`} />
            </label>
          ))}
          {(f.format === "knockout" || f.format === "groups") && (
            <label className="flex items-center gap-1.5 text-sm text-slate-600">
              <input type="checkbox" checked={f.thirdPlace} onChange={(e) => setF({ ...f, thirdPlace: e.target.checked })} />
              {t("tn.thirdPlace")}
            </label>
          )}
        </div>
      </details>
      <details className="rounded-lg border border-slate-200 p-3">
        <summary className="cursor-pointer text-sm font-medium text-slate-700">{t("tn.scoring")}</summary>
        <ScoringFields rules={f.rules} onChange={(rules) => setF({ ...f, rules })} />
      </details>
      <button className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">{t("tn.setUpHold")}</button>
    </form>
  );
}

/** A competition: one event holding its courts once, for divisions added to it as tournaments. */
function CreateCompetition({ venue, post }: { venue: ManagedVenue; post: (url: string, body: object) => Promise<boolean> }) {
  const t = useStaffT();
  const sports = activityKeys().filter((s) => venue.courts.some((c) => c.sport === s));
  const start = addDays(todayLocal(), 21);
  const [f, setF] = useState({
    name: "",
    sport: (sports[0] ?? "badminton") as Sport,
    startsOn: start,
    endsOn: start,
    startMin: Math.max(venue.openMin, 9 * 60),
    endMin: Math.min(venue.closeMin, 18 * 60),
    matchMinutes: "45",
    courtIds: [] as number[],
    maxDivisionsPerPlayer: "",
  });
  const courts = venue.courts.filter((c) => courtOffers(c, f.sport));
  const label = "flex flex-col text-xs font-medium text-slate-500";
  return (
    <details className="rounded-xl border border-dashed border-slate-300 bg-white p-4">
      <summary className="cursor-pointer font-semibold">{t("tn.setUpCompetition")}</summary>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await post("/api/admin/competitions", {
            ...f,
            venueId: venue.id,
            matchMinutes: Number(f.matchMinutes),
            courtIds: f.courtIds.length ? f.courtIds : courts.map((c) => c.id),
            maxDivisionsPerPlayer: f.maxDivisionsPerPlayer === "" ? null : Number(f.maxDivisionsPerPlayer),
          });
          if (ok) setF({ ...f, name: "" });
        }}
        className="mt-3 space-y-3"
      >
        <p className="text-sm text-slate-500">{t("tn.competitionIntro", { partOf: t("tn.partOf") })}</p>
        <div className="flex flex-wrap items-end gap-3">
          <label className={label}>
            {t("c.name")}
            <input required minLength={3} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={`w-64 ${input}`} placeholder={t("tn.competitionPlaceholder")} />
          </label>
          <label className={label}>
            {t("tn.sport")}
            <select value={f.sport} onChange={(e) => setF({ ...f, sport: e.target.value as Sport, courtIds: [] })} className={input}>
              {sports.map((s) => (
                <option key={s} value={s}>
                  {t.locale === "en" ? s : sportLabel(t.customer, s)}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            {t("tn.firstDay")}
            <input type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value, endsOn: e.target.value > f.endsOn ? e.target.value : f.endsOn })} className={input} />
          </label>
          <label className={label}>
            {t("tn.lastDay")}
            <input type="date" min={f.startsOn} value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} className={input} />
          </label>
          <label className={label}>
            {t("c.from")}
            <ClockField label={t("c.from")} value={f.startMin} onChange={(m) => setF({ ...f, startMin: m })} className={input} />
          </label>
          <label className={label}>
            {t("c.until")}
            <ClockField label={t("c.until")} value={f.endMin} after={f.startMin} onChange={(m) => setF({ ...f, endMin: m })} className={input} />
          </label>
          <label className={label}>
            {t("tn.eachMatch")}
            <input type="number" min={5} max={600} value={f.matchMinutes} onChange={(e) => setF({ ...f, matchMinutes: e.target.value })} className={`w-20 ${input}`} />
          </label>
          <label className={label}>
            {t("tn.divisionsPerPlayer")}
            <input type="number" min={1} max={20} value={f.maxDivisionsPerPlayer} onChange={(e) => setF({ ...f, maxDivisionsPerPlayer: e.target.value })} className={`w-20 ${input}`} />
          </label>
        </div>
        <fieldset className="text-sm">
          <legend className="text-xs font-medium text-slate-500">{t("tn.courtsAll")}</legend>
          <div className="flex flex-wrap gap-3 pt-1">
            {courts.map((c) => (
              <label key={c.id} className="inline-flex items-center gap-1">
                <input type="checkbox" checked={f.courtIds.includes(c.id)} onChange={() => setF({ ...f, courtIds: f.courtIds.includes(c.id) ? f.courtIds.filter((x) => x !== c.id) : [...f.courtIds, c.id] })} />
                {c.name}
              </label>
            ))}
          </div>
        </fieldset>
        <button className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">{t("tn.setUpHold")}</button>
      </form>
    </details>
  );
}

/**
 * Results from the people on court: what players reported and are waiting on
 * or dispute (staff settle it by entering the result below), and officials'
 * links to enter results, each shown once when made.
 */
function ResultsByPeople({ tn }: { tn: TournamentDetail }) {
  const t = useStaffT();
  const [state, setState] = useState<{ reports: MatchReport[]; officials: Official[] }>({ reports: [], officials: [] });
  const [link, setLink] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const base = `/api/admin/tournaments/${tn.id}`;
  const load = useCallback(async () => {
    const res = await fetch(base, { cache: "no-store" });
    if (res.ok) {
      const data = await readJson(res);
      setState({ reports: data.reports ?? [], officials: data.officials ?? [] });
    }
  }, [base]);
  useEffect(() => {
    void load();
  }, [load, tn]);
  const names = new Map(tn.entries.map((e) => [e.id, e.name]));
  const said = (r: MatchReport) =>
    r.walkover
      ? t("tn.report.walkover", { name: names.get(r.winner ?? 0) ?? "" })
      : r.winner === null
        ? t("tn.report.draw", { score: r.score ?? "" })
        : t("tn.report.won", { name: names.get(r.winner) ?? "", score: r.score ?? "" });
  const live = state.officials.filter((o) => !o.revokedAt);
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <h3 className="font-semibold">{t("tn.resultsFromPeople")}</h3>
      {error && <p className="mt-1 text-red-700">{error}</p>}
      {tn.resultsBy === "players" && (
        <div className="mt-2">
          {state.reports.length === 0 ? (
            <p className="text-slate-500">{t("tn.playersReportNone")}</p>
          ) : (
            <ul className="space-y-1">
              {state.reports.map((r) => (
                <li key={r.id} className={r.status === "disputed" ? "text-amber-900" : "text-slate-700"}>
                  {t(
                    r.status === "disputed"
                      ? r.disputeNote
                        ? "tn.report.disputedNote"
                        : "tn.report.disputed"
                      : r.disputeNote
                        ? "tn.report.waitingNote"
                        : "tn.report.waiting",
                    { name: names.get(r.entryId) ?? "", what: said(r), note: r.disputeNote ?? "" },
                  )}{" "}
                  {r.status === "disputed" && t("tn.report.enterBelow")}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="mt-3">
        <p className="text-slate-600">{t("tn.officialsIntro")}</p>
        <ul className="mt-1 space-y-1">
          {live.map((o) => (
            <li key={o.id} className="flex items-center gap-2">
              {o.name}
              {o.expiresOn && <span className="text-xs text-slate-500">{t("tn.until", { date: o.expiresOn })}</span>}
              <button
                onClick={async () => {
                  setError(null);
                  const res = await fetch(`${base}/officials/${o.id}`, { method: "DELETE" });
                  if (!res.ok) setError(t.err(await readJson(res)));
                  await load();
                }}
                className="text-xs text-red-700 underline"
              >
                {t("tn.withdrawLink")}
              </button>
            </li>
          ))}
        </ul>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            const res = await fetch(`${base}/officials`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
            const data = await readJson(res);
            if (!res.ok) return setError(t.err(data));
            setLink(data.link);
            setName("");
            await load();
          }}
          className="mt-2 flex flex-wrap items-center gap-2"
        >
          <input required minLength={2} placeholder={t("tn.officialName")} aria-label={t("tn.officialName")} value={name} onChange={(e) => setName(e.target.value)} className={input} />
          <button className="rounded-md border border-slate-300 px-3 py-1 text-sm">{t("tn.giveLink")}</button>
        </form>
        {link && (
          <p className="mt-2 break-all rounded-md bg-amber-50 px-3 py-2 text-amber-900">
            {t("tn.sendLink")} <span className="font-mono text-xs">{link}</span>
          </p>
        )}
      </div>
    </section>
  );
}

/** How the tournament treats somebody who leaves it (lib/tournament-rules.ts). */
function RulesFields({ rules, onChange, disabled = false }: { rules: CompetitionRules; onChange: (r: CompetitionRules) => void; disabled?: boolean }) {
  const t = useStaffT();
  const label = "flex flex-col text-xs font-medium text-slate-500";
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className={label}>
        {t("tn.rules.groupOnWithdrawal")}
        <select
          disabled={disabled}
          value={rules.groupResultsOnWithdrawal}
          onChange={(e) => onChange({ ...rules, groupResultsOnWithdrawal: e.target.value as "stand" | "void" })}
          className={input}
        >
          <option value="stand">{t("tn.rules.stand")}</option>
          <option value="void">{t("tn.rules.void")}</option>
        </select>
      </label>
      <label className={label}>
        {t("tn.rules.groupOnDq")}
        <select
          disabled={disabled}
          value={rules.groupResultsOnDisqualification}
          onChange={(e) => onChange({ ...rules, groupResultsOnDisqualification: e.target.value as "stand" | "void" })}
          className={input}
        >
          <option value="void">{t("tn.rules.void")}</option>
          <option value="stand">{t("tn.rules.stand")}</option>
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-xs text-slate-600">
        <input type="checkbox" disabled={disabled} checked={rules.refundBeforeDraw} onChange={(e) => onChange({ ...rules, refundBeforeDraw: e.target.checked })} />
        {t("tn.rules.refundBeforeDraw")}
      </label>
    </div>
  );
}

const rankLabel = (t: StaffT, key: RankKey): string =>
  ({
    points: t("tn.rank.points"),
    wins: t("tn.rank.wins"),
    set_diff: t("tn.rank.setDiff"),
    set_ratio: t("tn.rank.setRatio"),
    point_diff: t("tn.rank.pointDiff"),
    point_ratio: t("tn.rank.pointRatio"),
    points_for: t("tn.rank.pointsFor"),
    head_to_head: t("tn.rank.headToHead"),
  })[key];

/** How matches are scored and tables ranked, or how performances are measured (lib/tournament-rules.ts). */
function ScoringFields({ rules, onChange, disabled = false }: { rules: CompetitionRules; onChange: (r: CompetitionRules) => void; disabled?: boolean }) {
  const t = useStaffT();
  const label = "flex flex-col text-xs font-medium text-slate-500";
  const sc = rules.scoring;
  const set = (patch: Partial<CompetitionRules["scoring"]>) => onChange({ ...rules, scoring: { ...sc, ...patch } });
  if (rules.performance) {
    const p = rules.performance;
    const setP = (patch: Partial<NonNullable<CompetitionRules["performance"]>>) => onChange({ ...rules, performance: { ...p, ...patch } });
    if (p.counted) {
      // Counted performances (bouldering tops and zones, a height): what the round is ranked by, and how the final is made (lib/counted-performances.ts).
      const c = p.counted;
      const setC = (patch: Partial<typeof c>) => setP({ counted: { ...c, ...patch } });
      const presets: [string, string, typeof c.rankBy][] =
        c.kind === "height"
          ? [
              ["height", t("tn.cp.rank.height"), ["height", "attempts_height"]],
              ["heightOnly", t("tn.cp.rank.heightOnly"), ["height"]],
            ]
          : [
              ["full", t("tn.cp.rank.full"), ["tops", "zones", "attempts_top", "attempts_zone"]],
              ["simple", t("tn.cp.rank.simple"), ["tops", "zones"]],
            ];
      const preset = presets.find(([, , keys]) => keys.join() === c.rankBy.join())?.[0] ?? "custom";
      return (
        <div className="mt-2 flex flex-wrap items-end gap-3">
          {c.kind === "boulders" && (
            <label className={label}>
              {t("tn.cp.units")}
              <input disabled={disabled} type="number" min={1} max={40} value={c.units} onChange={(e) => setC({ units: Number(e.target.value) })} className={`w-20 ${input}`} />
            </label>
          )}
          <label className={label}>
            {t("tn.cp.rankBy")}
            <select disabled={disabled} value={preset} onChange={(e) => setC({ rankBy: presets.find(([key]) => key === e.target.value)?.[2] ?? c.rankBy })} className={input}>
              {presets.map(([key, text]) => (
                <option key={key} value={key}>
                  {text}
                </option>
              ))}
              {preset === "custom" && <option value="custom">{t("tn.cp.rank.custom")}</option>}
            </select>
          </label>
          <label className={label}>
            {t("tn.cp.groupSize")}
            <input disabled={disabled} type="number" min={2} max={40} value={p.heatSize} onChange={(e) => setP({ heatSize: Number(e.target.value) })} className={`w-20 ${input}`} />
          </label>
          <label className={label}>
            {t("tn.sc.finalSize")}
            <input disabled={disabled} type="number" min={0} max={40} value={p.finalSize} onChange={(e) => setP({ finalSize: Number(e.target.value) })} className={`w-20 ${input}`} />
          </label>
          <label className={label}>
            {t("tn.cp.finalStart")}
            <select disabled={disabled} value={c.finalStart} onChange={(e) => setC({ finalStart: e.target.value as typeof c.finalStart })} className={input}>
              <option value="reverse">{t("tn.cp.start.reverse")}</option>
              <option value="ranking">{t("tn.cp.start.ranking")}</option>
            </select>
          </label>
          <label className={label}>
            {t("tn.cp.cutTies")}
            <select disabled={disabled} value={c.cutTies} onChange={(e) => setC({ cutTies: e.target.value as typeof c.cutTies })} className={input}>
              <option value="choose">{t("tn.cp.ties.choose")}</option>
              <option value="all">{t("tn.cp.ties.all")}</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input type="checkbox" disabled={disabled} checked={c.countback} onChange={(e) => setC({ countback: e.target.checked })} />
            {t("tn.cp.countback")}
          </label>
        </div>
      );
    }
    return (
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className={label}>
          {t("tn.sc.measuredBy")}
          <select disabled={disabled} value={p.measure} onChange={(e) => setP({ measure: e.target.value as typeof p.measure, better: e.target.value === "time" ? "lower" : "higher" })} className={input}>
            <option value="time">{t("tn.sc.time")}</option>
            <option value="distance">{t("tn.sc.distance")}</option>
            <option value="score">{t("tn.sc.score")}</option>
          </select>
        </label>
        {p.measure === "score" && (
          <label className={label}>
            {t("tn.sc.better")}
            <select disabled={disabled} value={p.better} onChange={(e) => setP({ better: e.target.value as typeof p.better })} className={input}>
              <option value="higher">{t("tn.sc.higher")}</option>
              <option value="lower">{t("tn.sc.lower")}</option>
            </select>
          </label>
        )}
        <label className={label}>
          {t("tn.sc.attempts")}
          <input disabled={disabled} type="number" min={1} max={12} value={p.attempts} onChange={(e) => setP({ attempts: Number(e.target.value) })} className={`w-20 ${input}`} />
        </label>
        <label className={label}>
          {t("tn.sc.counts")}
          <select disabled={disabled} value={p.aggregate} onChange={(e) => setP({ aggregate: e.target.value as typeof p.aggregate })} className={input}>
            <option value="best">{t("tn.sc.best")}</option>
            <option value="total">{t("tn.sc.total")}</option>
          </select>
        </label>
        <label className={label}>
          {t("tn.sc.heatSize")}
          <input disabled={disabled} type="number" min={2} max={40} value={p.heatSize} onChange={(e) => setP({ heatSize: Number(e.target.value) })} className={`w-20 ${input}`} />
        </label>
        <label className={label}>
          {t("tn.sc.finalSize")}
          <input disabled={disabled} type="number" min={0} max={40} value={p.finalSize} onChange={(e) => setP({ finalSize: Number(e.target.value) })} className={`w-20 ${input}`} />
        </label>
      </div>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap items-end gap-3">
      <label className={label}>
        {t("tn.sc.scoresAre")}
        <select disabled={disabled} value={sc.kind} onChange={(e) => set({ kind: e.target.value as typeof sc.kind, draws: e.target.value === "tally" ? sc.draws : false })} className={input}>
          <option value="sets">{t("tn.sc.sets")}</option>
          <option value="tally">{t("tn.sc.tally")}</option>
        </select>
      </label>
      {sc.kind === "sets" ? (
        <label className={label}>
          {t("tn.sc.bestOf")}
          <select disabled={disabled} value={sc.bestOf} onChange={(e) => set({ bestOf: Number(e.target.value) })} className={input}>
            {[1, 3, 5, 7].map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" disabled={disabled} checked={sc.draws} onChange={(e) => set({ draws: e.target.checked })} />
          {t("tn.sc.draws")}
        </label>
      )}
      <label className={label}>
        {t("tn.sc.tablePoints")}
        <span className="flex gap-1">
          {(["win", "draw", "loss"] as const).map((k) => (
            <input
              key={k}
              disabled={disabled}
              type="number"
              min={0}
              max={10}
              value={sc.tablePoints[k]}
              onChange={(e) => set({ tablePoints: { ...sc.tablePoints, [k]: Number(e.target.value) } })}
              className={`w-14 ${input}`}
            />
          ))}
        </span>
      </label>
      {sc.kind === "sets" && (
        <label className={label}>
          <span className="flex items-center gap-1.5">
            <input
              type="checkbox"
              disabled={disabled}
              checked={sc.setPoints !== null}
              onChange={(e) => set({ setPoints: e.target.checked ? { winClear: 3, winDecider: 2, loseDecider: 1, loseClear: 0 } : null })}
            />
            {t("tn.sc.setPoints")}
          </span>
          {sc.setPoints && (
            <span className="flex gap-1">
              {(["winClear", "winDecider", "loseDecider", "loseClear"] as const).map((k) => (
                <input
                  key={k}
                  aria-label={t(`tn.sc.pt.${k}`)}
                  disabled={disabled}
                  type="number"
                  min={0}
                  max={10}
                  value={sc.setPoints![k]}
                  onChange={(e) => set({ setPoints: { ...sc.setPoints!, [k]: Number(e.target.value) } })}
                  className={`w-14 ${input}`}
                />
              ))}
            </span>
          )}
        </label>
      )}
      <label className={label}>
        {t("tn.sc.rankBy")}
        <span className="flex flex-wrap gap-1">
          {[0, 1, 2, 3].map((i) => (
            <select
              key={i}
              disabled={disabled}
              value={sc.rankBy[i] ?? ""}
              onChange={(e) => {
                const next = [...sc.rankBy];
                if (e.target.value) next[i] = e.target.value as RankKey;
                else next.splice(i);
                set({ rankBy: [...new Set(next.filter(Boolean))] });
              }}
              className={input}
            >
              <option value="">—</option>
              {RANK_KEYS.map((k) => (
                <option key={k} value={k}>
                  {rankLabel(t, k)}
                </option>
              ))}
            </select>
          ))}
        </span>
      </label>
      <label className={label}>
        {t("tn.sc.retired")}
        <select disabled={disabled} value={sc.retired} onChange={(e) => set({ retired: e.target.value as typeof sc.retired })} className={input}>
          <option value="win_only">{t("tn.sc.winOnly")}</option>
          <option value="as_played">{t("tn.sc.asPlayed")}</option>
        </select>
      </label>
      <label className={label}>
        {t("tn.sc.walkover")}
        <input
          disabled={disabled}
          defaultValue={sc.walkover ?? ""}
          placeholder={sc.kind === "tally" ? "3-0" : Array.from({ length: Math.ceil(sc.bestOf / 2) }, () => "21-0").join(", ")}
          onBlur={(e) => set({ walkover: e.target.value.trim() === "" ? null : e.target.value.trim() })}
          className={input}
        />
      </label>
    </div>
  );
}

function Manage({
  tn,
  venue,
  post,
  call,
  close,
  replace,
}: {
  tn: TournamentDetail;
  venue: ManagedVenue;
  post: (url: string, body: object) => Promise<boolean>;
  call: (url: string, body: object) => Promise<{ ok: boolean; data: Record<string, unknown> }>;
  close: () => void;
  /** The tournament as a change left it. */
  replace: (tn: TournamentDetail) => void;
}) {
  const t = useStaffT();
  const clock = useStaffClock();
  const may = useStaffMay();
  // Closing entries, the draw, its rules, saving it as a template and calling it off; changing its details.
  const runs = may("tournamentRun");
  const editsDetails = may("tournamentChange");
  const names = new Map(tn.entries.map((e) => [e.id, e.name]));
  const base = `/api/admin/tournaments/${tn.id}`;
  const [said, setSaid] = useState<Said[]>([]);
  const [editingDetails, setEditingDetails] = useState(false);
  const [fixing, setFixing] = useState<{ matchId: number; input: ResultInput; preview: CorrectionPreview } | null>(null);

  /** Out of the competition, after seeing what it changes. */
  async function takeOut(entryId: number, name: string, reason: OutReason) {
    const preview = await call(`${base}/entries/${entryId}`, { withdraw: true, reason, preview: true });
    if (!preview.ok) return;
    const changes = changesSaid(preview.data).map((c) => t.say(c.phrase, c.text));
    // A disqualification is kept with why; anything else may have a note.
    const note = window.prompt(reason === "disqualified" ? t("tn.out.whyDq", { name }) : t("tn.out.note", { name, reason: outLabel(t, reason) })) ?? null;
    if (note === null || (reason === "disqualified" && note.trim().length < 5)) return;
    if (!window.confirm(t("tn.out.confirm", { name, reason: outLabel(t, reason), changes: changes.join("\n") || t("tn.out.nothingElse") }))) return;
    const done = await call(`${base}/entries/${entryId}`, { withdraw: true, reason, note, token: preview.data.token });
    if (done.ok) setSaid(changesSaid(done.data));
  }

  /**
   * A result; one the knockout has moved past opens the correction review instead, for a manager (the matches
   * route refuses front desk a correction by what is asked; the desk is left with the refusal saying so).
   */
  async function result(matchId: number, input: ResultInput): Promise<boolean> {
    const done = await call(`${base}/matches/${matchId}`, input);
    if (done.ok || done.data.code !== "KNOCKOUT_STARTED" || !runs) return done.ok;
    const preview = await call(`${base}/matches/${matchId}`, { ...input, preview: true });
    if (preview.ok) setFixing({ matchId, input, preview: preview.data.preview as CorrectionPreview });
    return false;
  }
  const small = "rounded-md border border-slate-300 px-2 py-0.5 text-xs font-medium hover:border-teal-500";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <button onClick={close} className="text-sm text-teal-700 underline">
            {t("tn.back")}
          </button>
          <h2 className="mt-1 text-lg font-bold">
            {tn.name} <span className="text-sm font-normal text-slate-500">· {statusLabel(t, tn.status)}</span>
          </h2>
          <p className="text-sm text-slate-500">
            {dates(t, tn.startsOn, tn.endsOn)}, {formatMinute(tn.startMin, t.locale)}–{formatMinute(tn.endMin, t.locale)} ·{" "}
            {formatLabel(t, tn.format).toLowerCase()} · {tn.entryKind === "team" ? t("tn.kind.teams") : tn.teamSize === 2 ? t("tn.kind.doubles") : t("tn.kind.singles")} ·{" "}
            {money(tn.entryFee)} ·{" "}
            <a href={`/tournaments/${tn.id}`} target="_blank" rel="noopener" className="underline">
              {t("tn.publicPage")}
            </a>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {editsDetails && (tn.status === "open" || tn.status === "closed") && (
            <button onClick={() => setEditingDetails(!editingDetails)} className={small}>
              {t("p8c.tn.edit")}
            </button>
          )}
          {runs && tn.status === "open" && (
            <button onClick={() => void post(base, { action: "close" })} className={small}>
              {t("tn.closeEntries")}
            </button>
          )}
          {runs && (tn.status === "open" || tn.status === "closed") && (
            <button
              onClick={() => window.confirm(t("tn.drawConfirm")) && void post(base, { action: "draw" })}
              className="rounded-md bg-teal-600 px-3 py-1 text-sm font-semibold text-white hover:bg-teal-700"
            >
              {t("tn.makeDraw")}
            </button>
          )}
          {runs && (
            <button
              onClick={() => {
                const name = window.prompt(t("tn.saveTemplatePrompt"), tn.name);
                if (name) void call(base, { action: "save_template", name }).then((r) => r.ok && setSaid([{ text: t("tn.savedTemplate", { name }) }]));
              }}
              className={small}
            >
              {t("tn.saveTemplate")}
            </button>
          )}
          {runs && tn.status !== "finished" && tn.status !== "cancelled" && (
            <button
              onClick={() => window.confirm(t("tn.callOffConfirm", { name: tn.name })) && void post(base, { action: "cancel" })}
              className="rounded-md border border-red-300 px-3 py-1 text-sm font-medium text-red-700"
            >
              {t("tn.callItOff")}
            </button>
          )}
        </div>
      </div>

      {editingDetails && editsDetails && (tn.status === "open" || tn.status === "closed") && (
        <TournamentDetailsEditor
          key={tn.id}
          tn={tn}
          onClose={() => setEditingDetails(false)}
          onSaved={(now, notice) => {
            setEditingDetails(false);
            setSaid([{ text: notice }]);
            replace(now);
          }}
        />
      )}

      {tn.format !== "performance" && tn.status !== "cancelled" && tn.status !== "finished" && <ResultsByPeople tn={tn} />}

      <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
        <h3 className="font-semibold">{t("tn.leaveRules")}</h3>
        <p className="mt-1 text-xs text-slate-500">
          {t("tn.leaveRulesNote")}{" "}
          {tn.status === "open" || tn.status === "closed" ? t("tn.changeableUntilDraw") : t("tn.fixedSinceDraw")}
        </p>
        <ManagerOnly may="tournamentRun">
          <div className="mt-2">
            <RulesFields
              rules={tn.rules}
              disabled={tn.status !== "open" && tn.status !== "closed"}
              onChange={(rules) => void post(base, { action: "rules", rules })}
            />
          </div>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs font-medium text-slate-600">{tn.template ? t("tn.scoringFromTemplate", { template: tn.template }) : t("tn.scoring")}</summary>
            <ScoringFields rules={tn.rules} disabled={tn.status !== "open" && tn.status !== "closed"} onChange={(rules) => void post(base, { action: "rules", rules })} />
          </details>
        </ManagerOnly>
      </section>

      {tn.issues.filter((i) => i.status === "open").map((i) => (
        <IssuePanel key={i.id} tn={tn} issueId={i.id} names={names} venue={venue} call={call} onDone={(changes) => setSaid(changes)} />
      ))}

      {tn.performance && <PerformancePanel tn={tn} names={names} call={call} />}

      {said.length > 0 && (
        <section className="rounded-xl border border-teal-200 bg-teal-50 p-3 text-sm">
          <h3 className="font-semibold">{t("tn.whatChanged")}</h3>
          <ul className="mt-1 list-disc pl-5">
            {said.map((c, i) => (
              <li key={i}>{t.say(c.phrase, c.text)}</li>
            ))}
          </ul>
        </section>
      )}

      {fixing && (
        <CorrectionPanel
          fixing={fixing}
          names={names}
          knockout={tn.matches.find((m) => m.id === fixing.matchId)?.stage === "knockout"}
          swiss={tn.format === "swiss"}
          onCancel={() => setFixing(null)}
          onApply={async (mode, reason) => {
            const done = await call(`${base}/matches/${fixing.matchId}`, { ...fixing.input, correction: { mode, reason, token: fixing.preview.token } });
            if (done.ok) {
              setSaid(changesSaid(done.data));
              setFixing(null);
            }
          }}
        />
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="font-semibold">{t("tn.entriesCount", { n: tn.entries.filter((e) => e.status === "entered").length, max: tn.maxEntries })}</h3>
        <table className="mt-2 w-full text-sm">
          <tbody>
            {tn.entries.filter((e) => e.status !== "withdrawn").map((e) => (
              <tr key={e.id} className="border-t border-slate-100">
                <td className="py-1.5">
                  {e.name}
                  {e.guardian && (
                    <div className="text-xs text-slate-500">
                      {t("tn.guardian", { name: e.guardian.name })}
                    </div>
                  )}
                  {e.eligibilityChecked && <div className="text-xs text-emerald-700">{t("tn.eligibilityChecked", { by: e.eligibilityChecked.by })}</div>}
                  {e.atCounter && <div className="text-xs text-slate-500">{t("lg5.atCounter", { by: e.atCounter.by })}</div>}
                  {!e.atCounter && e.participantId && <div className="text-xs text-slate-500">{t("lg5.forParticipant")}</div>}
                </td>
                <td className="text-slate-500">{e.status === "waitlisted" ? t("tn.entryWaiting") : ""}</td>
                <td className="space-x-1 whitespace-nowrap">
                  {e.status === "entered" && tn.status !== "cancelled" && (
                    <>
                      <button onClick={() => void post(`${base}/entries/${e.id}`, { checkedIn: !e.checkedIn })} className={`${small} ${e.checkedIn ? "bg-emerald-50 text-emerald-700" : ""}`}>
                        {e.checkedIn ? t("tn.here") : t("tn.checkIn")}
                      </button>
                      {tn.ageRange && (
                        <button
                          onClick={() => void post(`${base}/entries/${e.id}`, { eligibilityChecked: !e.eligibilityChecked })}
                          title={t("tn.ageProofTitle")}
                          className={small}
                        >
                          {e.eligibilityChecked ? t("tn.undoCheck") : t("tn.ageChecked")}
                        </button>
                      )}
                    </>
                  )}
                </td>
                <td>
                  {(e.fee ?? tn.entryFee) > 0 && (
                    // Marked paid at the counter says how (X1-2).
                    <PayMark
                      paid={e.paid}
                      paidLabel={t("tn.paidMark")}
                      unpaidLabel={t("tn.unpaidMark")}
                      onPaid={(via) => void post(`${base}/entries/${e.id}`, { paid: true, via })}
                      onUnpaid={() => void post(`${base}/entries/${e.id}`, { paid: false })}
                      className={small}
                    />
                  )}
                </td>
                <td>
                  {(tn.status === "open" || tn.status === "closed") && e.status === "entered" && (
                    <label className="text-xs text-slate-500">
                      {t("tn.seed")}{" "}
                      <input
                        type="number"
                        min={1}
                        defaultValue={e.seed ?? ""}
                        onBlur={(ev) => void post(`${base}/entries/${e.id}`, { seed: ev.target.value ? Number(ev.target.value) : null })}
                        className="w-14 rounded border border-slate-300 px-1"
                      />
                    </label>
                  )}
                </td>
                <td className="text-right">
                  {tn.status !== "finished" && tn.status !== "cancelled" && (
                    <select
                      aria-label={t("tn.takeOut", { name: e.name })}
                      value=""
                      onChange={(ev) => ev.target.value && void takeOut(e.id, e.name, ev.target.value as OutReason)}
                      className="rounded border border-red-200 px-1 text-xs text-red-700"
                    >
                      <option value="">{t("tn.outMenu")}</option>
                      <option value="withdrawn">{t("tn.out.withdrawn")}</option>
                      {tn.status === "drawn" && <option value="retired">{t("tn.out.retired")}</option>}
                      {/* Disqualifying is the organiser's: the entries route refuses front desk it by what is asked. */}
                      {runs && <option value="disqualified">{t("tn.out.disqualified")}</option>}
                    </select>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {tn.entries.some((e) => e.out) && (
          <p className="mt-2 text-xs text-slate-500">
            {t("tn.outList", {
              list: tn.entries
                .filter((e) => e.out)
                .map((e) => t(e.out!.stage === "before_draw" ? "tn.outEntryBeforeDraw" : "tn.outEntry", { name: e.name, reason: outLabel(t, e.out!.reason) }))
                .join(", "),
            })}
          </p>
        )}
        {tn.status === "open" && (
          <CounterEntry
            venueId={tn.venueId}
            kind="tournament"
            teamSize={tn.teamSize}
            category={tn.category}
            ageRange={tn.ageRange}
            startsOn={tn.startsOn}
            team={tn.entryKind === "team"}
            mark={tn.format === "performance" && !tn.rules.performance?.counted}
            submit={(body) => post(`${base}/entries`, body)}
          />
        )}
      </section>

      {tn.groups.length > 0 && (
        <section className="grid gap-3 sm:grid-cols-2">
          {tn.groups.map((g) => (
            <div key={g.groupNo} className="rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-sm">
              <h3 className="font-semibold">{t("tn.group", { n: g.groupNo })}</h3>
              <table className="mt-1 w-full">
                <tbody>
                  {g.table.map((s) => (
                    <tr key={s.entryId} className={s.out ? "text-slate-400" : ""}>
                      <td>
                        {names.get(s.entryId)}
                        {s.out && <span className="ml-1 text-xs">{t(s.resultsVoid ? "tn.notThroughVoid" : "tn.notThrough", { reason: outLabel(t, s.out) })}</span>}
                      </td>
                      <td className="text-right text-slate-500">
                        {tn.rules.scoring.kind === "tally" ? (
                          <>
                            {s.won}–{s.drawn}–{s.lost} · {s.pointDiff >= 0 ? "+" : ""}
                            {s.pointDiff}
                            {tn.rules.scoring.rankBy.includes("points") && ` · ${t("tn.pts", { n: s.points })}`}
                          </>
                        ) : (
                          <>
                            {s.won}–{s.lost} · {t("tn.sets", { diff: `${s.setDiff >= 0 ? "+" : ""}${s.setDiff}` })}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      )}

      {tn.swiss && <SwissPanel tn={tn} names={names} base={base} call={call} />}

      {tn.status === "drawn" && tn.format !== "performance" && <TournamentDay tn={tn} />}

      {tn.matches.some((m) => m.stage === "group" || m.stage === "knockout") && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="font-semibold">{t("tn.matches")}</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {tn.matches
              .filter((m) => m.status !== "bye" && (m.stage === "group" || m.stage === "knockout"))
              .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || (a.minute ?? 0) - (b.minute ?? 0) || (a.courtId ?? 0) - (b.courtId ?? 0))
              .map((m) => (
                <MatchRow key={m.id} m={m} names={names} venue={venue} rules={tn.rules} swiss={tn.format === "swiss"} save={(body) => result(m.id, body as ResultInput)} />
              ))}
          </ul>
        </section>
      )}

      {tn.corrections.length > 0 && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
          <h3 className="font-semibold">{t("tn.corrections")}</h3>
          <ul className="mt-1 space-y-1">
            {tn.corrections.map((c, i) => (
              <li key={i}>
                {clock.time(c.createdAt, tn.venueId)} ·{" "}
                {c.kind === "replace"
                  ? t("tn.corr.replace")
                  : c.kind === "stand"
                    ? t("tn.corr.stand")
                    : c.kind === "replay"
                      ? t("tn.corr.replay")
                      : c.knockout
                        ? t("tn.corr.recordOnly")
                        : t("tn.corr.groupOnly")}
                : {c.reason}
                {c.changes && c.changes.length > 0 && (
                  <span className="text-slate-600"> — {c.changes.map((x, j) => t.say(c.changePhrases?.[j], x)).join(" ")}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * Reviewing a correction the knockout has moved past — a group result, or a
 * knockout result whose next match is played: what each way changes, a
 * reason, then confirm.
 */
function CorrectionPanel({
  fixing,
  names,
  knockout,
  swiss = false,
  onCancel,
  onApply,
}: {
  fixing: { matchId: number; input: ResultInput; preview: CorrectionPreview };
  names: Map<number, string>;
  knockout: boolean;
  /** A Swiss result put right after a later round was paired: keep the pairings, or pair the next round again. */
  swiss?: boolean;
  onCancel: () => void;
  onApply: (mode: "replace" | "standings_only", reason: string) => Promise<void>;
}) {
  const t = useStaffT();
  const [reason, setReason] = useState("");
  const { preview } = fixing;
  const list = (items: string[], phrases?: StaffText[]) => (
    <ul className="mt-1 list-disc pl-5">
      {items.map((c, i) => (
        <li key={i}>{t.say(phrases?.[i], c)}</li>
      ))}
    </ul>
  );
  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm" aria-label={t("tn.correction")}>
      <h3 className="font-semibold">{t("tn.reviewCorrection", { what: fixing.input.winner === null ? t("tn.aDraw") : t("tn.nameWon", { name: names.get(fixing.input.winner) ?? "" }) })}</h3>
      <p className="mt-1 text-xs text-slate-600">
        {t("tn.correctionNote")}
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <h4 className="font-semibold">{swiss ? t("sw.corr.pairAgain") : t("tn.putIntoKnockout")}</h4>
          {swiss && <p className="mt-1 text-xs text-slate-600">{t("sw.corr.pairAgainNote")}</p>}
          {preview.replace.possible ? (
            list(preview.replace.changes, preview.replace.changePhrases)
          ) : (
            <>
              <p className="mt-1 text-xs text-red-700">{t("tn.notSafely")}</p>
              {list(preview.replace.blockers, preview.replace.blockerPhrases)}
            </>
          )}
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <h4 className="font-semibold">{swiss ? t("sw.corr.stand") : knockout ? t("tn.recordOnlyTitle") : t("tn.groupTableOnly")}</h4>
          <p className="mt-1 text-xs text-slate-600">
            {swiss ? t("sw.corr.standNote") : knockout ? t("tn.recordOnlyNote") : t("tn.groupOnlyNote")}
          </p>
          {list(preview.standingsOnly.changes, preview.standingsOnly.changePhrases)}
        </div>
      </div>
      <label className="mt-3 block text-xs font-medium text-slate-600">
        {t("tn.whyCorrection")}
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("tn.whyCorrectionPlaceholder")} className={`mt-1 w-full ${input}`} />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          disabled={!preview.replace.possible || reason.trim().length < 5}
          onClick={() => window.confirm(swiss ? t("sw.corr.pairAgainConfirm") : t("tn.putConfirm")) && void onApply("replace", reason)}
          className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
        >
          {swiss ? t("sw.corr.pairAgain") : t("tn.putIntoKnockout")}
        </button>
        <button
          disabled={reason.trim().length < 5}
          onClick={() =>
            window.confirm(swiss ? t("sw.corr.standConfirm") : knockout ? t("tn.recordOnlyConfirm") : t("tn.groupOnlyConfirm")) &&
            void onApply("standings_only", reason)
          }
          className="rounded-md border border-amber-400 px-3 py-1.5 text-xs font-semibold text-amber-800 disabled:opacity-40"
        >
          {swiss ? t("sw.corr.stand") : knockout ? t("tn.recordOnly") : t("tn.groupTableOnly")}
        </button>
        <button onClick={onCancel} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs">
          {t("tn.leaveIt")}
        </button>
      </div>
    </section>
  );
}

/** Move a fixture still to play, or give it longer: to a court and time held for it or free to hold (managers). */
function MoveFixture({ m, venue, save }: { m: Match; venue: ManagedVenue; save: (body: object) => Promise<boolean> }) {
  const t = useStaffT();
  const [to, setTo] = useState({ date: m.date ?? "", startMin: m.minute ?? 540, courtId: m.courtId ?? 0, minutes: String(m.minutes) });
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-teal-700">{t("tn.move")}</summary>
      <div className="mt-1 flex flex-col gap-1">
        <input type="date" aria-label={t("c.date")} value={to.date} onChange={(e) => setTo({ ...to, date: e.target.value })} className={input} />
        <ClockField label={t("tn.start")} value={to.startMin} onChange={(v) => setTo({ ...to, startMin: v })} className={input} />
        <select aria-label={t("tn.court")} value={to.courtId} onChange={(e) => setTo({ ...to, courtId: Number(e.target.value) })} className={input}>
          {venue.courts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <label>
          {t("tn.minutes")}{" "}
          <input type="number" min={5} max={600} value={to.minutes} onChange={(e) => setTo({ ...to, minutes: e.target.value })} className={`w-16 ${input}`} />
        </label>
        <button onClick={() => void save({ move: { ...to, minutes: Number(to.minutes) } })} className="rounded-md border border-slate-300 px-2 py-1 text-xs">
          {t("tn.moveTell")}
        </button>
      </div>
    </details>
  );
}

function MatchRow({
  m,
  names,
  venue,
  rules,
  swiss = false,
  save,
}: {
  m: Match;
  names: Map<number, string>;
  venue: ManagedVenue;
  rules: CompetitionRules;
  swiss?: boolean;
  save: (body: object) => Promise<boolean>;
}) {
  const t = useStaffT();
  // Moving a fixture is the organiser's, as the draw is: the matches route refuses front desk it by what is asked.
  const organises = useStaffMay()("tournamentRun");
  const tally = rules.scoring.kind === "tally";
  const [score, setScore] = useState(m.score ?? "");
  const known = m.a !== null && m.b !== null;
  const side = (id: number | null) => (id === null ? t("tn.tbd") : names.get(id) ?? "?");
  const label = m.stage === "group" && swiss ? t("sw.round", { n: m.round }) : m.stage === "group" ? t("tn.group", { n: m.groupNo ?? "" }) : m.placement === 3 ? t("tn.thirdPlaceMatch") : t("tn.knockoutRound", { n: m.round });
  return (
    <li className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
      <span className="w-40 shrink-0 text-xs text-slate-500">
        {m.date} {m.minute !== null && `${formatMinute(m.minute, t.locale)}–${formatMinute(m.minute + m.minutes, t.locale)}`} · {m.courtName ?? "—"}
        <br />
        {label}
        {organises && m.status === "scheduled" && m.date !== null && <MoveFixture m={m} venue={venue} save={save} />}
      </span>
      <span className={`min-w-[10rem] flex-1 ${m.winner === m.a && m.a !== null ? "font-semibold" : ""}`}>{side(m.a)}</span>
      <span className="text-slate-400">{t("tn.versus")}</span>
      <span className={`min-w-[10rem] flex-1 ${m.winner === m.b && m.b !== null ? "font-semibold" : ""}`}>{side(m.b)}</span>
      {known && (
        <>
          <input aria-label={t("q8b.l.score")}
            value={score}
            onChange={(e) => setScore(e.target.value)}
            placeholder={tally ? (m.stage === "knockout" ? t("tn.penaltiesPlaceholder") : "3-2") : "21-15, 18-21, 21-10"}
            className={`w-40 ${input}`}
          />
          {tally && rules.scoring.draws && m.stage === "group" && (
            <button onClick={() => void save({ winner: null, score })} className="rounded-md border border-slate-300 px-2 py-1 text-xs">
              {t("tn.drawn")}
            </button>
          )}
          <button onClick={() => void save({ winner: m.a, score })} className="rounded-md border border-slate-300 px-2 py-1 text-xs">
            {t("tn.nameWon", { name: names.get(m.a!)?.split(" ")[0] ?? "" })}
          </button>
          <button onClick={() => void save({ winner: m.b, score })} className="rounded-md border border-slate-300 px-2 py-1 text-xs">
            {t("tn.nameWon", { name: names.get(m.b!)?.split(" ")[0] ?? "" })}
          </button>
          {m.status !== "done" && (
            <select aria-label={t("tn.walkoverTo")}
              value=""
              onChange={(e) => e.target.value && void save({ winner: Number(e.target.value), walkover: true })}
              className="rounded-md border border-slate-300 px-1 py-1 text-xs"
            >
              <option value="">{t("tn.walkoverTo")}</option>
              <option value={m.a!}>{names.get(m.a!)}</option>
              <option value={m.b!}>{names.get(m.b!)}</option>
            </select>
          )}
          <select
            aria-label={t("tn.retiredLabel")}
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              const [winner, out] = e.target.value.split(":");
              void save({ winner: Number(winner), score, retired: true, outOfEvent: out === "out" });
            }}
            className="rounded-md border border-slate-300 px-1 py-1 text-xs"
          >
            <option value="">{t("tn.retiredMenu")}</option>
            {[m.a!, m.b!].map((w) => {
              const quit = names.get(w === m.a ? m.b! : m.a!);
              return [
                <option key={`${w}:in`} value={`${w}:in`}>
                  {t("tn.stoppedIn", { name: quit ?? "" })}
                </option>,
                <option key={`${w}:out`} value={`${w}:out`}>
                  {t("tn.stoppedOut", { name: quit ?? "" })}
                </option>,
              ];
            })}
          </select>
          {m.status !== "scheduled" && (
            <span className="text-xs text-emerald-700">
              ✓{" "}
              {m.status === "walkover"
                ? t("tn.st.walkover")
                : m.status === "retired"
                  ? t("tn.st.retired", { score: m.score ?? "" })
                  : m.winner === null
                    ? t("tn.st.drawn", { score: m.score ?? "" })
                    : m.score}
            </span>
          )}
        </>
      )}
    </li>
  );
}

/**
 * A correction left the wrong competitor in matches already played: what it
 * affects, and the organiser's choice — let the results stand, or replay at
 * a court and time held for the tournament — with a reason, confirmed
 * against what was reviewed.
 */
function IssuePanel({
  tn,
  issueId,
  names,
  venue,
  call,
  onDone,
}: {
  tn: TournamentDetail;
  issueId: number;
  names: Map<number, string>;
  venue: ManagedVenue;
  call: (url: string, body: object) => Promise<{ ok: boolean; data: Record<string, unknown> }>;
  onDone: (changes: Said[]) => void;
}) {
  const t = useStaffT();
  const [review, setReview] = useState<IssueReview | null>(null);
  const [reason, setReason] = useState("");
  const [slots, setSlots] = useState<Record<number, { courtId: number; date: string; startMin: number }>>({});
  const url = `/api/admin/tournaments/${tn.id}/issues/${issueId}`;
  const issue = tn.issues.find((i) => i.id === issueId)!;
  useEffect(() => {
    void fetch(url, { cache: "no-store" }).then(async (r) => r.ok && setReview(await readJson(r)));
  }, [url, tn]);
  const courts = venue.courts.filter((c) => courtOffers(c, tn.sport));
  async function resolve(action: "stand" | "replay") {
    if (!review) return;
    if (!window.confirm(action === "stand" ? t("tn.issue.standConfirm") : t("tn.issue.replayConfirm"))) return;
    const done = await call(url, { action, reason, token: review.token, slots: action === "replay" ? slots : undefined });
    if (done.ok) onDone(changesSaid(done.data));
  }
  return (
    <section className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm" aria-label={t("tn.issue.label")}>
      <h3 className="font-semibold text-red-900">
        {t("tn.issue.title", {
          wrong: names.get(issue.wrongEntry) ?? "",
          right: issue.rightEntry === null ? t("tn.issue.nobody") : (names.get(issue.rightEntry) ?? ""),
        })}
      </h3>
      <p className="mt-1 text-xs text-slate-600">{t("tn.issue.note")}</p>
      <ul className="mt-2 list-disc pl-5">
        {issue.affected.map((a) => (
          <li key={a.matchId}>{t.say(a.phrase, a.text)}</li>
        ))}
      </ul>
      {/* Letting it stand or replaying is the organiser's: a manager's (lib/roles.ts). */}
      {review && (
        <ManagerOnly may="tournamentIssues">
        <div className="mt-3 space-y-2">
          {review.replay.possible ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-slate-700">{t("tn.issue.giveSlots")}</p>
              {review.replay.matches.map(({ namePhrase, ...m }) => ({ ...m, name: t.say(namePhrase, m.name) })).map((m) => (
                <div key={m.matchId} className="flex flex-wrap items-center gap-2">
                  <span className="w-40 text-xs">{m.needsSlot ? m.name : t("tn.issue.keepsTime", { name: m.name })}</span>
                  {m.needsSlot && (
                    <>
                      <select
                        aria-label={t("tn.issue.courtFor", { name: m.name })}
                        value={slots[m.matchId]?.courtId ?? ""}
                        onChange={(e) => setSlots({ ...slots, [m.matchId]: { ...(slots[m.matchId] ?? { date: tn.endsOn, startMin: tn.startMin }), courtId: Number(e.target.value) } })}
                        className={input}
                      >
                        <option value="">{t("tn.issue.courtMenu")}</option>
                        {courts.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <input
                        type="date"
                        aria-label={t("tn.issue.dateFor", { name: m.name })}
                        value={slots[m.matchId]?.date ?? ""}
                        onChange={(e) => setSlots({ ...slots, [m.matchId]: { ...(slots[m.matchId] ?? { courtId: courts[0]?.id ?? 0, startMin: tn.startMin }), date: e.target.value } })}
                        className={input}
                      />
                      <ClockField
                        label={t("tn.issue.timeFor", { name: m.name })}
                        value={slots[m.matchId]?.startMin ?? tn.startMin}
                        onChange={(min) => setSlots({ ...slots, [m.matchId]: { ...(slots[m.matchId] ?? { courtId: courts[0]?.id ?? 0, date: tn.endsOn }), startMin: min } })}
                        className={input}
                      />
                    </>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-red-800">{t("tn.issue.cannotReplay", { blockers: review.replay.blockers.map((b, i) => t.say("blockerPhrases" in review.replay ? review.replay.blockerPhrases[i] : null, b)).join(" ") })}</p>
          )}
          <label className="block text-xs font-medium text-slate-600">
            {t("tn.issue.why")}
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("tn.issue.whyPlaceholder")} className={`mt-1 w-full ${input}`} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button disabled={reason.trim().length < 5} onClick={() => void resolve("stand")} className="rounded-md border border-slate-400 px-3 py-1.5 text-xs font-semibold disabled:opacity-40">
              {t("tn.issue.stand")}
            </button>
            <button
              disabled={!review.replay.possible || reason.trim().length < 5}
              onClick={() => void resolve("replay")}
              className="rounded-md bg-red-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
            >
              {t("tn.issue.replay")}
            </button>
          </div>
        </div>
        </ManagerOnly>
      )}
    </section>
  );
}

/** A performance event's heats and final: each competitor's marks, lane by lane, and choosing a final's last places when level. */
function PerformancePanel({
  tn,
  names,
  call,
}: {
  tn: TournamentDetail;
  names: Map<number, string>;
  call: (url: string, body: object) => Promise<{ ok: boolean; data: Record<string, unknown> }>;
}) {
  const t = useStaffT();
  const p = tn.performance!;
  const rules = tn.rules.performance!;
  const units = tn.matches.filter((m) => m.stage === "heat" || m.stage === "final").sort((a, b) => (a.stage === "final" ? 1 : 0) - (b.stage === "final" ? 1 : 0) || a.position - b.position);
  const [chosen, setChosen] = useState<number[]>([]);
  return (
    <section className="space-y-3">
      {p.tieForFinal && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm">
          <h3 className="font-semibold">{t("tn.perf.tie")}</h3>
          <p className="mt-1 text-xs text-slate-600">{t("tn.perf.tieNote")}</p>
          {/* Who takes the last places is the organiser's: a manager's (lib/roles.ts). */}
          <ManagerOnly may="tournamentRun">
            <div className="mt-2 flex flex-wrap gap-3">
              {p.tieForFinal.map((id) => (
                <label key={id} className="inline-flex items-center gap-1">
                  <input type="checkbox" checked={chosen.includes(id)} onChange={() => setChosen(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id])} />
                  {names.get(id)}
                </label>
              ))}
            </div>
            <button onClick={() => void call(`/api/admin/tournaments/${tn.id}`, { action: "final", chosen })} className="mt-2 rounded-md bg-teal-600 px-3 py-1 text-xs font-semibold text-white">
              {t("tn.perf.putInFinal")}
            </button>
          </ManagerOnly>
        </div>
      )}
      {units.map((m) =>
        rules.counted ? (
          // Keyed by who is in it too: a final is filled once the groups are in, after this has first shown.
          <CountedHeat key={`${m.id}:${(p.lines[m.id] ?? []).map((l) => l.entryId).join(",")}`} tn={tn} m={m} lines={p.lines[m.id] ?? []} names={names} call={call} />
        ) : (
          <HeatEntry key={m.id} tn={tn} m={m} lines={p.lines[m.id] ?? []} names={names} attempts={rules.attempts} placeholder={rules.measure === "time" ? "1:02.35" : "7.42"} call={call} />
        )
      )}
      {rules.counted && p.field && (
        <>
          <FieldCounts stats={p.field.heat} />
          <FieldCounts stats={p.field.final} suffix={t("tn.perf.final")} />
        </>
      )}
    </section>
  );
}

function HeatEntry({
  tn,
  m,
  lines,
  names,
  attempts,
  placeholder,
  call,
}: {
  tn: TournamentDetail;
  m: Match;
  lines: NonNullable<TournamentDetail["performance"]>["lines"][number];
  names: Map<number, string>;
  attempts: number;
  placeholder: string;
  call: (url: string, body: object) => Promise<{ ok: boolean; data: Record<string, unknown> }>;
}) {
  const t = useStaffT();
  const unit = m.stage === "final" ? t("tn.perf.final") : t("tn.perf.heat", { n: m.position });
  const [rows, setRows] = useState(() =>
    Object.fromEntries(lines.map((l) => [l.entryId, { attempts: Array.from({ length: attempts }, (_, i) => (l.attempts[i] === undefined ? "" : l.attempts[i] === null ? "X" : String(l.attempts[i]))), status: l.status === "pending" ? "ok" : l.status }]))
  );
  if (lines.length === 0)
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-500">
        {t("tn.perf.filledLater", { unit })}
      </div>
    );
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-sm">
      <h3 className="font-semibold">
        {unit}{" "}
        <span className="text-xs font-normal text-slate-500">
          {m.date} {m.minute !== null && formatMinute(m.minute, t.locale)} · {m.courtName} · {m.status === "done" ? t("tn.perf.resultsIn") : t("tn.perf.toCome")}
        </span>
      </h3>
      <table className="mt-1 w-full">
        <tbody>
          {lines
            .slice()
            .sort((a, b) => a.lane - b.lane)
            .map((l) => (
              <tr key={l.entryId} className="border-t border-slate-100">
                <td className="w-10 text-xs text-slate-500">{l.lane}</td>
                <td>{names.get(l.entryId)}</td>
                <td className="whitespace-nowrap">
                  {rows[l.entryId]?.attempts.map((a, i) => (
                    <input
                      key={i}
                      aria-label={t("tn.perf.attempt", { name: names.get(l.entryId) ?? "", n: i + 1 })}
                      value={a}
                      disabled={rows[l.entryId].status !== "ok"}
                      onChange={(e) => {
                        const next = [...rows[l.entryId].attempts];
                        next[i] = e.target.value;
                        setRows({ ...rows, [l.entryId]: { ...rows[l.entryId], attempts: next } });
                      }}
                      placeholder={placeholder}
                      className="mr-1 w-20 rounded border border-slate-300 px-1 py-0.5 text-xs"
                    />
                  ))}
                </td>
                <td>
                  <select
                    aria-label={t("tn.perf.status", { name: names.get(l.entryId) ?? "" })}
                    value={rows[l.entryId]?.status}
                    onChange={(e) => setRows({ ...rows, [l.entryId]: { ...rows[l.entryId], status: e.target.value as typeof l.status } })}
                    className="rounded border border-slate-300 px-1 py-0.5 text-xs"
                  >
                    <option value="ok">{t("tn.perf.ok")}</option>
                    <option value="dns">{t("tn.perf.dns")}</option>
                    <option value="dnf">{t("tn.perf.dnf")}</option>
                    <option value="dq">{t("tn.out.disqualified")}</option>
                  </select>
                </td>
                <td className="text-right text-xs text-slate-600">
                  {l.shown ?? ""} {l.rank !== null && `(${l.rank})`}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      <button
        onClick={() =>
          void call(`/api/admin/tournaments/${tn.id}/matches/${m.id}`, {
            performances: Object.entries(rows)
              .filter(([, r]) => r.status !== "ok" || r.attempts.some((a) => a.trim()))
              .map(([entryId, r]) => ({ entryId: Number(entryId), status: r.status, attempts: r.status === "ok" ? r.attempts.filter((a) => a.trim()) : undefined })),
          })
        }
        className="mt-2 rounded-md bg-teal-600 px-3 py-1 text-xs font-semibold text-white"
      >
        {t("tn.perf.save")}
      </button>
    </div>
  );
}
