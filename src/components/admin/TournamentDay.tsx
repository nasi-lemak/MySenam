"use client";

import { useCallback, useEffect, useState } from "react";
import { readJson } from "@/lib/read-response";
import { formatMinute } from "@/lib/interval";
import type { StaffT } from "@/lib/staff-i18n";
import type { TournamentDetail } from "@/lib/tournaments";
import type { Blocker, DayBoard, DayFixture } from "@/lib/tournament-day";
import { useStaffT } from "./StaffLanguage";
import { useStaffMay } from "./StaffMay";

/**
 * The organiser's *Now and next* board for a tournament that is drawn
 * (lib/tournament-day.ts): what is on each court, what is next, who is
 * waiting and why not yet, the wait for a called fixture and what to do when
 * nobody comes, and the day's settings. Refreshes itself. A manager calls and
 * decides; front desk reads it (`tournamentDay`, lib/roles.ts), as it checks
 * players in and enters results below.
 */
export function TournamentDay({ tn }: { tn: TournamentDetail }) {
  const t = useStaffT();
  const may = useStaffMay()("tournamentDay");
  const base = `/api/admin/tournaments/${tn.id}/day`;
  const [board, setBoard] = useState<DayBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [outToo, setOutToo] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(base, { cache: "no-store" });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("dy1.loadFailed")));
      setBoard(data.board);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("dy1.loadFailed"));
    }
  }, [base, t]);
  useEffect(() => {
    void load();
    // The board is for the day: it keeps itself up to date.
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load, tn.matches]);

  async function act(body: object): Promise<boolean> {
    setError(null);
    setNote(null);
    const res = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await readJson(res).catch(() => ({}));
    if (!res.ok) {
      setError(t.err(data));
      return false;
    }
    setBoard(data.board);
    if (typeof data.moved === "string") setNote(data.moved);
    else if (typeof data.detail === "string") setNote(data.detail);
    return true;
  }

  if (tn.format === "performance") return null;
  if (!board) return error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null;

  const time = (f: DayFixture) => (f.minute === null ? "" : `${f.date !== board.today && f.date ? `${f.date} ` : ""}${formatMinute(f.minute, t.locale)}`);
  const sides = (f: DayFixture) => `${f.a.name ?? t("tn.tbd")} ${t("tn.versus")} ${f.b.name ?? t("tn.tbd")}`;
  const blockerText = (b: Blocker) =>
    b.code === "notHere"
      ? t("dy1.b.notHere", { name: b.name })
      : b.code === "resting"
        ? t("dy1.b.resting", { name: b.name, until: b.until ? clockOf(b.until, board, t) : "" })
        : b.code === "busy"
          ? t("dy1.b.busy", { name: b.name })
          : t("dy1.b.left", { name: b.name });
  const button = "rounded-md border border-slate-300 px-2 py-1 text-xs font-medium hover:bg-slate-50";
  const anyNotHere = board.waiting.some((w) => w.blockers.some((b) => b.code === "notHere"));

  const called = (f: DayFixture) => {
    return (
      <div className="space-y-2">
        <div className="font-medium">
          {f.label}: {sides(f)}
        </div>
        <div className="text-xs text-slate-600">
          <span className={`rounded px-1.5 py-0.5 font-semibold ${f.state === "playing" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
            {f.state === "playing" ? t("dy1.state.playing") : t("dy1.state.called")}
          </span>{" "}
          {f.state === "called" && (f.overdue ? t("dy1.timerOver") : t("dy1.timerLeft", { n: f.minutesLeft }))}
        </div>
        {may && (
          <div className="flex flex-wrap items-center gap-2">
            {f.state === "called" && (
              <button type="button" className={button} onClick={() => void act({ action: "start", matchId: f.id })}>
                {t("dy1.start")}
              </button>
            )}
            <button type="button" className={button} onClick={() => void act({ action: "release", matchId: f.id })}>
              {t("dy1.release")}
            </button>
          </div>
        )}
        {may && f.state === "called" && f.overdue && (
          <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-2">
            <div className="flex flex-wrap gap-2">
              <button type="button" className={button} onClick={() => void act({ action: "decide", matchId: f.id, decision: { action: "wait" } })}>
                {t("dy1.wait", { n: board.settings.callWaitMinutes })}
              </button>
              <button type="button" className={button} onClick={() => void act({ action: "decide", matchId: f.id, decision: { action: "swap" } })}>
                {t("dy1.swap")}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {[f.a, f.b].map((side, i) => {
                const other = i === 0 ? f.b : f.a;
                return (
                  <button
                    key={i}
                    type="button"
                    className={`${button} border-red-200 text-red-700`}
                    onClick={() => {
                      const confirmText = `${t("dy1.forfeitConfirm", { match: `${f.label}: ${sides(f)}`, winner: other.name ?? "", absent: side.name ?? "" })}${outToo ? ` ${t("dy1.forfeitOutConfirm", { absent: side.name ?? "" })}` : ""}`;
                      if (side.id !== null && window.confirm(confirmText)) void act({ action: "decide", matchId: f.id, decision: { action: "forfeit", absent: side.id, outOfEvent: outToo } });
                    }}
                  >
                    {t("dy1.forfeitFor", { name: side.name ?? "" })}
                  </button>
                );
              })}
            </div>
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              <input type="checkbox" checked={outToo} onChange={(e) => setOutToo(e.target.checked)} />
              {t("dy1.forfeitOut")}
            </label>
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm" aria-labelledby={`day-${tn.id}`}>
      <div>
        <h3 id={`day-${tn.id}`} className="font-semibold">
          {t("dy1.title")}
        </h3>
        <p className="mt-1 text-xs text-slate-500">{t("dy1.intro")}</p>
        {!may && <p className="mt-1 text-xs text-slate-500">{t("dy1.managerNote")}</p>}
        {may && anyNotHere && <p className="mt-1 text-xs text-slate-500">{t("dy1.checkInFirst")}</p>}
      </div>
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700">
          {error}
        </div>
      )}
      {note && <div className="rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-teal-900">{note}</div>}

      <div className="grid gap-3 sm:grid-cols-2">
        {board.courts.map((c) => (
          <div key={c.id} className="space-y-2 rounded-lg border border-slate-200 p-3">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold">{c.name}</h4>
              {c.free && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{t("dy1.free")}</span>}
            </div>
            {c.now ? (
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{t("dy1.onCourt")}</div>
                {called(c.now)}
              </div>
            ) : (
              <div className="text-xs text-slate-500">{t("dy1.free")}</div>
            )}
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{t("dy1.nextUp")}</div>
              {c.next ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span>
                    {c.next.label}: {sides(c.next)} · {time(c.next)}
                  </span>
                  {may && c.free && c.next.ready && (
                    <button type="button" className={button} onClick={() => void act({ action: "call", matchId: c.next!.id })}>
                      {t("dy1.call")}
                    </button>
                  )}
                </div>
              ) : (
                <span className="text-slate-500">{t("dy1.nothingNext")}</span>
              )}
            </div>
            {c.free &&
              (() => {
                const f = board.waiting.find((w) => w.id === c.proposal);
                return f ? (
                  <div className="flex flex-wrap items-center gap-2 rounded bg-teal-50 px-2 py-1 text-xs text-teal-900">
                    <span>{t("dy1.proposal", { court: c.name, match: f.label, sides: sides(f) })}</span>
                    {may && (
                      <button type="button" className={button} onClick={() => void act({ action: "call", matchId: f.id, courtId: c.id })}>
                        {t("dy1.callSuggested")}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-slate-500">{t("dy1.noReady", { court: c.name })}</div>
                );
              })()}
          </div>
        ))}
      </div>

      <div>
        <h4 className="font-semibold">{t("dy1.waitingTitle")}</h4>
        {board.waiting.length === 0 ? (
          <p className="mt-1 text-xs text-slate-500">{t("dy1.noneWaiting")}</p>
        ) : (
          <ul className="mt-1 space-y-2">
            {board.waiting.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
                <span className="min-w-[12rem] flex-1">
                  {f.label}: {sides(f)}
                  <span className="block text-xs text-slate-500">
                    {time(f)} · {f.courtName ?? "—"}
                  </span>
                  {f.blockers.length > 0 && <span className="block text-xs text-amber-800">{f.blockers.map(blockerText).join("; ")}</span>}
                </span>
                {f.ready && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-semibold text-emerald-800">{t("dy1.ready")}</span>}
                {may && f.ready && (
                  <>
                    <button type="button" className={button} onClick={() => void act({ action: "call", matchId: f.id })}>
                      {t("dy1.call")}
                    </button>
                    <select
                      aria-label={`${t("dy1.callTo", { court: "…" })} (${f.label})`}
                      value=""
                      onChange={(e) => e.target.value && void act({ action: "call", matchId: f.id, courtId: Number(e.target.value) })}
                      className="rounded-md border border-slate-300 px-1 py-1 text-xs"
                    >
                      <option value="">{t("dy1.callTo", { court: "…" })}</option>
                      {board.courts.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {board.recent.length > 0 && (
        <div>
          <h4 className="font-semibold">{t("dy1.recentTitle")}</h4>
          <ul className="mt-1 space-y-1 text-xs text-slate-600">
            {board.recent.map((r) => (
              <li key={r.id}>
                {r.label}: {r.a ?? t("tn.tbd")} {t("tn.versus")} {r.b ?? t("tn.tbd")} · {r.winner}
                {r.status === "walkover" ? ` (${t("dy1.walkover")})` : r.score ? ` ${r.score}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <DaySettings board={board} may={may} save={(body) => act({ action: "settings", ...body })} />

      <div className="text-xs text-slate-500">
        <a href={`/tournaments/${tn.id}/live`} target="_blank" rel="noreferrer" className="font-medium text-teal-700 underline">
          {t("dy1.livePage")}
        </a>{" "}
        {t("dy1.liveHint")}
      </div>
    </section>
  );
}

/** A time of day from an instant: on the venue's clock as the server read it (the board's own day and minute). */
function clockOf(instant: string, board: DayBoard, t: StaffT): string {
  const minutes = Math.round((new Date(instant).getTime() - new Date(board.now).getTime()) / 60_000);
  return formatMinute(board.nowMin + minutes, t.locale);
}

function DaySettings({ board, may, save }: { board: DayBoard; may: boolean; save: (body: object) => Promise<boolean> }) {
  const t = useStaffT();
  const [f, setF] = useState({
    rest: String(board.settings.minRestMinutes),
    wait: String(board.settings.callWaitMinutes),
    announce: board.settings.announceNext,
    names: board.settings.liveNames as string,
  });
  const [saved, setSaved] = useState(false);
  if (!may) return null;
  const input = "w-20 rounded-md border border-slate-300 px-2 py-1";
  return (
    <details className="rounded-lg border border-slate-200 p-3">
      <summary className="cursor-pointer text-sm font-medium text-slate-700">{t("dy1.settingsTitle")}</summary>
      <form
        className="mt-2 flex flex-wrap items-end gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setSaved(await save({ minRestMinutes: Number(f.rest), callWaitMinutes: Number(f.wait), announceNext: f.announce, liveNames: f.names }));
        }}
      >
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("dy1.rest")}
          <input type="number" min={0} max={240} value={f.rest} onChange={(e) => setF({ ...f, rest: e.target.value })} className={input} />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("dy1.callWait")}
          <input type="number" min={1} max={60} value={f.wait} onChange={(e) => setF({ ...f, wait: e.target.value })} className={input} />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={f.announce} onChange={(e) => setF({ ...f, announce: e.target.checked })} />
          {t("dy1.announce")}
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("dy1.liveNames")}
          <select value={f.names} onChange={(e) => setF({ ...f, names: e.target.value })} className="rounded-md border border-slate-300 px-2 py-1">
            <option value="full">{t("dy1.liveNames.full")}</option>
            <option value="short">{t("dy1.liveNames.short")}</option>
          </select>
        </label>
        <button className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700">{t("dy1.saveSettings")}</button>
        {saved && <span className="text-xs text-emerald-700">{t("dy1.saved")}</span>}
      </form>
    </details>
  );
}
