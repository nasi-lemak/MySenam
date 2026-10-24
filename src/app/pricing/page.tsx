import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { defaultFee, freeMonths } from "@/lib/billing";
import { serverT } from "@/lib/locale";
import { isMarketplace } from "@/lib/mode";
import { planTiers } from "@/lib/plans";
import { whatsappConfig } from "@/lib/transports";
import { packPrice, packSize } from "@/lib/whatsapp-credit";
import { money } from "@/lib/region";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await serverT();
  return { title: t("pricing.title") };
}

const rm = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/**
 * What a venue pays, published: worked out from the same tiers and settings
 * the invoices use, so the page cannot say one thing and the bill another.
 */
export default async function PricingPage() {
  if (!isMarketplace()) notFound();
  const t = await serverT();
  const plan = await planTiers();
  const flat = defaultFee();
  const months = freeMonths();
  const whatsapp = whatsappConfig() !== null;

  const span = (from: number, to: number | null) =>
    to === null ? t("pricing.upward", { from }) : from === to && from === 1 ? t("pricing.one") : t("pricing.range", { from, to });

  return (
    <div className="mx-auto max-w-4xl space-y-8 py-2">
      <header className="max-w-2xl">
        <h1 className="text-2xl font-bold">{t("pricing.title")}</h1>
        <p className="mt-2 text-slate-600">
          {t(plan.tiers.length > 0 ? "pricing.intro" : flat > 0 ? "pricing.introFlat" : "pricing.introFree")}
        </p>
      </header>

      {plan.tiers.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {plan.tiers.map((tier, i) => {
            const from = i === 0 ? 1 : (plan.tiers[i - 1].upTo ?? 0) + 1;
            const last = i === plan.tiers.length - 1;
            return (
              <li key={tier.name} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <h2 className="font-semibold text-slate-700">{tier.name}</h2>
                <p className="mt-2 text-3xl font-bold text-teal-700">{money(tier.monthlyFee.toFixed(2))}</p>
                <p className="text-sm text-slate-500">{t("pricing.month")}</p>
                <p className="mt-2 text-sm text-slate-600">{span(from, tier.upTo)}</p>
                {last && plan.extraEach > 0 && (
                  <p className="text-sm text-slate-500">{t("pricing.extra", { fee: rm(plan.extraEach) })}</p>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-xl border border-slate-200 bg-white p-5 text-lg font-semibold">
          {flat > 0 ? t("pricing.flat", { fee: rm(flat) }) : t("pricing.free")}
        </p>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <section>
          <h2 className="font-bold">{t("pricing.included")}</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
            <li>{t("pricing.inc1")}</li>
            <li>{t("pricing.inc2")}</li>
            {whatsapp && <li>{t("pricing.inc3")}</li>}
            <li>{t("pricing.inc4")}</li>
          </ul>
        </section>
        <section>
          <h2 className="font-bold">{t("pricing.money")}</h2>
          <p className="mt-2 text-sm text-slate-700">{t("pricing.money1")}</p>
        </section>
        <section>
          <h2 className="font-bold">{t("pricing.terms")}</h2>
          <p className="mt-2 text-sm text-slate-700">
            {t("pricing.terms1", {
              months: months === 0 ? t("pricing.monthsNone") : months === 1 ? t("pricing.monthsOne") : t("pricing.monthsMany", { n: months }),
            })}
          </p>
          {plan.tiers.length > 0 && <p className="mt-1 text-sm text-slate-700">{t("pricing.terms2")}</p>}
        </section>
        {whatsapp && (
          <section>
            <h2 className="font-bold">{t("pricing.extras")}</h2>
            <p className="mt-2 text-sm text-slate-700">{t("pricing.whatsapp", { price: rm(packPrice()), n: packSize() })}</p>
          </section>
        )}
      </div>

      <Link
        href="/list-your-venue"
        className="inline-block rounded-lg bg-teal-600 px-5 py-2.5 font-semibold text-white hover:bg-teal-700"
      >
        {t("pricing.cta")}
      </Link>
    </div>
  );
}
