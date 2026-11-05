"use client";

import { useCallback, useEffect, useState } from "react";
import { readJson } from "@/lib/read-response";
import type { Mark, Register, RegisterLine } from "@/lib/attendance";
import type { RefusalBody } from "@/lib/i18n";

/** The words a register says: each caller reads them from its own dictionary (the staff's, or the customer's for a coach's page). */
export type RegisterKey =
  | "title"
  | "loading"
  | "early"
  | "open"
  | "closed"
  | "lockedBy"
  | "nobody"
  | "present"
  | "absent"
  | "late"
  | "excused"
  | "unmarked"
  | "note"
  | "walkInAdd"
  | "walkInName"
  | "walkInTag"
  | "add"
  | "remove"
  | "reason"
  | "markedBy"
  | "failed"
  | "cancelled"
  | "close";

export const REGISTER_MARKS: Mark[] = ["present", "late", "absent", "excused"];

const TONE: Record<Mark, string> = {
  present: "border-emerald-500 bg-emerald-600 text-white",
  late: "border-amber-500 bg-amber-500 text-white",
  absent: "border-rose-500 bg-rose-600 text-white",
  excused: "border-slate-500 bg-slate-600 text-white",
};

/**
 * One session's register, as a tap list (lib/attendance.ts): each person with Present, Late, Absent and Excused, a note, walk-ins added by
 * name. Mobile-first and usable by keyboard: each person's marks are buttons that say whether they are on, with the person's name in
 * their accessible name. Before the session's day the list is read-only (a manager marks early); once the register is closed a manager
 * corrects it with a reason. The caller supplies how it is loaded, written and worded, so the same list serves the dashboard and a
 * coach's own page.
 */
