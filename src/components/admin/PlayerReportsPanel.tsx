"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import type { PlayerReport } from "@/lib/player-safety";
import { useStaffClock, useStaffT } from "./StaffLanguage";

type Show = "open" | "reviewed" | "all";

/** The route's page (lib/player-safety.ts, listPlayerReports): a full page may have more behind it. */
const PAGE = 50;

/**
 * Reports players made about each other, for the platform owner
 * (`/api/admin/player-reports`): open ones first, then those looked at, a
 * page at a time, newest first. Marking one reviewed is all the route does;
 * blocking stays the players' own (docs/features/matchmaking.md).
 */
export function PlayerReportsPanel() {
  const t = useStaffT();
  const clock = useStaffClock();
  const [show, setShow] = useState<Show>("open");
  const [reports, setReports] = useState<PlayerReport[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (which: Show, before?: number) => {
      setBusy(true);
      setError(null);
      try {
        const q = new URLSearchParams();
        if (which !== "all") q.set("status", which);
        if (before) q.set("before", String(before));
        const res = await fetch(`/api/admin/player-reports?${q}`, { cache: "no-store" });
        const data = await readJson(res).catch(() => null);
        if (!res.ok) throw new Error(t.err(data, t("ow5.rep.loadFailed")));
        const page = (data?.reports ?? []) as PlayerReport[];
        setReports((had) => (before && had ? [...had, ...page] : page));
        setMore(page.length >= PAGE);
      } catch (err) {
        setError(err instanceof Error ? err.message : t("ow5.rep.loadFailed"));
      } finally {
        setBusy(false);
      }
    },
    [t]
  );

  useEffect(() => {
    void load(show);
  }, [load, show]);

  async function review(id: number) {
    setError(null);
    const res = await fetch("/api/admin/player-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const data = await readJson(res).catch(() => null);
    if (!res.ok) setError(t.err(data, t("ow5.rep.reviewFailed")));
    // Refused as not open (another owner reviewed it first) is open no longer either.
    if (!res.ok && res.status !== 404) return;
    setReports((list) =>
      (list ?? []).flatMap((r) => (r.id !== id ? [r] : show === "open" ? [] : [{ ...r, status: "reviewed" as const }]))
    );
  }

  const open = reports?.filter((r) => r.status === "open").length ?? 0;
  const tabs: [Show, string][] = [
    ["open", t("ow5.rep.statusOpen")],
    ["reviewed", t("ow5.rep.statusReviewed")],
    ["all", t("ow5.rep.showAll")],
  ];

  return (
    <details className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm">
      <summary className="cursor-pointer font-semibold text-slate-800">
        {t("ow5.rep.title")}
        {show === "open" && reports && (
          <span className="font-normal text-slate-500">
            {" · "}
            {more ? t("ow5.rep.openMany", { n: open }) : t.plural("ow5.rep.open", open)}
          </span>
        )}
      </summary>
      <p className="mt-2 text-slate-600">{t("ow5.rep.intro")}</p>
      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={t("ow5.rep.title")}>
        {tabs.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setShow(id)}
            aria-pressed={show === id}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              show === id ? "bg-teal-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-teal-400"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <p className="mt-2 text-red-600">{error}</p>}
      {reports && reports.length === 0 && <p className="mt-3 text-slate-500">{t("ow5.rep.none")}</p>}
      {reports && reports.length > 0 && (
        <ul className="mt-3 space-y-2">
          {reports.map((r) => (
            <li key={r.id} className="rounded-lg border border-slate-200 px-3 py-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold">
                  {t(`ow5.reason.${r.reason}`)}
                  <span
                    className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${
                      r.status === "open" ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {r.status === "open" ? t("ow5.rep.statusOpen") : t("ow5.rep.statusReviewed")}
                  </span>
                </span>
                <span className="text-xs text-slate-500">
                  {clock.when(r.createdAt)}
                </span>
              </div>
              <p className="mt-1">
                {r.reported
                  ? t("ow5.rep.about", { name: r.reported.name, email: r.reported.email, n: r.reported.reports })
                  : t("ow5.rep.aboutGone")}
              </p>
              <p className="text-slate-600">
                {r.reporter ? t("ow5.rep.by", { name: r.reporter.name, email: r.reporter.email }) : t("ow5.rep.byGone")}
                {r.gameId !== null && <> · {t("ow5.rep.game", { id: r.gameId })}</>}
              </p>
              {r.note && <p className="mt-1 whitespace-pre-wrap rounded bg-slate-50 px-2 py-1 text-slate-700">{r.note}</p>}
              {r.status === "open" && (
                <button onClick={() => void review(r.id)} className="mt-1 text-xs font-semibold text-teal-700 underline">
                  {t("ow5.rep.markReviewed")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {more && reports && (
        <button
          onClick={() => void load(show, reports[reports.length - 1]?.id)}
          disabled={busy}
          className="mt-2 text-xs font-semibold text-teal-700 underline disabled:opacity-50"
        >
          {t("ow5.rep.older")}
        </button>
      )}
    </details>
  );
}
