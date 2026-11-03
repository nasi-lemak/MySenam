"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import { activityKeys } from "@/lib/activity-registry";
import { sportLabel } from "@/lib/i18n";
import type { ChallengeView, LadderDetail, Ladder, LadderSettings } from "@/lib/ladders";
import { LoadFailed } from "./place";
import type { ManagedVenue } from "./shared";
import { ManagerOnly, useStaffMay } from "./StaffMay";
import { useStaffT } from "./StaffLanguage";
import type { StaffT } from "@/lib/staff-i18n";

const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
const label = "flex flex-col text-xs font-medium text-slate-500";
const small = "rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:border-teal-500";
const primary = "rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700";

type Send = (url: string, body: object, method?: "POST") => Promise<boolean>;

/**
 * A venue's club ladders (lib/ladders.ts; ADR 0033): set one up, see its ranks and challenges, add a player at the counter, decide or correct a
 * challenge's result, move or take somebody off, freeze a place, end a season. Setting up, its settings, seasons, deciding and every
 * override are a manager's, each with a reason that is kept and logged; the desk reads and adds players at the counter.
 */
export function LaddersPanel({ venue }: { venue: ManagedVenue }) {
  const t = useStaffT();
  // Closed until opened, and read only then: a venue with no ladder has nothing to look at here.
  const [opened, setOpened] = useState(false);
  return (
    <details className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" onToggle={(e) => setOpened((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer font-semibold">{t("lds.title")}</summary>
      {opened && <LaddersBody venue={venue} />}
    </details>
  );
}

