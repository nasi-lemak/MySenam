"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { intlTag, isoOffset, region } from "@/lib/region";
import type { Locale } from "@/lib/i18n";
import type { StaffText } from "@/lib/staff-text";
import { useStaffT } from "./StaffLanguage";

/* ---------------- First run ---------------- */

interface DemoState {
  empty: boolean;
  seededOn: string | null;
  runsTo: string | null;
  stale: boolean;
  refreshable: boolean;
}

/** A yyyy-mm-dd as a Malaysian would read it. */
function readable(date: string, locale: Locale): string {
  return new Date(`${date}T00:00:00${isoOffset()}`).toLocaleDateString(intlTag(locale), {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: region().timeZone,
  });
}

/** A phrase with elements (bold tab names) where its `{name}` placeholders are. */
function withElements(text: string, parts: Record<string, ReactNode>): ReactNode[] {
  return text.split(/\{(\w+)\}/).map((piece, i) => (i % 2 ? <Fragment key={i}>{parts[piece] ?? `{${piece}}`}</Fragment> : piece));
}

/**
 * What an empty install — or a demo that has aged out — says for itself.
 *
 * A fresh MySenam has venues and courts and nothing else, so every tab opens
 * blank and a newcomer has no idea which of the eight to start with. The offer
 * to fill it appears only while nothing has been sold — the moment a real
 * booking exists it is gone for good, which is also what stops demo customers
 * ever appearing in a working venue's day list.
 *
 * The demo is written against the day it was loaded, so it runs out. When it
 * does, this offers to move it onto today instead of leaving somebody looking
 * at an empty day list and concluding the software does not work.
 */
export function FirstRun({ onSeeded }: { onSeeded: () => void }) {
  const t = useStaffT();
  const [state, setState] = useState<DemoState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ bookings: number; extras: string[]; extraPhrases?: StaffText[] } | null>(null);
  // A reload throws data away. Cheap to confirm, expensive to mis-click.
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    fetch("/api/admin/demo", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setState(d))
      .catch(() => setState(null));
  }, []);

  async function loadDemo(refresh = false) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("fr.couldNotLoad")));
      setDone({ bookings: data.bookings, extras: data.extras, extraPhrases: data.extraPhrases });
      setState(null);
      onSeeded();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("fr.couldNotLoad"));
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
        <p className="text-sm font-semibold text-emerald-900">
          {t("fr.written", { n: done.bookings })}
        </p>
        <p className="mt-1 text-sm text-emerald-800">
          {withElements(t("fr.doneNext", { extras: done.extras.map((e, i) => t.say(done.extraPhrases?.[i], e)).join(t("srv.list.comma")) }), {
            reports: <strong>{t("sh.tab.reports")}</strong>,
            bookings: <strong>{t("sh.tab.bookings")}</strong>,
          })}
        </p>
      </div>
    );

  if (state?.stale && state.refreshable)
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3.5">
        <h2 className="text-base font-bold text-amber-900">{t("fr.runOut")}</h2>
        <p className="mt-1 max-w-2xl text-sm text-amber-900/85">
          {t("fr.runOutBody", {
            written: state.seededOn ? readable(state.seededOn, t.locale) : t("fr.earlierDay"),
            runsTo: state.runsTo ? readable(state.runsTo, t.locale) : t("fr.datePast"),
          })}
        </p>
        {confirming ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() => loadDemo(true)}
              disabled={busy}
              className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {busy ? t("fr.rewriting") : t("fr.confirmReload")}
            </button>
            <button
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="rounded-lg px-3 py-2 text-sm font-medium text-amber-900 underline disabled:opacity-50"
            >
              {t("fr.leaveIt")}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="mt-3 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700"
          >
            {t("fr.reload")}
          </button>
        )}
        <p className="mt-2 text-xs text-amber-900/70">
          {t("fr.reloadWarning")}
        </p>
        {error && <p className="mt-3 text-sm font-medium text-red-700">{error}</p>}
      </div>
    );

  if (state?.empty !== true) return null;

  return (
    <div className="rounded-xl border border-teal-200 bg-teal-50/70 px-4 py-4">
      <h2 className="text-base font-bold text-teal-900">{t("fr.empty")}</h2>
      <p className="mt-1 max-w-2xl text-sm text-teal-900/80">
        {t("fr.emptyBody")}
      </p>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-teal-200 bg-white p-3.5">
          <p className="text-sm font-semibold">{t("fr.justLooking")}</p>
          <p className="mt-1 text-sm text-slate-600">
            {t("fr.demoBody")}
          </p>
          <button
            onClick={() => loadDemo()}
            disabled={busy}
            className="mt-3 rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {busy ? t("fr.writing") : t("fr.loadDemo")}
          </button>
          <p className="mt-2 text-xs text-slate-500">
            {t("fr.demoNote")}
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-3.5">
          <p className="text-sm font-semibold">{t("fr.realVenue")}</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-slate-600">
            <li>{withElements(t("fr.step1"), { tab: <strong>{t("sh.tab.venuesStaff")}</strong> })}</li>
            <li>{withElements(t("fr.step2"), { tab: <strong>{t("sh.tab.courts")}</strong> })}</li>
            <li>{withElements(t("fr.step3"), { tab: <strong>{t("sh.tab.venuesStaff")}</strong> })}</li>
          </ol>
          <p className="mt-2 text-xs text-slate-500">
            {t("fr.demoVenues")}
          </p>
        </div>
      </div>

      {error && <p className="mt-3 text-sm font-medium text-red-700">{error}</p>}
    </div>
  );
}
