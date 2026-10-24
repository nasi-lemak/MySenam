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
import type { CorrectionPreview, Match, ResultInput, Tournament, TournamentDetail } from "@/lib/tournaments";
import type { CompetitionRules, OutReason } from "@/lib/tournament-rules";
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
  const [open, setOpen] = useState<TournamentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const venue = venues.find((v) => v.id === venueId);

  const load = useCallback(async () => {
    if (!venueId) return;
    const res = await fetch(`/api/admin/tournaments?venueId=${venueId}`, { cache: "no-store" });
    if (res.ok) setList((await res.json()).tournaments);
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
                      <span className="font-medium">{t.name}</span> · {t.startsOn}
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
          <Create venue={venue} post={post} />
        </>
      )}
    </div>
  );
}

function Create({ venue, post }: { venue: ManagedVenue; post: (url: string, body: object) => Promise<boolean> }) {
  const sports = activityKeys().filter((s) => venue.courts.some((c) => c.sport === s));
  const start = addDays(todayLocal(), 14);
  const [f, setF] = useState({
    name: "",
    sport: (sports[0] ?? "badminton") as Sport,
    format: "knockout",
    teamSize: 1,
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
    matchMinutes: "60",
    courtIds: [] as number[],
    description: "",
    rules: { groupResultsOnWithdrawal: "stand", groupResultsOnDisqualification: "void", refundBeforeDraw: true } as CompetitionRules,
  });
  const courts = venue.courts.filter((c) => courtOffers(c, f.sport));
  const label = "flex flex-col text-xs font-medium text-slate-500";

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await post("/api/admin/tournaments", {
          ...f,
          venueId: venue.id,
          entryFee: Number(f.entryFee),
          maxEntries: Number(f.maxEntries),
          groupSize: Number(f.groupSize),
          advance: Number(f.advance),
          matchMinutes: Number(f.matchMinutes),
          courtIds: f.courtIds.length ? f.courtIds : courts.map((c) => c.id),
        });
        if (ok) setF({ ...f, name: "", description: "" });
      }}
      className="space-y-3 rounded-xl border border-dashed border-slate-300 bg-white p-4"
    >
      <h2 className="font-semibold">Set up a tournament</h2>
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
          <select value={f.sport} onChange={(e) => setF({ ...f, sport: e.target.value as Sport, courtIds: [] })} className={input}>
            {sports.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Format
          <select value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })} className={input}>
            <option value="knockout">Knockout</option>
            <option value="groups">Groups, then knockout</option>
          </select>
        </label>
        <label className={label}>
          Play
          <select
            value={f.teamSize}
            onChange={(e) => setF({ ...f, teamSize: Number(e.target.value), category: Number(e.target.value) === 1 && f.category === "mixed" ? "open" : f.category })}
            className={input}
          >
            <option value={1}>Singles</option>
            <option value={2}>Doubles</option>
          </select>
        </label>
        <label className={label}>
          Category
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value, teamSize: e.target.value === "mixed" ? 2 : f.teamSize })} className={input}>
            <option value="open">Open to all</option>
            <option value="women">Women&apos;s</option>
            <option value="men">Men&apos;s</option>
            <option value="mixed">Mixed doubles</option>
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
          Each match (minutes)
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
      <textarea placeholder="About it, for players (optional): prizes, rules, shuttles" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} rows={2} className={`w-full ${input}`} />
      <RulesFields rules={f.rules} onChange={(rules) => setF({ ...f, rules })} />
      <button className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">Set it up and hold the courts</button>
    </form>
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
    if (!window.confirm(`${name}: ${reason}?\n\n${changes.join("\n") || "Nothing else changes."}`)) return;
    const done = await call(`${base}/entries/${entryId}`, { withdraw: true, reason });
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
            {t.format === "groups" ? "groups, then knockout" : "knockout"} · {t.teamSize === 2 ? "doubles" : "singles"} ·{" "}
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
      </section>

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
                <td className="py-1.5">{e.name}</td>
                <td className="text-slate-500">{e.status === "waitlisted" ? "waiting" : ""}</td>
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
                        {s.won}–{s.lost} · sets {s.setDiff >= 0 ? "+" : ""}
                        {s.setDiff}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      )}

      {t.matches.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="font-semibold">Matches</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {t.matches
              .filter((m) => m.status !== "bye")
              .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || (a.minute ?? 0) - (b.minute ?? 0) || (a.courtId ?? 0) - (b.courtId ?? 0))
              .map((m) => (
                <MatchRow key={m.id} m={m} names={names} venue={venue} save={(body) => result(m.id, body as ResultInput)} />
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
                {localTime(c.createdAt)} · {c.kind === "replace" ? "put into the knockout" : "group table only, knockout as played"}: {c.reason}
                {c.changes && c.changes.length > 0 && <span className="text-slate-600"> — {c.changes.join(" ")}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Reviewing a group correction the knockout has moved past: what each way changes, a reason, then confirm. */
function CorrectionPanel({
  fixing,
  names,
  onCancel,
  onApply,
}: {
  fixing: { matchId: number; input: ResultInput; preview: CorrectionPreview };
  names: Map<number, string>;
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
      <h3 className="font-semibold">The knockout has begun: review this correction ({names.get(fixing.input.winner)} won)</h3>
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
          <h4 className="font-semibold">Group table only</h4>
          <p className="mt-1 text-xs text-slate-600">The knockout stays as it is being played.</p>
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
          onClick={() => window.confirm("Correct the group table only? The knockout stays as played.") && void onApply("standings_only", reason)}
          className="rounded-md border border-amber-400 px-3 py-1.5 text-xs font-semibold text-amber-800 disabled:opacity-40"
        >
          Group table only
        </button>
        <button onClick={onCancel} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs">
          Leave it
        </button>
      </div>
    </section>
  );
}

function MatchRow({
  m,
  names,
  save,
}: {
  m: Match;
  names: Map<number, string>;
  venue: ManagedVenue;
  save: (body: object) => Promise<boolean>;
}) {
  const [score, setScore] = useState(m.score ?? "");
  const known = m.a !== null && m.b !== null;
  const side = (id: number | null) => (id === null ? "to be decided" : names.get(id) ?? "?");
  const label = m.stage === "group" ? `Group ${m.groupNo}` : `Knockout round ${m.round}`;
  return (
    <li className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
      <span className="w-40 shrink-0 text-xs text-slate-500">
        {m.date} {m.minute !== null && formatMinute(m.minute)} · {m.courtName ?? "—"}
        <br />
        {label}
      </span>
      <span className={`min-w-[10rem] flex-1 ${m.winner === m.a && m.a !== null ? "font-semibold" : ""}`}>{side(m.a)}</span>
      <span className="text-slate-400">v</span>
      <span className={`min-w-[10rem] flex-1 ${m.winner === m.b && m.b !== null ? "font-semibold" : ""}`}>{side(m.b)}</span>
      {known && (
        <>
          <input value={score} onChange={(e) => setScore(e.target.value)} placeholder="21-15, 18-21, 21-10" className={`w-40 ${input}`} />
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
            <span className="text-xs text-emerald-700">✓ {m.status === "walkover" ? "walkover" : m.status === "retired" ? `retired ${m.score ?? ""}` : m.score}</span>
          )}
        </>
      )}
    </li>
  );
}