function LaddersBody({ venue }: { venue: ManagedVenue }) {
  const t = useStaffT();
  const [list, setList] = useState<Ladder[]>([]);
  const [open, setOpen] = useState<LadderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/ladders?venueId=${venue.id}`, { cache: "no-store" });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("q8b.loadFailed")));
      setList(data.ladders);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("q8b.loadFailed"));
    }
  }, [venue.id, t]);
  useEffect(() => {
    void load();
  }, [load]);

  async function show(id: number) {
    setError(null);
    const res = await fetch(`/api/admin/ladders/${id}`, { cache: "no-store" });
    const data = await readJson(res);
    if (!res.ok) return setError(t.err(data, t("q8b.loadFailed")));
    setOpen(data.ladder);
  }

  const send: Send = async (url, body) => {
    setError(null);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await readJson(res);
    if (!res.ok) {
      setError(t.err(data));
      return false;
    }
    if (data.ladder && "rows" in data.ladder) setOpen(data.ladder);
    await load();
    return true;
  };

  return (
    <section className="mt-3 space-y-3">
      <p className="text-sm text-slate-500">{t("lds.intro")}</p>
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {open ? (
        <Manage t={t} l={open} send={send} close={() => setOpen(null)} reload={() => show(open.id)} />
      ) : (
        <>
          {loadError ? (
            <LoadFailed message={loadError} onRetry={() => void load()} />
          ) : list.length === 0 ? (
            <p className="text-sm text-slate-500">{t("lds.none")}</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {list.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <span className="font-medium">{l.name}</span> · {t("lds.playersCount", { n: l.players })} · {t(`lds.audience.${l.audience}`)} ·{" "}
                    <span className="text-slate-500">{t(`lds.status.${l.status}`)}</span>
                  </span>
                  <button onClick={() => void show(l.id)} className="text-sm font-medium text-teal-700 underline">
                    {t("tn.open")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <ManagerOnly may="ladders">
            <Create t={t} venue={venue} send={send} />
          </ManagerOnly>
        </>
      )}
    </section>
  );
}

const NUMBERS: { key: keyof LadderSettings; min: number; max: number }[] = [
  { key: "reach", min: 1, max: 10 },
  { key: "respondDays", min: 1, max: 14 },
  { key: "playDays", min: 3, max: 60 },
  { key: "cooldownDays", min: 0, max: 90 },
  { key: "inactiveDays", min: 0, max: 365 },
  { key: "inactiveDrop", min: 1, max: 10 },
  { key: "freezeMaxDays", min: 1, max: 180 },
];

function Create({ t, venue, send }: { t: StaffT; venue: ManagedVenue; send: Send }) {
  const sports = activityKeys().filter((s) => venue.courts.some((c) => c.sport === s));
  const [f, setF] = useState({
    name: "",
    sport: sports[0] ?? "badminton",
    audience: "adults",
    teamSize: "1",
    description: "",
    reach: "3",
    respondDays: "3",
    playDays: "14",
    cooldownDays: "14",
    inactiveDays: "30",
    inactiveDrop: "1",
    freezeMaxDays: "60",
    declineIs: "free",
  });
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await send("/api/admin/ladders", {
          venueId: venue.id,
          name: f.name,
          sport: f.sport,
          audience: f.audience,
          teamSize: Number(f.teamSize),
          description: f.description,
          settings: { ...Object.fromEntries(NUMBERS.map((n) => [n.key, Number(f[n.key as keyof typeof f])])), declineIs: f.declineIs },
        });
        if (ok) setF({ ...f, name: "", description: "" });
      }}
      className="space-y-3 rounded-xl border border-dashed border-slate-300 p-4"
    >
      <h3 className="font-semibold">{t("lds.setUp")}</h3>
      <div className="flex flex-wrap items-end gap-3">
        <label className={label}>
          {t("lds.name")}
          <input required minLength={3} maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={`w-64 ${input}`} />
        </label>
        <label className={label}>
          {t("lds.sport")}
          <select value={f.sport} onChange={(e) => setF({ ...f, sport: e.target.value })} className={input}>
            {sports.map((s) => (
              <option key={s} value={s}>
                {t.locale === "en" ? s : sportLabel(t.customer, s)}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          {t("lds.audienceLabel")}
          <select value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })} className={input}>
            <option value="adults">{t("lds.audience.adults")}</option>
            <option value="juniors">{t("lds.audience.juniors")}</option>
          </select>
        </label>
        <label className={label}>
          {t("lds.entrants")}
          <select value={f.teamSize} onChange={(e) => setF({ ...f, teamSize: e.target.value })} className={input}>
            <option value="1">{t("tn.kind.singles")}</option>
            <option value="2">{t("tn.kind.doubles")}</option>
          </select>
        </label>
      </div>
      <Settings t={t} values={f} onChange={(v) => setF({ ...f, ...v })} />
      <label className={label}>
        {t("lds.description")}
        <textarea maxLength={2000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className={`${input} h-16`} />
      </label>
      <button className={primary}>{t("lds.create")}</button>
    </form>
  );
}

/** The ladder's published rules, as numbers a manager may change (they apply from now and never rewrite what happened). */
function Settings({ t, values, onChange }: { t: StaffT; values: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  return (
    <fieldset className="text-sm">
      <legend className="text-xs font-medium text-slate-500">{t("lds.settings")}</legend>
      <div className="flex flex-wrap items-end gap-3 pt-1">
        {NUMBERS.map((n) => (
          <label key={n.key} className={label}>
            {t(`lds.set.${n.key}`)}
            <input type="number" min={n.min} max={n.max} value={values[n.key]} onChange={(e) => onChange({ [n.key]: e.target.value })} className={`w-24 ${input}`} />
          </label>
        ))}
        <label className={label}>
          {t("lds.set.declineIs")}
          <select value={values.declineIs} onChange={(e) => onChange({ declineIs: e.target.value })} className={input}>
            <option value="free">{t("lds.set.declineFree")}</option>
            <option value="forfeit">{t("lds.set.declineForfeit")}</option>
          </select>
        </label>
      </div>
    </fieldset>
  );
}

function Manage({ t, l, send, close, reload }: { t: StaffT; l: LadderDetail; send: Send; close: () => void; reload: () => Promise<void> }) {
  const manages = useStaffMay()("ladderRun");
  const base = `/api/admin/ladders/${l.id}`;
  // Every override has a reason, kept and logged: one box for the next change.
  const [reason, setReason] = useState("");
  const [rank, setRank] = useState<Record<number, string>>({});
  const [until, setUntil] = useState<Record<number, string>>({});
  const [settings, setSettings] = useState<Record<string, string>>({ ...Object.fromEntries(NUMBERS.map((n) => [n.key, String(l.settings[n.key])])), declineIs: l.settings.declineIs });
  const [counter, setCounter] = useState({ phone: "", name: "", adult: false, partnerName: "" });
  const current = l.viewing?.endedOn === null;
  const names = new Map(l.rows.map((r) => [r.playerId, r.name]));
  const act = async (body: object) => {
    if (await send(base, body)) setReason("");
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <button onClick={close} className="text-sm text-teal-700 underline">
            {t("tn.back")}
          </button>
          <h3 className="mt-1 text-lg font-bold">
            {l.name} <span className="text-sm font-normal text-slate-500">· {t(`lds.status.${l.status}`)}</span>
          </h3>
          <p className="text-sm text-slate-500">
            {t(`lds.audience.${l.audience}`)} · {t("lds.season", { n: l.season?.number ?? l.viewing?.number ?? 1 })} · {t("lds.playersCount", { n: l.players })} ·{" "}
            <a href={`/ladders/${l.id}`} target="_blank" rel="noopener" className="underline">
              {t("tn.publicPage")}
            </a>
          </p>
        </div>
        <ManagerOnly may="ladderRun">
          {l.status === "open" && (
            <div className="flex flex-wrap gap-2">
              <button onClick={() => window.confirm(t("lds.endSeasonConfirm")) && void act({ action: "end_season" })} className={small}>
                {t("lds.endSeason")}
              </button>
              <button onClick={() => window.confirm(t("lds.closeConfirm")) && void act({ action: "close" })} className={small}>
                {t("lds.close")}
              </button>
              <button onClick={() => void act({ action: "rated", rated: !l.rated })} className={small}>
                {l.rated ? t("lds.unrate") : t("lds.rate")}
              </button>
            </div>
          )}
        </ManagerOnly>
      </div>
      <p className="text-xs text-slate-500">{t("lds.rule", { reach: l.settings.reach, respond: l.settings.respondDays, play: l.settings.playDays, cool: l.settings.cooldownDays })}</p>

      {manages && current && l.status === "open" && (
        <label className="block text-xs font-medium text-slate-600">
          {t("lds.reason")}
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("lds.reasonPlaceholder")} className={`mt-1 w-full ${input}`} />
        </label>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[26rem] text-sm">
          <thead className="text-xs text-slate-500">
            <tr>
              <th className="w-10 text-left font-medium">#</th>
              <th className="text-left font-medium">{t("sw.player")}</th>
              <th className="text-left font-medium">{t("lds.state")}</th>
              {manages && current && l.status === "open" && <th className="text-right font-medium">{t("lds.overrides")}</th>}
            </tr>
          </thead>
          <tbody>
            {l.rows.map((r) => (
              <tr key={r.playerId} className="border-t border-slate-100">
                <td className="py-1">{r.rank}</td>
                <td>
                  {r.name}
                  {r.atCounter && <span className="ml-1 text-xs text-slate-500">({t("lds.atCounter", { by: r.atCounter.by })})</span>}
                </td>
                <td className="text-xs text-slate-500">
                  {r.frozenUntil ? t("lds.frozenUntil", { date: r.frozenUntil }) : r.inChallenge ? t("lds.inChallenge") : t("lds.activeOn", { date: r.activeOn ?? "" })}
                </td>
                {manages && current && l.status === "open" && (
                  <td className="space-x-1 py-1 text-right">
                    <input
                      type="number"
                      min={1}
                      aria-label={t("lds.moveTo", { name: r.name })}
                      value={rank[r.playerId] ?? ""}
                      onChange={(e) => setRank({ ...rank, [r.playerId]: e.target.value })}
                      className="w-14 rounded border border-slate-300 px-1 text-xs"
                    />
                    <button disabled={!rank[r.playerId]} onClick={() => void act({ action: "move", playerId: r.playerId, rank: Number(rank[r.playerId]), reason })} className={small}>
                      {t("lds.move")}
                    </button>
                    {r.frozenUntil ? (
                      <button onClick={() => void act({ action: "thaw", playerId: r.playerId })} className={small}>
                        {t("lds.thaw")}
                      </button>
                    ) : (
                      <>
                        <input
                          type="date"
                          aria-label={t("lds.freezeUntil", { name: r.name })}
                          value={until[r.playerId] ?? ""}
                          onChange={(e) => setUntil({ ...until, [r.playerId]: e.target.value })}
                          className="rounded border border-slate-300 px-1 text-xs"
                        />
                        <button disabled={!until[r.playerId]} onClick={() => void act({ action: "freeze", playerId: r.playerId, until: until[r.playerId] })} className={small}>
                          {t("lds.freeze")}
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => window.confirm(t("lds.removeConfirm", { name: r.name })) && void act({ action: "remove", playerId: r.playerId, reason })}
                      className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-700"
                    >
                      {t("lds.remove")}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {current && l.status === "open" && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (await send(`${base}/players`, { phone: counter.phone, name: counter.name, adult: counter.adult, partnerName: counter.partnerName || undefined }))
              setCounter({ phone: "", name: "", adult: false, partnerName: "" });
          }}
          className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 p-3"
        >
          <span className="w-full text-sm font-medium">{t("lds.addAtCounter")}</span>
          <label className={label}>
            {t("lds.counterName")}
            <input required value={counter.name} onChange={(e) => setCounter({ ...counter, name: e.target.value })} className={input} />
          </label>
          <label className={label}>
            {t("lds.counterPhone")}
            <input required value={counter.phone} onChange={(e) => setCounter({ ...counter, phone: e.target.value })} className={input} />
          </label>
          {l.teamSize === 2 && (
            <label className={label}>
              {t("lds.counterPartner")}
              <input required value={counter.partnerName} onChange={(e) => setCounter({ ...counter, partnerName: e.target.value })} className={input} />
            </label>
          )}
          {l.audience === "adults" && (
            <label className="flex items-center gap-1.5 text-sm text-slate-600">
              <input type="checkbox" checked={counter.adult} onChange={(e) => setCounter({ ...counter, adult: e.target.checked })} />
              {t("lds.counterAdult")}
            </label>
          )}
          <button className={small}>{t("lds.add")}</button>
        </form>
      )}

      {manages && current && l.status === "open" && (
        <details className="rounded-lg border border-slate-200 p-3">
          <summary className="cursor-pointer text-sm font-medium">{t("lds.settings")}</summary>
          <div className="mt-2 space-y-2">
            <Settings t={t} values={settings} onChange={(v) => setSettings({ ...settings, ...v })} />
            <button
              onClick={() => void act({ action: "settings", settings: { ...Object.fromEntries(NUMBERS.map((n) => [n.key, Number(settings[n.key])])), declineIs: settings.declineIs } })}
              className={small}
            >
              {t("lds.saveSettings")}
            </button>
          </div>
        </details>
      )}

      <section>
        <h4 className="font-semibold">{t("lds.challenges")}</h4>
        {l.challenges.length === 0 ? (
          <p className="text-sm text-slate-500">{t("lds.noChallenges")}</p>
        ) : (
          <ul className="mt-1 divide-y divide-slate-100 text-sm">
            {l.challenges.map((c) => (
              <Challenge key={c.id} t={t} c={c} names={names} editable={manages && current && l.status === "open"} reason={reason} act={act} reload={reload} />
            ))}
          </ul>
        )}
      </section>

      {l.events && (
        <details className="rounded-lg border border-slate-200 p-3">
          <summary className="cursor-pointer text-sm font-medium">{t("lds.ledger")}</summary>
          <p className="mt-1 text-xs text-slate-500">{t("lds.ledgerNote")}</p>
          <ul className="mt-2 space-y-0.5 text-xs">
            {l.events.map((e) => (
              <li key={e.id} className={e.voided ? "text-slate-400 line-through" : ""}>
                {e.ord}. {e.on} · {t(`lds.ev.${e.kind}`)} {names.get(e.playerId) ?? `#${e.playerId}`}
                {e.otherId !== null && ` ${t("tn.versus")} ${names.get(e.otherId) ?? `#${e.otherId}`}`}
                {e.kind === "result" && ` (${e.data.challengerWon ? t("lds.ev.challengerWon") : t("lds.ev.challengedWon")}${e.data.forfeit ? `, ${t("lds.ev.forfeit")}` : ""})`}
                {e.kind === "drop" && ` (${e.data.places ?? 1})`}
                {e.kind === "move" && ` → ${e.data.toRank}`}
                {e.kind === "freeze" && ` → ${e.data.until}`}
                {e.data.reason && ` · ${e.data.reason}`}
                {e.voided && e.voidedReason && ` · ${t("lds.ev.voided", { why: e.voidedReason })}`}
              </li>
            ))}
          </ul>
        </details>
      )}

      {l.seasons.length > 1 && (
        <p className="text-xs text-slate-500">
          {t("lds.archive")}:{" "}
          {l.seasons
            .filter((s) => s.endedOn !== null)
            .map((s) => `${t("lds.season", { n: s.number })} (${s.endedOn})`)
            .join(", ")}
        </p>
      )}
    </div>
  );
}

