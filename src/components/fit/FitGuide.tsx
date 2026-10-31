import Link from "next/link";
import type { Phrase, T } from "@/lib/i18n";
import type { Availability } from "@/lib/guide/capabilities";
import { activityName, list, presentCapability, presentChip, presentWorkflows, typeName, type ChipPresentation } from "@/lib/guide/public/present";
import { applyAddress } from "@/lib/guide/public/select";
import type { FitView } from "@/lib/guide/public/view";
import { AVAILABILITY_PHRASE, GROUP_PHRASE } from "@/lib/guide/public/view";
import Walkthrough, { type WalkthroughText } from "./Walkthrough";
import WorkflowTabs from "./WorkflowTabs";

/**
 * The tailored explanation for a selection: a day in MySenam as stepped
 * walkthroughs, what would be set up, what is available (by what using it
 * takes), where support is partial, what MySenam does not do, and the way on
 * to the application form (docs/features/venue-guide.md#the-public-guide).
 *
 * Server-rendered, so it is in the page a search engine reads. Every claim in
 * it comes from the capability registry through `fitView`; the words from the
 * customer dictionaries in the visitor's language.
 */

const SYMBOL: Record<Availability, string> = { now: "●", configuration: "◐", integration: "⇄", approval: "✓", unsupported: "✕" };
const CHIP: Record<Availability, string> = {
  now: "border-teal-300 bg-teal-50 text-teal-900",
  configuration: "border-sky-300 bg-sky-50 text-sky-900",
  integration: "border-amber-300 bg-amber-50 text-amber-900",
  approval: "border-amber-300 bg-amber-50 text-amber-900",
  unsupported: "border-slate-300 bg-slate-100 text-slate-700",
};
const AVAILABILITY_ORDER: Availability[] = ["now", "configuration", "integration", "approval", "unsupported"];

const H2 = "text-xl font-bold text-slate-900";

function Chip({ chip }: { chip: ChipPresentation }) {
  return (
    <li className={`inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 py-1 text-sm ${CHIP[chip.availability]}`}>
      <span aria-hidden>{SYMBOL[chip.availability]}</span>
      <span>
        {chip.title}
        {chip.needs && <span className="text-xs"> ({chip.needs})</span>}
      </span>
    </li>
  );
}

