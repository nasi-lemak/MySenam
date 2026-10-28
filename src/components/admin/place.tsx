"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useStaffClock, useStaffT } from "./StaffLanguage";

/**
 * Where a member of staff is on the dashboard, kept in its address (audit R8
 * X2-13): the tab (`?tab=schedule`) and, on the screens that have them, the
 * venue and the day (`&venue=3&date=2026-10-31`), so a reload, the Back
 * button or a link someone was sent lands where they were. A tab is a step in
 * the browser's history; changing the venue or the day replaces the address
 * rather than piling up steps.
 */

/** The value of one of the dashboard's address parameters, or null (on the server, or not given). */
export function placeParam(key: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(key);
}

/** Set (or, with null, remove) address parameters, keeping the others and any #section. */
export function setPlaceParams(values: Record<string, string | null>, mode: "push" | "replace" = "replace"): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === "") url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  if (url.href === window.location.href) return;
  if (mode === "push") window.history.pushState(window.history.state, "", url);
  else window.history.replaceState(window.history.state, "", url);
}

/**
 * The dashboard's tab, read from the address and written back to it: Back
 * and Forward move between tabs, and a tab this member of staff does not
 * have (a front desk's link to Reports) falls back to the first.
 */
export function useTabInAddress<T extends string>(allowed: readonly T[], fallback: T): [T, (tab: T) => void] {
  const read = useCallback((): T => {
    const asked = placeParam("tab");
    return asked !== null && (allowed as readonly string[]).includes(asked) ? (asked as T) : fallback;
  }, [allowed, fallback]);
  const [tab, setTabState] = useState<T>(fallback);
  // Read once mounted, so the server's render (the first tab) and the browser's agree.
  useEffect(() => {
    setTabState(read());
    const back = () => setTabState(read());
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, [read]);
  const setTab = useCallback((next: T) => {
    setTabState(next);
    setPlaceParams({ tab: next }, "push");
  }, []);
  return [tab, setTab];
}

/**
 * A venue or day a screen is on, kept in the address under `key`: read from
 * it when the screen opens (where `valid` accepts what is there), written to
 * it on every change. Leaving the screen leaves the value in the address for
 * the next screen that reads the same key, so the venue chosen on the day
 * list is the one the schedule opens on.
 */
export function useAddressed<V extends string | number>(
  key: "venue" | "date",
  initial: V | (() => V),
  valid: (value: V) => boolean = () => true
): [V, (value: V) => void] {
  const [value, setValue] = useState<V>(() => {
    const start = typeof initial === "function" ? (initial as () => V)() : initial;
    const asked = placeParam(key);
    if (asked === null) return start;
    const read = (typeof start === "number" ? Number(asked) : asked) as V;
    return (typeof read !== "number" || Number.isFinite(read)) && valid(read) ? read : start;
  });
  const set = useCallback(
    (next: V) => {
      setValue(next);
      setPlaceParams({ [key]: String(next) });
    },
    [key]
  );
  return [value, set];
}

/** A day as the address keeps it: YYYY-MM-DD. */
export const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

/** How often an open day list or schedule reads itself again (audit R8 X2-14). */
export const REFRESH_MS = 60_000;

/**
 * A screen that keeps itself up to date while it is in front of somebody
 * (audit R8 X2-14): `load` again every minute while the page is visible, at
 * once when it becomes visible again after a while hidden, and not at all
 * while it is hidden. Only the screen's data is read again; anything being
 * typed is the screen's own state and stays. The screens' loads already
 * throw a late answer for an earlier day or venue away (B19), so a refresh
 * racing a change of day cannot show the wrong one.
 *
 * Returns when the data was last read, for `UpdatedNote`; `loaded()` is for
 * the screen to call after a load of its own (a change of day, an action).
 */
export function useAutoRefresh(load: () => unknown, ms: number = REFRESH_MS): { updatedAt: Date | null; loaded: () => void } {
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const latest = useRef(load);
  const last = useRef(0);
  useEffect(() => {
    latest.current = load;
  }, [load]);
  const loaded = useCallback(() => {
    last.current = Date.now();
    setUpdatedAt(new Date(last.current));
  }, []);
  useEffect(() => {
    const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
    const run = async () => {
      if (!visible()) return;
      last.current = Date.now();
      try {
        await latest.current();
      } finally {
        setUpdatedAt(new Date());
      }
    };
    const timer = window.setInterval(() => void run(), ms);
    const shown = () => {
      if (visible() && Date.now() - last.current >= Math.min(ms, 15_000)) void run();
    };
    document.addEventListener("visibilitychange", shown);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [ms]);
  return { updatedAt, loaded };
}

/**
 * A list that could not be read, said as such with a way to try again (audit
 * R8 X2-7): never the list's "None yet", which tells staff their tournaments
 * or leagues are gone when the server only failed to answer.
 */
export function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useStaffT();
  return (
    <div role="alert" className="mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      <span>{message}</span>
      <button type="button" onClick={onRetry} className="rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-100">
        {t("q8b.tryAgain")}
      </button>
    </div>
  );
}

/** "Updated 6:31 PM": when an auto-refreshing screen last read its data, in the venue's clock. */
export function UpdatedNote({ at, venueId }: { at: Date | null; venueId?: number | null }) {
  const t = useStaffT();
  const clock = useStaffClock();
  if (!at) return null;
  return (
    <span className="text-xs text-slate-500" data-testid="updated-note">
      {t("q8b.updated", { time: clock.time(at, venueId) })}
    </span>
  );
}