/** One challenge, and for a manager the decision on its result. */
function Challenge({ t, c, names, editable, reason, act, reload }: { t: StaffT; c: ChallengeView; names: Map<number, string>; editable: boolean; reason: string; act: (body: object) => Promise<void>; reload: () => Promise<void> }) {
  const [winner, setWinner] = useState(String(c.challenger));
  const [score, setScore] = useState(c.score ?? "");
  const [walkover, setWalkover] = useState(false);
  const decide = (extra: object) => act({ action: "decide", challengeId: c.id, reason, ...extra }).then(reload);
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-center gap-x-2">
        <span className="font-medium">
          {c.challengerName || names.get(c.challenger)} {t("tn.versus")} {c.challengedName || names.get(c.challenged)}
        </span>
        <span className="text-xs text-slate-500">
          ({t("lds.ranks", { a: c.challengerRank, b: c.challengedRank })}) · {t(`lds.cs.${c.status}`)}
          {c.status === "walkover" ? ` ${t("lds.cs.forfeitTo", { name: names.get(c.winner ?? 0) ?? "" })}` : c.score ? ` ${c.score}` : ""}
        </span>
        {c.disputeNote && <span className="text-xs text-amber-800">{t("lds.disputeNote", { note: c.disputeNote })}</span>}
      </div>
      {editable && c.status !== "declined" && c.status !== "cancelled" && c.status !== "lapsed" && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-teal-700">{t("lds.decide")}</summary>
          <div className="mt-1 flex flex-wrap items-end gap-2">
            <label className={label}>
              {t("lds.winner")}
              <select value={winner} onChange={(e) => setWinner(e.target.value)} className={input}>
                <option value={c.challenger}>{c.challengerName}</option>
                <option value={c.challenged}>{c.challengedName}</option>
              </select>
            </label>
            <label className={label}>
              {t("q8b.l.score")}
              <input value={score} onChange={(e) => setScore(e.target.value)} placeholder="21-15, 18-21, 21-10" className={`w-44 ${input}`} />
            </label>
            <label className="flex items-center gap-1 text-xs text-slate-600">
              <input type="checkbox" checked={walkover} onChange={(e) => setWalkover(e.target.checked)} />
              {t("tn.st.walkover")}
            </label>
            <button disabled={reason.trim().length < 3} onClick={() => void decide({ winner: Number(winner), score: walkover ? undefined : score, walkover })} className={small}>
              {t("lds.decideSave")}
            </button>
            <button disabled={reason.trim().length < 3} onClick={() => void decide({ void: true })} className={small}>
              {t("lds.strike")}
            </button>
            <button disabled={reason.trim().length < 3} onClick={() => void decide({ clear: true })} className={small}>
              {t("lds.putBack")}
            </button>
          </div>
        </details>
      )}
    </li>
  );
}
