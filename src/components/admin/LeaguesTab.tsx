"use client";

import { readJson } from "@/lib/read-response";
import { activityKeys } from "@/lib/activity-registry";
import { useCallback, useEffect, useState } from "react";
import { todayLocal } from "./shared";
import type { ManagedVenue } from "./shared";
import { addDays } from "@/lib/time";
import { type Sport } from "@/lib/types";
import type { League, LeagueDetail, LeagueMatch, MatchStatus, SeasonStatus } from "@/lib/leagues";
import type { CompetitionTemplate } from "@/lib/competition-templates";
import { money, currencySymbol } from "@/lib/region";
import type { StaffT } from "@/lib/staff-i18n";
import { useStaffT } from "./StaffLanguage";
import { CounterEntry } from "./CounterEntry";
import { LoadFailed } from "./place";
import { sportLabel } from "@/lib/i18n";
import { levelLabel } from "./TournamentsTab";
import { PayMark } from "./CounterMethod";

const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
const LEVELS = ["", "beginner", "intermediate", "advanced", "competitive"];

/** A phrase with one value in bold, wherever the language puts it. */
function withStrong(t: StaffT, phrase: Parameters<StaffT>[0], vars: Record<string, string | number>, bold: string, value: string) {
  const [before, after = ""] = t(phrase, { ...vars, [bold]: "\u0000" }).split("\u0000");
  return (
    <>
      {before}
      <strong>{value}</strong>
      {after}
    </>
  );
}

const seasonStatus = (t: StaffT, status: SeasonStatus): string =>
  ({ forming: t("lg.status.forming"), running: t("lg.status.running"), finished: t("lg.status.finished") })[status] ?? status;

const matchStatus = (t: StaffT, status: MatchStatus): string =>
  ({
    unplayed: t("lg.match.unplayed"),
    reported: t("lg.match.reported"),
    confirmed: t("lg.match.confirmed"),
    disputed: t("lg.match.disputed"),
    walkover: t("lg.match.walkover"),
    void: t("lg.match.void"),
  })[status] ?? status;

/**
 * A venue's box leagues: set one up; see who has joined and place
 * newcomers; start and end seasons (they also do so by themselves on their
 * dates); settle disputed results, and put any result right.
 */
