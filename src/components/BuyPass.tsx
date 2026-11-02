"use client";

import { readJson } from "@/lib/read-response";
import { useState } from "react";
import Link from "next/link";
import { useT } from "@/components/Language";
import { hasPhrase, sportLabel, translateError, type Phrase, type T } from "@/lib/i18n";
import type { PassProduct } from "@/lib/pass-products";

/** Where this visitor stands for buying online, worked out on the server. */
export type PassStanding = "signIn" | "noPhone" | "ok";

/** Somebody this account acts for now, for whom a pass for one person's place can be bought. */
export interface PassPerson {
  id: number;
  name: string;
}

/** A refusal about buying a pass, in the customer's language: by its code where it has one. */
function explain(t: T, body: { error?: string; code?: string; vars?: Record<string, string | number> } | null): string {
  if (body?.code && hasPhrase(`pso.err.${body.code}`)) return t(`pso.err.${body.code}` as Phrase, body.vars);
  return translateError(t, body as { error: string }) || t("pay.failed");
}

/** What a pass spends, how long it lasts and what it pays for, in the customer's words. */
export function passTerms(t: T, p: PassProduct): string[] {
  const out = [
    p.kind === "time"
      ? t("pso.hours", { hours: Math.round((p.entries / 60) * 100) / 100 })
      : p.entryMinutes
        ? t("pso.entriesOf", { n: p.entries, minutes: p.entryMinutes })
        : t("pso.entries", { n: p.entries }),
    t("pso.valid", { n: p.validDays }),
  ];
  if (p.maxMinutes) out.push(t("pso.maxLength", { minutes: p.maxMinutes }));
  if (p.sport) out.push(t("pso.sport", { sport: sportLabel(t, p.sport) }));
  if (p.coachName) out.push(t("pso.coach", { name: p.coachName }));
  out.push(t(`pso.scope.${p.scope}` as Phrase));
  return out;
}

/**
 * The venue's passes sold online, each with its price, what it spends, how
 * long it lasts and what it covers, bought by a signed-in customer and paid
 * to the venue on its own payment page (lib/pass-purchases.ts). A pass for one
 * person's place can be bought for somebody the account looks after. The pass
 * is issued once it is paid.
 */
export default function BuyPass({
  venueId,
  products,
  standing,
  people = [],
}: {
  venueId: number;
  products: PassProduct[];
  standing: PassStanding;
  /** The people this account looks after now. */
  people?: PassPerson[];
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [forWhom, setForWhom] = useState<number | null>(null);

  async function buy(p: PassProduct, participantId: number | null) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/my/passes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, productId: p.id, ...(participantId !== null ? { participantId } : {}) }),
      });
      const data = await readJson(res);
      if (!res.ok || typeof data.url !== "string") throw new Error(explain(t, data));
      window.location.assign(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pay.failed"));
      setBusy(false);
    }
  }

  function choose(p: PassProduct) {
    setError(null);
    // Only a pass for one person's place can be somebody else's; with nobody to choose, it is the buyer's own.
    if (p.scope !== "participant" || people.length === 0) return void buy(p, null);
    setChosen(p.id);
    setForWhom(null);
  }

  return (
    <section className="rounded-xl border border-teal-200 bg-white px-4 py-3 text-sm shadow-sm">
      <h2 className="font-semibold text-teal-900">🎫 {t("pso.title")}</h2>
      <p className="mt-0.5 text-slate-600">{t("pso.intro")}</p>
      <ul className="mt-2 space-y-2">
        {products.map((p) => (
          <li key={p.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <span className="font-medium">{p.name}</span>
                <span className="block text-xs text-slate-500">{passTerms(t, p).join(" · ")}</span>
              </span>
              {standing === "ok" && chosen !== p.id ? (
                <button
                  onClick={() => choose(p)}
                  disabled={busy}
                  className="min-h-6 rounded-lg bg-teal-600 px-3 py-1.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                >
                  {t("pso.buy", { price: p.price })}
                </button>
              ) : (
                chosen !== p.id && <span className="font-semibold">{t("pso.price", { price: p.price })}</span>
              )}
            </div>
            {chosen === p.id && (
              <div className="mt-2 rounded-lg border border-teal-100 bg-teal-50/50 p-3">
                <fieldset>
                  <legend className="font-medium text-slate-700">{t("pso.whoFor")}</legend>
                  <div className="mt-1 flex flex-wrap gap-3">
                    <label className="flex items-center gap-1.5">
                      <input type="radio" name={`pass-for-${p.id}`} checked={forWhom === null} onChange={() => setForWhom(null)} />
                      {t("pso.me")}
                    </label>
                    {people.map((x) => (
                      <label key={x.id} className="flex items-center gap-1.5">
                        <input type="radio" name={`pass-for-${p.id}`} checked={forWhom === x.id} onChange={() => setForWhom(x.id)} />
                        {x.name}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <button
                  onClick={() => buy(p, forWhom)}
                  disabled={busy}
                  className="mt-2 min-h-6 rounded-lg bg-teal-600 px-3 py-1.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                >
                  {t("pso.buy", { price: p.price })}
                </button>
                <button onClick={() => setChosen(null)} className="ml-3 mt-2 min-h-6 text-xs text-slate-500 underline">
                  {t("pso.cancel")}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-slate-500">{t("pso.rules")}</p>
      {standing === "signIn" && (
        <Link href={`/login?next=${encodeURIComponent(`/venue/${venueId}`)}`} className="mt-2 inline-block font-semibold text-teal-800 underline">
          {t("pso.signIn")}
        </Link>
      )}
      {standing === "noPhone" && (
        <Link href="/account" className="mt-2 inline-block font-semibold text-teal-800 underline">
          {t("pso.noPhone")}
        </Link>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs font-medium text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
