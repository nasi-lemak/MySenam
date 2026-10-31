"use client";

import { useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";

/**
 * The journeys of a business, one at a time as tabs (docs/features/venue-guide.md#the-public-guide).
 *
 * Without script, and before the page has loaded, there are no tabs: every
 * journey is on the page in order, each under its own heading, so the content
 * is all there for a reader, a search engine and a phone. With script the
 * headings become a tab list (the arrow keys, Home and End move between tabs;
 * only the open tab is in the tab order) and one journey shows at a time.
 */

export interface TabItem {
  id: string;
  title: string;
  intro: string;
  /** Where it came from, when several kinds of business were chosen. */
  from: string | null;
  content: ReactNode;
}

const subscribe = () => () => {};
const useEnhanced = () =>
  useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );

export default function WorkflowTabs({ items, label }: { items: TabItem[]; label: string }) {
  const enhanced = useEnhanced();
  const [active, setActive] = useState(0);
  const base = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const several = items.length > 1;

  const move = (i: number) => {
    const next = (i + items.length) % items.length;
    setActive(next);
    tabs.current[next]?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") move(i - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(items.length - 1);
    else return;
    e.preventDefault();
  };

  return (
    <div>
      {enhanced && several && (
        <div role="tablist" aria-label={label} className="mb-4 flex flex-wrap gap-2">
          {items.map((it, i) => (
            <button
              key={it.id}
              id={`${base}-tab-${i}`}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              type="button"
              role="tab"
              aria-selected={i === active}
              aria-controls={`${base}-panel-${i}`}
              tabIndex={i === active ? 0 : -1}
              onClick={() => setActive(i)}
              onKeyDown={(e) => onKey(e, i)}
              className={`inline-flex min-h-9 items-center rounded-full border px-3 text-sm font-medium ${
                i === active ? "border-teal-700 bg-teal-700 text-white" : "border-slate-300 bg-white text-slate-700 hover:border-teal-600"
              }`}
            >
              {it.title}
            </button>
          ))}
        </div>
      )}
      <div className="space-y-8">
        {items.map((it, i) => {
          const shown = !enhanced || !several || i === active;
          return (
            <section
              key={it.id}
              id={`${base}-panel-${i}`}
              role={enhanced && several ? "tabpanel" : undefined}
              aria-labelledby={enhanced && several ? `${base}-tab-${i}` : `${base}-h-${i}`}
              hidden={!shown}
            >
              <h3 id={`${base}-h-${i}`} className="m-0 text-lg font-bold text-slate-900">
                {it.title}
              </h3>
              <p className="m-0 mt-1 text-sm text-slate-600">
                {it.intro}
                {it.from && <span className="ml-2 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{it.from}</span>}
              </p>
              <div className="mt-3">{it.content}</div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
