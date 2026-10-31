"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { StaffPhrase } from "@/lib/staff-i18n";
import type { SetupView } from "@/lib/guide/http";
import type { PlanItem } from "@/lib/guide/plan";
import { hasHistory } from "@/lib/guide/profile-types";
import type { JourneyView } from "@/lib/guide/setup-journey";
import type { DashboardTab } from "@/lib/guide/shell";
import { unanswered } from "@/lib/guide/setup-questions";
import { placeParam, setPlaceParams } from "../place";
import { useStaffT } from "../StaffLanguage";
import { SetupDiscovery } from "./SetupDiscovery";
import { SetupStepCard, STATE_PHRASES } from "./SetupStepCard";
import { fallbackExtras, loadJourney, writeGuide } from "./setup/api";
import { GROUP_PHRASES } from "./setup/tabs";

/**
 * The setup journey (docs/features/venue-guide.md#the-setup-journey; ADR 0028):
 * the tab's `setup` view.
 *
 * Two stages over the venue's real configuration. *Discovery*: a few
 * conditional questions about the business, on a venue's first visit or when
 * the manager asks to review them, never asking what the saved settings show.
 * *The plan*: the steps `buildSetupPlan` makes from the answers and the
 * venue's saved state, each a card whose action is the existing editor run
 * here or a link to the existing screen, with a sticky list of steps, a
 * counts-based progress line, and the launch readiness and *Try it* panels. A
 * venue with bookings sees what it has as done, is told that nothing is
 * changed unless it saves a change in that screen, and can start a targeted
 * journey for one capability (`?focus=`) without rerunning the whole plan.
 *
 * It owns no setting. What it reads comes from `GET /api/admin/guide/setup/journey`
 * on every change; what it saves is the manager's answers and reviews, and every
 * setting through the existing editor's own route.
 */

/** Where the journey is in the address, like the tab and the view: a reload, the Back button and a link land where it was. */
const param = (key: "focus" | "stage" | "step"): string | null => placeParam(key);

/** The starting points for an established venue: what each opens is a targeted journey. */
const ENTRY_POINTS: { focus: string; label: StaffPhrase }[] = [
  { focus: "activity-catalogue", label: "gs.entry.activity" },
  { focus: "programmes", label: "gs.entry.programme" },
  { focus: "branches", label: "gs.entry.branch" },
  { focus: "staff-invitations", label: "gs.entry.staff" },
  { focus: "policies", label: "gs.entry.policy" },
];

