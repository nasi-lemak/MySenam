"use client";

import { readJson } from "@/lib/read-response";
import { useEffect, useState } from "react";
import type { CancelPolicy } from "@/lib/cancel-policy";
import { useStaffT } from "./StaffLanguage";
import { HelpTip } from "./guide/HelpTip";

/**
 * What a late cancellation or a no-show costs here: whether customers may
 * still cancel online after the cutoff, for a share of the price, and how
 * many strikes before a number pays online to book.
 */
export function CancelPolicyEditor({ venueId }: { venueId: number }) {
  const t = useStaffT();
  const [policy, setPolicy] = useState<CancelPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPolicy(null);
    void fetch(`/api/admin/cancel-policy?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => readJson(r))
      .then((d: { policy?: CancelPolicy }) => setPolicy(d.policy ?? null));
  }, [venueId]);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/cancel-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, ...policy }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("cxl.couldNotSave")));
      setPolicy(data.policy);
      setNotice(t("c.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("cxl.couldNotSave"));
    } finally {
      setBusy(false);
    }
  }

  if (!policy) return null;
  const input = "w-16 rounded-md border border-slate-300 px-2 py-1 text-sm";
  const num = (v: string) => (v === "" ? null : Number(v));
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold">{t("cxl.title")}</h3>
        <HelpTip place="venues.cancellation" venueId={venueId} />
      </div>
      <p className="mt-1 text-xs text-slate-500">{t("cxl.intro")}</p>
      <label className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="checkbox"
          checked={policy.lateKeep !== null}
          onChange={(e) => setPolicy({ ...policy, lateKeep: e.target.checked ? 50 : null })}
        />
        {t("cxl.lateKeepBefore")}
        <input
          type="number"
          min={0}
          max={100}
          aria-label={t("cxl.percentKept")}
          disabled={policy.lateKeep === null}
          value={policy.lateKeep ?? ""}
          onChange={(e) => setPolicy({ ...policy, lateKeep: num(e.target.value) })}
          className={input}
        />
        {t("cxl.lateKeepAfter")}
      </label>
      <p className="ml-6 text-xs text-slate-500">{t("cxl.lateKeepNote")}</p>
      {/* With no late cancelling for a share back: whether a court may still be given back, nothing refunded (lib/cancel-policy.ts). */}
      {policy.lateKeep === null && (
        <>
          <label className="mt-3 flex flex-wrap items-center gap-2">
            <input type="checkbox" checked={policy.giveBack} onChange={(e) => setPolicy({ ...policy, giveBack: e.target.checked })} />
            {t("q8a.cxl.giveBack")}
          </label>
          <p className="ml-6 text-xs text-slate-500">{t("q8a.cxl.giveBackNote")}</p>
        </>
      )}
      <label className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="checkbox"
          checked={policy.strikeLimit !== null}
          onChange={(e) => setPolicy({ ...policy, strikeLimit: e.target.checked ? 3 : null })}
        />
        {t("cxl.strikesBefore")}
        <input
          type="number"
          min={1}
          max={20}
          aria-label={t("cxl.strikes")}
          disabled={policy.strikeLimit === null}
          value={policy.strikeLimit ?? ""}
          onChange={(e) => setPolicy({ ...policy, strikeLimit: num(e.target.value) })}
          className={input}
        />
        {t("cxl.strikesMiddle")}
        <input
          type="number"
          min={7}
          max={365}
          aria-label={t("cxl.days")}
          disabled={policy.strikeLimit === null}
          value={policy.strikeDays}
          onChange={(e) => setPolicy({ ...policy, strikeDays: Number(e.target.value) })}
          className={input}
        />
        {t("cxl.strikesAfter")}
      </label>
      <p className="ml-6 text-xs text-slate-500">{t("cxl.strikesNote")}</p>
      <label className="mt-3 flex flex-wrap items-center gap-2">
        {t("cxl.onlineRefundsLabel")}
        <select
          aria-label={t("cxl.onlineRefunds")}
          value={policy.onlineRefunds}
          onChange={(e) => setPolicy({ ...policy, onlineRefunds: e.target.value as CancelPolicy["onlineRefunds"] })}
          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
        >
          <option value="staff">{t("cxl.refundStaff")}</option>
          <option value="gateway">{t("cxl.refundGateway")}</option>
          <option value="credit">{t("cxl.refundCredit")}</option>
        </select>
      </label>
      <label className="mt-2 flex flex-wrap items-center gap-2">
        {t("cxl.refundDaysBefore")}
        <input
          type="number"
          min={1}
          max={30}
          aria-label={t("cxl.refundDays")}
          value={policy.refundWithinDays}
          onChange={(e) => setPolicy({ ...policy, refundWithinDays: Number(e.target.value) })}
          className={input}
        />
        {t("cxl.refundDaysAfter")}
      </label>
      <p className="ml-0 text-xs text-slate-500">{t("cxl.refundNote")}</p>
      <button
        disabled={busy}
        onClick={save}
        className="mt-3 rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
      >
        {t("c.save")}
      </button>
      {error && <p className="mt-2 text-xs font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-2 text-xs text-emerald-700">{notice}</p>}
    </div>
  );
}
