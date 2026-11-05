"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionView, QueueView, Reconciliation } from "@/lib/accounting-push";
import { money, region } from "@/lib/region";
import type { StaffPhrase, StaffT } from "@/lib/staff-i18n";
import { CATEGORY_PHRASES, methodText } from "./cash-up-words";
import { placeParam, setPlaceParams } from "./place";
import { todayLocal } from "./shared";
import { useStaffClock, useStaffT } from "./StaffLanguage";
import type { Category } from "@/lib/accounting";

/**
 * Reports, Accounting: the venue's live push of its sales to Xero (lib/accounting-push.ts; docs/integrations/xero.md). The
 * connection and what is sent (with the venue's acknowledgement), the mapping the manager sets, the queue (what is held
 * for mapping, what failed and why, retry), a start day for earlier sales with its preview, and the venue's totals checked
 * against what was sent. The export above it is unchanged and is still the way for SQL Account and AutoCount.
 */

interface ChartAccount {
  code: string;
  name: string;
  class: string;
  acceptsPayments: boolean;
}
interface ChartTax {
  type: string;
  name: string;
  rate: number;
}
type Entry = { code: string; name: string | null };
interface Data {
  connection: ConnectionView;
  mapping: { account: Record<string, Entry>; tax: Record<string, Entry>; payment: Record<string, Entry> };
  chart: { accounts: ChartAccount[]; taxRates: ChartTax[]; fetchedAt: string | null };
  keys: { account: string[]; owed: string[]; payment: string[]; tax: string[] };
  queue: QueueView;
}
type Kind = "account" | "tax" | "payment";

/** An amount in cents, with its two decimals, as money. */
const rm = (cents: number) => money(((cents < 0 ? -cents : cents) / 100).toFixed(2)).replace(/^/, cents < 0 ? "-" : "");

/** Why a sign-in at Xero did not finish: the codes the callback sends the dashboard back with (lib/accounting-push.ts `whyCode`). */
const WHY = ["declined", "other_person", "one_organisation", "currency", "sign_in", "bad_state"];

const card = "rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm";
const button = "rounded-md border border-slate-300 px-3 py-1.5 font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const primary = "rounded-md bg-teal-700 px-3 py-1.5 font-semibold text-white hover:bg-teal-800 disabled:opacity-50";

function needText(t: StaffT, need: string): string {
  const [kind, ...rest] = need.split(":");
  const key = rest.join(":");
  if (kind === "account") {
    const phrase = CATEGORY_PHRASES[key as Category];
    const what = phrase ? t(phrase) : key;
    return t(key === "Stored credit" || key === "Gift vouchers" ? "xr.need.accountOwed" : "xr.need.account", { what });
  }
  if (kind === "tax") return t("xr.need.tax", { what: key === "none" ? t("xr.tax.none") : t("xr.tax.rate", { rate: key.slice(5) }) });
  return t("xr.need.payment", { what: methodText(t, key === "none" ? null : key) });
}

function errorText(t: StaffT, code: string | null, detail: string | null): string {
  if (code === "rejected") return detail ? t("xr.err.rejected", { detail }) : t("xr.err.rejectedPlain");
  const phrase = code ? (`xr.err.${code}` as StaffPhrase) : null;
  return phrase && ["unavailable", "rate_limited", "unauthorised", "internal", "waiting_for_sale"].includes(code!) ? t(phrase) : t("xr.err.rejectedPlain");
}

