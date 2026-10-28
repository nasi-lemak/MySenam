"use client";

import { readJson } from "@/lib/read-response";
import { useEffect, useState } from "react";
import type { HoldPolicy } from "@/lib/holds";
import { DEPOSIT_PERCENTS } from "@/lib/types";
import { useStaffT } from "./StaffLanguage";

/**
 * Ask for payment online to hold a booking: the answer to slots lost to
 * people who never come. Off, a booking stands unpaid until the counter.
 */
export function HoldPolicyEditor({ venueId, canPayOnline }: { venueId: number; canPayOnline: boolean }) {
  const t = useStaffT();
  const [policy, setPolicy] = useState<HoldPolicy | null>(null);
  const [minutes, setMinutes] = useState("15");
  const [deposit, setDeposit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPolicy(null);
    void fetch(`/api/admin/hold-policy?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => readJson(r))
      .then((d: { policy?: HoldPolicy }) => {
        if (!d.policy) return;
        setPolicy(d.policy);
        setMinutes(String(d.policy.minutes));
        setDeposit(d.policy.depositPercent ? String(d.policy.depositPercent) : "");
      });
  }, [venueId, canPayOnline]);

  async function save(on: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/hold-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, on, minutes: Number(minutes), depositPercent: deposit ? Number(deposit) : null }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("hold.couldNotSave")));
      setPolicy(data.policy);
      setNotice(
        on
          ? data.policy.depositPercent
            ? t("hold.nowHeldDeposit", { minutes: data.policy.minutes, percent: data.policy.depositPercent })
            : t("hold.nowHeld", { minutes: data.policy.minutes })
          : t("hold.nowOff")
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t("hold.couldNotSave"));
    } finally {
      setBusy(false);
    }
  }

  if (!policy) return null;
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm">
      <h3 className="font-semibold">{t("hold.title")}</h3>
      <p className="mt-1 text-xs text-slate-500">{t("hold.intro")}</p>
      <p className="mt-1 text-xs text-slate-500">{t("hold.depositIntro")}</p>
      {!canPayOnline && <p className="mt-2 text-xs font-medium text-amber-700">{t("hold.setUpFirst")}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          {t("hold.holdFor")}
          <input
            type="number"
            min={5}
            max={60}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            className="w-16 rounded-md border border-slate-300 px-2 py-1"
          />
          {t("hold.minutes")}
        </label>
        <label className="flex items-center gap-2">
          {t("hold.customerPays")}
          <select value={deposit} onChange={(e) => setDeposit(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1">
            <option value="">{t("hold.wholePrice")}</option>
            {DEPOSIT_PERCENTS.map((p) => (
              <option key={p} value={p}>
                {t("hold.wholeOrDeposit", { percent: p })}
              </option>
            ))}
          </select>
        </label>
        {policy.on ? (
          <>
            <button disabled={busy} onClick={() => save(true)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold">
              {t("c.save")}
            </button>
            <button disabled={busy} onClick={() => save(false)} className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-600">
              {t("hold.turnOff")}
            </button>
          </>
        ) : (
          <button
            disabled={busy || !canPayOnline}
            onClick={() => save(true)}
            className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {t("hold.turnOn")}
          </button>
        )}
        <span className={`text-xs font-semibold ${policy.active ? "text-emerald-700" : "text-slate-500"}`}>
          {policy.active ? t("hold.statusOn") : policy.on ? t("hold.statusNoPay") : t("hold.statusOff")}
        </span>
      </div>
      {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-2 text-sm font-medium text-emerald-700">{notice}</p>}
    </div>
  );
}
