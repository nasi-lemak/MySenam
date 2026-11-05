"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import type { SeatLabel } from "@/lib/message-contexts";
import type { MessageReportOut, SuspensionOut } from "@/lib/message-moderation";
import type { CaseOut } from "@/lib/youth-report-cases";
import { useStaffClock, useStaffT } from "./StaffLanguage";

type Show = "open" | "reviewed" | "all";
type Kind = "game" | "team" | "group" | "tournament-match" | "league-match" | "ladder-challenge" | "team-fixture";
type Reason = "abuse" | "spam" | "contact" | "safety" | "other";

/** The route's page size (lib/message-moderation.ts, listMessageReports): a full page may have more behind it. */
const PAGE = 50;

/**
 * Reports of messages between players, for a venue's manager (the conversations that belong to the venue) and the platform owner (those
 * that belong to none), and the suspensions in force (`/api/admin/message-moderation`; docs/features/player-messages.md#moderation).
 * Nobody here reads an ordinary message: what a report carries is a copy of the last messages as the reporter saw them. Each action is
 * logged by number and reason, never with any message text.
 */
export function MessageReportsPanel() {
  const t = useStaffT();
  const clock = useStaffClock();
  const [show, setShow] = useState<Show>("open");
  const [reports, setReports] = useState<MessageReportOut[] | null>(null);
  const [suspensions, setSuspensions] = useState<SuspensionOut[]>([]);
  const [scope, setScope] = useState<"venue" | "platform">("venue");
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  // A report in a youth group's thread is a case: its evidence is read one report at a time, each reading recorded (ADR 0049).
  const [cases, setCases] = useState<Record<number, CaseOut>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});

  const load = useCallback(
    async (which: Show, before?: number) => {
      setError(null);
      try {
        const q = new URLSearchParams();
        if (which !== "all") q.set("status", which);
        if (before) q.set("before", String(before));
        const res = await fetch(`/api/admin/message-moderation?${q}`, { cache: "no-store" });
        const data = await readJson(res).catch(() => null);
        if (!res.ok) throw new Error(t.err(data, t("pmg.loadFailed")));
        const page = (data?.reports ?? []) as MessageReportOut[];
        setReports((had) => (before && had ? [...had, ...page] : page));
        setSuspensions((data?.suspensions ?? []) as SuspensionOut[]);
        setScope(data?.scope === "platform" ? "platform" : "venue");
        setMore(page.length >= PAGE);
      } catch (err) {
        setError(err instanceof Error ? err.message : t("pmg.loadFailed"));
      }
    },
    [t]
  );

  useEffect(() => {
    void load(show);
  }, [load, show]);

  async function act(body: Record<string, unknown>) {
    setError(null);
    const res = await fetch("/api/admin/message-moderation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await readJson(res).catch(() => null);
    if (!res.ok) return setError(t.err(data, t("pmg.actionFailed")));
    await load(show);
  }

  async function openCase(id: number) {
    setError(null);
    const res = await fetch(`/api/admin/message-moderation?report=${id}`, { cache: "no-store" });
    const data = await readJson(res).catch(() => null);
    if (!res.ok) return setError(t.err(data, t("pmg.actionFailed")));
    setCases((had) => ({ ...had, [id]: data.case as CaseOut }));
  }

  /** One step of a case: with a reason, or the words of a note or of the one notification the reported adult is ever sent. */
  async function caseAct(id: number, step: string, body: Record<string, unknown> = {}) {
    setError(null);
    const res = await fetch("/api/admin/message-moderation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "case", id, step, ...body }) });
    const data = await readJson(res).catch(() => null);
    if (!res.ok) return setError(t.err(data, t("pmg.actionFailed")));
    setTexts((had) => ({ ...had, [`n${id}`]: "", [`t${id}`]: "" }));
    await load(show);
    await openCase(id);
  }

  const label = (from: SeatLabel | null): string => {
    if (!from) return t("pmg.former");
    const names = (from.g ?? []).join(", ");
    if (from.c) return t("pmg.from.captain", { team: from.c });
    if (from.n && names) return t("pmg.from.nameGuardian", { name: from.n, names });
    if (names) return t("pmg.from.guardian", { names });
    return from.n ?? t("pmg.former");
  };
  const reasonFor = (key: string) => reasons[key] ?? "";
  const open = reports?.filter((r) => r.status === "open").length ?? 0;
  const tabs: [Show, string][] = [
    ["open", t("pmg.statusOpen")],
    ["reviewed", t("pmg.statusReviewed")],
    ["all", t("pmg.showAll")],
  ];
  const small = "min-h-9 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:border-teal-500";

  return (
    <details className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm">
      <summary className="cursor-pointer font-semibold text-slate-800">
        {t("pmg.title")}
        {show === "open" && reports && <span className="font-normal text-slate-500">{" · "}{more ? t("pmg.openMany", { n: open }) : t.plural("pmg.openCount", open)}</span>}
      </summary>
      <p className="mt-2 text-slate-600">{t("pmg.intro")}</p>
      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={t("pmg.title")}>
        {tabs.map(([id, text]) => (
          <button
            key={id}
            onClick={() => setShow(id)}
            aria-pressed={show === id}
            className={`min-h-9 rounded-full px-3 py-1 text-xs font-medium ${show === id ? "bg-teal-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-teal-400"}`}
          >
            {text}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-red-600">
          {error}
        </p>
      )}
      {reports && reports.length === 0 && <p className="mt-3 text-slate-500">{t("pmg.none")}</p>}
      {reports && reports.length > 0 && (
        <ul className="mt-3 space-y-3">
          {reports.map((r) => {
            const key = `r${r.id}`;
            return (
              <li key={r.id} className="rounded-lg border border-slate-200 px-3 py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold">
                    {t(`pmg.reason.${r.reason as Reason}`)}
                    <span className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${r.status === "open" ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-slate-600"}`}>
                      {r.status === "open" ? t("pmg.statusOpen") : t("pmg.statusReviewed")}
                    </span>
                    {r.urgent && <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">{t("ysg.urgent")}</span>}
                  </span>
                  <span className="text-xs text-slate-500">{clock.when(r.createdAt)}</span>
                </div>
                <p className="text-slate-600">{t("pmg.context", { kind: t(`pmg.kind.${r.kind as Kind}`), id: r.contextId })}</p>
                <p className="text-slate-600">{t("pmg.reporter", { who: label(r.reporter) })}</p>
                <p className="mt-1">
                  {r.reported ? t("pmg.reported", { who: label(r.reported.label), id: r.reported.userId ?? 0, n: r.reported.reporters }) : t("pmg.reportedGone")}
                  {r.reported?.suspended && <strong className="ml-1 text-red-700">{t("pmg.suspendedHere")}</strong>}
                </p>
                {r.note && <p className="mt-1 whitespace-pre-wrap rounded bg-slate-50 px-2 py-1 text-slate-700">{r.note}</p>}
                {r.linesHeld && (
                  <div className="mt-1 space-y-2" data-testid="youth-case">
                    <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">{t("msg3.case.protective")}</p>
                    {r.restricted && <p className="text-xs text-slate-600">{t("msg3.case.restricted")}</p>}
                    {r.escalated && <p className="text-xs text-slate-600">{t("msg3.case.escalated")}</p>}
                    {!cases[r.id] ? (
                      <button className={small} onClick={() => void openCase(r.id)}>
                        {t("msg3.case.open")}
                      </button>
                    ) : (
                      <div className="space-y-2 rounded-md bg-slate-50 p-2">
                        <p className="text-xs text-slate-500">{t("msg3.case.evidenceNote")}</p>
                        <ol className="space-y-1">
                          {cases[r.id].lines.map((l) => (
                            <li key={l.id} className={`rounded px-2 py-1 ${l.flagged ? "bg-amber-50 ring-1 ring-amber-300" : "bg-white"}`}>
                              <span className="text-xs font-semibold text-slate-600">
                                {label(l.from)} · {clock.when(l.at)}
                                {l.flagged && <> · {t("pmg.flagged")}</>}
                              </span>
                              <p className="whitespace-pre-wrap break-words text-slate-800">{l.body ?? t("pmg.removed")}</p>
                            </li>
                          ))}
                        </ol>
                        {cases[r.id].notes.length > 0 && (
                          <ul className="space-y-0.5 text-xs text-slate-600">
                            {cases[r.id].notes.map((n) => (
                              <li key={n.id}>
                                {clock.when(n.at)} · {n.by} · {t(`msg3.case.act.${n.action}` as "msg3.case.act.read")}
                                {n.detail && n.action !== "read" ? `: ${n.detail}` : ""}
                              </li>
                            ))}
                          </ul>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <button className={small} onClick={() => void caseAct(r.id, "confirm", { reason: reasonFor(key) })}>
                            {t("msg3.case.confirm")}
                          </button>
                          <button className={small} onClick={() => void caseAct(r.id, "extend", { reason: reasonFor(key) })}>
                            {t("msg3.case.extend")}
                          </button>
                          {cases[r.id].restricted && (
                            <button className={small} onClick={() => void caseAct(r.id, "lift", { reason: reasonFor(key) })}>
                              {t("msg3.case.lift")}
                            </button>
                          )}
                          {scope === "venue" && !cases[r.id].escalated && (
                            <button className={small} onClick={() => void caseAct(r.id, "escalate", { reason: reasonFor(key) })}>
                              {t("msg3.case.escalate")}
                            </button>
                          )}
                        </div>
                        <label className="block text-xs font-medium text-slate-600">
                          {t("msg3.case.noteLabel")}
                          <input value={texts[`n${r.id}`] ?? ""} onChange={(e) => setTexts((had) => ({ ...had, [`n${r.id}`]: e.target.value }))} maxLength={1000} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
                        </label>
                        <button className={small} onClick={() => void caseAct(r.id, "note", { text: texts[`n${r.id}`] ?? "" })}>
                          {t("msg3.case.note")}
                        </button>
                        {cases[r.id].reported.adult && (
                          <div className="space-y-1">
                            <label className="block text-xs font-medium text-slate-600">
                              {t("msg3.case.tellLabel")}
                              <textarea value={texts[`t${r.id}`] ?? ""} onChange={(e) => setTexts((had) => ({ ...had, [`t${r.id}`]: e.target.value }))} maxLength={1000} rows={3} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
                            </label>
                            <p className="text-xs text-slate-500">{t("msg3.case.tellNote")}</p>
                            <button className={small} onClick={() => void caseAct(r.id, "notify", { text: texts[`t${r.id}`] ?? "" })}>
                              {t("msg3.case.tell")}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {!r.linesHeld && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs font-semibold text-teal-700">{t("pmg.copy")}</summary>
                  <ol className="mt-1 space-y-1">
                    {r.lines.map((l) => (
                      <li key={l.id} className={`rounded px-2 py-1 ${l.flagged ? "bg-amber-50 ring-1 ring-amber-300" : "bg-slate-50"}`}>
                        <span className="text-xs font-semibold text-slate-600">
                          {label(l.from)} · {clock.when(l.at)}
                          {l.flagged && <> · {t("pmg.flagged")}</>}
                        </span>
                        {/* Plain text: nothing in a message is interpreted or opened. */}
                        <p className="whitespace-pre-wrap break-words text-slate-800">{l.body ?? t("pmg.removed")}</p>
                      </li>
                    ))}
                  </ol>
                </details>
                )}
                {r.status === "reviewed" && r.outcome && (
                  <p className="mt-1 text-xs text-slate-500">{t("pmg.handled", { name: r.reviewedBy ?? "", outcome: t(`pmg.outcome.${r.outcome}`) })}</p>
                )}
                <div className="mt-2 space-y-2">
                  <label className="block text-xs font-medium text-slate-600">
                    {t("pmg.reasonLabel")}
                    <input
                      value={reasonFor(key)}
                      onChange={(e) => setReasons((had) => ({ ...had, [key]: e.target.value }))}
                      maxLength={300}
                      className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {r.threadId !== null && r.threadState && (
                      <>
                        <span className="self-center text-xs text-slate-500">{t("pmg.thread.state", { state: t(`pmg.thread.${r.threadState}`) })}</span>
                        {r.threadState === "open" && (
                          <button className={small} onClick={() => void act({ action: "thread", id: r.threadId, state: "muted", reason: reasonFor(key) })}>
                            {t("pmg.thread.pause")}
                          </button>
                        )}
                        {r.threadState === "muted" && (
                          <button className={small} onClick={() => void act({ action: "thread", id: r.threadId, state: "open", reason: reasonFor(key) })}>
                            {t("pmg.thread.reopen")}
                          </button>
                        )}
                        {r.threadState !== "closed" && (
                          <button className={small} onClick={() => void act({ action: "thread", id: r.threadId, state: "closed", reason: reasonFor(key) })}>
                            {t("pmg.thread.close")}
                          </button>
                        )}
                      </>
                    )}
                    {r.reported?.userId && !r.reported.suspended && (
                      <button className={small} onClick={() => void act({ action: "suspend", userId: r.reported!.userId, reportId: r.id, reason: reasonFor(key) })} title={scope === "platform" ? t("pmg.suspendScopeAll") : t("pmg.suspendScopeVenue")}>
                        {t("pmg.suspend")}
                      </button>
                    )}
                    {r.status === "open" && (
                      <>
                        <button className={small} onClick={() => void act({ action: "review", id: r.id, outcome: "no_action" })}>
                          {t("pmg.review.noAction")}
                        </button>
                        <button className={small} onClick={() => void act({ action: "review", id: r.id, outcome: "action_taken" })}>
                          {t("pmg.review.taken")}
                        </button>
                        {r.linesHeld && (
                          <button className={small} onClick={() => void act({ action: "review", id: r.id, outcome: "restriction_continues" })}>
                            {t("msg3.case.review.continues")}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {more && reports && (
        <button onClick={() => void load(show, reports[reports.length - 1]?.id)} className="mt-2 min-h-9 text-xs font-semibold text-teal-700 underline">
          {t("pmg.older")}
        </button>
      )}
      <h3 className="mt-4 font-semibold text-slate-800">{t("pmg.suspensions")}</h3>
      {suspensions.length === 0 && <p className="text-slate-500">{t("pmg.suspensionNone")}</p>}
      <ul className="mt-1 space-y-2">
        {suspensions.map((s) => {
          const key = `s${s.id}`;
          return (
            <li key={s.id} className="rounded-lg border border-slate-200 px-3 py-2">
              <p>{t("pmg.suspension", { who: s.who, id: s.userId, reason: s.reason })}</p>
              <p className="text-xs text-slate-500">{s.pendingReview ? t("pmg.suspensionAuto", { when: clock.when(s.createdAt) }) : t("pmg.suspensionBy", { name: s.adminName ?? "", when: clock.when(s.createdAt) })}</p>
              <label className="mt-1 block text-xs font-medium text-slate-600">
                {t("pmg.reasonLabel")}
                <input value={reasonFor(key)} onChange={(e) => setReasons((had) => ({ ...had, [key]: e.target.value }))} maxLength={300} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
              </label>
              <div className="mt-1 flex gap-2">
                <button className={small} onClick={() => void act({ action: "lift", id: s.id, reason: reasonFor(key) })}>
                  {t("pmg.lift")}
                </button>
                {s.pendingReview && (
                  <button className={small} onClick={() => void act({ action: "confirm", id: s.id, reason: reasonFor(key) })}>
                    {t("pmg.confirm")}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
