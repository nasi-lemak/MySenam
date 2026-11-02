"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BUILTIN_ACTIVITIES } from "@/lib/activity-catalogue";
import { BUSINESS_TYPES, type BusinessTypeId } from "@/lib/guide/business-types";
import { BUSINESS_TONES } from "@/lib/icons/glyphs";
import { ActivityTile, GlyphTile } from "@/components/Glyph";
import type { AnswerKey, AnswerPatch, GuideAnswers } from "@/lib/guide/answer-schema";
import type { SetupView } from "@/lib/guide/http";
import { questionFlow, type Question } from "@/lib/guide/setup-questions";
import { useStaffT } from "../StaffLanguage";
import { writeGuide } from "./setup/api";
import { activityName, renderSay } from "./setup/say";

/**
 * The discovery stage of the setup journey: the owner's questions, one at a
 * time (docs/features/venue-guide.md#the-setup-journey).
 *
 * Short and conditional: a question whose answer the venue's saved settings
 * already show is not asked (it is said as a fact, "from your settings"), one
 * that earlier answers make irrelevant is left out. Every answer is saved
 * with the revision it was given on, as it is given (a phone and a computer
 * agree, and a stale save is refused and shown with the answers now saved,
 * keeping what was entered here). Going back never loses an answer: the answer
 * on screen is saved on the way back as on the way forward.
 */

type Draft = string[] | string | boolean | null;

const asDraft = (q: Question, answers: GuideAnswers): Draft => {
  const saved = answers[q.id as AnswerKey] as unknown;
  if (saved === undefined) return q.kind === "multi" || q.kind === "types" || q.kind === "activities" ? [] : null;
  return saved as Draft;
};