export function RegisterPanel({
  load,
  send,
  say,
  errorText,
  lock,
  onClose,
}: {
  load: () => Promise<Response>;
  send: (body: Record<string, unknown>) => Promise<Response>;
  say: (key: RegisterKey, vars?: Record<string, string | number>) => string;
  errorText: (data: RefusalBody | null | undefined, fallback: string) => string;
  /** A manager's lock and the corrections kept, on the dashboard only. */
  lock?: { toggle: (locked: boolean) => Promise<Response>; lockText: string; unlockText: string; historyTitle: string; historyLine: (h: NonNullable<Register["history"]>[number]) => string };
  onClose?: () => void;
}) {
  const [register, setRegister] = useState<Register | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [walkIn, setWalkIn] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      const res = await load();
      const data = await readJson(res);
      if (!res.ok) throw new Error(errorText(data, say("failed")));
      setRegister(data.register as Register);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : say("failed"));
    }
  }, [load, errorText, say]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await send({ ...body, ...(register?.phase === "closed" && reason.trim() ? { reason: reason.trim() } : {}) });
      const data = await readJson(res);
      if (!res.ok) throw new Error(errorText(data, say("failed")));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : say("failed"));
    } finally {
      setBusy(false);
    }
  }

  if (!register) return <p className="text-sm text-slate-500">{error ?? say("loading")}</p>;
  const closed = register.phase === "closed";
  const mayWrite = register.canMark || register.canCorrect;
  const needReason = closed && register.canCorrect && reason.trim().length < 3;
  const noteOf = (l: RegisterLine) => notes[l.key] ?? l.note ?? "";

  return (
    <section className="space-y-3 text-sm" data-testid="register">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-bold">{say("title")}</h3>
        <span className="text-xs text-slate-600">
          {register.session.date}
          {register.phase === "early" && <> · {say("early")}</>}
          {register.phase === "open" && <> · {say("open", { date: register.closesOn })}</>}
          {closed && <> · {register.locked ? say("lockedBy", { by: register.locked.by }) : say("closed")}</>}
        </span>
      </div>
      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
          {error}
        </p>
      )}
      {closed && register.canCorrect && (
        <label className="block text-xs font-medium text-slate-700">
          {say("reason")}
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={300}
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            data-testid="register-reason"
          />
        </label>
      )}
      {register.lines.length === 0 ? (
        <p className="text-slate-500">{say("nobody")}</p>
      ) : (
        <ul className="space-y-3">
          {register.lines.map((l) => (
            <li key={l.key} className="rounded-lg border border-slate-200 bg-white p-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={`font-medium ${l.cancelled ? "text-slate-400 line-through" : ""}`}>
                  {l.name}
                  {l.walkIn && <span className="ml-2 rounded-full bg-violet-50 px-1.5 py-0.5 text-[11px] font-semibold text-violet-700">{say("walkInTag")}</span>}
                  {l.cancelled && <span className="ml-2 text-xs font-normal text-slate-500">{say("cancelled")}</span>}
                </span>
                {l.phone && <span className="text-xs text-slate-400">{l.phone}</span>}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={l.name}>
                {REGISTER_MARKS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={l.mark === m}
                    aria-label={`${l.name}: ${say(m)}`}
                    disabled={busy || !mayWrite || needReason}
                    onClick={() => void act({ action: "mark", key: l.key, mark: m, note: noteOf(l) })}
                    className={`min-h-[36px] min-w-[72px] rounded-md border px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${
                      l.mark === m ? TONE[m] : "border-slate-300 bg-white text-slate-700 hover:border-teal-500"
                    }`}
                  >
                    {say(m)}
                  </button>
                ))}
                {l.walkIn && mayWrite && (
                  <button type="button" disabled={busy || needReason} onClick={() => void act({ action: "remove", key: l.key })} className="px-2 text-xs text-slate-500 underline">
                    {say("remove")}
                  </button>
                )}
              </div>
              {(mayWrite || l.note) && (
                <input
                  aria-label={`${l.name}: ${say("note")}`}
                  value={noteOf(l)}
                  disabled={!mayWrite}
                  maxLength={200}
                  onChange={(e) => setNotes({ ...notes, [l.key]: e.target.value })}
                  onBlur={() => {
                    if (l.mark && mayWrite && !needReason && noteOf(l) !== (l.note ?? "")) void act({ action: "mark", key: l.key, mark: l.mark, note: noteOf(l) });
                  }}
                  placeholder={say("note")}
                  className="mt-2 block w-full rounded-md border border-slate-200 px-2 py-1 text-xs disabled:bg-slate-50"
                />
              )}
              {l.markedBy && <p className="mt-1 text-[11px] text-slate-400">{say("markedBy", { by: l.markedBy })}</p>}
            </li>
          ))}
        </ul>
      )}
      {mayWrite && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!walkIn.trim()) return;
            void act({ action: "walkin", name: walkIn.trim() }).then(() => setWalkIn(""));
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            {say("walkInAdd")}
            <input
              value={walkIn}
              onChange={(e) => setWalkIn(e.target.value)}
              maxLength={80}
              aria-label={say("walkInName")}
              placeholder={say("walkInName")}
              className="w-56 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>
          <button type="submit" disabled={busy || needReason || !walkIn.trim()} className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
            {say("add")}
          </button>
        </form>
      )}
      {lock && register.canLock && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void (async () => {
              setBusy(true);
              try {
                const res = await lock.toggle(!register.locked);
                const data = await readJson(res);
                if (!res.ok) throw new Error(errorText(data, say("failed")));
                await refresh();
              } catch (err) {
                setError(err instanceof Error ? err.message : say("failed"));
              } finally {
                setBusy(false);
              }
            })()
          }
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-teal-500"
        >
          {register.locked ? lock.unlockText : lock.lockText}
        </button>
      )}
      {lock && register.history && register.history.length > 0 && (
        <div className="text-xs text-slate-600">
          <p className="font-semibold">{lock.historyTitle}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {register.history.map((h, i) => (
              <li key={i}>{lock.historyLine(h)}</li>
            ))}
          </ul>
        </div>
      )}
      {onClose && (
        <button type="button" onClick={onClose} className="w-full rounded-lg bg-teal-600 py-2 font-semibold text-white hover:bg-teal-700">
          {say("close")}
        </button>
      )}
    </section>
  );
}
