import { notFound } from "next/navigation";
import Link from "next/link";
import { currentLocale, currentSiteName } from "@/lib/locale";
import { translator } from "@/lib/i18n";
import { LanguageProvider } from "@/components/Language";
import { PlaybookDocument } from "@/components/admin/guide/PlaybookDocument";
import { coachForToken } from "@/lib/coach-schedule";
import { coachPlaybook } from "@/lib/guide/playbook/server";
import { staffLocale, staffTranslator } from "@/lib/staff-i18n";

export const dynamic = "force-dynamic";

/**
 * A coach's guide, at the same private link as their schedule
 * (`/coach/<token>/guide`; docs/features/venue-guide.md, "The operating
 * playbook"): how to use their page, their hours and days off, and exactly what
 * they can and cannot see. The link is checked as the schedule's is (a wrong,
 * lapsed or withdrawn one is the same not-found), and the guide is built from
 * what is the coach's own: their venue's saved configuration for what the
 * venue offers, and their own lessons and hours. Nothing about money and
 * nothing about anybody else's people.
 *
 * In the coach's own language where they chose one among those the staff
 * dictionaries have (English, Malay, Chinese), else the install's first staff
 * language: the staff dictionaries have no Tamil.
 */
export default async function CoachGuidePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const found = await coachForToken(token);
  if (!found) notFound();
  const site = await currentSiteName();
  const t = translator(found.locale ?? (await currentLocale()), site);
  const staff = staffTranslator(staffLocale(t.locale), site);
  const playbook = await coachPlaybook(found);
  return (
    <LanguageProvider locale={t.locale} site={site}>
      <div className="mx-auto max-w-2xl space-y-4">
        <p className="text-sm print:hidden">
          <Link href={`/coach/${token}`} className="font-semibold text-teal-700 underline">
            {staff("gp.ui.coachBack")}
          </Link>
        </p>
        <h1 className="text-xl font-bold print:hidden">{staff("gp.ui.coachTitle")}</h1>
        <PlaybookDocument playbook={playbook} />
      </div>
    </LanguageProvider>
  );
}
