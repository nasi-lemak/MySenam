"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import type { Court, Venue } from "@/lib/types";
import type { StaffPhrase } from "@/lib/staff-i18n";
import type { SetupView } from "@/lib/guide/http";
import { GUIDE_VIEWS, type DashboardTab, type GuideView } from "@/lib/guide/shell";
import { placeParam, setPlaceParams, useAddressed } from "../place";
import { useStaffT } from "../StaffLanguage";
import { DiscoverView } from "./DiscoverView";
import { PlaybookView } from "./PlaybookView";
import { SetupPlanView } from "./SetupPlanView";

/**
 * The venue guide's tab (`?tab=guide&view=setup|playbook|discover`;
 * docs/features/venue-guide.md#the-dashboard-tab).
 *
 * The shell the three guides are built into: a view switcher and, for each
 * view, its own component (`SetupPlanView`, `PlaybookView`, `DiscoverView`),
 * each fed by one route. Front desk is shown only the playbook: setting a
 * venue up is a manager's, and the server refuses the desk the setup routes
 * regardless of what is drawn here.
 */

const VIEW_PHRASES: Record<GuideView, StaffPhrase> = {
  setup: "gd.view.setup",
  playbook: "gd.view.playbook",
  discover: "gd.view.discover",
};

export function GuideTab({
  venues,
  role,
  onGo,
}: {
  venues: (Venue & { courts: Court[] })[];
  /** The signed-in account's own role: the desk is shown the playbook only. */
  role: "manager" | "desk";
  onGo: (tab: DashboardTab) => void;
}) {
  const t = useStaffT();
  const views: GuideView[] = role === "desk" ? ["playbook"] : [...GUIDE_VIEWS];
  const [view, setViewState] = useState<GuideView>(views[0]);
  const [venueId, setVenueId] = useAddressed<number>("venue", venues[0]?.id ?? 1, (id) => venues.some((v) => v.id === id));

  // The view is in the address, as the tab is: a reload or a link lands where it was.
  useEffect(() => {
    const asked = placeParam("view");
    setViewState(asked !== null && (views as string[]).includes(asked) ? (asked as GuideView) : views[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);
  const setView = (next: GuideView) => {
    setViewState(next);
    setPlaceParams({ view: next });
  };

  // A suggestion's "Set this up": the setup journey narrowed to that capability, not the whole of setup again.
  const startSetup = (focus: string) => {
    setPlaceParams({ focus, step: null });
    setView("setup");
  };

  return (
    <div className="space-y-4" data-guide-view={view}>
      <div>
        <h2 className="text-lg font-semibold">{t("gd.title")}</h2>
        <p className="mt-0.5 text-sm text-slate-600">{t("gd.intro")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <nav aria-label={t("gd.views")} className="flex flex-wrap gap-2">
          {views.map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              aria-current={view === v ? "page" : undefined}
              className={`min-h-9 rounded-full px-4 py-1.5 text-sm font-medium ${view === v ? "bg-teal-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-teal-400"}`}
            >
              {t(VIEW_PHRASES[v])}
            </button>
          ))}
        </nav>
        {venues.length > 1 && (
          <select
            aria-label={t("gd.venue")}
            value={venueId}
            onChange={(e) => setVenueId(Number(e.target.value))}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          >
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {venues.length === 0 ? null : view === "playbook" ? (
        <PlaybookView key={`playbook-${venueId}`} venueId={venueId} onGo={onGo} onView={setView} />
      ) : role === "desk" ? (
        <p className="text-sm text-slate-600">{t("gd.managerOnly")}</p>
      ) : view === "discover" ? (
        <SetupData key={`discover-${venueId}`} venueId={venueId} render={(data, post) => <DiscoverView data={data} post={post} onGo={onGo} onSetUp={startSetup} />} />
      ) : (
        <SetupData key={`setup-${venueId}`} venueId={venueId} render={(data) => <SetupPlanView data={data} onGo={onGo} />} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- shared reading

type Post = (body: Record<string, unknown>) => Promise<void>;

/** Reads the setup view of a venue, and hands the views a `post` that writes and takes the answer sent back. */
function SetupData({ venueId, render }: { venueId: number; render: (data: SetupView, post: Post) => React.ReactNode }) {
  const t = useStaffT();
  const [data, setData] = useState<SetupView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/guide/setup?venueId=${venueId}`, { cache: "no-store" });
      const body = await readJson(res);
      if (!res.ok) throw new Error(t.err(body, t("gd.failed")));
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gd.failed"));
    }
  }, [venueId, t]);
  useEffect(() => {
    void load();
  }, [load]);

  const post: Post = async (body) => {
    setError(null);
    try {
      const res = await fetch("/api/admin/guide/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, ...body }),
      });
      const answer = await readJson(res);
      // A stale save comes back with the current view: take it, and say so.
      if (answer?.plan) setData(answer);
      if (!res.ok) throw new Error(t.err(answer, t("gd.failed")));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gd.failed"));
    }
  };

  if (error && !data)
    return (
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {error}{" "}
        <button type="button" onClick={() => void load()} className="underline">
          {t("q8b.tryAgain")}
        </button>
      </div>
    );
  if (!data) return <p className="text-sm text-slate-500">{t("gd.loading")}</p>;
  return (
    <>
      {error && (
        <p role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {render(data, post)}
    </>
  );
}
