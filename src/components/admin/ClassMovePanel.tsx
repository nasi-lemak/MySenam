"use client";

import { readJson } from "@/lib/read-response";
import { useState } from "react";
import { ClockField } from "@/components/ClockField";
import type { ClassSession } from "@/lib/types";
import type { MovePreview, MoveScope } from "@/lib/class-moves";
import { formatMinute } from "@/lib/interval";
import { shortDate } from "@/lib/region";
import { useStaffT } from "./StaffLanguage";

/**
 * Move a class (POST /api/admin/classes/:id/move; lib/class-moves.ts): this session, it and the later ones of its weekly series,
 * or the whole term, to another date, time or court. Asked first what it would do (who is enrolled and waiting, who holds a pass
 * entry, what is in the way, what each person will be told), then moved and told, all of it or none.
 */
export function ClassMovePanel({
  session,
  courts,
  onDone,
  onClose,
}: {
  session: ClassSession;
  /** The venue's shared facilities a class may be held on. */
  courts: { id: number; name: string; capacity: number }[];
  onDone: (notice: string) => void;
  onClose: () => void;
}) {
  const t = useStaffT();
  const [scope, setScope] = useState<MoveScope>("one");
  const [date, setDate] = useState(session.date);
  const [start, setStart] = useState(session.startMin);
  const [courtId, setCourtId] = useState("");
  const [seen, setSeen] = useState<MovePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const body = () => ({ date, start, scope, ...(courtId !== "" ? { courtId: Number(courtId) } : {}) });

  async function send(preview: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/classes/${session.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body(), ...(preview ? { preview: true } : {}) }),
      });
      const data = await readJson(res);
      if (!res.ok) {
        setSeen(null);
        // A refused move names each session in the way; the first is the sentence.
        const more = Array.isArray(data.conflicts) ? (data.conflicts as { date: string; error: string; code?: string; vars?: Record<string, string | number> }[]).slice(1).map((c) => `${shortDate(c.date, t.locale, true)}: ${t.err(c)}`) : [];
        throw new Error([t.err(data, t("clsa.move.failed")), ...more].join(" "));
      }
      if (preview) setSeen(data as MovePreview);
      else onDone(t.plural("clsa.move.done", (data.classes as unknown[]).length, { told: data.told }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("clsa.move.failed"));
    } finally {
      setBusy(false);
    }
  }

  const at = (w: { date: string; startMin: number; endMin: number; courtName: string }) =>
    `${shortDate(w.date, t.locale, true)} ${formatMinute(w.startMin, t.locale)}–${formatMinute(w.endMin, t.locale)}, ${w.courtName}`;
  const input = "mt-0.5 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  const label = "block text-xs font-medium text-slate-600";
  const scopes: MoveScope[] = session.seriesCode ? ["one", "following", "term"] : ["one"];
  const changed = () => setSeen(null);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="max-h-[88vh] w-full max-w-lg space-y-3 overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl" role="dialog" aria-label={t("clsa.move.title", { name: session.name, date: session.date })}>
        <h3 className="text-lg font-bold">{t("clsa.move.title", { name: session.name, date: session.date })}</h3>
        <p className="text-xs text-slate-600">{t("clsa.move.help")}</p>
        {scopes.length > 1 && (
          <label className={label}>
            {t("clsa.move.scope")}
            <select value={scope} onChange={(e) => { setScope(e.target.value as MoveScope); changed(); }} className={input}>
              {scopes.map((s) => (
                <option key={s} value={s}>
                  {t(`clsa.move.scope.${s}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="grid grid-cols-2 gap-3">
          <label className={label}>
            {t("clsa.move.date")}
            <input type="date" required value={date} onChange={(e) => { setDate(e.target.value); changed(); }} className={input} />
          </label>
          <label className={label}>
            {t("clsa.move.start")}
            <ClockField label={t("clsa.move.start")} value={start} onChange={(m) => { setStart(m); changed(); }} className={input} />
          </label>
        </div>
        <label className={label}>
          {t("clsa.move.court")}
          <select value={courtId} onChange={(e) => { setCourtId(e.target.value); changed(); }} className={input}>
            <option value="">{t("clsa.move.sameCourt")}</option>
            {courts
              .filter((c) => c.id !== session.courtId)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.capacity})
                </option>
              ))}
          </select>
        </label>
        {error && <p className="text-sm font-medium text-red-700">{error}</p>}

        {seen && (
          <div className="space-y-3 rounded-xl border border-teal-200 bg-teal-50/50 p-3 text-sm" data-testid="move-preview">
            <ul className="space-y-2">
              {seen.sessions.map((s) => (
                <li key={s.classId} className="rounded-lg bg-white p-2 shadow-sm">
                  <p className="font-medium">{t("clsa.move.line", { from: at(s.from), to: at(s.to) })}</p>
                  <p className="text-xs text-slate-600">
                    {t("clsa.move.enrolled", { n: s.enrolled })} · {t("clsa.move.waiting", { n: s.waiting })}
                  </p>
                  {s.conflict && <p className="mt-1 text-xs font-semibold text-red-700">{t("clsa.move.cannot", { why: t.err(s.conflict) })}</p>}
                  {s.people.length > 0 && (
                    <details className="mt-1 text-xs">
                      <summary className="cursor-pointer text-teal-700">{t("clsa.move.people")}</summary>
                      <ul className="mt-1 space-y-0.5">
                        {s.people.map((p) => (
                          <li key={p.bookingId}>
                            {p.participantName ? `${p.participantName} (${p.name})` : p.name} <span className="text-slate-400">{p.code}</span>
                            {p.pass && <span className="ml-1 rounded-full bg-violet-50 px-1.5 text-violet-700">{t("clsa.move.pass")}</span>}
                            {p.membership && <span className="ml-1 rounded-full bg-sky-50 px-1.5 text-sky-700">{t("clsa.move.membership")}</span>}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              ))}
            </ul>
            {seen.skipped.length > 0 && (
              <ul className="space-y-0.5 text-xs text-slate-600">
                {seen.skipped.map((k) => (
                  <li key={k.classId}>{t(`clsa.move.skipped.${k.reason}`, { date: shortDate(k.date, t.locale, true) })}</li>
                ))}
              </ul>
            )}
            <p className="text-xs text-slate-600">{t("clsa.move.window", { n: seen.windowDays })}</p>
            {seen.notices.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer font-medium text-teal-700">
                  {t("clsa.move.notices")} ({seen.notices.length})
                </summary>
                <ul className="mt-1 space-y-2">
                  {seen.notices.map((n, i) => (
                    <li key={i} className="rounded-md bg-white p-2">
                      <p className="font-medium">
                        {t("clsa.move.noticeLine", { name: n.name, kind: t(`clsa.move.kind.${n.kind}`), locale: n.locale, channels: n.channels.length > 0 ? n.channels.join(", ") : t("clsa.move.noChannel") })}
                      </p>
                      <p className="mt-1 whitespace-pre-line text-slate-600">{n.text}</p>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {seen.blocked && <p className="font-semibold text-red-700">{t("clsa.move.blocked")}</p>}
          </div>
        )}

        <div className="flex gap-2 pt-1">
          {seen && !seen.blocked ? (
            <button type="button" disabled={busy} onClick={() => void send(false)} className="flex-1 rounded-lg bg-teal-600 py-2 font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
              {t("clsa.move.confirm")}
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => void send(true)} className="flex-1 rounded-lg bg-teal-600 py-2 font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
              {t("clsa.move.check")}
            </button>
          )}
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">
            {t("c.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
