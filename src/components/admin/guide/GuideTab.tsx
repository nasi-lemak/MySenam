"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import type { Court, Venue } from "@/lib/types";
import type { StaffPhrase } from "@/lib/staff-i18n";
import type { SetupView } from "@/lib/guide/http";
import type { PlanItem, Say, SetupGroup, StepStatus } from "@/lib/guide/plan";
import type { ReadinessItem } from "@/lib/guide/readiness";
import { GUIDE_VIEWS, type DashboardTab, type GuideRole, type GuideView } from "@/lib/guide/shell";
import { placeParam, setPlaceParams, useAddressed } from "../place";
import { useStaffT } from "../StaffLanguage";

/**
 * The venue guide's tab (`?tab=guide&view=setup|playbook|discover`;
 * docs/features/venue-guide.md#the-dashboard-tab).
 *
 * The shell the three guides are built into: a view switcher and, for each
 * view, a clearly marked placeholder that reads the real API and shows what
 * it returns as plain lists, so the setup journey, the playbook and the
 * discovery view each replace one function below (`SetupView`,
 * `PlaybookView`, `DiscoverView`) and nothing else. Front desk is shown only
 * the playbook: setting a venue up is a manager's, and the server refuses the
 * desk the setup routes regardless of what is drawn here.
 */

const GROUP_PHRASES: Record<SetupGroup, StaffPhrase> = {
  identity: "gd.group.identity",
  resources: "gd.group.resources",
  pricing: "gd.group.pricing",
  policies: "gd.group.policies",
  people: "gd.group.people",
  payments: "gd.group.payments",
  programmes: "gd.group.programmes",
  launch: "gd.group.launch",
};

const STATE_PHRASES: Record<StepStatus, StaffPhrase> = {
  done: "gd.state.done",
  todo: "gd.state.todo",
  optional: "gd.state.optional",
  "review-needed": "gd.state.reviewNeeded",
  blocked: "gd.state.blocked",
};

const VIEW_PHRASES: Record<GuideView, StaffPhrase> = {
  setup: "gd.view.setup",
  playbook: "gd.view.playbook",
  discover: "gd.view.discover",
};

const ROLE_PHRASES: Record<GuideRole, StaffPhrase> = {
  manager: "gd.role.manager",
  desk: "gd.role.desk",
  coach: "gd.role.coach",
};

/** What a screen name is called in the dashboard's own tab labels. */
const TAB_PHRASES: Record<DashboardTab, StaffPhrase> = {
  bookings: "sh.tab.bookings",
  schedule: "sh.tab.schedule",
  occupancy: "sh.tab.occupancy",
  reports: "sh.tab.reports",
  courts: "sh.tab.courts",
  classes: "sh.tab.classes",
  tournaments: "sh.tab.tournaments",
  leagues: "sh.tab.leagues",
  credit: "sh.tab.credit",
  venues: "sh.tab.venueDetails",
  guide: "gd.tab",
};