export default function FitGuide({ view, t }: { view: FitView; t: T }) {
  const workflows = presentWorkflows(view, t);
  const walkText: WalkthroughText = {
    stepN: t("fit.step.n"),
    previous: t("fit.step.prev"),
    next: t("fit.step.next"),
    sees: t("fit.label.sees"),
    checks: t("fit.label.checks"),
    relies: t("fit.label.relies"),
    notSupported: t("fit.label.notSupported"),
    instead: t("fit.label.instead"),
    illustration: t("fit.illustration"),
    screenOf: t("fit.screen.of"),
  };
  const chosen = list(t, [...view.types.map((id) => typeName(t, id)), ...view.selection.activities.map((k) => activityName(t, k))]);

  const sections = [
    workflows.length > 0 && { id: "day", title: t("fit.sec.day") },
    view.combined && { id: "combined", title: t("fit.sec.combined") },
    view.setup.length > 0 && { id: "setup", title: t("fit.sec.setup") },
    { id: "available", title: t("fit.sec.avail") },
    { id: "know", title: t("fit.sec.know") },
    { id: "not", title: t("fit.sec.not") },
    { id: "start", title: t("fit.sec.cta") },
  ].filter((s): s is { id: string; title: string } => Boolean(s));

  const chips = view.byAvailability;

  return (
    <div className="space-y-10">
      <div className="space-y-2">
        <p className="m-0 text-slate-700">{t("fit.sel.summary", { list: chosen })}</p>
        <nav aria-label={t("fit.jump")}>
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0 text-sm">
            {sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="inline-flex min-h-9 items-center rounded-full border border-slate-300 px-3 text-slate-700 hover:border-teal-600 hover:text-teal-800">
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      {workflows.length > 0 && (
        <section id="day" aria-labelledby="day-h" className="scroll-mt-20">
          <h2 id="day-h" className={H2}>
            {t("fit.sec.day")}
          </h2>
          <p className="mt-1 text-slate-600">{t("fit.sec.dayLead")}</p>
          <div className="mt-4">
            <WorkflowTabs
              label={t("fit.wf.journeys")}
              items={workflows.map((w) => ({
                id: w.id,
                title: w.title,
                intro: w.intro,
                from: w.from,
                content: <Walkthrough steps={w.steps} text={walkText} />,
              }))}
            />
          </div>
        </section>
      )}

      {view.combined && (
        <section id="combined" aria-labelledby="combined-h" className="scroll-mt-20">
          <h2 id="combined-h" className={H2}>
            {t("fit.sec.combined")}
          </h2>
          <p className="mt-1 text-slate-600">{t("fit.combined.lead")}</p>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-slate-700">
            {view.combinedClaims.map((id) => (
              <li key={id}>{t(`fit.combined.${id}` as Phrase)}</li>
            ))}
          </ul>
        </section>
      )}

      {view.setup.length > 0 && (
        <section id="setup" aria-labelledby="setup-h" className="scroll-mt-20">
          <h2 id="setup-h" className={H2}>
            {t("fit.sec.setup")}
          </h2>
          <p className="mt-1 text-slate-600">{t("fit.sec.setupLead")}</p>
          <ol className="mt-4 list-none space-y-5 p-0">
            {view.setup.map((g) => (
              <li key={g.group}>
                <h3 className="m-0 text-base font-semibold text-slate-800">{t(GROUP_PHRASE(g.group))}</h3>
                <ul className="m-0 mt-2 list-disc space-y-1.5 pl-5 text-sm text-slate-700">
                  {g.items.map((l) => (
                    <li key={l.capability.id}>
                      <span className="font-medium text-slate-900">{t(l.capability.titleKey)}</span>: {t(l.capability.blurbKey)}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section id="available" aria-labelledby="available-h" className="scroll-mt-20">
        <h2 id="available-h" className={H2}>
          {t("fit.sec.avail")}
        </h2>
        <p className="mt-1 text-slate-600">{t("fit.sec.availLead")}</p>
        <div className="mt-4 space-y-4">
          {AVAILABILITY_ORDER.map((a) =>
            chips[a].length === 0 ? null : (
              <div key={a}>
                <h3 className="m-0 text-base font-semibold text-slate-800">
                  <span aria-hidden>{SYMBOL[a]} </span>
                  {t(AVAILABILITY_PHRASE(a))}
                </h3>
                <ul className="m-0 mt-2 flex list-none flex-wrap gap-2 p-0">
                  {chips[a].map((l) => (
                    <Chip key={l.capability.id} chip={presentChip(t, l)} />
                  ))}
                </ul>
              </div>
            )
          )}
        </div>
      </section>

      <section id="know" aria-labelledby="know-h" className="scroll-mt-20">
        <h2 id="know-h" className={H2}>
          {t("fit.sec.know")}
        </h2>
        {view.partial.length === 0 ? (
          <p className="mt-1 text-slate-600">{t("fit.know.none")}</p>
        ) : (
          <>
            <p className="mt-1 text-slate-600">{t("fit.sec.knowLead")}</p>
            <ul className="m-0 mt-3 list-none space-y-3 p-0">
              {view.partial.map((a) => (
                <li key={a.key} className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
                  <p className="m-0 font-semibold text-slate-900">
                    {activityName(t, a.key)} <span className="font-normal text-slate-600">· {t(a.support === "specialised" ? "fit.support.specialised" : "fit.support.basic")}</span>
                  </p>
                  {a.supportNote && (
                    <p className="m-0 mt-1 text-slate-700">
                      <span className="text-slate-500">{t("fit.know.note")}</span>{" "}
                      <span lang="en">{a.supportNote}</span>
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section id="not" aria-labelledby="not-h" className="scroll-mt-20">
        <h2 id="not-h" className={H2}>
          {t("fit.sec.not")}
        </h2>
        <p className="mt-1 text-slate-600">{t("fit.sec.notLead")}</p>
        <div className="mt-4 space-y-5">
          {[
            { key: "yours", heading: t("fit.not.yours"), items: view.limits.relevant },
            { key: "others", heading: t("fit.not.others"), items: view.limits.others },
          ].map((group) =>
            group.items.length === 0 ? null : (
              <div key={group.key}>
                <h3 className="m-0 text-base font-semibold text-slate-800">{group.heading}</h3>
                <ul className="m-0 mt-2 list-none space-y-2 p-0">
                  {group.items.map((c) => {
                    const p = presentCapability(t, c);
                    return (
                      <li key={c.id} className="rounded-xl border border-slate-300 bg-slate-50 p-3 text-sm">
                        <p className="m-0 font-semibold text-slate-900">
                          <span aria-hidden>✕ </span>
                          {p.title}
                        </p>
                        <p className="m-0 mt-1 text-slate-700">{p.blurb}</p>
                        {p.alternative && (
                          <p className="m-0 mt-1 text-slate-700">
                            <span className="font-medium">{t("fit.label.instead")}:</span> {p.alternative}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )
          )}
        </div>
      </section>

      <section id="start" aria-labelledby="start-h" className="scroll-mt-20 rounded-2xl border border-teal-200 bg-teal-50 p-5">
        <h2 id="start-h" className={H2}>
          {t("fit.sec.cta")}
        </h2>
        <p className="mt-1 text-slate-700">{t("fit.cta.body")}</p>
        <p className="mt-3 flex flex-wrap items-center gap-3">
          <Link href={applyAddress(view.selection)} className="inline-flex min-h-10 items-center rounded-lg bg-teal-700 px-4 font-semibold text-white hover:bg-teal-800">
            {t(view.empty ? "fit.cta.buttonPlain" : "fit.cta.button")}
          </Link>
          <Link href="/pricing" className="inline-flex min-h-9 items-center rounded-md px-2 text-sm font-medium text-teal-800 underline">
            {t("fit.cta.pricing")}
          </Link>
        </p>
        <p className="m-0 mt-3 text-xs text-slate-600">{t("fit.cta.privacy")}</p>
      </section>
    </div>
  );
}
