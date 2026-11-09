"use client";

import { useState } from "react";
import { readJson } from "@/lib/read-response";
import { money, shortDate } from "@/lib/region";
import type { DayCount, HistoricalCandidate, HistoricalFinding, HistoricalPreview, HistoricalRecord } from "@/lib/historical-counter-refunds";
import { COUNTER_METHODS, type CounterMethod } from "@/lib/types";
import { useStaffClock, useStaffT } from "./StaffLanguage";
import { useStaffMay } from "./StaffMay";

interface Loaded {
  since: string | null;
  candidates: HistoricalCandidate[];
  records: HistoricalRecord[];
}

interface Form {
  finding: HistoricalFinding;
  earlierAmount: string;
  earlierOn: string;
  earlierVia: CounterMethod;
  nowAmount: string;
  nowVia: CounterMethod;
  evidence: string;
  reason: string;
  remainderReason: string;
  ack: boolean;
}

const blank = (c: HistoricalCandidate): Form => ({
  finding: "earlier",
  earlierAmount: String(c.noteTotal),
  earlierOn: c.noteDay,
  earlierVia: c.paidWith ?? "cash",
  nowAmount: String(c.noteTotal),
  nowVia: c.paidWith ?? "cash",
  evidence: "",
  reason: "",
  remainderReason: "",
  ack: false,
});

/**
 * Cancellations from before money owed back was written down (ADR 0078; lib/historical-counter-refunds.ts), under the owed-back list: a
 * manager's only, loaded when opened. Each credit note with its evidence; the manager records what the evidence shows (handed back at the time,
 * now, or part of each), sees the preview of what is written and what it does to the cash-up, and confirms a day with a till count.
 */