interface PlaybookAnswer {
  venueId: number;
  role: GuideRole;
  ownRole: GuideRole;
  roles: GuideRole[];
  facts: Say[];
}

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
        <PlaybookView key={`playbook-${venueId}`} venueId={venueId} />
      ) : role === "desk" ? (
        <p className="text-sm text-slate-600">{t("gd.managerOnly")}</p>
      ) : view === "discover" ? (
        <SetupData key={`discover-${venueId}`} venueId={venueId} render={(data, post) => <DiscoverView data={data} post={post} onGo={onGo} />} />
      ) : (
        <SetupData key={`setup-${venueId}`} venueId={venueId} render={(data, post) => <SetupPlanView data={data} post={post} onGo={onGo} />} />
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

const say = (t: ReturnType<typeof useStaffT>, s: Say) => t(s.key, s.vars);

function Placeholder() {
  const t = useStaffT();
  return (
    <p data-placeholder className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-600">
      {t("gd.placeholder")}
    </p>
  );
}

// ---------------------------------------------------------------- the setup view (placeholder: the setup journey replaces it)

function SetupPlanView({ data, post, onGo }: { data: SetupView; post: Post; onGo: (tab: DashboardTab) => void }) {
  const t = useStaffT();
  const c = data.plan.counts;
  return (
    <section aria-labelledby="guide-setup-heading" className="space-y-4">
      <h3 id="guide-setup-heading" className="font-semibold">
        {t("gs.heading")}
      </h3>
      <Placeholder />
      <p className="text-sm text-slate-600">{t("gd.plan.counts", { done: c.done, todo: c.todo, optional: c.optional, review: c["review-needed"] })}</p>
      {data.plan.groups.length === 0 && <p className="text-sm text-slate-500">{t("gd.plan.empty")}</p>}
      {data.plan.groups.map((group) => (
        <div key={group.group}>
          <h4 className="text-sm font-semibold text-slate-700">{t(GROUP_PHRASES[group.group])}</h4>
          <ul className="mt-1 space-y-2">
            {group.items.map((item) => (
              <PlanRow key={item.id} item={item} onGo={onGo} onReviewed={() => post({ action: "acknowledge", step: item.id })} />
            ))}
          </ul>
        </div>
      ))}
      <Readiness data={data} onGo={onGo} />
    </section>
  );
}

function PlanRow({ item, onGo, onReviewed }: { item: PlanItem; onGo: (tab: DashboardTab) => void; onReviewed: () => void }) {
  const t = useStaffT();
  const unverified = item.state.status === "done" && item.state.verified === false;
  return (
    <li className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" data-step={item.id}>
      <p className="font-medium">
        {t(item.titleKey)} <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">{t(STATE_PHRASES[item.state.status])}</span>{" "}
        <span className="text-xs font-normal text-slate-500">{item.required ? t("gd.required") : t("gd.optionalTag")}</span>
      </p>
      <p className="text-slate-600">{t(item.whyKey)}</p>
      <p className="text-xs text-slate-500">{say(t, item.because)}</p>
      {item.recommend && (
        <p className="text-xs text-slate-600">
          {t("gd.recommended")}: {say(t, item.recommend)}
        </p>
      )}
      {item.consequence && (
        <p className="text-xs text-slate-600">
          {t("gd.consequence")}: {say(t, item.consequence)}
        </p>
      )}
      {item.state.note && <p className="text-xs text-slate-600">{say(t, item.state.note)}</p>}
      {unverified && !item.state.note && <p className="text-xs text-slate-600">{t("gd.unverified")}</p>}
      {item.state.blockedBy && <p className="text-xs text-slate-600">{t("gd.blockedBy", { steps: item.state.blockedBy.join(", ") })}</p>}
      {item.state.reviewedAt && <p className="text-xs text-slate-600">{t("gd.reviewedOn", { at: item.state.reviewedAt, name: item.state.reviewedBy ?? "" })}</p>}
      <div className="mt-1 flex flex-wrap items-center gap-3">
        {item.configure &&
          (item.allowed ? (
            <button type="button" onClick={() => onGo(item.configure!.tab)} className="min-h-8 rounded-md bg-teal-600 px-3 text-xs font-medium text-white hover:bg-teal-700">
              {t("gd.openScreen", { screen: t(TAB_PHRASES[item.configure.tab]) })}
            </button>
          ) : (
            <span className="text-xs text-slate-500">{t("gd.managerChanges")}</span>
          ))}
        {item.kind === "review" && item.state.status !== "done" && (
          <button type="button" onClick={onReviewed} className="min-h-8 rounded-md border border-slate-300 px-3 text-xs font-medium hover:border-teal-400">
            {t("gd.markReviewed")}
          </button>
        )}
      </div>
    </li>
  );
}

function Readiness({ data, onGo }: { data: SetupView; onGo: (tab: DashboardTab) => void }) {
  const t = useStaffT();
  const r = data.readiness;
  const groups: [StaffPhrase, ReadinessItem[]][] = [
    ["gd.ready.missing", r.requiredMissing],
    ["gd.ready.unverified", r.unverifiedExternal],
    ["gd.ready.legal", r.legalPrerequisite],
    ["gd.ready.feature", r.featureSpecific],
    ["gd.ready.optional", r.optionalEnhancements],
    ["gd.ready.complete", r.configurationComplete],
  ];
  return (
    <div className="space-y-2" data-readiness>
      <h4 className="text-sm font-semibold text-slate-700">{t("gd.ready.heading")}</h4>
      <p className="text-xs text-slate-500">{t("gd.ready.intro")}</p>
      {groups.map(([title, items]) => (
        <div key={title}>
          <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t(title)}</h5>
          {items.length === 0 ? (
            <p className="text-xs text-slate-400">{t("gd.ready.none")}</p>
          ) : (
            <ul className="list-disc pl-5 text-sm text-slate-700">
              {items.map((item) => (
                <li key={item.id}>
                  {item.say ? t.say(item.say) : say(t, item.label)}{" "}
                  {item.configure && (
                    <button type="button" onClick={() => onGo(item.configure!.tab)} className="text-xs underline hover:text-teal-700">
                      {t("gd.open")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- the playbook (placeholder: the playbook replaces it)

function PlaybookView({ venueId }: { venueId: number }) {
  const t = useStaffT();
  const [as, setAs] = useState<GuideRole | null>(null);
  const [data, setData] = useState<PlaybookAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    fetch(`/api/admin/guide/playbook?venueId=${venueId}${as ? `&as=${as}` : ""}`, { cache: "no-store" })
      .then(async (res) => {
        const body = await readJson(res);
        if (!res.ok) throw new Error(t.err(body, t("gd.failed")));
        if (current) setData(body);
      })
      .catch((err) => current && setError(err instanceof Error ? err.message : t("gd.failed")));
    return () => {
      current = false;
    };
  }, [venueId, as, t]);

  if (error)
    return (
      <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {error}
      </p>
    );
  if (!data) return <p className="text-sm text-slate-500">{t("gd.loading")}</p>;
  return (
    <section aria-labelledby="guide-playbook-heading" className="space-y-3">
      <h3 id="guide-playbook-heading" className="font-semibold">
        {t("gp.heading")}
      </h3>
      <Placeholder />
      {data.roles.length > 1 && (
        <label className="flex items-center gap-2 text-sm">
          {t("gd.playbook.as")}
          <select value={data.role} onChange={(e) => setAs(e.target.value as GuideRole)} className="rounded-md border border-slate-300 px-2 py-1 text-sm">
            {data.roles.map((r) => (
              <option key={r} value={r}>
                {t(ROLE_PHRASES[r])}
              </option>
            ))}
          </select>
        </label>
      )}
      <h4 className="text-sm font-semibold text-slate-700">{t("gd.playbook.heading")}</h4>
      <ul className="list-disc pl-5 text-sm text-slate-700">
        {data.facts.map((fact, i) => (
          <li key={i}>{say(t, fact)}</li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- discoveries (placeholder: contextual help and discovery replace it)

function DiscoverView({ data, post, onGo }: { data: SetupView; post: Post; onGo: (tab: DashboardTab) => void }) {
  const t = useStaffT();
  return (
    <section aria-labelledby="guide-discover-heading" className="space-y-3">
      <h3 id="guide-discover-heading" className="font-semibold">
        {t("gh.discoverHeading")}
      </h3>
      <Placeholder />
      <h4 className="text-sm font-semibold text-slate-700">{t("gd.discover.heading")}</h4>
      {data.discoveries.length === 0 && <p className="text-sm text-slate-500">{t("gd.discover.none")}</p>}
      <ul className="space-y-2">
        {data.discoveries.map((d) => (
          <li key={d.id} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" data-discovery={d.id}>
            <p>{say(t, d.reason)}</p>
            <div className="mt-1 flex flex-wrap gap-3">
              {d.configure && (
                <button type="button" onClick={() => onGo(d.configure!.tab)} className="min-h-8 rounded-md bg-teal-600 px-3 text-xs font-medium text-white hover:bg-teal-700">
                  {t("gd.openScreen", { screen: t(TAB_PHRASES[d.configure.tab]) })}
                </button>
              )}
              <button type="button" onClick={() => post({ action: "dismiss", id: d.id })} className="min-h-8 rounded-md border border-slate-300 px-3 text-xs font-medium hover:border-teal-400">
                {t("gd.discover.dismiss")}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
