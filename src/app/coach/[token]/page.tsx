import { notFound } from "next/navigation";
import { serverT } from "@/lib/locale";
import { coachForToken, coachLessons } from "@/lib/coach-schedule";
import { addDays, formatHour, todayISO } from "@/lib/time";
import CoachSelfService from "@/components/CoachSelfService";
import CoachApprovals from "@/components/CoachApprovals";

export const dynamic = "force-dynamic";

/** A coach's own lessons, at the private link the venue gave them (lib/coach-schedule.ts). */
export default async function CoachSchedulePage({ params }: { params: Promise<{ token: string }> }) {
  const t = await serverT();
  const { token } = await params;
  const found = await coachForToken(token);
  if (!found) notFound();
  const today = todayISO(found.zone);
  const lessons = await coachLessons(found.coach.id, today, addDays(today, 30));
  const days = [...new Set(lessons.map((l) => l.date))];
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-xl font-bold">{t("coachpage.title", { name: found.coach.name, venue: found.venueName })}</h1>
      <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">{t("coachpage.private")}</p>
      <a href={`/api/coach-calendar/${token}.ics`} className="inline-block text-sm font-semibold text-teal-700 underline">
        📅 {t("coachpage.subscribe")}
      </a>
      <CoachApprovals token={token} />
      <CoachSelfService token={token} hours={found.coach.hours} timeOff={found.coach.timeOff} />
      {lessons.length === 0 ? (
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
                        {formatHour(l.startHour)}–{formatHour(l.endHour)}
                      </span>{" "}
                      · {l.court} · {l.student}
                      {!l.paid && <span className="text-amber-700"> · {t("coachpage.unpaid")}</span>}
                    </span>
                    <a href={`tel:${l.phone}`} className="text-teal-700 underline">
                      {l.phone}
                    </a>
                  </li>
                ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