export function SetupDiscovery({
  view,
  onView,
  onDone,
}: {
  view: SetupView;
  /** The setup view a save answered with (or, for a stale one, the answers now saved). */
  onView: (view: SetupView) => void;
  onDone: () => void;
}) {
  const t = useStaffT();
  const flow = useMemo(() => questionFlow(view.profile, view.answers), [view.profile, view.answers]);
  const asked = flow.filter((e) => e.fact === null).map((e) => e.question);
  const known = flow.filter((e) => e.fact !== null);
  // The first question not answered yet, else the first: "Review my business" opens on answers already given.
  const firstOpen = Math.max(0, asked.findIndex((q) => view.answers[q.id] === undefined));
  const [at, setAt] = useState<string>(asked[firstOpen]?.id ?? asked[0]?.id ?? "");
  const index = Math.max(0, asked.findIndex((q) => q.id === at));
  const question = asked[index];
  const [draft, setDraft] = useState<Draft>(() => (question ? asDraft(question, view.answers) : null));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  // A new question: its saved answer, and focus on its heading so a screen reader says where it is.
  useEffect(() => {
    if (question) setDraft(asDraft(question, view.answers));
    setProblem(null);
    heading.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question?.id]);

  if (!question)
    return (
      <section aria-labelledby="gs-disc-heading" className="space-y-3">
        <h4 id="gs-disc-heading" className="text-base font-semibold">
          {t("gs.disc.heading")}
        </h4>
        <p className="text-sm text-slate-600">{t("gs.disc.nothing")}</p>
        <button type="button" onClick={onDone} className="min-h-10 rounded-md bg-teal-600 px-4 text-sm font-medium text-white hover:bg-teal-700">
          {t("gs.disc.toPlan")}
        </button>
      </section>
    );

  /** The patch for the draft: an empty list is "none" only where saying so is an answer (memberships); elsewhere it is not answering. */
  const patchFor = (): AnswerPatch | null => {
    const key = question.id;
    const saved = view.answers[key] as unknown;
    if (draft === null || draft === undefined) return null;
    if (Array.isArray(draft)) {
      if (draft.length === 0 && key !== "memberships") return saved === undefined ? null : ({ [key]: null } as AnswerPatch);
      if (JSON.stringify(draft) === JSON.stringify(saved)) return null;
      return { [key]: draft } as AnswerPatch;
    }
    if (draft === saved) return null;
    return { [key]: draft } as AnswerPatch;
  };

  /** Save the answer on screen (when it changed), then move; a refusal keeps the entry here. */
  async function go(to: "next" | "back" | "skip") {
    setBusy(true);
    setProblem(null);
    const patch = to === "skip" ? null : patchFor();
    if (patch) {
      const saved = await writeGuide(view.venueId, { action: "answers", answers: patch, rev: view.rev }, t);
      if (!saved.ok) {
        // Somebody saved since: show the answers now saved, keep what was entered, and let it be saved again on top.
        if (saved.view) onView(saved.view);
        setProblem(saved.stale ? t("gs.stale") : saved.error);
        setBusy(false);
        return;
      }
      onView(saved.view);
    }
    setBusy(false);
    if (to === "back") {
      if (index > 0) setAt(asked[index - 1].id);
      return;
    }
    if (index + 1 < asked.length) setAt(asked[index + 1].id);
    else onDone();
  }

  const last = index + 1 >= asked.length;
  return (
    <section aria-labelledby="gs-disc-heading" className="space-y-4" data-stage="questions">
      <div>
        <h4 id="gs-disc-heading" className="text-base font-semibold">
          {t("gs.disc.heading")}
        </h4>
        <p className="mt-0.5 text-sm text-slate-600">{t("gs.disc.intro")}</p>
      </div>
      {known.length > 0 && (
        <details className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium">{t("gs.disc.known", { n: known.length })}</summary>
          <ul className="mt-2 space-y-1">
            {known.map((e) => (
              <li key={e.question.id} data-fact={e.question.id}>
                {renderSay(t, e.fact!)} <span className="text-xs text-slate-500">({t("gs.disc.fromSettings")})</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="text-xs font-medium text-slate-500" aria-live="polite">
        {t("gs.disc.progress", { n: index + 1, total: asked.length })}
      </p>
      <div className="space-y-3" data-question={question.id}>
        <h5 ref={heading} tabIndex={-1} className="text-xl font-semibold outline-none">
          {t(question.title)}
        </h5>
        <p className="text-sm text-slate-600">{t(question.help)}</p>
        <QuestionInput q={question} draft={draft} setDraft={setDraft} answers={view.answers} />
      </div>
      {problem && (
        <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || index === 0} onClick={() => void go("back")} className="min-h-10 rounded-md border border-slate-300 px-4 text-sm font-medium hover:border-teal-400 disabled:opacity-40">
          {t("gs.disc.back")}
        </button>
        <button type="button" disabled={busy} onClick={() => void go("next")} className="min-h-10 rounded-md bg-teal-600 px-5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
          {last ? t("gs.disc.finish") : t("gs.disc.next")}
        </button>
        <button type="button" disabled={busy} onClick={() => void go("skip")} className="min-h-10 rounded-md px-3 text-sm text-slate-600 underline hover:text-teal-700">
          {t("gs.disc.skip")}
        </button>
        <button type="button" onClick={onDone} className="ml-auto min-h-10 px-2 text-sm text-slate-500 underline hover:text-teal-700">
          {t("gs.disc.toPlan")}
        </button>
      </div>
    </section>
  );
}

const choiceClass = "flex min-h-10 cursor-pointer items-start gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm has-[:checked]:border-teal-500 has-[:checked]:bg-teal-50";

function QuestionInput({ q, draft, setDraft, answers }: { q: Question; draft: Draft; setDraft: (d: Draft) => void; answers: GuideAnswers }) {
  const t = useStaffT();
  if (q.kind === "types") {
    const chosen = (draft as string[]) ?? [];
    return (
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="sr-only">{t(q.title)}</legend>
        {BUSINESS_TYPES.map((b) => (
          <label key={b.id} className={`${choiceClass} items-center`}>
            <input
              type="checkbox"
              checked={chosen.includes(b.id)}
              onChange={(e) => setDraft(e.target.checked ? [...chosen, b.id] : chosen.filter((x) => x !== b.id))}
              className="h-5 w-5 shrink-0 accent-teal-600"
            />
            <GlyphTile name={`business/${b.id}`} tone={BUSINESS_TONES[b.id]} size={36} />
            <span>{t.customer(b.titleKey as never)}</span>
          </label>
        ))}
      </fieldset>
    );
  }
  if (q.kind === "activities") return <ActivityPicker chosen={(draft as string[]) ?? []} setChosen={setDraft} types={(answers.types ?? []) as BusinessTypeId[]} />;
  if (q.kind === "multi") {
    const chosen = (draft as string[]) ?? [];
    return (
      <fieldset className="space-y-2">
        <legend className="sr-only">{t(q.title)}</legend>
        {q.options!.map((o) => (
          <label key={o.value} className={choiceClass}>
            <input
              type="checkbox"
              checked={chosen.includes(o.value)}
              onChange={(e) => setDraft(e.target.checked ? [...chosen, o.value] : chosen.filter((x) => x !== o.value))}
              className="mt-0.5 h-5 w-5 accent-teal-600"
            />
            <span>{t(o.label)}</span>
          </label>
        ))}
        {q.id === "memberships" && <p className="text-xs text-slate-500">{t("gs.disc.noneTicked")}</p>}
      </fieldset>
    );
  }
  if (q.kind === "single") {
    return (
      <fieldset className="space-y-2">
        <legend className="sr-only">{t(q.title)}</legend>
        {q.options!.map((o) => (
          <label key={o.value} className={choiceClass}>
            <input type="radio" name={`q-${q.id}`} checked={draft === o.value} onChange={() => setDraft(o.value)} className="mt-0.5 h-5 w-5 accent-teal-600" />
            <span>{t(o.label)}</span>
          </label>
        ))}
      </fieldset>
    );
  }
  return (
    <fieldset className="space-y-2">
      <legend className="sr-only">{t(q.title)}</legend>
      {[true, false].map((v) => (
        <label key={String(v)} className={choiceClass}>
          <input type="radio" name={`q-${q.id}`} checked={draft === v} onChange={() => setDraft(v)} className="mt-0.5 h-5 w-5 accent-teal-600" />
          <span>{v ? t("gs.disc.yes") : t("gs.disc.no")}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** The catalogue's activities, those of the chosen kinds of business first, each with what MySenam can and cannot do for it, said as the catalogue says it. */
function ActivityPicker({ chosen, setChosen, types }: { chosen: string[]; setChosen: (d: Draft) => void; types: BusinessTypeId[] }) {
  const t = useStaffT();
  const suggested = new Set(types.flatMap((id) => BUSINESS_TYPES.find((b) => b.id === id)?.activities ?? []));
  const rows = (list: typeof BUILTIN_ACTIVITIES) =>
    list.map((a) => {
      const note = a.supportNote ? (t.known(`srv.support.${a.key}` as never) ?? a.supportNote) : null;
      return (
        <li key={a.key}>
          <label className={choiceClass}>
            <input
              type="checkbox"
              checked={chosen.includes(a.key)}
              onChange={(e) => setChosen(e.target.checked ? [...chosen, a.key] : chosen.filter((x) => x !== a.key))}
              className="mt-0.5 h-5 w-5 accent-teal-600"
            />
            <ActivityTile sport={a.key} size={32} />
            <span>
              <span className="font-medium">{activityName(t, a.key)}</span>{" "}
              <span className="text-xs text-slate-500">{t(`res.support.${a.support}`)}</span>
              {note && (
                <span className="mt-0.5 block text-xs text-slate-600">
                  <span className="font-semibold">{t("gs.disc.limit")}:</span> {note}
                </span>
              )}
            </span>
          </label>
        </li>
      );
    });
  const first = BUILTIN_ACTIVITIES.filter((a) => suggested.has(a.key));
  const rest = BUILTIN_ACTIVITIES.filter((a) => !suggested.has(a.key));
  return (
    <div className="space-y-3">
      {first.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{t("gs.disc.suggested")}</p>
          <ul className="space-y-2">{rows(first)}</ul>
        </div>
      )}
      <details open={first.length === 0}>
        <summary className="min-h-8 cursor-pointer text-sm font-medium text-teal-700">{first.length > 0 ? t("gs.disc.moreActivities") : t("gs.disc.allActivities")}</summary>
        <ul className="mt-2 space-y-2">{rows(rest)}</ul>
      </details>
    </div>
  );
}