export function LeaguesTab({ venues }: { venues: ManagedVenue[] }) {
  const t = useStaffT();
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [list, setList] = useState<League[]>([]);
  const [templates, setTemplates] = useState<CompetitionTemplate[]>([]);
  const [open, setOpen] = useState<LeagueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The list could not be read: said so, with Try again, never "None yet" (audit R8 X2-7).
  const [loadError, setLoadError] = useState<string | null>(null);
  const venue = venues.find((v) => v.id === venueId);

  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      const res = await fetch(`/api/admin/leagues?venueId=${venueId}`, { cache: "no-store" });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("q8b.loadFailed")));
      setList(data.leagues);
      setTemplates(data.templates ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("q8b.loadFailed"));
    }
  }, [venueId, t]);
  useEffect(() => {
    void load();
  }, [load]);

  async function show(id: number, season?: number) {
    setError(null);
    try {
      const res = await fetch(`/api/admin/leagues/${id}${season ? `?season=${season}` : ""}`, { cache: "no-store" });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("q8b.loadFailed")));
      setOpen(data.league);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("q8b.loadFailed"));
    }
  }

  async function post(url: string, body: object): Promise<boolean> {
    setError(null);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await readJson(res);
    if (!res.ok) {
      setError(t.err(data));
      return false;
    }
    if (data.league && "boxes" in data.league) setOpen(data.league);
    await load();
    return true;
  }

  if (!venue) return <p className="text-sm text-slate-500">{t("tn.noVenue")}</p>;
  return (
    <div className="space-y-4">
      {venues.length > 1 && (
        <select aria-label={t("q8b.l.venue")}
          value={venueId}
          onChange={(e) => {
            setVenueId(Number(e.target.value));
            setOpen(null);
          }}
          className={input}
        >
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      )}
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {open ? (
        <Manage l={open} post={post} show={(season) => void show(open.id, season)} close={() => setOpen(null)} />
      ) : (
        <>
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="font-semibold">{t("lg.title")}</h2>
            {loadError ? (
              <LoadFailed message={loadError} onRetry={() => void load()} />
            ) : list.length === 0 ? (
              <p className="mt-1 text-sm text-slate-500">{t("tn.noneYet")}</p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-100 text-sm">
                {list.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <span className="font-medium">{l.name}</span> · {t("lg.playerCount", { n: l.players })} ·{" "}
                      <span className="text-slate-500">
                        {l.status === "closed"
                          ? t("lg.stopped")
                          : l.current
                            ? l.current.status === "forming"
                              ? t("lg.seasonStarts", { n: l.current.number, date: l.current.startsOn })
                              : t("lg.seasonEnds", { n: l.current.number, date: l.current.endsOn })
                            : ""}
                      </span>
                    </span>
                    <button onClick={() => void show(l.id)} className="text-sm font-medium text-teal-700 underline">
                      {t("tn.open")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <Create venue={venue} post={post} templates={templates} />
        </>
      )}
    </div>
  );
}

function Create({ venue, post, templates }: { venue: ManagedVenue; post: (url: string, body: object) => Promise<boolean>; templates: CompetitionTemplate[] }) {
  const t = useStaffT();
  const sports = activityKeys().filter((s) => venue.courts.some((c) => c.sport === s));
  /** A sport's own template, as a new league starts from (the server picks the same when none is sent). */
  const ownTemplate = (sport: string) => templates.find((x) => x.sports.includes(sport))?.key ?? "";
  const [f, setF] = useState({
    name: "",
    sport: (sports[0] ?? "badminton") as Sport,
    teamSize: 1,
    who: "anyone",
    level: "",
    boxSize: "4",
    moves: "1",
    seasonDays: "28",
    fee: "30",
    startsOn: addDays(todayLocal(), 14),
    description: "",
    // "": the sport's own template.
    template: "",
  });
  const chosen = templates.find((x) => x.key === (f.template || ownTemplate(f.sport)));
  const label = "flex flex-col text-xs font-medium text-slate-500";

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await post("/api/admin/leagues", {
          ...f,
          venueId: venue.id,
          boxSize: Number(f.boxSize),
          moves: Number(f.moves),
          seasonDays: Number(f.seasonDays),
          fee: Number(f.fee),
        });
        if (ok) setF({ ...f, name: "", description: "" });
      }}
      className="space-y-3 rounded-xl border border-dashed border-slate-300 bg-white p-4"
    >
      <h2 className="font-semibold">{t("lg.setUp")}</h2>
      <p className="text-sm text-slate-500">{t("lg.setUpIntro")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className={label}>
          {t("c.name")}
          <input required minLength={3} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={`w-64 ${input}`} placeholder={t("lg.namePlaceholder")} />
        </label>
        <label className={label}>
          {t("tn.sport")}
          <select value={f.sport} onChange={(e) => setF({ ...f, sport: e.target.value as Sport })} className={input}>
            {sports.map((s) => (
              <option key={s} value={s}>
                {t.locale === "en" ? s : sportLabel(t.customer, s)}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          {t("lg.play")}
          <select value={f.teamSize} onChange={(e) => setF({ ...f, teamSize: Number(e.target.value) })} className={input}>
            <option value={1}>{t("lg.singles")}</option>
            <option value={2}>{t("lg.doublesPairs")}</option>
          </select>
        </label>
        <label className={label}>
          {t("lg.whoCanPlay")}
          <select value={f.who} onChange={(e) => setF({ ...f, who: e.target.value })} className={input}>
            <option value="anyone">{t("lg.anyone")}</option>
            <option value="women">{t("lg.womenOnly")}</option>
            <option value="men">{t("lg.menOnly")}</option>
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
          {t("lg.boxSize")}
          <input type="number" min={3} max={6} value={f.boxSize} onChange={(e) => setF({ ...f, boxSize: e.target.value })} className={`w-16 ${input}`} />
        </label>
        <label className={label}>
          {t("lg.upDown")}
          <select value={f.moves} onChange={(e) => setF({ ...f, moves: e.target.value })} className={input}>
            <option value="1">{t("lg.eachWay", { n: 1 })}</option>
            <option value="2">{t("lg.eachWay", { n: 2 })}</option>
          </select>
        </label>
        <label className={label}>
          {t("lg.seasonDays")}
          <input type="number" min={14} max={62} value={f.seasonDays} onChange={(e) => setF({ ...f, seasonDays: e.target.value })} className={`w-20 ${input}`} />
        </label>
        <label className={label}>
          {t("lg.fee", { cur: currencySymbol() })}
          <input type="number" min={0} step={0.01} value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} className={`w-24 ${input}`} />
        </label>
        {templates.length > 0 && (
          <label className={label}>
            {t("lg.scoredAs")}
            <select value={f.template || ownTemplate(f.sport)} onChange={(e) => setF({ ...f, template: e.target.value })} className={`w-72 ${input}`}>
              {templates.map((x) => (
                <option key={x.key} value={x.key}>
                  {t.known(`srv.tpl.${x.key}`) ?? x.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={label}>
          {t("lg.firstSeason")}
          <input type="date" required value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} className={input} />
        </label>
      </div>
      {chosen && <p className="text-xs text-slate-500">{t.known(`srv.tpl.${chosen.key}.note`) ?? chosen.note} {t("lg.templateCaveat")}</p>}
      <label className={label}>
        {t("lg.about")}
        <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} rows={2} className={input} />
      </label>
      <button className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">{t("lg.setUpButton")}</button>
    </form>
  );
}

function Manage({
  l,
  post,
  show,
  close,
}: {
  l: LeagueDetail;
  post: (url: string, body: object) => Promise<boolean>;
  show: (season?: number) => void;
  close: () => void;
}) {
  const t = useStaffT();
  const names = new Map(l.people.map((p) => [p.id, p.name]));
  const base = `/api/admin/leagues/${l.id}`;
  const current = l.current;
  const [startsOn, setStartsOn] = useState(current?.startsOn ?? "");
  const disputed = l.viewing?.status === "running" ? l.matches.filter((m) => m.status === "disputed") : [];
  const waiting = l.viewing?.status === "running" ? l.matches.filter((m) => m.status === "reported").length : 0;
  const lastBox = Math.max(0, ...l.places.map((p) => p.boxNo));
  const editable = l.viewing?.status === "running";

  return (
    <div className="space-y-4">
      <button onClick={close} className="text-sm text-teal-700 underline">
        {t("lg.back")}
      </button>
      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">{l.name}</h2>
            <p className="text-sm text-slate-500">
              {t.locale === "en" ? l.sport : sportLabel(t.customer, l.sport)} · {l.teamSize === 2 ? t("lg.doublesPairsLower") : t("lg.singlesLower")}
              {l.who !== "anyone" && ` · ${l.who === "women" ? t("lg.who.women") : l.who === "men" ? t("lg.who.men") : l.who}`} · {t("lg.boxesOf", { n: l.boxSize })} ·{" "}
              {t("lg.upAndDown", { n: l.moves })} · {t("lg.seasonLength", { n: l.seasonDays })} ·{" "}
              {l.fee > 0 ? t("lg.feeASeason", { fee: money(l.fee) }) : t("lg.noFee")} · {t("lg.playerCount", { n: l.players })}
              {l.status === "closed" && ` · ${t("lg.stopped")}`}
            </p>
          </div>
          <a href={`/leagues/${l.id}`} target="_blank" rel="noreferrer" className="text-sm text-teal-700 underline">
            {t("lg.publicPage")}
          </a>
        </div>

        {current?.status === "forming" && (
          <div className="flex flex-wrap items-end gap-3 rounded-lg bg-slate-50 p-3 text-sm">
            <span className="flex-1">{withStrong(t, "lg.formingNote", { n: current.number, players: l.players }, "date", current.startsOn)}</span>
            <input aria-label={t("q8b.l.startsOn")} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} className={input} />
            <button onClick={() => void post(base, { action: "plan", startsOn })} className="rounded-md border border-slate-300 px-3 py-1.5">
              {t("lg.moveStart")}
            </button>
            <button
              onClick={() => {
                if (window.confirm(t("lg.startConfirm"))) void post(base, { action: "start" });
              }}
              className="rounded-md bg-teal-600 px-3 py-1.5 font-semibold text-white hover:bg-teal-700"
            >
              {t("lg.startNow")}
            </button>
          </div>
        )}
        {current?.status === "running" && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-slate-50 p-3 text-sm">
            <span className="flex-1">{withStrong(t, "lg.runningNote", { n: current.number, from: current.startsOn }, "to", current.endsOn)}</span>
            <button
              onClick={() => {
                const note = [
                  waiting > 0 ? t.plural("lg.waitingStand", waiting) : "",
                  disputed.length > 0 ? t.plural("lg.disputedVoid", disputed.length) : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                if (window.confirm(t("lg.endConfirm", { n: current.number, note }))) void post(base, { action: "end" });
              }}
              className="rounded-md border border-slate-300 px-3 py-1.5"
            >
              {t("lg.endNow")}
            </button>
          </div>
        )}
        {l.status === "running" && current?.status !== "running" && (
          <button
            onClick={() => {
              if (window.confirm(t("lg.stopConfirm"))) void post(base, { action: "close" });
            }}
            className="text-sm text-red-700 underline"
          >
            {t("lg.stop")}
          </button>
        )}
      </section>

      {disputed.length > 0 && (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 shadow-sm">
          <h3 className="font-semibold text-amber-900">{t("lg.disputed")}</h3>
          <ul className="mt-2 divide-y divide-amber-200 text-sm">
            {disputed.map((m) => (
              <li key={m.id} className="py-2">
                <div>
                  {t(m.reportedBy ? "lg.disputedLineBy" : "lg.disputedLine", {
                    box: m.boxNo,
                    a: names.get(m.a) ?? "",
                    b: names.get(m.b) ?? "",
                    score: m.score ?? "",
                    winner: names.get(m.winner ?? 0) ?? "",
                    by: m.reportedBy ? (names.get(m.reportedBy) ?? "") : "",
                  })}
                </div>
                <div className="text-amber-900">“{m.disputeNote}”</div>
                <Decide m={m} names={names} post={(body) => post(`${base}/matches/${m.id}`, body)} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {l.seasons.filter((s) => s.status !== "forming").length > 1 && (
        <nav className="flex flex-wrap gap-2">
          {l.seasons
            .filter((s) => s.status !== "forming")
            .map((s) => (
              <button
                key={s.id}
                onClick={() => show(s.number)}
                className={`rounded-full px-3 py-1 text-sm ${l.viewing?.id === s.id ? "bg-teal-600 text-white" : "bg-white ring-1 ring-slate-200"}`}
              >
                {t("lg.season", { n: s.number })}
              </button>
            ))}
        </nav>
      )}

      {l.boxes.length > 0 && l.viewing && (
        <section className="space-y-3">
          <h3 className="font-semibold">
            {t("lg.season", { n: l.viewing.number })} <span className="text-sm font-normal text-slate-500">({seasonStatus(t, l.viewing.status)})</span>
          </h3>
          <div className="grid gap-3 lg:grid-cols-2">
            {l.boxes.map((box) => (
              <div key={box.boxNo} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <h4 className="font-semibold">{t("lg.box", { n: box.boxNo })}</h4>
                <ul className="mt-1 text-sm">
                  {box.table.map((s, i) => {
                    const place = l.places.find((p) => p.playerId === s.entryId)!;
                    return (
                      <li key={s.entryId} className="flex flex-wrap items-center gap-x-3 py-0.5">
                        <span className={`flex-1 ${place.withdrawn ? "text-slate-400 line-through" : ""}`}>
                          {i + 1}. {names.get(s.entryId)} <span className="text-slate-500">({s.won}–{s.lost})</span>
                          {place.move && place.move !== "stay" && <span className="ml-1 text-xs">{place.move === "up" ? t("lg.up") : t("lg.down")}</span>}
                        </span>
                        {l.fee > 0 && (
                          // Marked paid at the counter says how (X1-2).
                          <PayMark
                            paid={place.paid}
                            paidLabel={`✓ ${t("lg.paid")}`}
                            unpaidLabel={t("p8b.lg.markPaid")}
                            onPaid={(via) => void post(`${base}/places/${place.id}`, { paid: true, via })}
                            onUnpaid={() => void post(`${base}/places/${place.id}`, { paid: false })}
                            className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-600"
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
                <ul className="mt-2 divide-y divide-slate-100 text-sm">
                  {l.matches
                    .filter((m) => m.boxNo === box.boxNo)
                    .map((m) => (
                      <li key={m.id} className="py-1.5">
                        <div className="flex flex-wrap gap-x-3">
                          <span className="flex-1">
                            <span className={m.winner === m.a ? "font-semibold" : ""}>{names.get(m.a)}</span> {t("tn.versus")}{" "}
                            <span className={m.winner === m.b ? "font-semibold" : ""}>{names.get(m.b)}</span>
                          </span>
                          <span className="text-slate-600">{m.score}</span>
                          <span className="text-xs text-slate-400">{m.status === "confirmed" ? "" : matchStatus(t, m.status)}</span>
                        </div>
                        {editable && <Decide m={m} names={names} post={(body) => post(`${base}/matches/${m.id}`, body)} compact />}
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
          {lastBox > 0 && <p className="text-xs text-slate-500">{t("lg.scoresNote")}</p>}
        </section>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="font-semibold">{t("lg.playersTitle")}</h3>
        <p className="mt-1 text-sm text-slate-500">{t("lg.playersNote")}</p>
        <ul className="mt-2 divide-y divide-slate-100 text-sm">
          {l.people
            .filter((p) => p.status === "active")
            .map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 py-1.5">
                <span className="flex-1">
                  {p.name}
                  {p.level && <span className="text-slate-500"> · {levelLabel(t, p.level)}</span>}
                  {p.atCounter && <span className="block text-xs text-slate-500">{t("lg5.atCounter", { by: p.atCounter.by })}</span>}
                  {!p.atCounter && p.participantId && <span className="block text-xs text-slate-500">{t("lg5.forParticipant")}</span>}
                </span>
                <label className="flex items-center gap-1 text-xs text-slate-500">
                  {t("lg.startInBox")}
                  <input
                    type="number"
                    min={1}
                    defaultValue={p.startBox ?? ""}
                    onBlur={(e) => {
                      const v = e.target.value === "" ? null : Number(e.target.value);
                      if (v !== (p.startBox ?? null)) void post(`${base}/players/${p.id}`, { startBox: v });
                    }}
                    className={`w-16 ${input}`}
                  />
                </label>
                <button
                  onClick={() => {
                    if (window.confirm(t("lg.removeConfirm", { name: p.name })))
                      void post(`${base}/players/${p.id}`, { remove: true });
                  }}
                  className="text-xs text-red-700 underline"
                >
                  {t("c.remove")}
                </button>
              </li>
            ))}
        </ul>
        {l.status === "running" && (
          <CounterEntry
            venueId={l.venueId}
            kind="league"
            teamSize={l.teamSize}
            category={l.who === "anyone" ? "open" : l.who}
            submit={(body) => post(`${base}/players`, body)}
          />
        )}
      </section>
    </div>
  );
}

/** Staff putting a result right: a score, a walkover, struck off, or back to be played. */
function Decide({
  m,
  names,
  post,
  compact = false,
}: {
  m: LeagueMatch;
  names: Map<number, string>;
  post: (body: object) => Promise<boolean>;
  compact?: boolean;
}) {
  const t = useStaffT();
  const [editing, setEditing] = useState(!compact);
  const [winner, setWinner] = useState(m.winner ?? m.a);
  const [score, setScore] = useState(m.score ?? "");
  if (!editing)
    return (
      <button onClick={() => setEditing(true)} className="text-xs text-teal-700 underline">
        {t("c.change")}
      </button>
    );
  const small = "rounded-md border border-slate-300 px-2 py-1 text-xs";
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <select aria-label={t("q8b.l.winner")} value={winner} onChange={(e) => setWinner(Number(e.target.value))} className={small}>
        <option value={m.a}>{t("tn.nameWon", { name: names.get(m.a) ?? "" })}</option>
        <option value={m.b}>{t("tn.nameWon", { name: names.get(m.b) ?? "" })}</option>
      </select>
      <input aria-label={t("q8b.l.score")} value={score} onChange={(e) => setScore(e.target.value)} placeholder="21-15, 21-18" className={`w-32 ${small}`} />
      {/* Each decision is on the result as shown here (its version): one a player changed since is refused, to look at again. */}
      <button onClick={() => void post({ winner, score, version: m.version })} className="rounded-md bg-teal-600 px-2 py-1 text-xs font-semibold text-white">
        {t("c.save")}
      </button>
      <button onClick={() => void post({ winner, walkover: true, version: m.version })} className={small}>
        {t("lg.walkover")}
      </button>
      <button onClick={() => void post({ void: true, version: m.version })} className={small}>
        {t("lg.dontCount")}
      </button>
      {m.status !== "unplayed" && (
        <button onClick={() => void post({ clear: true, version: m.version })} className={small}>
          {t("lg.toBePlayed")}
        </button>
      )}
      {compact && (
        <button onClick={() => setEditing(false)} className="text-xs text-slate-500 underline">
          {t("c.cancel")}
        </button>
      )}
    </div>
  );
}