export function AccountingPanel({ venueId, from, to }: { venueId: number; from: string; to: string }) {
  const t = useStaffT();
  const clock = useStaffClock();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [draft, setDraft] = useState<Record<Kind, Record<string, string>>>({ account: {}, tax: {}, payment: {} });
  const [startDay, setStartDay] = useState("");
  const [preview, setPreview] = useState<{ from: string; count: number; totalCents: number } | null>(null);
  const [recon, setRecon] = useState<Reconciliation | null>(null);

  const asked = useRef(0);
  const load = useCallback(async () => {
    const mine = ++asked.current;
    try {
      const res = await fetch(`/api/admin/accounting?venueId=${venueId}`, { cache: "no-store" });
      const body = await readJson(res);
      if (mine !== asked.current) return;
      if (!res.ok) throw new Error(t.err(body, t("xr.connectFailed")));
      // Only an answer of the right shape: anything else shows nothing rather than a half-drawn panel.
      if (body?.connection && body.queue) setData(body);
      setError(null);
    } catch (err) {
      if (mine === asked.current) setError(err instanceof Error ? err.message : t("xr.connectFailed"));
    }
  }, [venueId, t]);

  useEffect(() => {
    setData(null);
    setDraft({ account: {}, tax: {}, payment: {} });
    setPreview(null);
    setRecon(null);
    setNote(null);
    void load();
  }, [load]);

  // Back from Xero's consent screen: said once, and taken out of the address.
  useEffect(() => {
    const result = placeParam("xero");
    if (!result) return;
    // Only words the dashboard has: what the address says is chosen from a list, never shown as it came.
    const why = placeParam("why") ?? "";
    setNote(result === "connected" ? t("xr.flash.connected") : t("xr.flash.failed", { why: t(`xr.why.${WHY.includes(why) ? why : "bad_state"}` as StaffPhrase) }));
    setPlaceParams({ xero: null, why: null, venue: null });
  }, [t]);

  /** One request to the route; its answer's refusal in the staff language. */
  async function post(action: string, extra: Record<string, unknown>, failed: StaffPhrase): Promise<Record<string, unknown> | null> {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch("/api/admin/accounting", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ venueId, action, ...extra }) });
      const body = await readJson(res);
      if (!res.ok) throw new Error(t.err(body, t(failed)));
      return body;
    } catch (err) {
      setError(err instanceof Error ? err.message : t(failed));
      return null;
    } finally {
      setBusy(null);
    }
  }

  if (!data) return error ? <section className={card}><p role="alert" className="text-red-700">{error}</p></section> : null;
  const { connection, queue } = data;
  const connected = connection.status === "connected" || connection.status === "needs_reconnect";
  const available = connection.available.approved && connection.available.configured;

  async function connect() {
    const out = await post("connect", { acknowledged: agreed, noticeVersion: connection.noticeVersion }, "xr.connectFailed");
    if (out && typeof out.url === "string") window.location.assign(out.url);
  }

  async function disconnect() {
    if (!window.confirm(t("xr.disconnectConfirm"))) return;
    const out = await post("disconnect", {}, "xr.disconnectFailed");
    if (!out) return;
    setNote(out.revoked ? t("xr.disconnected") : t("xr.disconnectedLocal"));
    await load();
  }

  async function readChart() {
    const out = await post("chart", {}, "xr.map.readFailed");
    if (out) await load();
  }

  async function saveMapping() {
    const out = await post("mapping", draft, "xr.map.saveFailed");
    if (!out) return;
    setDraft({ account: {}, tax: {}, payment: {} });
    setNote(t("xr.map.saved"));
    await load();
  }

  async function sendNow() {
    const out = await post("send_now", {}, "xr.q.sendFailed");
    if (!out) return;
    const q = out.queue as QueueView;
    setNote(t("xr.q.result", { sent: Number(out.sent ?? 0), left: q.counts.queued + q.counts.held + q.counts.failed }));
    await load();
  }

  async function retry(id: number | null) {
    const out = await post("retry", id === null ? {} : { id }, "xr.q.retryFailed");
    if (out) await load();
  }

  async function check() {
    setPreview(null);
    const out = await post("preview_start", { from: startDay }, "xr.start.failed");
    if (out) setPreview(out.preview as { from: string; count: number; totalCents: number });
  }

  async function confirmStart() {
    if (!preview) return;
    const out = await post("start", { from: preview.from, count: preview.count, totalCents: preview.totalCents }, "xr.start.failed");
    if (!out) return;
    setPreview(null);
    setNote(t("xr.start.done", { n: Number(out.added ?? 0) }));
    await load();
  }

  async function reconcile() {
    setBusy("reconcile");
    setError(null);
    try {
      const res = await fetch(`/api/admin/accounting?venueId=${venueId}&reconcile=1&from=${from}&to=${to}`, { cache: "no-store" });
      const body = await readJson(res);
      if (!res.ok) throw new Error(t.err(body, t("xr.rec.failed")));
      setRecon(body.reconciliation as Reconciliation);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("xr.rec.failed"));
    } finally {
      setBusy(null);
    }
  }

  const choice = (kind: Kind, key: string) => draft[kind][key] ?? data.mapping[kind][key]?.code ?? "";
  const pick = (kind: Kind, key: string, code: string) => setDraft((d) => ({ ...d, [kind]: { ...d[kind], [key]: code } }));
  const dirty = (["account", "tax", "payment"] as Kind[]).some((k) => Object.keys(draft[k]).length > 0);

  const mapRow = (kind: Kind, key: string, label: string, options: { code: string; name: string }[]) => (
    <label key={`${kind}:${key}`} className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 py-1.5">
      <span className="min-w-[10rem]">{label}</span>
      <select
        aria-label={label}
        value={choice(kind, key)}
        onChange={(e) => pick(kind, key, e.target.value)}
        className="min-w-[12rem] max-w-full rounded-md border border-slate-300 px-2 py-1.5"
      >
        <option value="">{t("xr.map.choose")}</option>
        {options.map((o) => (
          <option key={o.code} value={o.code}>
            {o.code} {o.name}
          </option>
        ))}
        {/* A choice kept from before the list was read again stays shown rather than vanishing. */}
        {choice(kind, key) !== "" && !options.some((o) => o.code === choice(kind, key)) && <option value={choice(kind, key)}>{choice(kind, key)}</option>}
      </select>
    </label>
  );

  const incomeKeys = data.keys.account.filter((k) => !data.keys.owed.includes(k));
  const accountOptions = (cls: string) => data.chart.accounts.filter((a) => a.class === cls).map((a) => ({ code: a.code, name: a.name }));
  const taxOptions = (key: string) =>
    data.chart.taxRates
      .filter((r) => (key === "none" ? r.rate === 0 : Math.abs(r.rate - Number(key.slice(5))) <= 0.005))
      .map((r) => ({ code: r.type, name: r.name }));
  const stat = (n: number, phrase: StaffPhrase) => (
    <div key={phrase} className="min-w-[6rem]">
      <div className="text-xl font-semibold tabular-nums">{n}</div>
      <div className="text-xs text-slate-500">{t(phrase)}</div>
    </div>
  );

  return (
    <section className={`${card} space-y-4`} aria-labelledby="xr-title">
      <div>
        <h3 id="xr-title" className="font-semibold">
          {t("xr.title")}
        </h3>
        <p className="mt-1 text-xs text-slate-500">{t("xr.intro")}</p>
      </div>
      {note && (
        <p role="status" className="rounded-md bg-teal-50 px-3 py-2 text-teal-900">
          {note}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-red-800">
          {error}
        </p>
      )}

      {!connection.available.approved && <p className="text-slate-700">{t("xr.offInstall")}</p>}
      {connection.available.approved && !connection.available.configured && <p className="text-slate-700">{t("xr.notRegistered")}</p>}

      {available && (
        <>
          {connected ? (
            <div className="space-y-1">
              <p className="font-medium">{t("xr.connected", { org: connection.organisation ?? "" })}</p>
              <p className="text-xs text-slate-600">
                {t("xr.connectedBy", { when: connection.connectedAt ? clock.when(connection.connectedAt, venueId) : "", name: connection.connectedBy ?? "", date: connection.startDate ?? "" })}
              </p>
              <p className="text-xs text-slate-600">
                {t("xr.agreed", { when: connection.acknowledgedAt ? clock.when(connection.acknowledgedAt, venueId) : "", name: connection.acknowledgedBy ?? "", n: connection.noticeVersion })}
              </p>
              <p className="text-xs text-slate-600">{connection.lastOkAt ? t("xr.lastOk", { when: clock.when(connection.lastOkAt, venueId) }) : t("xr.neverSent")}</p>
              {connection.status === "needs_reconnect" && <p className="font-medium text-amber-800">{t("xr.needsReconnect")}</p>}
              {connection.pausedUntil && <p className="text-amber-800">{t("xr.paused", { when: clock.when(connection.pausedUntil, venueId) })}</p>}
              {connection.failingSince && <p className="text-amber-800">{t("xr.failingSince", { when: clock.when(connection.failingSince, venueId) })}</p>}
              <div className="flex flex-wrap gap-2 pt-1">
                <button type="button" className={button} onClick={() => void disconnect()} disabled={busy !== null}>
                  {t("xr.disconnect")}
                </button>
              </div>
            </div>
          ) : null}

          {(!connected || connection.status === "needs_reconnect") && (
            <div className="space-y-2 rounded-lg border border-slate-200 p-3">
              <h4 className="font-semibold">{t("xr.notice.title")}</h4>
              <p>{t("xr.notice.sends")}</p>
              <p>{t("xr.notice.never")}</p>
              <p>{t("xr.notice.where", { country: region().name })}</p>
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-1" />
                <span>{t("xr.notice.agree")}</span>
              </label>
              <p className="text-xs text-slate-500">{t("xr.notice.version", { n: connection.noticeVersion })}</p>
              <p className="text-xs text-slate-600">{t("xr.connectHelp")}</p>
              <button type="button" className={primary} onClick={() => void connect()} disabled={!agreed || busy !== null}>
                {busy === "connect" ? t("xr.connecting") : t("xr.connect")}
              </button>
            </div>
          )}
        </>
      )}

      {available && connection.status === "connected" && (
        <>
          <div className="space-y-2">
            <h4 className="font-semibold">{t("xr.q.title")}</h4>
            <div className="flex flex-wrap gap-4">
              {stat(queue.counts.sent, "xr.q.sent")}
              {stat(queue.counts.queued + queue.counts.sending - queue.counts.retrying, "xr.q.waiting")}
              {stat(queue.counts.retrying, "xr.q.retrying")}
              {stat(queue.counts.failed, "xr.q.failed")}
              {stat(queue.counts.held, "xr.q.held")}
              {stat(queue.counts.skipped, "xr.q.skipped")}
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={primary} onClick={() => void sendNow()} disabled={busy !== null}>
                {busy === "send_now" ? t("xr.q.sending") : t("xr.q.sendNow")}
              </button>
              {queue.counts.failed > 0 && (
                <button type="button" className={button} onClick={() => void retry(null)} disabled={busy !== null}>
                  {t("xr.q.retryAll")}
                </button>
              )}
            </div>
            {Object.entries(queue.skipped).length > 0 && (
              <ul className="list-disc pl-5 text-xs text-slate-600">
                {Object.entries(queue.skipped).map(([reason, n]) => (
                  <li key={reason}>{t(`xr.skip.${reason}` as StaffPhrase, { n })}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-1">
            <h4 className="font-semibold">{t("xr.held.title")}</h4>
            {queue.held.length === 0 ? (
              <p className="text-slate-600">{t("xr.held.none")}</p>
            ) : (
              <ul className="space-y-1">
                {queue.held.map((h) => (
                  <li key={h.id} className="rounded-md bg-amber-50 px-3 py-1.5">
                    <span className="font-medium">{h.number}</span> {h.day} {rm(h.grossCents)}{" "}
                    {h.kind === "credit_note" && <span className="text-xs text-slate-600">{t("xr.credit")}</span>}
                    <div className="text-xs text-slate-700">{t("xr.held.needs", { what: h.needs.map((n) => needText(t, n)).join(", ") })}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-1">
            <h4 className="font-semibold">{t("xr.failed.title")}</h4>
            {queue.failed.length === 0 ? (
              <p className="text-slate-600">{t("xr.failed.none")}</p>
            ) : (
              <ul className="space-y-1">
                {queue.failed.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-red-50 px-3 py-1.5">
                    <span>
                      <span className="font-medium">{f.number}</span> {f.day} {rm(f.grossCents)}{" "}
                      {f.kind === "credit_note" && <span className="text-xs text-slate-600">{t("xr.credit")}</span>}
                      <span className="block text-xs text-slate-700">{errorText(t, f.code, f.detail)}</span>
                    </span>
                    <button type="button" className={button} onClick={() => void retry(f.id)} disabled={busy !== null}>
                      {t("xr.q.retry")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2">
            <h4 className="font-semibold">{t("xr.map.title")}</h4>
            <p className="text-xs text-slate-600">{t("xr.map.intro")}</p>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={button} onClick={() => void readChart()} disabled={busy !== null}>
                {busy === "chart" ? t("xr.map.reading") : t("xr.map.load")}
              </button>
              <span className="text-xs text-slate-600">{data.chart.fetchedAt ? t("xr.map.readAt", { when: clock.when(data.chart.fetchedAt, venueId) }) : t("xr.map.notRead")}</span>
            </div>
            {data.chart.accounts.length + data.chart.taxRates.length > 0 && (
              <div className="space-y-3">
                <fieldset>
                  <legend className="font-medium">{t("xr.map.income")}</legend>
                  {incomeKeys.map((k) => mapRow("account", k, t(CATEGORY_PHRASES[k as Category] ?? "p8b.cat.other"), accountOptions("REVENUE")))}
                </fieldset>
                <fieldset>
                  <legend className="font-medium">{t("xr.map.owed")}</legend>
                  {data.keys.owed.map((k) => mapRow("account", k, t(CATEGORY_PHRASES[k as Category]), accountOptions("LIABILITY")))}
                </fieldset>
                <fieldset>
                  <legend className="font-medium">{t("xr.map.tax")}</legend>
                  {data.keys.tax.map((k) => mapRow("tax", k, k === "none" ? t("xr.tax.none") : t("xr.tax.rate", { rate: k.slice(5) }), taxOptions(k)))}
                </fieldset>
                <fieldset>
                  <legend className="font-medium">{t("xr.map.payment")}</legend>
                  {data.keys.payment.map((k) =>
                    mapRow(
                      "payment",
                      k,
                      methodText(t, k === "none" ? null : k),
                      data.chart.accounts.filter((a) => a.acceptsPayments).map((a) => ({ code: a.code, name: a.name }))
                    )
                  )}
                </fieldset>
                <button type="button" className={primary} onClick={() => void saveMapping()} disabled={!dirty || busy !== null}>
                  {t("xr.map.save")}
                </button>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <h4 className="font-semibold">{t("xr.start.title")}</h4>
            <p className="text-xs text-slate-600">{t("xr.start.intro")}</p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1">
                <span>{t("xr.start.from")}</span>
                <input
                  type="date"
                  value={startDay}
                  max={todayLocal()}
                  onChange={(e) => {
                    setStartDay(e.target.value);
                    setPreview(null);
                  }}
                  className="rounded-md border border-slate-300 px-2 py-1.5"
                />
              </label>
              <button type="button" className={button} onClick={() => void check()} disabled={!startDay || busy !== null}>
                {t("xr.start.preview")}
              </button>
            </div>
            {preview && (
              <div className="flex flex-wrap items-center gap-3">
                <span>{t("xr.start.result", { count: preview.count, total: rm(preview.totalCents) })}</span>
                <button type="button" className={primary} onClick={() => void confirmStart()} disabled={busy !== null || preview.count === 0}>
                  {t("xr.start.confirm")}
                </button>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <h4 className="font-semibold">{t("xr.rec.title")}</h4>
            <p className="text-xs text-slate-600">{t("xr.rec.intro")}</p>
            <button type="button" className={button} onClick={() => void reconcile()} disabled={busy !== null}>
              {t("xr.rec.run", { from, to })}
            </button>
            {recon && (
              <div className="space-y-1" role="status">
                {recon.differs ? (
                  <p className="font-medium text-red-800">
                    {t("xr.rec.differs", {
                      lcount: recon.ledger.count,
                      ltotal: rm(recon.ledger.grossCents),
                      ltax: rm(recon.ledger.taxCents),
                      scount: recon.sent.count,
                      stotal: rm(recon.sent.grossCents),
                      stax: rm(recon.sent.taxCents),
                      diff: rm(recon.ledger.grossCents - recon.sent.grossCents),
                    })}
                  </p>
                ) : (
                  <p className="font-medium text-teal-800">{t("xr.rec.same", { count: recon.sent.count, total: rm(recon.sent.grossCents), tax: rm(recon.sent.taxCents) })}</p>
                )}
                {(recon.waiting.queued > 0 || recon.waiting.held > 0 || recon.waiting.failed > 0) && (
                  <p>{t("xr.rec.waiting", { queued: recon.waiting.queued, held: recon.waiting.held, failed: recon.waiting.failed })}</p>
                )}
                {recon.days.length > 0 && (
                  <div>
                    <p className="text-xs text-slate-600">{t("xr.rec.days")}</p>
                    <ul className="list-disc pl-5 text-xs">
                      {recon.days.map((d) => (
                        <li key={d.day}>{t("xr.rec.day", { day: d.day, ledger: rm(d.ledgerGrossCents), sent: rm(d.sentGrossCents) })}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
