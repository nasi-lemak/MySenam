"use client";

import { useState } from "react";
import Link from "next/link";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import type { MembershipPlan } from "@/lib/membership-plans";
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
}: {
  venueId: number;
  plans: MembershipPlan[];
  standing: JoinStanding;
}) {
  const t = useT();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pay(planId: number) {
    setBusy(planId);
    setError(null);
    try {
      const res = await fetch("/api/my/membership", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
      });
      const data = await res.json();
      if (!res.ok || typeof data.url !== "string") throw new Error(translateError(t, data) || t("pay.failed"));
      window.location.assign(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pay.failed"));
      setBusy(null);
    }
  }

  const canPay = standing.kind === "join" || standing.kind === "renew";
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
      {canPay && <p className="mt-2 text-xs text-slate-500">{t("member.how")}</p>}
      {error && <p className="mt-1 text-xs font-medium text-red-700">{error}</p>}
    </section>
  );
}
