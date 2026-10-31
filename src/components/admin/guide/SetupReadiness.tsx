"use client";

import type { StaffPhrase } from "@/lib/staff-i18n";
import type { SetupView } from "@/lib/guide/http";
import type { ReadinessItem } from "@/lib/guide/readiness";
import type { DashboardTab } from "@/lib/guide/shell";
import { useStaffT } from "../StaffLanguage";
import { useStaffMay } from "../StaffMay";
import { TAB_PHRASES } from "./setup/tabs";
import { renderSay } from "./setup/say";

/**
 * Launch readiness, as the setup journey shows it
 * (docs/features/venue-guide.md#the-setup-journey): six kinds of thing kept
 * apart, never one score, each item with the reason it is there and where to
 * fix it (or who: an install's own settings are for whoever runs the install).
 * It reads `launchReadiness`'s answer and decides nothing.
 */

const GROUPS: { key: keyof SetupView["readiness"]; title: StaffPhrase; help: StaffPhrase }[] = [
  { key: "requiredMissing", title: "gd.ready.missing", help: "gs.ready.help.missing" },
  { key: "unverifiedExternal", title: "gd.ready.unverified", help: "gs.ready.help.unverified" },
  { key: "legalPrerequisite", title: "gd.ready.legal", help: "gs.ready.help.legal" },
  { key: "featureSpecific", title: "gd.ready.feature", help: "gs.ready.help.feature" },
  { key: "optionalEnhancements", title: "gd.ready.optional", help: "gs.ready.help.optional" },
  { key: "configurationComplete", title: "gd.ready.complete", help: "gs.ready.help.complete" },
];

export function SetupReadiness({ view, onGo, onStep }: { view: SetupView; onGo: (tab: DashboardTab) => void; onStep: (id: string) => void }) {
  const t = useStaffT();
  const may = useStaffMay();
  return (
    <div className="space-y-3" data-readiness>
      <p className="text-sm text-slate-600">{t("gd.ready.intro")}</p>
      {GROUPS.map(({ key, title, help }) => {
        const items = view.readiness[key] as ReadinessItem[];
        return (
          <section key={key} aria-labelledby={`ready-${key}`} data-ready-group={key}>
            <h5 id={`ready-${key}`} className="text-sm font-semibold text-slate-800">
              {t(title)} <span className="text-xs font-normal text-slate-500">({items.length})</span>
            </h5>
            <p className="text-xs text-slate-500">{t(help)}</p>
            {items.length === 0 ? (
              <p className="mt-1 text-xs text-slate-400">{t("gd.ready.none")}</p>
            ) : (
              <ul className="mt-1 space-y-2">
                {items.map((item) => (
                  <li key={item.id} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" data-ready-item={item.id}>
                    <p className="font-medium">{item.say ? t.say(item.say) : renderSay(t, item.label)}</p>
                    {item.why && <p className="text-xs text-slate-600">{renderSay(t, item.why)}</p>}
                    <p className="mt-1 flex flex-wrap items-center gap-3 text-xs">
                      {item.stepId && key !== "configurationComplete" && (
                        <button type="button" onClick={() => onStep(item.stepId!)} className="min-h-8 rounded-md border border-slate-300 px-2 hover:border-teal-400">
                          {t("gs.ready.toStep")}
                        </button>
                      )}
                      {item.configure && (!item.staffAction || may(item.staffAction)) && (
                        <button type="button" onClick={() => onGo(item.configure!.tab)} className="min-h-8 rounded-md px-2 underline hover:text-teal-700">
                          {t("gd.openScreen", { screen: t(TAB_PHRASES[item.configure.tab]) })}
                        </button>
                      )}
                      {item.configure && item.staffAction && !may(item.staffAction) && <span className="text-slate-500">{t("gd.managerChanges")}</span>}
                      {!item.configure && !item.stepId && key !== "configurationComplete" && <span className="text-slate-500">{t(item.id === "email" ? "gs.ready.askInstall" : "gs.ready.noScreen")}</span>}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