export function HistoricalRefunds({ onDone, onError }: { onDone: (notice: string) => void; onError: (error: string) => void }) {
  const t = useStaffT();
  const clock = useStaffClock();
  const may = useStaffMay();
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [preview, setPreview] = useState<HistoricalPreview | null>(null);
  const [busy, setBusy] = useState(false);
  if (!may("historicalRefunds")) return null;

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/bookings/owed/historical", { cache: "no-store" });
      const body = await readJson(res);
      if (!res.ok) throw new Error(t.err(body, t("h78.loadFailed")));
      setData({ since: body.since ?? null, candidates: body.candidates ?? [], records: body.records ?? [] });
    } catch (err) {
      onError(err instanceof Error ? err.message : t("h78.loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  const via = (m: CounterMethod | null) => (m ? t(`c.via.${m}`) : t("p8a.day.viaUnrecorded"));
  const day = (d: string) => shortDate(d, t.locale, true);
  const edit = (patch: Partial<Form>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    // Any change is previewed again before it can be recorded.
    setPreview(null);
  };

  function body(c: HistoricalCandidate, f: Form, asPreview: boolean) {
    return {
      creditNoteId: c.creditNoteId,
      finding: f.finding,
      ...(f.finding !== "now" ? { earlier: { amount: Number(f.earlierAmount), on: f.earlierOn, via: f.earlierVia } } : {}),
      ...(f.finding !== "earlier" ? { now: { amount: Number(f.nowAmount), via: f.nowVia } } : {}),
      evidence: f.evidence,
      reason: f.reason,
      remainderReason: f.remainderReason,
      acknowledgeCountedDays: f.ack,
      ...(asPreview ? { preview: true } : {}),
    };
  }

  async function submit(c: HistoricalCandidate, asPreview: boolean) {
    if (!form) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/bookings/owed/historical", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body(c, form, asPreview)),
      });
      const out = await readJson(res);
      if (!res.ok) throw new Error(t.err(out, t("h78.failed")));
      if (asPreview) setPreview(out.preview as HistoricalPreview);
      else {
        setOpen(null);
        setForm(null);
        setPreview(null);
        onDone(t("h78.done", { code: c.bookingCode }));
        await load();
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : t("h78.failed"));
    } finally {
      setBusy(false);
    }
  }

  const counted = (date: string, counts: DayCount[]) =>
    counts.map((n, i) => (
      <li key={`${date}-${i}`} className="font-medium text-red-800">
        {n.by ? t("h78.pv.counted", { date: day(date), by: n.by, when: clock.when(n.at) }) : t("h78.pv.countedNobody", { date: day(date), when: clock.when(n.at) })}
      </li>
    ));

  if (!data)
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm" data-testid="historical-refunds">
        <button type="button" disabled={loading} onClick={() => void load()} className="text-xs font-semibold text-slate-700 underline disabled:opacity-50">
          {loading ? t("h78.loading") : t("h78.open")}
        </button>
      </div>
    );

  const since = data.since ? day(data.since.slice(0, 10)) : null;
  return (
    <div className="rounded-xl border border-slate-300 bg-slate-50 px-4 py-3 text-sm" data-testid="historical-refunds">
      <p className="font-semibold text-slate-900">{since ? t("h78.title", { date: since }) : t("h78.titleNoDate")}</p>
      {since && <p className="mt-0.5 text-xs text-slate-700">{t("h78.help", { date: since })}</p>}
      {data.candidates.length === 0 && <p className="mt-2 text-xs text-slate-600">{t("h78.none")}</p>}
      <ul className="mt-2 space-y-3">
        {data.candidates.map((c) => (
          <li key={c.creditNoteId} className="text-xs text-slate-900" data-testid="historical-candidate">
            <span>
              {t("h78.line", {
                code: c.bookingCode,
                note: c.creditNote,
                amount: money(c.noteTotal),
                what: t(c.kind === "withdrawal" ? "h78.what.withdrawal" : "h78.what.cancellation"),
                date: day(c.noteDay),
                via: via(c.paidWith),
              })}
            </span>
            <ul className="mt-0.5 list-disc pl-4 text-slate-700" data-testid="historical-evidence">
              {c.logEvidence.length > 0 && <li>{t("h78.ev.log", { actions: c.logEvidence.join(", ") })}</li>}
              {c.otherNotes.count > 0 && <li>{t("h78.ev.notes", { count: c.otherNotes.count, amount: money(c.otherNotes.total) })}</li>}
              {c.storedCredit > 0 && <li>{t("h78.ev.credit", { amount: money(c.storedCredit) })}</li>}
              {c.paidOutOnBooking > 0 && <li>{t("h78.ev.payouts", { amount: money(c.paidOutOnBooking) })}</li>}
              {c.possibleDuplicate ? <li className="font-medium text-amber-800">{t("h78.ev.duplicate")}</li> : <li>{t("h78.ev.none")}</li>}
            </ul>
            {open !== c.creditNoteId ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setOpen(c.creditNoteId);
                  setForm(blank(c));
                  setPreview(null);
                }}
                className="mt-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50"
              >
                {t("h78.review")}
              </button>
            ) : (
              form && (
                <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-white p-3" data-testid="historical-form">
                  <label className="block">
                    {t("h78.f.finding")}{" "}
                    <select value={form.finding} onChange={(e) => edit({ finding: e.target.value as HistoricalFinding })} className="rounded-md border border-slate-300 px-1 py-0.5">
                      <option value="earlier">{t("h78.f.earlier")}</option>
                      <option value="now">{t("h78.f.now")}</option>
                      <option value="earlier_and_now">{t("h78.f.both")}</option>
                    </select>
                  </label>
                  {form.finding !== "now" && (
                    <div className="flex flex-wrap items-center gap-2">
                      <label>
                        {t("h78.f.earlierAmount")}{" "}
                        <input type="number" step="0.01" min="0" value={form.earlierAmount} onChange={(e) => edit({ earlierAmount: e.target.value })} className="w-24 rounded-md border border-slate-300 px-1 py-0.5" />
                      </label>
                      <label>
                        {t("h78.f.earlierOn")}{" "}
                        <input type="date" value={form.earlierOn} onChange={(e) => edit({ earlierOn: e.target.value })} className="rounded-md border border-slate-300 px-1 py-0.5" />
                      </label>
                      <label>
                        {t("h78.f.via")}{" "}
                        <select value={form.earlierVia} onChange={(e) => edit({ earlierVia: e.target.value as CounterMethod })} className="rounded-md border border-slate-300 px-1 py-0.5">
                          {COUNTER_METHODS.map((m) => (
                            <option key={m} value={m}>
                              {t(`c.via.${m}`)}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                  {form.finding !== "earlier" && (
                    <div className="flex flex-wrap items-center gap-2">
                      <label>
                        {t("h78.f.nowAmount")}{" "}
                        <input type="number" step="0.01" min="0" value={form.nowAmount} onChange={(e) => edit({ nowAmount: e.target.value })} className="w-24 rounded-md border border-slate-300 px-1 py-0.5" />
                      </label>
                      <label>
                        {t("h78.f.via")}{" "}
                        <select value={form.nowVia} onChange={(e) => edit({ nowVia: e.target.value as CounterMethod })} className="rounded-md border border-slate-300 px-1 py-0.5">
                          {COUNTER_METHODS.map((m) => (
                            <option key={m} value={m}>
                              {t(`c.via.${m}`)}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                  <p className="text-slate-500">{t("h78.f.noNames")}</p>
                  <label className="block">
                    {t("h78.f.evidence")}
                    <input value={form.evidence} maxLength={500} onChange={(e) => edit({ evidence: e.target.value })} className="mt-0.5 w-full rounded-md border border-slate-300 px-1 py-0.5" />
                  </label>
                  <label className="block">
                    {t("h78.f.reason")}
                    <input value={form.reason} maxLength={500} onChange={(e) => edit({ reason: e.target.value })} className="mt-0.5 w-full rounded-md border border-slate-300 px-1 py-0.5" />
                  </label>
                  <label className="block">
                    {t("h78.f.remainderReason")}
                    <input value={form.remainderReason} maxLength={500} onChange={(e) => edit({ remainderReason: e.target.value })} className="mt-0.5 w-full rounded-md border border-slate-300 px-1 py-0.5" />
                  </label>
                  {preview && (
                    <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-950" data-testid="historical-preview">
                      <p className="font-semibold">{t("h78.pv.title")}</p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4">
                        <li>{t("h78.pv.writes", { code: c.bookingCode, note: c.creditNote })}</li>
                        <li>{preview.writes.payout ? t("h78.pv.payout", { amount: money(preview.writes.payout.amount), via: via(preview.writes.payout.via) }) : t("h78.pv.noPayout")}</li>
                        {preview.remainder > 0 && <li>{t("h78.pv.remainder", { amount: money(preview.remainder) })}</li>}
                        {preview.today && <li>{t("h78.pv.today", { date: day(preview.today.day), amount: money(preview.today.amount), via: via(preview.today.via) })}</li>}
                        {preview.today && counted(preview.today.day, preview.today.counts)}
                        <li>{t("h78.pv.noteDay", { date: day(preview.noteDay.day) })}</li>
                        {counted(preview.noteDay.day, preview.noteDay.counts)}
                        {preview.earlierDay && preview.earlierDay.day !== preview.noteDay.day && (
                          <li>
                            {t("h78.pv.earlierDay", {
                              date: day(preview.earlierDay.day),
                              amount: money(preview.earlierDay.amount),
                              via: via(preview.earlierDay.via),
                              noteDay: day(preview.noteDay.day),
                            })}
                          </li>
                        )}
                        {preview.earlierDay && counted(preview.earlierDay.day, preview.earlierDay.counts)}
                      </ul>
                      {preview.needsAcknowledgement && (
                        <label className="mt-1 flex items-center gap-1 font-medium">
                          <input type="checkbox" checked={form.ack} onChange={(e) => setForm({ ...form, ack: e.target.checked })} />
                          {t("h78.f.ack")}
                        </label>
                      )}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void submit(c, true)}
                      className="rounded-md border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50"
                    >
                      {t("h78.preview")}
                    </button>
                    {preview && (
                      <button
                        type="button"
                        disabled={busy || (preview.needsAcknowledgement && !form.ack)}
                        onClick={() => void submit(c, false)}
                        className="rounded-md border border-amber-400 bg-white px-2.5 py-1 font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                      >
                        {t("h78.save")}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(null);
                        setForm(null);
                        setPreview(null);
                      }}
                      className="px-2 py-1 font-medium text-slate-500 hover:text-slate-700"
                    >
                      {t("c.cancel")}
                    </button>
                  </div>
                </div>
              )
            )}
          </li>
        ))}
      </ul>
      {data.records.length > 0 && (
        <div className="mt-3" data-testid="historical-records">
          <p className="text-xs font-semibold text-slate-900">{t("h78.rec.title")}</p>
          <ul className="mt-1 space-y-1.5 text-xs text-slate-800">
            {data.records.map((r) => (
              <li key={r.id}>
                <span className="font-medium">
                  {r.bookingCode}
                  {r.creditNote ? ` · ${r.creditNote}` : ""} · {t("h78.rec.status")}
                </span>
                <br />
                {[
                  r.earlier ? t("h78.rec.earlier", { amount: money(r.earlier.amount), date: day(r.earlier.on), via: via(r.earlier.via), recorded: day(clock.day(r.recordedAt, r.venueId)) }) : "",
                  r.now ? t("h78.rec.now", { amount: money(r.now.amount), date: day(clock.day(r.now.paidOutAt ?? r.recordedAt, r.venueId)), via: via(r.now.via) }) : "",
                  r.remainder > 0 ? t("h78.rec.remainder", { amount: money(r.remainder), reason: r.remainderReason ?? "" }) : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
                <br />
                <span className="text-slate-600">{t("h78.rec.by", { by: r.verifiedBy, evidence: r.evidence, reason: r.reason })}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
