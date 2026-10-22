"use client";

import { useState } from "react";
import Link from "next/link";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import type { MembershipPlan } from "@/lib/membership-plans";
import type { Renewal } from "@/lib/payments";
import { money } from "@/lib/region";

/** Where this visitor stands, worked out on the server. */
export type JoinStanding =
  | { kind: "signIn" }
  | { kind: "noPhone" }
  | { kind: "join" }
  | { kind: "renew"; until: string }
  | { kind: "early"; until: string; from: string };

/** A venue's membership plans, joined or renewed online and paid to the venue. */
export default function JoinMembership({
  venueId,
  plans,
  standing,
  canAutoRenew = false,
  renewal = null,
}: {
  venueId: number;
  plans: MembershipPlan[];
  standing: JoinStanding;
  /** The venue's gateway can charge each period by itself. */
  canAutoRenew?: boolean;
  /** This visitor's membership here already renews itself. */
  renewal?: Renewal | null;
}) {
  const t = useT();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoRenew, setAutoRenew] = useState(false);
  const [renewing, setRenewing] = useState(renewal);
  const [stopped, setStopped] = useState(false);

  async function stop() {
    if (!renewing) return;
    setError(null);
    try {
      const res = await fetch(`/api/my/membership?renewal=${renewing.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("pay.failed"));
      setRenewing(null);
      setStopped(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pay.failed"));
    }
  }

  async function pay(planId: number) {
    setBusy(planId);
    setError(null);
    try {
      const res = await fetch("/api/my/membership", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, autoRenew: canAutoRenew && autoRenew }),
      });
      const data = await res.json();
      if (!res.ok || typeof data.url !== "string") throw new Error(translateError(t, data) || t("pay.failed"));
      window.location.assign(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pay.failed"));
      setBusy(null);
    }
  }

  const canPay = (standing.kind === "join" || standing.kind === "renew") && !renewing;
  return (
    <section className="rounded-xl border border-violet-200 bg-white px-4 py-3 text-sm shadow-sm">
      <h2 className="font-semibold text-violet-900">
        🎟️ {standing.kind === "renew" || standing.kind === "early" ? t("member.renewTitle") : t("member.joinTitle")}
      </h2>
      <p className="mt-0.5 text-slate-600">
        {standing.kind === "renew"
          ? t("member.renewBody", { until: standing.until })
          : standing.kind === "early"
            ? t("member.earlyBody", { until: standing.until, from: standing.from })
            : t("member.joinBody")}
      </p>
      <ul className="mt-2 space-y-1.5">
        {plans.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <span className="font-medium">{p.name}</span>{" "}
              <span className="text-slate-500">· {t.plural("member.months", p.months)}</span>
              {/* A tier's own benefits, where it has them. */}
              {p.ratePercent !== null && <span className="text-violet-700"> · {t("member.tierRate", { pct: 100 - p.ratePercent })}</span>}
              {p.aheadDays !== null && <span className="text-violet-700"> · {t("member.tierAhead", { n: p.aheadDays })}</span>}
            </span>
            {canPay ? (
              <button
                onClick={() => pay(p.id)}
                disabled={busy !== null}
                className="rounded-lg bg-violet-600 px-3 py-1.5 font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
              >
                {t(standing.kind === "renew" ? "member.renew" : "member.join", { price: p.price })}
              </button>
            ) : (
              <span className="font-semibold">{money(p.price)}</span>
            )}
          </li>
        ))}
      </ul>
      {standing.kind === "signIn" && (
        <Link
          href={`/login?next=${encodeURIComponent(`/venue/${venueId}`)}`}
          className="mt-2 inline-block font-semibold text-violet-800 underline"
        >
          {t("member.signIn")}
        </Link>
      )}
      {standing.kind === "noPhone" && (
        <Link href="/account" className="mt-2 inline-block font-semibold text-violet-800 underline">
          {t("member.noPhone")}
        </Link>
      )}
      {canPay && canAutoRenew && (
        <label className="mt-2 flex items-center gap-2 text-slate-700">
          <input type="checkbox" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} />
          {t("member.autoRenew")}
        </label>
      )}
      {renewing && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-slate-700">
          <span>{t("member.renewing", { until: renewing.until ?? "—" })}</span>
          <button onClick={stop} className="font-semibold text-violet-800 underline">
            {t("member.stopRenewing")}
          </button>
        </div>
      )}
      {stopped && <p className="mt-2 text-emerald-700">{t("member.stopped")}</p>}
      {canPay && <p className="mt-2 text-xs text-slate-500">{t("member.how")}</p>}
      {error && <p className="mt-1 text-xs font-medium text-red-700">{error}</p>}
    </section>
  );
}
