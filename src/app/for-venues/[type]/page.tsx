import { GlyphTile } from "@/components/Glyph";
import { BUSINESS_TONES } from "@/lib/icons/glyphs";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import FitGuide from "@/components/fit/FitGuide";
import { businessType } from "@/lib/guide/business-types";
import { typeName } from "@/lib/guide/public/present";
import { guideAddress, parseSelection, type Params } from "@/lib/guide/public/select";
import { fitView } from "@/lib/guide/public/view";
import { serverT } from "@/lib/locale";
import { isMarketplace } from "@/lib/mode";
import { siteOrigin } from "@/lib/seo";

/**
 * One kind of business: its own indexable page, server-rendered in the
 * visitor's language, with its own title, description and canonical address
 * (docs/features/venue-guide.md#the-public-guide). The same content as the
 * picker shows for that choice, from the same model. Writes nothing.
 */
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ type: string }>; searchParams: Promise<Params> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { type } = await params;
  const t = await serverT();
  const known = businessType(type);
  if (!known || !isMarketplace()) return { title: t("fit.title"), robots: { index: false, follow: false } };
  const name = typeName(t, known.id);
  return {
    title: t("fit.type.title", { type: name }),
    description: t("fit.type.desc", { type: name }),
    alternates: { canonical: `${await siteOrigin()}/for-venues/${known.id}` },
  };
}

export default async function ForVenueTypePage({ params, searchParams }: Props) {
  if (!isMarketplace()) notFound();
  const known = businessType((await params).type);
  if (!known) notFound();
  const t = await serverT();
  const selection = { types: [known.id], activities: parseSelection(await searchParams).activities };
  const view = fitView(selection);
  const name = typeName(t, known.id);
  return (
    <div className="mx-auto max-w-4xl space-y-8 py-2">
      <header className="max-w-2xl">
        <div className="flex items-center gap-3">
          <GlyphTile name={`business/${known.id}`} tone={BUSINESS_TONES[known.id]} size={48} />
          <h1 className="text-2xl font-bold">{t("fit.type.title", { type: name })}</h1>
        </div>
        <p className="mt-2 text-slate-600">{t("fit.type.desc", { type: name })}</p>
        <p className="mt-3 flex flex-wrap gap-x-4 text-sm">
          <Link href={guideAddress({ types: [known.id], activities: [] })} className="inline-flex min-h-9 items-center font-medium text-teal-800 underline">
            {t("fit.type.combine")}
          </Link>
          <Link href="/for-venues" className="inline-flex min-h-9 items-center font-medium text-teal-800 underline">
            {t("fit.type.all")}
          </Link>
        </p>
      </header>
      <FitGuide view={view} t={t} />
    </div>
  );
}
