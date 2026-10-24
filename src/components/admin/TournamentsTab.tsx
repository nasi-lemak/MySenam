"use client";

import { courtOffers } from "@/lib/court-activities";
import { activityKeys } from "@/lib/activity-registry";
import { useCallback, useEffect, useState } from "react";
import { localTime, todayLocal } from "./shared";
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

const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
const LEVELS = ["", "beginner", "intermediate", "advanced", "competitive"];

/**
 * A venue's tournaments: set one up, holding its courts; take entries; seed
 * and make the draw; and enter results as they come in.
 */
export function TournamentsTab({ venues }: { venues: ManagedVenue[] }) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [list, setList] = useState<Tournament[]>([]);
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [catalog, setCatalog] = useState<{ templates: CompetitionTemplate[]; venueTemplates: VenueTemplate[] }>({ templates: [], venueTemplates: [] });
  const [open, setOpen] = useState<TournamentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const venue = venues.find((v) => v.id === venueId);

  const load = useCallback(async () => {
    if (!venueId) return;
    const res = await fetch(`/api/admin/tournaments?venueId=${venueId}`, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      setList(data.tournaments);
      setCompetitions(data.competitions ?? []);
      setCatalog({ templates: data.templates ?? [], venueTemplates: data.venueTemplates ?? [] });
    }
  }, [venueId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function show(id: number) {
    const res = await fetch(`/api/admin/tournaments/${id}`, { cache: "no-store" });
    if (res.ok) setOpen((await res.json()).tournament);
  }

  /** A request whose answer the caller reads (previews, corrections); errors shown as for `post`. */
  async function call(url: string, body: object): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    setError(null);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) setError(typeof data.error === "string" ? data.error : "That did not work.");
    else {
      if (data.tournament && typeof data.tournament === "object" && "entries" in data.tournament) setOpen(data.tournament as TournamentDetail);
      await load();
    }
    return { ok: res.ok, data };
  }

  async function post(url: string, body: object): Promise<boolean> {
    setError(null);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "That did not work.");
      return false;
    }
    if (data.tournament && "entries" in data.tournament) setOpen(data.tournament);
    await load();
    return true;
  }

  async function callOff(c: Competition) {
    if (!confirm(`Call off ${c.name} and every division in it? Entrants are told, fees paid online are owed back, and the courts go back on sale.`)) return;
    setError(null);
    const res = await fetch(`/api/admin/competitions/${c.id}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) setError(data.error ?? "That did not work.");
    await load();
  }

  if (!venue) return <p className="text-sm text-slate-500">No venue.</p>;
  return (
    <div className="space-y-4">
      {venues.length > 1 && (
        <select value={venueId} onChange={(e) => { setVenueId(Number(e.target.value)); setOpen(null); }} className={input}>
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      )}
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {open ? (
        <Manage t={open} venue={venue} post={post} call={call} close={() => setOpen(null)} />
      ) : (
        <>
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="font-semibold">Tournaments</h2>
            {list.length === 0 ? (
              <p className="mt-1 text-sm text-slate-500">None yet. Set one up below.</p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-100 text-sm">
                {list.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <span className="font-medium">{t.name}</span>
                      {t.competition && <span className="text-slate-500"> ({t.competition.name})</span>} · {t.startsOn}
                      {t.endsOn !== t.startsOn && ` to ${t.endsOn}`} · {t.entered}/{t.maxEntries} entered
                      {t.waitlisted > 0 && `, ${t.waitlisted} waiting`} · <span className="text-slate-500">{t.status}</span>
                    </span>
                    <button onClick={() => void show(t.id)} className="text-sm font-medium text-teal-700 underline">
                      Open
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {competitions.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="font-semibold">Competitions</h2>
              <p className="mt-0.5 text-xs text-slate-500">One event holding its courts once, with divisions inside it, each drawn on its own and scheduled around the others.</p>
              <ul className="mt-2 divide-y divide-slate-100 text-sm">
                {competitions.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <span className="font-medium">{c.name}</span> · {c.startsOn}
                      {c.endsOn !== c.startsOn && ` to ${c.endsOn}`}, {formatMinute(c.startMin)}–{formatMinute(c.endMin)} ·{" "}
                      {list.filter((t) => t.competition?.id === c.id).length} division(s)
                      {c.maxDivisionsPerPlayer !== null && ` · up to ${c.maxDivisionsPerPlayer} per player`} · <span className="text-slate-500">{c.status}</span>
                    </span>
                    {c.status === "open" && (
                      <button onClick={() => void callOff(c)} className="text-sm text-red-700 underline">
                        Call off
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {catalog.templates.length > 0 && <Create venue={venue} post={post} catalog={catalog} competitions={competitions.filter((c) => c.status === "open")} />}
          <CreateCompetition venue={venue} post={post} />
        </>
      )}
    </div>
  );
}

const FORMAT_LABEL: Record<string, string> = {
  knockout: "Knockout",
  groups: "Groups, then knockout",
  round_robin: "Round robin (everybody plays everybody)",
  performance: "Heats and a final (times, distances, scores)",
};

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
  });
  const partOf = competitions.find((c) => String(c.id) === f.competitionId) ?? null;
  const courts = venue.courts.filter((c) => courtOffers(c, f.sport));
  const label = "flex flex-col text-xs font-medium text-slate-500";
  const template = catalog.templates.find((x) => x.key === f.template) ?? first;
  /** Start from a template: its formats, who enters, the match length and its rules. */
  const startFrom = (t: CompetitionTemplate, sport = f.sport) =>
    setF({
      ...f,
      sport,
      template: t.key,
      format: t.formats.includes(f.format as never) ? f.format : t.formats[0],
      entryKind: t.entryKinds.includes(f.entryKind as never) ? f.entryKind : t.entryKinds[0],
      teamSize: t.entryKinds.includes("pair") && f.teamSize === 2 ? 2 : 1,
      roster: t.roster ?? f.roster,
      matchMinutes: String(t.matchMinutes),
      rules: t.rules,
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
          courtIds: f.courtIds.length ? f.courtIds : courts.map((c) => c.id),
        });
        if (ok) setF({ ...f, name: "", description: "" });
      }}
      className="space-y-3 rounded-xl border border-dashed border-slate-300 bg-white p-4"
    >
      <h2 className="font-semibold">Set up a tournament</h2>
      {competitions.length > 0 && (
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Part of
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
            <option value="">On its own, holding its own courts</option>
            {competitions.map((c) => (
              <option key={c.id} value={c.id}>
                A division of {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="text-sm text-slate-500">
        The courts are held for those hours from now on, so nobody can book them. Players enter at /tournaments; you
        make the draw when entries close.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className={label}>
          Name
          <input required minLength={3} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={`w-64 ${input}`} placeholder="Open Singles, November" />
        </label>
        <label className={label}>
          Sport
          <select value={f.sport} onChange={(e) => startFrom(templateFor(e.target.value), e.target.value as Sport)} className={input}>
            {sports.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Starting from
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
                  {x.label}
                </option>
              ))}
            {catalog.venueTemplates.length > 0 && (
              <optgroup label="Your own">
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
          Format
          <select value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })} className={input}>
            {template.formats.map((fm) => (
              <option key={fm} value={fm}>
                {FORMAT_LABEL[fm]}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Who enters
          <select
            value={f.entryKind}
            onChange={(e) => setF({ ...f, entryKind: e.target.value, teamSize: e.target.value === "pair" ? 2 : 1, category: e.target.value !== "pair" && f.category === "mixed" ? "open" : f.category })}
            className={input}
          >
            {template.entryKinds.map((k) => (
              <option key={k} value={k}>
                {k === "player" ? "Singles (one player)" : k === "pair" ? "Doubles (pairs)" : "Teams, with a roster"}
              </option>
            ))}
          </select>
        </label>
        {f.entryKind === "team" && (
          <label className={label}>
            Roster (fewest–most players)
            <span className="flex gap-1">
              <input type="number" min={1} max={40} value={f.roster.min} onChange={(e) => setF({ ...f, roster: { ...f.roster, min: Number(e.target.value) } })} className={`w-16 ${input}`} />
              <input type="number" min={1} max={40} value={f.roster.max} onChange={(e) => setF({ ...f, roster: { ...f.roster, max: Number(e.target.value) } })} className={`w-16 ${input}`} />
            </span>
          </label>
        )}
        <label className={label}>
          Category
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value, entryKind: e.target.value === "mixed" ? "pair" : f.entryKind, teamSize: e.target.value === "mixed" ? 2 : f.teamSize })} className={input}>
            <option value="open">Open to all</option>
            <option value="women">Women&apos;s</option>
            <option value="men">Men&apos;s</option>
            {template.entryKinds.includes("pair") && <option value="mixed">Mixed doubles</option>}
          </select>
        </label>
        <label className={label}>
          Level
          <select value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })} className={input}>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l || "Open to all"}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Entry fee ({currencySymbol()})
          <input type="number" min={0} step={0.01} value={f.entryFee} onChange={(e) => setF({ ...f, entryFee: e.target.value })} className={`w-24 ${input}`} />
        </label>
        <label className={label}>
          Most entries
          <input type="number" min={2} max={128} value={f.maxEntries} onChange={(e) => setF({ ...f, maxEntries: e.target.value })} className={`w-20 ${input}`} />
        </label>
        {f.format === "groups" && (
          <>
            <label className={label}>
              Group size
              <input type="number" min={3} max={6} value={f.groupSize} onChange={(e) => setF({ ...f, groupSize: e.target.value })} className={`w-20 ${input}`} />
            </label>
            <label className={label}>
              Through from each
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
            Played in {partOf.name}&apos;s time: {partOf.startsOn}
            {partOf.endsOn !== partOf.startsOn && ` to ${partOf.endsOn}`}, {formatMinute(partOf.startMin)}–{formatMinute(partOf.endMin)}, on its courts; its matches are {partOf.matchMinutes} minutes unless this division says.
          </p>
          <label className={label}>
            This division&apos;s matches (minutes)
            <input type="number" min={5} max={600} value={f.matchMinutes} onChange={(e) => setF({ ...f, matchMinutes: e.target.value })} className={`w-24 ${input}`} />
          </label>
        </div>
      ) : (
      <div className="flex flex-wrap items-end gap-3">
        <label className={label}>
          First day
          <input type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value, endsOn: e.target.value > f.endsOn ? e.target.value : f.endsOn })} className={input} />
        </label>
        <label className={label}>
          Last day
          <input type="date" min={f.startsOn} value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} className={input} />
        </label>
        <label className={label}>
          From
          <ClockField label="From" value={f.startMin} onChange={(m) => setF({ ...f, startMin: m })} className={input} />
        </label>
        <label className={label}>
          Until
          <ClockField label="Until" value={f.endMin} after={f.startMin} onChange={(m) => setF({ ...f, endMin: m })} className={input} />
        </label>
        <label className={label}>
          {f.format === "performance" ? "Each heat (minutes)" : "Each match (minutes)"}
          <input type="number" min={5} max={600} value={f.matchMinutes} onChange={(e) => setF({ ...f, matchMinutes: e.target.value })} className={input} />
        </label>
        <fieldset className="text-sm">
          <legend className="text-xs font-medium text-slate-500">Courts (all, unless you pick)</legend>
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
          Entries close after (optional)
          <input type="date" value={f.entriesCloseOn} onChange={(e) => setF({ ...f, entriesCloseOn: e.target.value })} className={input} />
        </label>
        <label className={label}>
          Ages on the first day (optional)
          <span className="flex items-center gap-1">
            <input type="number" min={3} max={99} placeholder="from" aria-label="Youngest age" value={f.ageMin} onChange={(e) => setF({ ...f, ageMin: e.target.value })} className={`w-16 ${input}`} />
            –
            <input type="number" min={3} max={99} placeholder="to" aria-label="Oldest age" value={f.ageMax} onChange={(e) => setF({ ...f, ageMax: e.target.value })} className={`w-16 ${input}`} />
          </span>
        </label>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={f.membersOnly} onChange={(e) => setF({ ...f, membersOnly: e.target.checked })} />
          Members only
        </label>
        {f.format !== "performance" && (
          <label className={label}>
            Results entered by
            <select value={f.resultsBy} onChange={(e) => setF({ ...f, resultsBy: e.target.value })} className={input}>
              <option value="staff">Staff (and officials you give a link)</option>
              <option value="players">The players: one side reports, the other confirms</option>
            </select>
          </label>
        )}
      </div>
      {(f.ageMin || f.ageMax) && (
        <p className="text-xs text-slate-500">Entrants declare their date of birth (and a partner&apos;s); a team&apos;s captain declares the roster within the ages. Nobody checks a document here: check at the venue if it matters.</p>
      )}
      <textarea placeholder="About it, for players (optional): prizes, rules, shuttles" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} rows={2} className={`w-full ${input}`} />
      <p className="text-xs text-slate-500">
        {template.note} Templates are common club practice, not a governing body&apos;s regulations: check them against the rules you play
        under.
      </p>
      {f.format !== "performance" && <RulesFields rules={f.rules} onChange={(rules) => setF({ ...f, rules })} />}
      <details className="rounded-lg border border-slate-200 p-3">
        <summary className="cursor-pointer text-sm font-medium text-slate-700">Match lengths by stage{f.format === "knockout" || f.format === "groups" ? ", third-place match" : ""}</summary>
        <p className="mt-2 text-xs text-slate-500">
          Blank takes {f.matchMinutes} minutes. Each fixture keeps the length it was drawn with, and can be given more when you move it. A length is the time held on court, not how long play will take.
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          {(f.format === "performance" ? (["heat", "final"] as const) : f.format === "knockout" ? (["knockout", "final"] as const) : f.format === "groups" ? (["group", "knockout", "final"] as const) : (["group"] as const)).map((k) => (
            <label key={k} className={label}>
              {k === "group" ? "Group matches" : k === "knockout" ? "Knockout rounds" : k === "heat" ? "Heats" : "Final"}
              <input type="number" min={5} max={600} placeholder={f.matchMinutes} value={f.stageMinutes[k]} onChange={(e) => setF({ ...f, stageMinutes: { ...f.stageMinutes, [k]: e.target.value } })} className={`w-24 ${input}`} />
            </label>
          ))}
          {(f.format === "knockout" || f.format === "groups") && (
            <label className="flex items-center gap-1.5 text-sm text-slate-600">
              <input type="checkbox" checked={f.thirdPlace} onChange={(e) => setF({ ...f, thirdPlace: e.target.checked })} />
              Third-place match (the semi-finals&apos; losers; played at the final&apos;s length)
            </label>
          )}
        </div>
      </details>
      <details className="rounded-lg border border-slate-200 p-3">
        <summary className="cursor-pointer text-sm font-medium text-slate-700">Scoring and ranking</summary>
        <ScoringFields rules={f.rules} onChange={(rules) => setF({ ...f, rules })} />
      </details>
      <button className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">Set it up and hold the courts</button>
    </form>
  );
}

/** A competition: one event holding its courts once, for divisions added to it as tournaments. */
function CreateCompetition({ venue, post }: { venue: ManagedVenue; post: (url: string, body: object) => Promise<boolean> }) {
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
      <summary className="cursor-pointer font-semibold">Set up a competition with divisions</summary>
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
        <p className="text-sm text-slate-500">
          The courts are held for these days and hours at once. Then add each division (singles, doubles, under 12s) above, choosing this
          competition under &quot;Part of&quot;: each has its own format, rules, entries and draw, and every division&apos;s matches are this long.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className={label}>
            Name
            <input required minLength={3} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={`w-64 ${input}`} placeholder="Club Championships 2026" />
          </label>
          <label className={label}>
            Sport
            <select value={f.sport} onChange={(e) => setF({ ...f, sport: e.target.value as Sport, courtIds: [] })} className={input}>
              {sports.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            First day
            <input type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value, endsOn: e.target.value > f.endsOn ? e.target.value : f.endsOn })} className={input} />
          </label>
          <label className={label}>
            Last day
            <input type="date" min={f.startsOn} value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} className={input} />
          </label>
          <label className={label}>
            From
            <ClockField label="From" value={f.startMin} onChange={(m) => setF({ ...f, startMin: m })} className={input} />
          </label>
          <label className={label}>
            Until
            <ClockField label="Until" value={f.endMin} after={f.startMin} onChange={(m) => setF({ ...f, endMin: m })} className={input} />
          </label>
          <label className={label}>
            Each match (minutes)
            <input type="number" min={5} max={600} value={f.matchMinutes} onChange={(e) => setF({ ...f, matchMinutes: e.target.value })} className={`w-20 ${input}`} />
          </label>
          <label className={label}>
            Divisions per player (optional)
            <input type="number" min={1} max={20} value={f.maxDivisionsPerPlayer} onChange={(e) => setF({ ...f, maxDivisionsPerPlayer: e.target.value })} className={`w-20 ${input}`} />
          </label>
        </div>
        <fieldset className="text-sm">
          <legend className="text-xs font-medium text-slate-500">Courts (all, unless you pick)</legend>
          <div className="flex flex-wrap gap-3 pt-1">
            {courts.map((c) => (
              <label key={c.id} className="inline-flex items-center gap-1">
                <input type="checkbox" checked={f.courtIds.includes(c.id)} onChange={() => setF({ ...f, courtIds: f.courtIds.includes(c.id) ? f.courtIds.filter((x) => x !== c.id) : [...f.courtIds, c.id] })} />
                {c.name}
              </label>
            ))}
          </div>
        </fieldset>
        <button className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">Set it up and hold the courts</button>
      </form>
    </details>
  );
}

/**
 * Results from the people on court: what players reported and are waiting on
 * or dispute (staff settle it by entering the result below), and officials'
 * links to enter results, each shown once when made.
 */
function ResultsByPeople({ t }: { t: TournamentDetail }) {
  const [state, setState] = useState<{ reports: MatchReport[]; officials: Official[] }>({ reports: [], officials: [] });
  const [link, setLink] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const base = `/api/admin/tournaments/${t.id}`;
  const load = useCallback(async () => {
    const res = await fetch(base, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      setState({ reports: data.reports ?? [], officials: data.officials ?? [] });
    }
  }, [base]);
  useEffect(() => {
    void load();
  }, [load, t]);
  const names = new Map(t.entries.map((e) => [e.id, e.name]));
  const said = (r: MatchReport) =>
    r.walkover ? `a walkover to ${names.get(r.winner ?? 0)}` : r.winner === null ? `a draw, ${r.score}` : `${names.get(r.winner)} won ${r.score}`;
  const live = state.officials.filter((o) => !o.revokedAt);
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <h3 className="font-semibold">Results from the players and officials</h3>
      {error && <p className="mt-1 text-red-700">{error}</p>}
      {t.resultsBy === "players" && (
        <div className="mt-2">
          {state.reports.length === 0 ? (
            <p className="text-slate-500">Players report their own matches and the other side confirms. Nothing is waiting.</p>
          ) : (
            <ul className="space-y-1">
              {state.reports.map((r) => (
                <li key={r.id} className={r.status === "disputed" ? "text-amber-900" : "text-slate-700"}>
                  {r.status === "disputed" ? "Disputed" : "Waiting for confirmation"}: {names.get(r.entryId)} reported {said(r)}
                  {r.disputeNote && ` — the other side says: "${r.disputeNote}"`}. {r.status === "disputed" && "Enter the result yourselves below."}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="mt-3">
        <p className="text-slate-600">
          Officials (referees) enter results through a link of their own, no account needed; each result is recorded with their name. A link
          enters results of matches still to be decided, works until the last day, and stops at once when withdrawn; corrections stay with you.
        </p>
        <ul className="mt-1 space-y-1">
          {live.map((o) => (
            <li key={o.id} className="flex items-center gap-2">
              {o.name}
              {o.expiresOn && <span className="text-xs text-slate-500">until {o.expiresOn}</span>}
              <button
                onClick={async () => {
                  setError(null);
                  const res = await fetch(`${base}/officials/${o.id}`, { method: "DELETE" });
                  if (!res.ok) setError((await res.json()).error ?? "That did not work.");
                  await load();
                }}
                className="text-xs text-red-700 underline"
              >
                Withdraw the link
              </button>
            </li>
          ))}
        </ul>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            const res = await fetch(`${base}/officials`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
            const data = await res.json();
            if (!res.ok) return setError(data.error ?? "That did not work.");
            setLink(data.link);
            setName("");
            await load();
          }}
          className="mt-2 flex flex-wrap items-center gap-2"
        >
          <input required minLength={2} placeholder="Official's name" value={name} onChange={(e) => setName(e.target.value)} className={input} />
          <button className="rounded-md border border-slate-300 px-3 py-1 text-sm">Give an official a link</button>
        </form>
        {link && (
          <p className="mt-2 break-all rounded-md bg-amber-50 px-3 py-2 text-amber-900">
            Send this link to the official now; it is shown only this once: <span className="font-mono text-xs">{link}</span>
          </p>
        )}
      </div>
    </section>
  );
}

/** How the tournament treats somebody who leaves it (lib/tournament-rules.ts). */
function RulesFields({ rules, onChange, disabled = false }: { rules: CompetitionRules; onChange: (r: CompetitionRules) => void; disabled?: boolean }) {
  const label = "flex flex-col text-xs font-medium text-slate-500";
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className={label}>
        Group results of a player who withdraws or retires
        <select
          disabled={disabled}
          value={rules.groupResultsOnWithdrawal}
          onChange={(e) => onChange({ ...rules, groupResultsOnWithdrawal: e.target.value as "stand" | "void" })}
          className={input}
        >
          <option value="stand">Stand as played</option>
          <option value="void">Are void</option>
        </select>
      </label>
      <label className={label}>
        Group results of a player disqualified
        <select
          disabled={disabled}
          value={rules.groupResultsOnDisqualification}
          onChange={(e) => onChange({ ...rules, groupResultsOnDisqualification: e.target.value as "stand" | "void" })}
          className={input}
        >
          <option value="void">Are void</option>
          <option value="stand">Stand as played</option>
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-xs text-slate-600">
        <input type="checkbox" disabled={disabled} checked={rules.refundBeforeDraw} onChange={(e) => onChange({ ...rules, refundBeforeDraw: e.target.checked })} />
        Fee paid online owed back to anyone leaving before the draw
      </label>
    </div>
  );
}

const RANK_LABEL: Record<RankKey, string> = {
  points: "table points",
  wins: "wins",
  set_diff: "set difference",
  set_ratio: "set ratio (won ÷ lost)",
  point_diff: "point (or goal) difference",
  point_ratio: "point ratio (scored ÷ conceded)",
  points_for: "points (or goals) scored",
  head_to_head: "who beat whom",
};

/** How matches are scored and tables ranked, or how performances are measured (lib/tournament-rules.ts). */
function ScoringFields({ rules, onChange, disabled = false }: { rules: CompetitionRules; onChange: (r: CompetitionRules) => void; disabled?: boolean }) {
  const label = "flex flex-col text-xs font-medium text-slate-500";
  const sc = rules.scoring;
  const set = (patch: Partial<CompetitionRules["scoring"]>) => onChange({ ...rules, scoring: { ...sc, ...patch } });
  if (rules.performance) {
    const p = rules.performance;
    const setP = (patch: Partial<NonNullable<CompetitionRules["performance"]>>) => onChange({ ...rules, performance: { ...p, ...patch } });
    return (
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className={label}>
          Measured by
          <select disabled={disabled} value={p.measure} onChange={(e) => setP({ measure: e.target.value as typeof p.measure, better: e.target.value === "time" ? "lower" : "higher" })} className={input}>
            <option value="time">Time (lower wins)</option>
            <option value="distance">Distance (higher wins)</option>
            <option value="score">Score</option>
          </select>
        </label>
        {p.measure === "score" && (
          <label className={label}>
            Better score
            <select disabled={disabled} value={p.better} onChange={(e) => setP({ better: e.target.value as typeof p.better })} className={input}>
              <option value="higher">Higher</option>
              <option value="lower">Lower (golf)</option>
            </select>
          </label>
        )}
        <label className={label}>
          Attempts, ends or games each
          <input disabled={disabled} type="number" min={1} max={12} value={p.attempts} onChange={(e) => setP({ attempts: Number(e.target.value) })} className={`w-20 ${input}`} />
        </label>
        <label className={label}>
          Counts
          <select disabled={disabled} value={p.aggregate} onChange={(e) => setP({ aggregate: e.target.value as typeof p.aggregate })} className={input}>
            <option value="best">The best attempt</option>
            <option value="total">The total</option>
          </select>
        </label>
        <label className={label}>
          In each heat (lanes, targets)
          <input disabled={disabled} type="number" min={2} max={40} value={p.heatSize} onChange={(e) => setP({ heatSize: Number(e.target.value) })} className={`w-20 ${input}`} />
        </label>
        <label className={label}>
          Into the final (0: none)
          <input disabled={disabled} type="number" min={0} max={40} value={p.finalSize} onChange={(e) => setP({ finalSize: Number(e.target.value) })} className={`w-20 ${input}`} />
        </label>
      </div>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap items-end gap-3">
      <label className={label}>
        Scores are
        <select disabled={disabled} value={sc.kind} onChange={(e) => set({ kind: e.target.value as typeof sc.kind, draws: e.target.value === "tally" ? sc.draws : false })} className={input}>
          <option value="sets">Sets or games (21-15, 18-21)</option>
          <option value="tally">One number each (goals, points: 3-2)</option>
        </select>
      </label>
      {sc.kind === "sets" ? (
        <label className={label}>
          Best of
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
          Group matches may be drawn
        </label>
      )}
      <label className={label}>
        Table points: win / draw / loss
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
            Table points by set score: clear win / deciding-set win / deciding-set loss / clear loss
          </span>
          {sc.setPoints && (
            <span className="flex gap-1">
              {(["winClear", "winDecider", "loseDecider", "loseClear"] as const).map((k) => (
                <input
                  key={k}
                  aria-label={`Points: ${k}`}
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
        Tables ranked by, in order
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
                  {RANK_LABEL[k]}
                </option>
              ))}
            </select>
          ))}
        </span>
      </label>
      <label className={label}>
        A retirement&apos;s score, as it stood
        <select disabled={disabled} value={sc.retired} onChange={(e) => set({ retired: e.target.value as typeof sc.retired })} className={input}>
          <option value="win_only">Counts the win only</option>
          <option value="as_played">Counts as played in the differences</option>
        </select>
      </label>
      <label className={label}>
        A walkover counts as (winner first; empty: the win only)
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
  t,
  venue,
  post,
  call,
  close,
}: {
  t: TournamentDetail;
  venue: ManagedVenue;
  post: (url: string, body: object) => Promise<boolean>;
  call: (url: string, body: object) => Promise<{ ok: boolean; data: Record<string, unknown> }>;
  close: () => void;
}) {
  const names = new Map(t.entries.map((e) => [e.id, e.name]));
  const base = `/api/admin/tournaments/${t.id}`;
  const [said, setSaid] = useState<string[]>([]);
  const [fixing, setFixing] = useState<{ matchId: number; input: ResultInput; preview: CorrectionPreview } | null>(null);

  /** Out of the competition, after seeing what it changes. */
  async function takeOut(entryId: number, name: string, reason: OutReason) {
    const preview = await call(`${base}/entries/${entryId}`, { withdraw: true, reason, preview: true });
    if (!preview.ok) return;
    const changes = (preview.data.changes as string[]) ?? [];
    // A disqualification is kept with why; anything else may have a note.
    const note = window.prompt(reason === "disqualified" ? `Why is ${name} disqualified? (kept with the record)` : `A note for the record (optional): why ${name} is ${reason}`) ?? null;
    if (note === null || (reason === "disqualified" && note.trim().length < 5)) return;
    if (!window.confirm(`${name}: ${reason}?\n\n${changes.join("\n") || "Nothing else changes."}`)) return;
    const done = await call(`${base}/entries/${entryId}`, { withdraw: true, reason, note, token: preview.data.token });
    if (done.ok) setSaid((done.data.changes as string[]) ?? []);
  }

  /** A result; one the knockout has moved past opens the correction review instead. */
  async function result(matchId: number, input: ResultInput): Promise<boolean> {
    const done = await call(`${base}/matches/${matchId}`, input);
    if (done.ok || done.data.code !== "KNOCKOUT_STARTED") return done.ok;
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
            ← All tournaments
          </button>
          <h2 className="mt-1 text-lg font-bold">
            {t.name} <span className="text-sm font-normal text-slate-500">· {t.status}</span>
          </h2>
          <p className="text-sm text-slate-500">
            {t.startsOn}
            {t.endsOn !== t.startsOn && ` to ${t.endsOn}`}, {formatMinute(t.startMin)}–{formatMinute(t.endMin)} ·{" "}
            {FORMAT_LABEL[t.format].toLowerCase()} · {t.entryKind === "team" ? "teams" : t.teamSize === 2 ? "doubles" : "singles"} ·{" "}
            {money(t.entryFee)} · <a href={`/tournaments/${t.id}`} target="_blank" rel="noopener" className="underline">public page ↗</a>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {t.status === "open" && (
            <button onClick={() => void post(base, { action: "close" })} className={small}>
              Close entries
            </button>
          )}
          {(t.status === "open" || t.status === "closed") && (
            <button
              onClick={() => window.confirm("Make the draw now? Entries close, and everybody is told their first match.") && void post(base, { action: "draw" })}
              className="rounded-md bg-teal-600 px-3 py-1 text-sm font-semibold text-white hover:bg-teal-700"
            >
              Make the draw
            </button>
          )}
          <button
            onClick={() => {
              const name = window.prompt("Keep these settings as a template, to start the next one from. Its name:", t.name);
              if (name) void call(base, { action: "save_template", name }).then((r) => r.ok && setSaid([`Saved as the template "${name}".`]));
            }}
            className={small}
          >
            Save as template
          </button>
          {t.status !== "finished" && t.status !== "cancelled" && (
            <button
              onClick={() => window.confirm(`Call off ${t.name}? The courts go back on sale, entrants are told, and fees paid online are owed back.`) && void post(base, { action: "cancel" })}
              className="rounded-md border border-red-300 px-3 py-1 text-sm font-medium text-red-700"
            >
              Call it off
            </button>
          )}
        </div>
      </div>

      {t.format !== "performance" && t.status !== "cancelled" && t.status !== "finished" && <ResultsByPeople t={t} />}

      <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
        <h3 className="font-semibold">Rules for anyone who leaves</h3>
        <p className="mt-1 text-xs text-slate-500">
          Whatever these say, a player who is out goes no further: matches they have left are walkovers, and the next in
          their group goes through. Knockout results already played stand.{" "}
          {t.status === "open" || t.status === "closed" ? "They can be changed until the draw." : "Fixed since the draw."}
        </p>
        <div className="mt-2">
          <RulesFields
            rules={t.rules}
            disabled={t.status !== "open" && t.status !== "closed"}
            onChange={(rules) => void post(base, { action: "rules", rules })}
          />
        </div>
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-slate-600">Scoring and ranking{t.template ? ` (from the template ${t.template})` : ""}</summary>
          <ScoringFields rules={t.rules} disabled={t.status !== "open" && t.status !== "closed"} onChange={(rules) => void post(base, { action: "rules", rules })} />
        </details>
      </section>

      {t.issues.filter((i) => i.status === "open").map((i) => (
        <IssuePanel key={i.id} t={t} issueId={i.id} names={names} venue={venue} call={call} onDone={(changes) => setSaid(changes)} />
      ))}

      {t.performance && <PerformancePanel t={t} names={names} call={call} />}

      {said.length > 0 && (
        <section className="rounded-xl border border-teal-200 bg-teal-50 p-3 text-sm">
          <h3 className="font-semibold">What that changed</h3>
          <ul className="mt-1 list-disc pl-5">
            {said.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </section>
      )}

      {fixing && (
        <CorrectionPanel
          fixing={fixing}
          names={names}
          knockout={t.matches.find((m) => m.id === fixing.matchId)?.stage === "knockout"}
          onCancel={() => setFixing(null)}
          onApply={async (mode, reason) => {
            const done = await call(`${base}/matches/${fixing.matchId}`, { ...fixing.input, correction: { mode, reason, token: fixing.preview.token } });
            if (done.ok) {
              setSaid((done.data.changes as string[]) ?? []);
              setFixing(null);
            }
          }}
        />
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="font-semibold">Entries ({t.entries.filter((e) => e.status === "entered").length} of {t.maxEntries})</h3>
        <table className="mt-2 w-full text-sm">
          <tbody>
            {t.entries.filter((e) => e.status !== "withdrawn").map((e) => (
              <tr key={e.id} className="border-t border-slate-100">
                <td className="py-1.5">
                  {e.name}
                  {e.guardian && (
                    <div className="text-xs text-slate-500">
                      Under 18 as declared · guardian {e.guardian.name} agreed (their word, not checked)
                    </div>
                  )}
                  {e.eligibilityChecked && <div className="text-xs text-emerald-700">✓ eligibility checked by {e.eligibilityChecked.by}</div>}
                </td>
                <td className="text-slate-500">{e.status === "waitlisted" ? "waiting" : ""}</td>
                <td className="space-x-1 whitespace-nowrap">
                  {e.status === "entered" && t.status !== "cancelled" && (
                    <>
                      <button onClick={() => void post(`${base}/entries/${e.id}`, { checkedIn: !e.checkedIn })} className={`${small} ${e.checkedIn ? "bg-emerald-50 text-emerald-700" : ""}`}>
                        {e.checkedIn ? "✓ here" : "check in"}
                      </button>
                      {t.ageRange && (
                        <button
                          onClick={() => void post(`${base}/entries/${e.id}`, { eligibilityChecked: !e.eligibilityChecked })}
                          title="You saw proof of age at the venue. Nothing about the document is recorded."
                          className={small}
                        >
                          {e.eligibilityChecked ? "undo check" : "age checked"}
                        </button>
                      )}
                    </>
                  )}
                </td>
                <td>
                  {t.entryFee > 0 && (
                    <button onClick={() => void post(`${base}/entries/${e.id}`, { paid: !e.paid })} className={`${small} ${e.paid ? "bg-emerald-50 text-emerald-700" : ""}`}>
                      {e.paid ? "✓ paid" : "unpaid"}
                    </button>
                  )}
                </td>
                <td>
                  {(t.status === "open" || t.status === "closed") && e.status === "entered" && (
                    <label className="text-xs text-slate-500">
                      Seed{" "}
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
                  {t.status !== "finished" && t.status !== "cancelled" && (
                    <select
                      aria-label={`Take ${e.name} out`}
                      value=""
                      onChange={(ev) => ev.target.value && void takeOut(e.id, e.name, ev.target.value as OutReason)}
                      className="rounded border border-red-200 px-1 text-xs text-red-700"
                    >
                      <option value="">out…</option>
                      <option value="withdrawn">withdrawn</option>
                      {t.status === "drawn" && <option value="retired">retired</option>}
                      <option value="disqualified">disqualified</option>
                    </select>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {t.entries.some((e) => e.out) && (
          <p className="mt-2 text-xs text-slate-500">
            Out: {t.entries.filter((e) => e.out).map((e) => `${e.name} (${e.out!.reason}${e.out!.stage === "before_draw" ? ", before the draw" : ""})`).join(", ")}
          </p>
        )}
      </section>

      {t.groups.length > 0 && (
        <section className="grid gap-3 sm:grid-cols-2">
          {t.groups.map((g) => (
            <div key={g.groupNo} className="rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-sm">
              <h3 className="font-semibold">Group {g.groupNo}</h3>
              <table className="mt-1 w-full">
                <tbody>
                  {g.table.map((s) => (
                    <tr key={s.entryId} className={s.out ? "text-slate-400" : ""}>
                      <td>
                        {names.get(s.entryId)}
                        {s.out && <span className="ml-1 text-xs">({s.out}{s.resultsVoid ? ", results void" : ""}, not through)</span>}
                      </td>
                      <td className="text-right text-slate-500">
                        {t.rules.scoring.kind === "tally" ? (
                          <>
                            {s.won}–{s.drawn}–{s.lost} · {s.pointDiff >= 0 ? "+" : ""}
                            {s.pointDiff}
                            {t.rules.scoring.rankBy.includes("points") && ` · ${s.points} pts`}
                          </>
                        ) : (
                          <>
                            {s.won}–{s.lost} · sets {s.setDiff >= 0 ? "+" : ""}
                            {s.setDiff}
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

      {t.matches.some((m) => m.stage === "group" || m.stage === "knockout") && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="font-semibold">Matches</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {t.matches
              .filter((m) => m.status !== "bye" && (m.stage === "group" || m.stage === "knockout"))
              .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || (a.minute ?? 0) - (b.minute ?? 0) || (a.courtId ?? 0) - (b.courtId ?? 0))
              .map((m) => (
                <MatchRow key={m.id} m={m} names={names} venue={venue} rules={t.rules} save={(body) => result(m.id, body as ResultInput)} />
              ))}
          </ul>
        </section>
      )}

      {t.corrections.length > 0 && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
          <h3 className="font-semibold">Corrections after the knockout began</h3>
          <ul className="mt-1 space-y-1">
            {t.corrections.map((c, i) => (
              <li key={i}>
                {localTime(c.createdAt)} ·{" "}
                {c.kind === "replace"
                  ? "put into the knockout"
                  : c.kind === "stand"
                    ? "results let stand"
                    : c.kind === "replay"
                      ? "replayed"
                      : c.knockout
                        ? "this match's record only, later rounds as played"
                        : "group table only, knockout as played"}
                : {c.reason}
                {c.changes && c.changes.length > 0 && <span className="text-slate-600"> — {c.changes.join(" ")}</span>}
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
  onCancel,
  onApply,
}: {
  fixing: { matchId: number; input: ResultInput; preview: CorrectionPreview };
  names: Map<number, string>;
  knockout: boolean;
  onCancel: () => void;
  onApply: (mode: "replace" | "standings_only", reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const { preview } = fixing;
  const list = (items: string[]) => (
    <ul className="mt-1 list-disc pl-5">
      {items.map((c, i) => (
        <li key={i}>{c}</li>
      ))}
    </ul>
  );
  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm" aria-label="Correction">
      <h3 className="font-semibold">The knockout has begun: review this correction ({fixing.input.winner === null ? "a draw" : `${names.get(fixing.input.winner)} won`})</h3>
      <p className="mt-1 text-xs text-slate-600">
        Nothing has changed yet. It is kept with your reason and what it changes, and the public page says a correction was made.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <h4 className="font-semibold">Put into the knockout</h4>
          {preview.replace.possible ? (
            list(preview.replace.changes)
          ) : (
            <>
              <p className="mt-1 text-xs text-red-700">Not safely: settle these by hand first (correct the knockout&apos;s own results, or run it again).</p>
              {list(preview.replace.blockers)}
            </>
          )}
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <h4 className="font-semibold">{knockout ? "This match's record only" : "Group table only"}</h4>
          <p className="mt-1 text-xs text-slate-600">
            {knockout ? "Who went on is not changed: the later rounds stand as they were played." : "The knockout stays as it is being played."}
          </p>
          {list(preview.standingsOnly.changes)}
        </div>
      </div>
      <label className="mt-3 block text-xs font-medium text-slate-600">
        Why (kept with the correction)
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Scorer swapped the names; appeal upheld" className={`mt-1 w-full ${input}`} />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          disabled={!preview.replace.possible || reason.trim().length < 5}
          onClick={() => window.confirm("Put this into the knockout? The changes listed are made.") && void onApply("replace", reason)}
          className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
        >
          Put into the knockout
        </button>
        <button
          disabled={reason.trim().length < 5}
          onClick={() =>
            window.confirm(knockout ? "Correct this match's record only? The later rounds stay as played." : "Correct the group table only? The knockout stays as played.") &&
            void onApply("standings_only", reason)
          }
          className="rounded-md border border-amber-400 px-3 py-1.5 text-xs font-semibold text-amber-800 disabled:opacity-40"
        >
          {knockout ? "Record only" : "Group table only"}
        </button>
        <button onClick={onCancel} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs">
          Leave it
        </button>
      </div>
    </section>
  );
}

/** Move a fixture still to play, or give it longer: to a court and time held for it or free to hold (managers). */
function MoveFixture({ m, venue, save }: { m: Match; venue: ManagedVenue; save: (body: object) => Promise<boolean> }) {
  const [to, setTo] = useState({ date: m.date ?? "", startMin: m.minute ?? 540, courtId: m.courtId ?? 0, minutes: String(m.minutes) });
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-teal-700">Move…</summary>
      <div className="mt-1 flex flex-col gap-1">
        <input type="date" aria-label="Date" value={to.date} onChange={(e) => setTo({ ...to, date: e.target.value })} className={input} />
        <ClockField label="Start" value={to.startMin} onChange={(v) => setTo({ ...to, startMin: v })} className={input} />
        <select aria-label="Court" value={to.courtId} onChange={(e) => setTo({ ...to, courtId: Number(e.target.value) })} className={input}>
          {venue.courts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <label>
          Minutes{" "}
          <input type="number" min={5} max={600} value={to.minutes} onChange={(e) => setTo({ ...to, minutes: e.target.value })} className={`w-16 ${input}`} />
        </label>
        <button onClick={() => void save({ move: { ...to, minutes: Number(to.minutes) } })} className="rounded-md border border-slate-300 px-2 py-1 text-xs">
          Move it and tell the players
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
  save,
}: {
  m: Match;
  names: Map<number, string>;
  venue: ManagedVenue;
  rules: CompetitionRules;
  save: (body: object) => Promise<boolean>;
}) {
  const tally = rules.scoring.kind === "tally";
  const [score, setScore] = useState(m.score ?? "");
  const known = m.a !== null && m.b !== null;
  const side = (id: number | null) => (id === null ? "to be decided" : names.get(id) ?? "?");
  const label = m.stage === "group" ? `Group ${m.groupNo}` : m.placement === 3 ? "Third-place match" : `Knockout round ${m.round}`;
  return (
    <li className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
      <span className="w-40 shrink-0 text-xs text-slate-500">
        {m.date} {m.minute !== null && `${formatMinute(m.minute)}–${formatMinute(m.minute + m.minutes)}`} · {m.courtName ?? "—"}
        <br />
        {label}
        {m.status === "scheduled" && m.date !== null && <MoveFixture m={m} venue={venue} save={save} />}
      </span>
      <span className={`min-w-[10rem] flex-1 ${m.winner === m.a && m.a !== null ? "font-semibold" : ""}`}>{side(m.a)}</span>
      <span className="text-slate-400">v</span>
      <span className={`min-w-[10rem] flex-1 ${m.winner === m.b && m.b !== null ? "font-semibold" : ""}`}>{side(m.b)}</span>
      {known && (
        <>
          <input
            value={score}
            onChange={(e) => setScore(e.target.value)}
            placeholder={tally ? (m.stage === "knockout" ? "2-2 (penalties 4-3)" : "3-2") : "21-15, 18-21, 21-10"}
            className={`w-40 ${input}`}
          />
          {tally && rules.scoring.draws && m.stage === "group" && (
            <button onClick={() => void save({ winner: null, score })} className="rounded-md border border-slate-300 px-2 py-1 text-xs">
              Drawn
            </button>
          )}
          <button onClick={() => void save({ winner: m.a, score })} className="rounded-md border border-slate-300 px-2 py-1 text-xs">
            {names.get(m.a!)?.split(" ")[0]} won
          </button>
          <button onClick={() => void save({ winner: m.b, score })} className="rounded-md border border-slate-300 px-2 py-1 text-xs">
            {names.get(m.b!)?.split(" ")[0]} won
          </button>
          {m.status !== "done" && (
            <select
              value=""
              onChange={(e) => e.target.value && void save({ winner: Number(e.target.value), walkover: true })}
              className="rounded-md border border-slate-300 px-1 py-1 text-xs"
            >
              <option value="">Walkover to…</option>
              <option value={m.a!}>{names.get(m.a!)}</option>
              <option value={m.b!}>{names.get(m.b!)}</option>
            </select>
          )}
          <select
            aria-label="Retired"
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              const [winner, out] = e.target.value.split(":");
              void save({ winner: Number(winner), score, retired: true, outOfEvent: out === "out" });
            }}
            className="rounded-md border border-slate-300 px-1 py-1 text-xs"
          >
            <option value="">Retired…</option>
            {[m.a!, m.b!].map((w) => {
              const quit = names.get(w === m.a ? m.b! : m.a!);
              return [
                <option key={`${w}:in`} value={`${w}:in`}>{quit} stopped (still in the event)</option>,
                <option key={`${w}:out`} value={`${w}:out`}>{quit} stopped, and is out</option>,
              ];
            })}
          </select>
          {m.status !== "scheduled" && (
            <span className="text-xs text-emerald-700">
              ✓ {m.status === "walkover" ? "walkover" : m.status === "retired" ? `retired ${m.score ?? ""}` : m.winner === null ? `drawn ${m.score ?? ""}` : m.score}
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
  t,
  issueId,
  names,
  venue,
  call,
  onDone,
}: {
  t: TournamentDetail;
  issueId: number;
  names: Map<number, string>;
  venue: ManagedVenue;
  call: (url: string, body: object) => Promise<{ ok: boolean; data: Record<string, unknown> }>;
  onDone: (changes: string[]) => void;
}) {
  const [review, setReview] = useState<IssueReview | null>(null);
  const [reason, setReason] = useState("");
  const [slots, setSlots] = useState<Record<number, { courtId: number; date: string; startMin: number }>>({});
  const url = `/api/admin/tournaments/${t.id}/issues/${issueId}`;
  const issue = t.issues.find((i) => i.id === issueId)!;
  useEffect(() => {
    void fetch(url, { cache: "no-store" }).then(async (r) => r.ok && setReview(await r.json()));
  }, [url, t]);
  const courts = venue.courts.filter((c) => courtOffers(c, t.sport));
  async function resolve(action: "stand" | "replay") {
    if (!review) return;
    if (!window.confirm(action === "stand" ? "Let the results stand as played? It is recorded, with your reason." : "Replay these matches at the times given? What was played stays in the record.")) return;
    const done = await call(url, { action, reason, token: review.token, slots: action === "replay" ? slots : undefined });
    if (done.ok) onDone((done.data.changes as string[]) ?? []);
  }
  return (
    <section className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm" aria-label="Progression to resolve">
      <h3 className="font-semibold text-red-900">
        Under review: {names.get(issue.wrongEntry)} went on in place of {issue.rightEntry === null ? "nobody known" : names.get(issue.rightEntry)}
      </h3>
      <p className="mt-1 text-xs text-slate-600">The tournament does not finish until this is resolved. Played matches are never changed silently.</p>
      <ul className="mt-2 list-disc pl-5">
        {issue.affected.map((a) => (
          <li key={a.matchId}>{a.text}</li>
        ))}
      </ul>
      {review && (
        <div className="mt-3 space-y-2">
          {review.replay.possible ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-slate-700">To replay, give each match a court and a time:</p>
              {review.replay.matches.map((m) => (
                <div key={m.matchId} className="flex flex-wrap items-center gap-2">
                  <span className="w-40 text-xs">{m.name}{m.needsSlot ? "" : " (keeps its time)"}</span>
                  {m.needsSlot && (
                    <>
                      <select
                        aria-label={`Court for ${m.name}`}
                        value={slots[m.matchId]?.courtId ?? ""}
                        onChange={(e) => setSlots({ ...slots, [m.matchId]: { ...(slots[m.matchId] ?? { date: t.endsOn, startMin: t.startMin }), courtId: Number(e.target.value) } })}
                        className={input}
                      >
                        <option value="">court…</option>
                        {courts.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <input
                        type="date"
                        aria-label={`Date for ${m.name}`}
                        value={slots[m.matchId]?.date ?? ""}
                        onChange={(e) => setSlots({ ...slots, [m.matchId]: { ...(slots[m.matchId] ?? { courtId: courts[0]?.id ?? 0, startMin: t.startMin }), date: e.target.value } })}
                        className={input}
                      />
                      <ClockField
                        label={`Time for ${m.name}`}
                        value={slots[m.matchId]?.startMin ?? t.startMin}
                        onChange={(min) => setSlots({ ...slots, [m.matchId]: { ...(slots[m.matchId] ?? { courtId: courts[0]?.id ?? 0, date: t.endsOn }), startMin: min } })}
                        className={input}
                      />
                    </>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-red-800">It cannot be replayed here: {review.replay.blockers.join(" ")} Let it stand, or arrange it by hand and record the result.</p>
          )}
          <label className="block text-xs font-medium text-slate-600">
            Why (kept with the resolution)
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Both finalists agreed; appeal upheld" className={`mt-1 w-full ${input}`} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button disabled={reason.trim().length < 5} onClick={() => void resolve("stand")} className="rounded-md border border-slate-400 px-3 py-1.5 text-xs font-semibold disabled:opacity-40">
              Let the results stand
            </button>
            <button
              disabled={!review.replay.possible || reason.trim().length < 5}
              onClick={() => void resolve("replay")}
              className="rounded-md bg-red-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
            >
              Replay
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** A performance event's heats and final: each competitor's marks, lane by lane, and choosing a final's last places when level. */
function PerformancePanel({
  t,
  names,
  call,
}: {
  t: TournamentDetail;
  names: Map<number, string>;
  call: (url: string, body: object) => Promise<{ ok: boolean; data: Record<string, unknown> }>;
}) {
  const p = t.performance!;
  const rules = t.rules.performance!;
  const units = t.matches.filter((m) => m.stage === "heat" || m.stage === "final").sort((a, b) => (a.stage === "final" ? 1 : 0) - (b.stage === "final" ? 1 : 0) || a.position - b.position);
  const [chosen, setChosen] = useState<number[]>([]);
  return (
    <section className="space-y-3">
      {p.tieForFinal && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm">
          <h3 className="font-semibold">Level for the final&apos;s last place</h3>
          <p className="mt-1 text-xs text-slate-600">Decide it as your rules say (a swim-off, say), then choose who goes through.</p>
          <div className="mt-2 flex flex-wrap gap-3">
            {p.tieForFinal.map((id) => (
              <label key={id} className="inline-flex items-center gap-1">
                <input type="checkbox" checked={chosen.includes(id)} onChange={() => setChosen(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id])} />
                {names.get(id)}
              </label>
            ))}
          </div>
          <button onClick={() => void call(`/api/admin/tournaments/${t.id}`, { action: "final", chosen })} className="mt-2 rounded-md bg-teal-600 px-3 py-1 text-xs font-semibold text-white">
            Put them in the final
          </button>
        </div>
      )}
      {units.map((m) => (
        <HeatEntry key={m.id} t={t} m={m} lines={p.lines[m.id] ?? []} names={names} attempts={rules.attempts} placeholder={rules.measure === "time" ? "1:02.35" : "7.42"} call={call} />
      ))}
    </section>
  );
}

function HeatEntry({
  t,
  m,
  lines,
  names,
  attempts,
  placeholder,
  call,
}: {
  t: TournamentDetail;
  m: Match;
  lines: NonNullable<TournamentDetail["performance"]>["lines"][number];
  names: Map<number, string>;
  attempts: number;
  placeholder: string;
  call: (url: string, body: object) => Promise<{ ok: boolean; data: Record<string, unknown> }>;
}) {
  const [rows, setRows] = useState(() =>
    Object.fromEntries(lines.map((l) => [l.entryId, { attempts: Array.from({ length: attempts }, (_, i) => (l.attempts[i] === undefined ? "" : l.attempts[i] === null ? "X" : String(l.attempts[i]))), status: l.status === "pending" ? "ok" : l.status }]))
  );
  if (lines.length === 0)
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-500">
        {m.stage === "final" ? "Final" : `Heat ${m.position}`}: filled once the heats are in.
      </div>
    );
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-sm">
      <h3 className="font-semibold">
        {m.stage === "final" ? "Final" : `Heat ${m.position}`}{" "}
        <span className="text-xs font-normal text-slate-500">
          {m.date} {m.minute !== null && formatMinute(m.minute)} · {m.courtName} · {m.status === "done" ? "results in" : "to come"}
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
                      aria-label={`${names.get(l.entryId)} attempt ${i + 1}`}
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
                    aria-label={`${names.get(l.entryId)} status`}
                    value={rows[l.entryId]?.status}
                    onChange={(e) => setRows({ ...rows, [l.entryId]: { ...rows[l.entryId], status: e.target.value as typeof l.status } })}
                    className="rounded border border-slate-300 px-1 py-0.5 text-xs"
                  >
                    <option value="ok">result</option>
                    <option value="dns">did not start</option>
                    <option value="dnf">did not finish</option>
                    <option value="dq">disqualified</option>
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
          void call(`/api/admin/tournaments/${t.id}/matches/${m.id}`, {
            performances: Object.entries(rows)
              .filter(([, r]) => r.status !== "ok" || r.attempts.some((a) => a.trim()))
              .map(([entryId, r]) => ({ entryId: Number(entryId), status: r.status, attempts: r.status === "ok" ? r.attempts.filter((a) => a.trim()) : undefined })),
          })
        }
        className="mt-2 rounded-md bg-teal-600 px-3 py-1 text-xs font-semibold text-white"
      >
        Save results
      </button>
    </div>
  );
}
