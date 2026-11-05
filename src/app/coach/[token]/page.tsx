import { notFound } from "next/navigation";
import { currentLocale, currentSiteName } from "@/lib/locale";
import { translator } from "@/lib/i18n";
import { LanguageProvider } from "@/components/Language";
import CoachLanguage from "@/components/CoachLanguage";
import { coachForToken, coachLessons } from "@/lib/coach-schedule";
import { coachClasses } from "@/lib/class-coaches";
import { clockRange } from "@/lib/region";
import { addDays, formatHour, todayISO } from "@/lib/time";
import CoachSelfService from "@/components/CoachSelfService";
import Link from "next/link";
import { linkIn } from "@/lib/link-locale";
import { staffLocale, staffTranslator } from "@/lib/staff-i18n";

export const dynamic = "force-dynamic";

/**
 * A coach's own lessons, at the private link the venue gave them
 * (lib/coach-schedule.ts), in the coach's own language where they chose one,
 * else the one the visitor reads the site in.
 */
export default async function CoachSchedulePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const found = await coachForToken(token);
  if (!found) notFound();
  const site = await currentSiteName();
  const t = translator(found.locale ?? (await currentLocale()), site);
  const today = todayISO(found.zone);
  const lessons = await coachLessons(found.coach.id, today, addDays(today, 30));
  const classes = await coachClasses(found.coach.id, today, addDays(today, 30));
  const days = [...new Set([...lessons.map((l) => l.date), ...classes.map((c) => c.date)])].sort();
  return (
    <LanguageProvider locale={t.locale} site={site}>
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-xl font-bold">{t("coachpage.title", { name: found.coach.name, venue: found.venueName })}</h1>
      <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">{t("coachpage.private")}</p>
      {/* The feed in the language this page is read in (lib/coach-schedule.ts `coachFeedLocale`). */}
      <a href={linkIn(`/api/coach-calendar/${token}.ics`, t.locale)} className="inline-block text-sm font-semibold text-teal-700 underline">
        📅 {t("coachpage.subscribe")}
      </a>
      {/* Applications are reviewed signed in to the coach's own account, never at this link (ADR 0020). */}
      <p className="text-sm text-slate-600">
        {t("apr.coachSignIn")}{" "}
        <Link href="/account/approvals" className="font-semibold text-teal-700 underline">
          {t("apr.coachSignInLink")}
        </Link>
      </p>
      {/* What this page does, and what the coach can and cannot see (lib/guide/playbook). */}
      <p className="text-sm">
        <Link href={`/coach/${token}/guide`} className="font-semibold text-teal-700 underline">
          {staffTranslator(staffLocale(t.locale), site)("gp.ui.coachLink")}
        </Link>
      </p>
      <CoachLanguage token={token} chosen={found.locale} />
      <CoachSelfService token={token} hours={found.coach.hours} timeOff={found.coach.timeOff} />
      {lessons.length === 0 && classes.length === 0 ? (
        <p className="text-sm text-slate-600">{t("coachpage.none")}</p>
      ) : (
        days.map((d) => (
          <section key={d} className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
            <h2 className="font-semibold">{d}</h2>
            <ul className="mt-2 space-y-2">
              {lessons
                .filter((l) => l.date === d)
                .map((l) => (
                  <li key={l.code} className="flex flex-wrap justify-between gap-2">
                    <span>
                      <span className="font-medium">
                        {formatHour(l.startHour, t.locale)}–{formatHour(l.endHour, t.locale)}
                      </span>{" "}
                      · {l.court} · {l.student}
                      {!l.paid && <span className="text-amber-700"> · {t("coachpage.unpaid")}</span>}
                    </span>
                    <a href={`tel:${l.phone}`} className="text-teal-700 underline">
                      {l.phone}
                    </a>
                  </li>
                ))}
              {classes
                .filter((c) => c.date === d)
                .map((c) => (
                  <li key={`class-${c.id}`}>
                    <span className="font-medium">{clockRange(c.startMin, c.endMin, t.locale)}</span> ·{" "}
                    {t("clsa.coach.line", { name: c.name, court: c.court, enrolled: c.enrolled, capacity: c.capacity })}
                  </li>
                ))}
            </ul>
          </section>
        ))
      )}
    </div>
    </LanguageProvider>
  );
}
