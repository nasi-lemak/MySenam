"use client";

import { useEffect, useRef, useState } from "react";
import type { StaffPhrase } from "@/lib/staff-i18n";
import type { PlanItem, ProposalNature, StepStatus } from "@/lib/guide/plan";
import type { JourneyView } from "@/lib/guide/setup-journey";
import type { DashboardTab } from "@/lib/guide/shell";
import { useStaffT } from "../StaffLanguage";
import { ACTIONS, ALWAYS_SHOWN } from "./setup/actions";
import { renderSay } from "./setup/say";
import { TAB_PHRASES } from "./setup/tabs";

/**
 * One step of the setup plan as a card (docs/features/venue-guide.md#the-setup-journey):
 * its title; why the venue is shown it; its state in words and an icon (never
 * colour alone); whether what it proposes is a recommendation, a setting
 * already saved, a rule the platform always enforces or the operator's own
 * choice; a short explanation with the longer one folded away; what saving
 * will do before a consequential choice; and the action, which is the existing
 * editor run here, or a link to the existing screen.
 */

export const STATE_PHRASES: Record<StepStatus, StaffPhrase> = {
  done: "gd.state.done",
  todo: "gd.state.todo",
  optional: "gd.state.optional",
  "review-needed": "gd.state.reviewNeeded",
  blocked: "gd.state.blocked",
};

const STATE_ICONS: Record<StepStatus, string> = { done: "✓", todo: "○", optional: "◇", "review-needed": "!", blocked: "⏸" };

const NATURE_PHRASES: Record<ProposalNature, StaffPhrase> = {
  recommendation: "gs.nature.recommendation",
  saved: "gs.nature.saved",
  choice: "gs.nature.choice",
};

export function SetupStepCard({
  item,
  view,
  titles,
  current,
  focusNow,
  onChanged,
  onGo,
  onStep,
  onReviewed,
}: {
  item: PlanItem;
  view: JourneyView;
  /** Titles of the steps in the plan, for naming what a blocked step waits for. */
  titles: Record<string, StaffPhrase>;
  /** The step the journey is on (`aria-current`). */
  current: boolean;
  /** Move focus to this step's heading: set when the manager goes to it, never on first load. */
  focusNow: boolean;
  onChanged: () => void;
  onGo: (tab: DashboardTab, from: string) => void;
  onStep: (id: string) => void;
  onReviewed: (id: string) => void;
}) {
  const t = useStaffT();
  const heading = useRef<HTMLHeadingElement>(null);
  const Action = item.action ? ACTIONS[item.action] : null;
  const shown = item.action !== null && ALWAYS_SHOWN.includes(item.action);
  const [open, setOpen] = useState(false);
  const blocked = item.state.status === "blocked";
  const unverified = item.state.status === "done" && item.state.verified === false;

  useEffect(() => {
    if (focusNow) heading.current?.focus();
  }, [focusNow]);

  return (
    <li id={`step-${item.id}`} data-step={item.id} data-state={item.state.status} aria-current={current ? "step" : undefined} className="scroll-mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span aria-hidden className="text-base">
          {STATE_ICONS[item.state.status]}
        </span>
        <h5 ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">
          {t(item.titleKey)}
        </h5>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">{t(STATE_PHRASES[item.state.status])}</span>
        <span className="text-xs text-slate-500">{item.required ? t("gd.required") : t("gd.optionalTag")}</span>
        <span className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-600" data-nature={item.nature}>
          {t(NATURE_PHRASES[item.nature])}
        </span>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        {t("gs.card.because")}: {renderSay(t, item.because)}
      </p>
      <p className="mt-1 text-base text-slate-800">{t(item.whyKey)}</p>
      {item.recommend && (
        <p className="mt-2 text-slate-700" data-recommendation>
          <span className="font-semibold">{t("gd.recommended")}:</span> {renderSay(t, item.recommend)} <span className="text-xs text-slate-500">{t("gs.card.notSaved")}</span>
        </p>
      )}
      {item.platformRule && (
        <p className="mt-2 text-slate-700" data-platform-rule>
          <span className="font-semibold">{t("gs.nature.platform")}:</span> {renderSay(t, item.platformRule)}
        </p>
      )}
      {item.consequence && (
        <p role="note" className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900" data-consequence>
          <span className="font-semibold">{t("gs.card.before")}:</span> {renderSay(t, item.consequence)}
        </p>
      )}
      <details className="mt-2">
        <summary className="min-h-8 cursor-pointer text-sm font-medium text-teal-700">{t("gs.card.more")}</summary>
        <p className="mt-1 text-slate-700">{t(`gs.more.${item.id}` as StaffPhrase)}</p>
      </details>
      {item.state.note && <p className="mt-2 text-slate-700">{renderSay(t, item.state.note)}</p>}
      {unverified && !item.state.note && <p className="mt-2 text-slate-700">{t("gd.unverified")}</p>}
      {blocked && item.state.blockedBy && (
        <p className="mt-2 text-slate-700">
          {t("gd.blockedBy", { steps: item.state.blockedBy.map((id) => (titles[id] ? t(titles[id]) : id)).join(", ") })}{" "}
          {item.state.blockedBy.map((id) => (
            <button key={id} type="button" onClick={() => onStep(id)} className="mr-2 min-h-8 underline hover:text-teal-700">
              {t("gs.card.goTo", { step: titles[id] ? t(titles[id]) : id })}
            </button>
          ))}
        </p>
      )}
      {item.state.reviewedAt && <p className="mt-2 text-slate-700">{t("gd.reviewedOn", { at: item.state.reviewedAt, name: item.state.reviewedBy ?? "" })}</p>}

      {/* The action: the existing editor here, or the existing screen; a link only where the role may use what it opens. */}
      {item.allowed ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {Action && !blocked && !shown && (
              <button
                type="button"
                aria-expanded={open}
                aria-controls={`step-action-${item.id}`}
                onClick={() => setOpen(!open)}
                className="min-h-10 rounded-md bg-teal-600 px-4 text-sm font-semibold text-white hover:bg-teal-700"
              >
                {open ? t("gs.card.hide") : t("gs.card.doHere")}
              </button>
            )}
            {item.configure && (
              <button
                type="button"
                onClick={() => onGo(item.configure!.tab, item.id)}
                className={`min-h-10 rounded-md px-4 text-sm font-medium ${Action ? "border border-slate-300 hover:border-teal-400" : "bg-teal-600 text-white hover:bg-teal-700"}`}
              >
                {t("gd.openScreen", { screen: t(TAB_PHRASES[item.configure.tab]) })}
              </button>
            )}
            {item.kind === "review" && item.state.status !== "done" && (
              <button type="button" onClick={() => onReviewed(item.id)} className="min-h-10 rounded-md border border-slate-300 px-4 text-sm font-medium hover:border-teal-400">
                {t("gd.markReviewed")}
              </button>
            )}
          </div>
          {Action && !blocked && (shown || open) && (
            <div id={`step-action-${item.id}`} data-action={item.action}>
              <Action venueId={view.venueId} view={view} item={item} onChanged={onChanged} onGo={(tab) => onGo(tab, item.id)} onStep={onStep} />
            </div>
          )}
        </div>
      ) : (
        item.configure && <p className="mt-3 text-xs text-slate-500">{t("gd.managerChanges")}</p>
      )}
    </li>
  );
}