export function SetupPlanView({ data, onGo }: { data: SetupView; onGo: (tab: DashboardTab) => void }) {
  const t = useStaffT();
  const venueId = data.venueId;
  const [journey, setJourney] = useState<JourneyView | null>(null);
  const [focus, setFocusState] = useState<string | null>(() => param("focus"));
  const [stage, setStageState] = useState<"questions" | "plan">(() => {
    const asked = param("stage");
    if (asked === "questions" || asked === "plan") return asked;
    // A first visit to a venue with nothing set up and nothing said: the questions come first.
    return data.rev === 0 && !hasHistory(data.profile) && Object.keys(data.answers).length <= 1 ? "questions" : "plan";
  });
  const [current, setCurrent] = useState<string | null>(() => param("step"));
  const [focusNow, setFocusNow] = useState<string | null>(() => param("step"));
  const [navOpen, setNavOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const view: JourneyView = journey ?? { ...data, extras: fallbackExtras(data) };

  const reload = useCallback(async () => {
    const loaded = await loadJourney(venueId, focus, t);
    if (loaded.ok) {
      setJourney(loaded.view);
      setProblem(null);
    } else setProblem(loaded.error);
  }, [venueId, focus, t]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const setStage = (next: "questions" | "plan") => {
    setStageState(next);
    setPlaceParams({ stage: next });
  };
  const startFocus = (next: string | null) => {
    setFocusState(next);
    setJourney(null);
    setPlaceParams({ focus: next, step: null });
    setCurrent(null);
    setStageState("plan");
  };
  const goToStep = useCallback((id: string) => {
    setCurrent(id);
    setFocusNow(id);
    setNavOpen(false);
    setPlaceParams({ step: id });
    document.getElementById(`step-${id}`)?.scrollIntoView?.({ block: "start" });
  }, []);
  /** Leaving for the screen a step opens keeps the step in the address, so the browser's Back button and the guide tab come back to it. */
  const openScreen = (tab: DashboardTab, from: string) => {
    setPlaceParams({ step: from });
    onGo(tab);
  };

  const onView = (next: SetupView) => setJourney((prev) => ({ ...(prev ?? { ...data, extras: fallbackExtras(data) }), ...next, plan: focus ? (prev?.plan ?? next.plan) : next.plan, extras: prev?.extras ?? fallbackExtras(next) }));

  async function reviewed(step: string) {
    const saved = await writeGuide(venueId, { action: "acknowledge", step }, t);
    if (!saved.ok) return setProblem(saved.error);
    setProblem(null);
    // The answer is the unfocused setup view; a targeted journey reads its own plan again.
    if (focus) void reload();
    else onView(saved.view);
  }

  const plan = view.plan;
  const titles = useMemo(() => Object.fromEntries(plan.items.map((i) => [i.id, i.titleKey])) as Record<string, StaffPhrase>, [plan.items]);
  const history = hasHistory(view.profile);
  const requiredDone = plan.items.filter((i) => i.required && i.state.status === "done").length;
  const otherOpen = plan.items.filter((i) => !i.required && i.state.status !== "done").length;
  const firstOpen = plan.items.find((i) => i.state.status === "todo" || i.state.status === "review-needed");
  const here = current ?? firstOpen?.id ?? null;
  const focusName = focus ? (focus in GROUP_PHRASES ? t(GROUP_PHRASES[focus as keyof typeof GROUP_PHRASES]) : t.customer(`gcap.${focus}.title` as never)) : null;
  const toAsk = unanswered(view.profile, view.answers).length;

  return (
    <section aria-labelledby="guide-setup-heading" className="space-y-4" data-guide-setup data-stage={stage}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id="guide-setup-heading" className="text-xl font-semibold">
            {t("gs.heading")}
          </h3>
          <p className="mt-0.5 text-sm text-slate-600">{t("gs.intro")}</p>
        </div>
        {stage === "plan" && (
          <button type="button" onClick={() => setStage("questions")} className="min-h-10 rounded-md border border-slate-300 px-3 text-sm font-medium hover:border-teal-400">
            {t("gs.review")}
          </button>
        )}
      </div>

      {problem && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {problem}{" "}
          <button type="button" onClick={() => void reload()} className="underline">
            {t("q8b.tryAgain")}
          </button>
        </p>
      )}

      {history && (
        <p role="note" className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900" data-history-banner>
          {t("gs.history")}
        </p>
      )}

      {stage === "questions" ? (
        <SetupDiscovery view={view} onView={onView} onDone={() => setStage("plan")} />
      ) : focus && !journey ? (
        <p className="text-sm text-slate-500">{t("gd.loading")}</p>
      ) : (
        <>
          {focus ? (
            <p role="note" className="flex flex-wrap items-center gap-2 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-sm text-teal-900" data-focus={focus}>
              <span>{t("gs.focus.banner", { what: focusName ?? focus })}</span>
              <button type="button" onClick={() => startFocus(null)} className="min-h-8 underline">
                {t("gs.focus.all")}
              </button>
            </p>
          ) : (
            history && (
              <div className="space-y-1" data-entry-points>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("gs.entry.heading")}</p>
                <div className="flex flex-wrap gap-2">
                  {ENTRY_POINTS.map((e) => (
                    <button key={e.focus} type="button" onClick={() => startFocus(e.focus)} className="min-h-10 rounded-full border border-slate-300 px-3 text-sm hover:border-teal-400">
                      {t(e.label)}
                    </button>
                  ))}
                </div>
              </div>
            )
          )}

          {toAsk > 0 && !focus && (
            <p className="text-sm text-slate-600">
              {t("gs.unanswered", { n: toAsk })}{" "}
              <button type="button" onClick={() => setStage("questions")} className="min-h-8 underline hover:text-teal-700">
                {t("gs.answerNow")}
              </button>
            </p>
          )}

          <p className="text-base font-medium" data-progress>
            {plan.counts.requiredTotal > 0 ? t("gs.progress", { done: requiredDone, total: plan.counts.requiredTotal }) : t("gs.progress.none")}
            <span className="ml-2 text-sm font-normal text-slate-600">{t("gs.progress.other", { n: otherOpen })}</span>
          </p>

          {plan.groups.length === 0 && <p className="text-sm text-slate-500">{t("gd.plan.empty")}</p>}

          <div className="md:grid md:grid-cols-[15rem_minmax(0,1fr)] md:gap-6">
            <nav aria-label={t("gs.nav")} className="mb-4 md:sticky md:top-2 md:mb-0 md:max-h-[90vh] md:self-start md:overflow-y-auto" data-step-list>
              <button type="button" aria-expanded={navOpen} aria-controls="setup-step-list" onClick={() => setNavOpen(!navOpen)} className="min-h-10 w-full rounded-md border border-slate-300 px-3 text-left text-sm font-medium md:hidden">
                {t("gs.nav.toggle", { n: plan.items.length })}
              </button>
              <ol id="setup-step-list" className={`${navOpen ? "mt-2 block" : "hidden"} space-y-1 md:mt-0 md:block`}>
                {plan.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => goToStep(item.id)}
                      aria-current={here === item.id ? "step" : undefined}
                      className={`flex min-h-8 w-full items-start gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-slate-100 ${here === item.id ? "bg-teal-50 font-semibold" : ""}`}
                    >
                      <span aria-hidden>{item.state.status === "done" ? "✓" : item.state.status === "blocked" ? "⏸" : item.state.status === "review-needed" ? "!" : item.state.status === "optional" ? "◇" : "○"}</span>
                      <span>
                        {t(item.titleKey)}
                        <span className="sr-only"> ({t(STATE_PHRASES[item.state.status])})</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
            <div className="space-y-6">
              {plan.groups.map((group) => (
                <section key={group.group} aria-labelledby={`setup-group-${group.group}`}>
                  <h4 id={`setup-group-${group.group}`} className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
                    {t(GROUP_PHRASES[group.group])}
                  </h4>
                  <ul className="space-y-3">
                    {group.items.map((item: PlanItem) => (
                      <SetupStepCard
                        key={item.id}
                        item={item}
                        view={view}
                        titles={titles}
                        current={here === item.id}
                        focusNow={focusNow === item.id}
                        onChanged={() => void reload()}
                        onGo={openScreen}
                        onStep={goToStep}
                        onReviewed={(id) => void reviewed(id)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
