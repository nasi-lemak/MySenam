"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/components/Language";
import { errorText, translateError, type ErrorCode } from "@/lib/i18n";
import { LIMITS } from "@/lib/message-limits";
import { contextTitle, senderText } from "@/lib/message-titles";
import type { MessageOut, ThreadView } from "@/lib/messages";

const REASONS = ["abuse", "spam", "contact", "safety", "other"] as const;
/** How often an open conversation asks for what is new, while the tab is visible: polling, no sockets. */
const POLL_MS = 15_000;

/**
 * One conversation (docs/features/player-messages.md): the messages, newest last, a box to write in, and for each message from somebody
 * else a way to block them or report it. New messages are announced in a live region for screen readers and arrive by polling.
 * Text only: a message is shown as the plain text it is, with no link opened and no picture loaded.
 */
export function Thread({ kind, id, onBack }: { kind: string; id: number; onBack: () => void }) {
  const t = useT();
  const [view, setView] = useState<ThreadView | null>(null);
  const [messages, setMessages] = useState<MessageOut[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const [reporting, setReporting] = useState<number | null>(null);
  const [reason, setReason] = useState<string>("");
  const [note, setNote] = useState("");
  const latest = useRef(0);
  const end = useRef<HTMLDivElement>(null);
  const base = `/api/messages/${kind}/${id}`;

  const load = useCallback(
    async (after: number, poll = false) => {
      const res = await fetch(`${base}?read=1${after ? `&after=${after}` : ""}`, { cache: "no-store" });
      const data = await readJson(res).catch(() => null);
      if (!res.ok) {
        setView(null);
        setError(translateError(t, data));
        return;
      }
      const next = data as ThreadView;
      setView(next);
      if (!poll && after === 0) {
        setMessages(next.messages);
      } else if (next.messages.length > 0) {
        setMessages((had) => [...had, ...next.messages.filter((m) => !had.some((h) => h.id === m.id))]);
        const fresh = next.messages.filter((m) => !m.mine).length;
        if (fresh > 0) setLive(t.plural("pmsg.newMessages", fresh));
      }
      latest.current = Math.max(latest.current, next.latestId);
    },
    [base, t]
  );

  useEffect(() => {
    latest.current = 0;
    void load(0);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load(latest.current, true);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length]);

  async function send() {
    if (!draft.trim() || busy) return;
    setBusy(true);
    setError(null);
    const res = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: draft }) });
    const data = await readJson(res).catch(() => null);
    setBusy(false);
    if (!res.ok) return setError(translateError(t, data));
    setDraft("");
    await load(latest.current, true);
  }

  async function post(path: string, body: object, ok: string) {
    setError(null);
    setNotice(null);
    const res = await fetch(`${base}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await readJson(res).catch(() => null);
    if (!res.ok) return setError(translateError(t, data));
    setNotice(ok);
    return true;
  }

  async function mute(muted: boolean) {
    const res = await fetch(base, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ muted }) });
    if (res.ok) setView((v) => (v ? { ...v, muted } : v));
  }

  const when = (at: string) => new Intl.DateTimeFormat(t.locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(`${at.replace(" ", "T")}Z`));
  const input = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3">
      <button onClick={onBack} className="min-h-9 self-start rounded-md px-1 text-sm text-teal-700 underline">
        {t("pmsg.back")}
      </button>
      {view && <h1 className="text-xl font-bold">{contextTitle(t, view.info)}</h1>}
      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {view && (
        <>
          <p className="text-xs text-slate-500">{t("pmsg.reminder")}</p>
          <div className="flex flex-wrap items-center gap-3 text-sm text-slate-600">
            <span>{t.plural("pmsg.people", view.people)}</span>
            <button onClick={() => void mute(!view.muted)} className="min-h-9 rounded-md px-1 text-teal-700 underline" aria-pressed={view.muted}>
              {view.muted ? t("pmsg.unmute") : t("pmsg.mute")}
            </button>
          </div>
          {view.muted && <p className="text-xs text-slate-500">{t("pmsg.muteNote")}</p>}
          {notice && (
            <p role="status" className="rounded-md bg-teal-50 px-3 py-2 text-sm text-teal-900">
              {notice}
            </p>
          )}
          <ol className="flex flex-col gap-2" aria-label={contextTitle(t, view.info)}>
            {messages.length === 0 && <li className="text-sm text-slate-500">{t("pmsg.empty")}</li>}
            {messages.map((m) => (
              <li key={m.id} className={`flex flex-col gap-1 ${m.mine ? "items-end" : "items-start"}`}>
                <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${m.mine ? "bg-teal-600 text-white" : "bg-slate-100 text-slate-900"}`}>
                  <p className={`text-xs font-semibold ${m.mine ? "text-teal-50" : "text-slate-600"}`}>{m.mine ? t("pmsg.you") : senderText(t, m.from)}</p>
                  {/* Plain text, never a link: whitespace kept, nothing interpreted. */}
                  <p className={`whitespace-pre-wrap break-words ${m.body === null ? "italic opacity-80" : ""}`}>{m.body ?? t("pmsg.removed")}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <time dateTime={`${m.at.replace(" ", "T")}Z`}>{when(m.at)}</time>
                  {!m.mine && m.body !== null && (
                    <>
                      <button
                        onClick={async () => {
                          if (await post("block", { messageId: m.id }, t("pmsg.blocked"))) void load(0);
                        }}
                        className="min-h-6 rounded border border-slate-200 px-2 hover:border-red-400"
                      >
                        {t("pmsg.block")}
                      </button>
                      <button onClick={() => setReporting(reporting === m.id ? null : m.id)} aria-expanded={reporting === m.id} className="min-h-6 rounded border border-slate-200 px-2 hover:border-red-400">
                        {t("pmsg.report")}
                      </button>
                    </>
                  )}
                </div>
                {reporting === m.id && (
                  <form
                    className="w-full space-y-2 rounded-lg border border-slate-200 bg-white p-3 text-sm"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (await post("report", { messageId: m.id, reason, note }, t("pmsg.reported"))) {
                        setReporting(null);
                        setReason("");
                        setNote("");
                      }
                    }}
                  >
                    <label className="block font-medium">
                      {t("pmsg.reportWhy")}
                      <select value={reason} onChange={(e) => setReason(e.target.value)} required className={`${input} mt-1`}>
                        <option value="" disabled />
                        {REASONS.map((r) => (
                          <option key={r} value={r}>
                            {t(`pmsg.reason.${r}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block font-medium">
                      {t("pmsg.reportNote")}
                      <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} className={`${input} mt-1`} />
                    </label>
                    <div className="flex gap-2">
                      <button type="submit" className="min-h-9 rounded-md bg-red-600 px-3 py-1.5 font-semibold text-white">
                        {t("pmsg.reportSend")}
                      </button>
                      <button type="button" onClick={() => setReporting(null)} className="min-h-9 rounded-md px-3 py-1.5 text-slate-600 underline">
                        {t("pmsg.cancel")}
                      </button>
                    </div>
                  </form>
                )}
              </li>
            ))}
          </ol>
          <div ref={end} />
          {/* New messages are announced politely, and never steal focus from the box being written in. */}
          <p role="status" aria-live="polite" className="sr-only">
            {live}
          </p>
          {view.canSend ? (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label className="block text-sm font-medium">
                {t("pmsg.write")}
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  maxLength={LIMITS.maxLength}
                  rows={3}
                  className={`${input} mt-1`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
              </label>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-slate-500">{t("pmsg.counter", { n: [...draft].length, max: LIMITS.maxLength })}</span>
                <button type="submit" disabled={busy || !draft.trim()} className="min-h-10 rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                  {busy ? t("pmsg.sending") : t("pmsg.send")}
                </button>
              </div>
            </form>
          ) : (
            <p className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">
              {view.phase === "read_only" ? t("pmsg.phase.read_only") : view.phase === "paused" ? t("pmsg.phase.paused") : view.whyNot ? errorText(t, view.whyNot as ErrorCode) : ""}
            </p>
          )}
        </>
      )}
    </div>
  );
}
