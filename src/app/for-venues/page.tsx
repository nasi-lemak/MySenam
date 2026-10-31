import type { Metadata } from "next";
import { notFound } from "next/navigation";
import FitGuide from "@/components/fit/FitGuide";
import FitPicker from "@/components/fit/FitPicker";
import { fitView } from "@/lib/guide/public/view";
import { isEmptySelection, parseSelection, type Params } from "@/lib/guide/public/select";
import { serverT } from "@/lib/locale";
import { isMarketplace } from "@/lib/mode";
import { siteOrigin } from "@/lib/seo";

/**
 * How MySenam fits your business: a picker of the kinds of business and a
 * tailored explanation for the choice (docs/features/venue-guide.md#the-public-guide).
 *
 * The choice is in the address (`?types=a,b&activities=x`), so the page is
 * the same for the same address, works with no script and writes nothing:
 * no cookie, no record. Only a marketplace has it, as it alone takes venues.
 * In the visitor's language, which is why it is rendered for each request
 * rather than built once. The bare page is the one to index; a choice is a
 * view of the same content and points back to it.
 */
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Params> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const t = await serverT();
  const chosen = !isEmptySelection(parseSelection(await searchParams));
  return {
    title: t("fit.title"),
    description: t("fit.metaDesc"),
    alternates: { canonical: `${await siteOrigin()}/for-venues` },
    ...(chosen ? { robots: { index: false, follow: true } } : {}),
  };
}

export default async function ForVenuesPage({ searchParams }: Props) {
  if (!isMarketplace()) notFound();
  const t = await serverT();
  const selection = parseSelection(await searchParams);
  const view = fitView(selection);
  return (
    <div className="mx-auto max-w-4xl space-y-8 py-2">
      <header className="max-w-2xl">
        <h1 className="text-2xl font-bold">{t("fit.title")}</h1>
        <p className="mt-2 text-slate-600">{t("fit.lead")}</p>
      </header>
      <FitPicker selection={selection} t={t} showCards={view.empty} />
      {!view.empty && <FitGuide view={view} t={t} />}
    </div>
  );
}
