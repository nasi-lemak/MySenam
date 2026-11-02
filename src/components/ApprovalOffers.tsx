import Link from "next/link";
import { requirementsAt } from "@/lib/approvals";
import { ActivityGlyph } from "@/components/Glyph";
import { sportLabel, type T } from "@/lib/i18n";

/**
 * On a venue's page: the activities here that need the venue's approval
 * first, each with a link to apply online (lib/approvals.ts), so nobody has
 * to come to the counter just to register.
 */
export default async function ApprovalOffers({ t, venueId }: { t: T; venueId: number }) {
  const open = await requirementsAt(venueId, { openOnly: true });
  if (open.length === 0) return null;
  return (
    <section className="rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-900">
      <p className="font-semibold">{t("apr.offersTitle")}</p>
      <p className="mt-0.5 text-violet-800">{t("apr.offersIntro")}</p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {open.map((r) => (
          <li key={r.id}>
            <Link
              href={`/account/approvals?venueId=${venueId}&sport=${encodeURIComponent(r.sport)}`}
              className="inline-block rounded-full border border-violet-300 bg-white px-3 py-1 font-medium text-violet-800 hover:bg-violet-100"
            >
              <ActivityGlyph sport={r.sport} /> {t("apr.offersApply", { activity: sportLabel(t, r.sport) })}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
