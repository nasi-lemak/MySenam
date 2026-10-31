"use client";

import { useId, useRef, useState, useSyncExternalStore } from "react";
import { fill } from "@/lib/i18n";
import type { StepPresentation } from "@/lib/guide/public/present";
import IllustrativeScreen from "./IllustrativeScreen";

/**
 * One journey, step by step: who does what, what they see, what MySenam
 * checks, and a small made-up screen (docs/features/venue-guide.md#the-public-guide).
 *
 * It is a plain ordered list first. Without script (and before the page has
 * loaded) every step is open and the page reads top to bottom, which is also
 * what a phone shows. With script the steps become a stepper: one open at a
 * time, each heading a button (`aria-expanded`), *Previous step* and *Next
 * step* below, and focus follows the step opened so a keyboard user never
 * loses their place. Nothing depends on a pointer or on animation.
 */

export interface WalkthroughText {
  /** "Step {n} of {total}": a template, since a server component cannot hand a function to this one. */
  stepN: string;
  previous: string;
  next: string;
  sees: string;
  checks: string;
  relies: string;
  notSupported: string;
  instead: string;
  illustration: string;
  /** "Illustrated screen: {title}" */
  screenOf: string;
}

/** Whether this is the browser after hydration: false on the server and for the first paint, true after. */
const subscribe = () => () => {};
const useEnhanced = () =>
  useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );

export default function Walkthrough({ steps, text }: { steps: StepPresentation[]; text: WalkthroughText }) {
  const enhanced = useEnhanced();
  const [active, setActive] = useState(0);
  const base = useId();
  const heads = useRef<(HTMLButtonElement | null)[]>([]);

  const go = (i: number) => {
    const next = Math.max(0, Math.min(steps.length - 1, i));
    setActive(next);
    // The step that opened takes focus: after the render that shows it.
    queueMicrotask(() => heads.current[next]?.focus());
  };

  return (
    <div>
      <ol className="m-0 list-none space-y-3 p-0">
        {steps.map((s, i) => {
          const open = !enhanced || i === active;
          const panel = `${base}-panel-${i}`;
          const head = (
            <>
              <span aria-hidden className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-teal-700 text-sm font-bold text-white">
                {s.number}
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-medium text-slate-500">
                  {fill(text.stepN, { n: s.number, total: steps.length })} · {s.actor}
                </span>
                <span className="block font-semibold text-slate-900">{s.title}</span>
              </span>
            </>
          );
          return (
            <li key={s.id} className="rounded-xl border border-slate-200 bg-white shadow-sm">
              <h4 className="m-0">
                {enhanced ? (
                  <button
                    type="button"
                    ref={(el) => {
                      heads.current[i] = el;
                    }}
                    aria-expanded={open}
                    aria-controls={panel}
                    aria-current={i === active ? "step" : undefined}
                    onClick={() => setActive(i)}
                    className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-slate-50"
                  >
                    {head}
                  </button>
                ) : (
                  <span className="flex items-center gap-3 px-3 py-2">{head}</span>
                )}
              </h4>
              <div id={panel} hidden={!open} className="grid gap-4 border-t border-slate-100 px-3 py-3 md:grid-cols-2">
                <div className="space-y-3 text-sm text-slate-700">
                  <div>
                    <h5 className="m-0 text-xs font-semibold uppercase tracking-wide text-slate-500">{text.sees}</h5>
                    <p className="m-0 mt-1">{s.sees}</p>
                  </div>
                  <div>
                    <h5 className="m-0 text-xs font-semibold uppercase tracking-wide text-slate-500">{text.checks}</h5>
                    <p className="m-0 mt-1">{s.checks}</p>
                    {s.notes.length > 0 && (
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        {s.notes.map((n) => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  {s.limits.length > 0 && (
                    <ul className="m-0 list-none space-y-1 p-0">
                      {s.limits.map((l) => (
                        <li key={l.id} className="rounded-lg border border-slate-300 bg-slate-100 px-2.5 py-1.5">
                          <span className="font-semibold">
                            <span aria-hidden>✕ </span>
                            {text.notSupported}: {l.title}.
                          </span>{" "}
                          {l.alternative && (
                            <span>
                              {text.instead}: {l.alternative}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {s.relies.length > 0 && (
                    <p className="m-0 text-xs text-slate-500">
                      {text.relies}: {s.relies.map((r) => r.title).join(" · ")}
                    </p>
                  )}
                </div>
                <IllustrativeScreen title={s.screen.title} lines={s.screen.lines} note={text.illustration} label={fill(text.screenOf, { title: s.screen.title })} />
              </div>
            </li>
          );
        })}
      </ol>
      {enhanced && steps.length > 1 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => go(active - 1)}
            disabled={active === 0}
            className="inline-flex min-h-9 items-center rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {text.previous}
          </button>
          <button
            type="button"
            onClick={() => go(active + 1)}
            disabled={active === steps.length - 1}
            className="inline-flex min-h-9 items-center rounded-lg bg-teal-700 px-3 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
          >
            {text.next}
          </button>
          <p role="status" className="m-0 text-sm text-slate-600">
            {fill(text.stepN, { n: active + 1, total: steps.length })}
          </p>
        </div>
      )}
    </div>
  );
}
