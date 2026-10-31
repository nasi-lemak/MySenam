"use client";

import { useId, useMemo, useState } from "react";
import { BUILTIN_ACTIVITIES } from "@/lib/activity-catalogue";
import { availabilityOf, capability, type Capability } from "@/lib/guide/capabilities";
import { CAPABILITY_TOPIC, catalogue, setupFocus, type CatalogueItem } from "@/lib/guide/help-catalogue";
import type { SetupView } from "@/lib/guide/http";
import { linkAllowed, SCREEN_PHRASE } from "@/lib/guide/playbook/dsl";
import type { GuideLink } from "@/lib/guide/playbook/types";
import type { DashboardTab } from "@/lib/guide/shell";
import { useStaffT } from "../StaffLanguage";
import { TopicStatus, useTopic } from "./HelpTip";

/**
 * The guide's discover view (docs/features/venue-guide.md#contextual-help-and-discovery):
 * what suits this venue and it does not use yet, at most three, each with the
 * reason it is shown, what it needs and any limitation; then everything
 * MySenam can do, by area, each item marked in use, available or not currently
 * supported.
 *
 * It says "suggestions", never "recommended for you": they come from simple
 * published rules over the venue's saved settings and answers (`discover`,
 * lib/guide/discover.ts), nothing is learned, and nothing is switched on. A
 * suggestion that is set aside stays set aside; one the venue already uses is
 * never offered; an item MySenam does not support is listed with what to do
 * instead and is never offered for setup. A manager's view: the front desk is
 * not shown it (GuideTab), and the server refuses it the data.
 */

type Post = (body: Record<string, unknown>) => Promise<void>;

export function DiscoverView({
  data,
  post,
  onGo,
  onSetUp,
}: {
  data: SetupView;
  post: Post;
  onGo: (tab: DashboardTab) => void;
  /** Start a targeted setup journey (`?view=setup&focus=`), without the whole of setup again. */
  onSetUp: (focus: string) => void;
}) {
  const t = useStaffT();
  const suggestions = data.discoveries;
  const groups = useMemo(() => catalogue(data.profile, suggestions.map((d) => d.id)), [data.profile, suggestions]);
  const actions = { venueId: data.venueId, role: data.role, onGo, onSetUp };
  return (
    <section aria-labelledby="guide-discover-heading" className="space-y-6" data-discover>
      <div>
        <h3 id="guide-discover-heading" className="font-semibold">
          {t("gh.discoverHeading")}
        </h3>
        <p className="mt-0.5 text-sm text-slate-600">{t("gh.disc.intro")}</p>
      </div>

      <section aria-labelledby="guide-suggestions-heading" data-suggestions className="space-y-2">
        <h4 id="guide-suggestions-heading" className="text-sm font-semibold text-slate-700">
          {t("gh.disc.suggestions", { n: suggestions.length })}
        </h4>
        {suggestions.length === 0 && <p className="text-sm text-slate-500">{t("gd.discover.none")}</p>}
        <ul className="space-y-3">
          {suggestions.map((d) => {
            const cap = capability(d.id);
            if (!cap) return null;
            return (
              <li key={d.id} data-suggestion={d.id} className="space-y-2 rounded-xl border border-teal-200 bg-white px-4 py-3 text-sm">
                <p className="font-semibold">{t.customer(cap.titleKey)}</p>
                <p className="text-slate-700">{t(d.reason.key, d.reason.vars)}</p>
                <Needs capability={cap} />
                <Actions capability={cap} focus={setupFocus(cap, data.profile)} dismiss={() => post({ action: "dismiss", id: d.id })} {...actions} />
                <How capability={cap} topic={CAPABILITY_TOPIC[d.id] ?? null} venueId={data.venueId} onGo={onGo} />
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="guide-catalogue-heading" data-catalogue className="space-y-2">
        <div>
          <h4 id="guide-catalogue-heading" className="text-base font-semibold">
            {t("gh.catalog.heading")}
          </h4>
          <p className="mt-0.5 text-sm text-slate-600">{t("gh.catalog.intro")}</p>
        </div>
        <div className="space-y-2">
          {groups.map((g) => (
            <details key={g.group} data-group={g.group} className="rounded-xl border border-slate-200 bg-white">
              <summary className="min-h-10 cursor-pointer px-4 py-2 text-sm">
                <span className="font-semibold">{t(`gh.group.${g.group}`)}</span>{" "}
                <span className="text-xs text-slate-500">{t("gh.catalog.counts", g.counts)}</span>
              </summary>
              <ul className="divide-y divide-slate-100 border-t border-slate-100 px-4">
                {g.items.map((item) => (
                  <Row key={item.capability.id} item={item} venueId={data.venueId} role={data.role} onGo={onGo} onSetUp={onSetUp} />
                ))}
              </ul>
            </details>
          ))}
        </div>
      </section>
    </section>
  );
}

/** What a capability needs, in the guide's words, and the services it depends on. */
function Needs({ capability: cap }: { capability: Capability }) {
  const t = useStaffT();
  const availability = availabilityOf(cap);
  const services = (cap.integrations ?? []).map((i) => t(`gh.integ.${i}`)).join(t("gp.list.join"));
  return (
    <p className="text-xs text-slate-600" data-availability={availability}>
      <span className="font-medium">{t(`gh.avail.${availability}`)}</span>
      {services !== "" && cap.status === "available" && <> {t("gh.disc.needs", { services })}</>}
    </p>
  );
}

/** What the catalogue says is wrong with a way of selling or working that MySenam does not support: what the activity's note says. */
function limitationOf(cap: Capability, t: ReturnType<typeof useStaffT>): string | null {
  if (!cap.activityNote) return null;
  const activity = BUILTIN_ACTIVITIES.find((a) => a.key === cap.activityNote);
  if (!activity?.supportNote) return null;
  return t.known(`srv.support.${activity.key}`) ?? activity.supportNote;
}

/** The buttons of a suggestion or an available item: set it up (a targeted journey) or open its screen; never for one that is not supported. */
function Actions({
  capability: cap,
  focus,
  dismiss,
  venueId,
  role,
  onGo,
  onSetUp,
}: {
  capability: Capability;
  focus: string | null;
  dismiss?: () => Promise<void>;
  venueId: number;
  role: SetupView["role"];
  onGo: (tab: DashboardTab) => void;
  onSetUp: (focus: string) => void;
}) {
  const t = useStaffT();
  const [busy, setBusy] = useState(false);
  if (cap.status !== "available") return null;
  const screen = cap.configure && linkAllowed(role, cap.configure.tab, cap.staffAction ?? undefined) ? cap.configure : null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {focus ? (
        <a
          href={`/admin?tab=guide&view=setup&venue=${venueId}&focus=${focus}`}
          data-setup={focus}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            onSetUp(focus);
          }}
          className="inline-flex min-h-8 items-center rounded-md bg-teal-600 px-3 text-xs font-medium text-white hover:bg-teal-700"
        >
          {t("gh.disc.setUp")}
        </a>
      ) : (
        screen && (
          <button type="button" onClick={() => onGo(screen.tab)} className="min-h-8 rounded-md bg-teal-600 px-3 text-xs font-medium text-white hover:bg-teal-700">
            {t("gd.openScreen", { screen: t(SCREEN_PHRASE[screen.tab]) })}
          </button>
        )
      )}
      {dismiss && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await dismiss();
            } finally {
              setBusy(false);
            }
          }}
          className="min-h-8 rounded-md border border-slate-300 px-3 text-xs font-medium hover:border-teal-400 disabled:opacity-50"
        >
          {busy ? t("gh.disc.working") : t("gh.disc.notForUs")}
        </button>
      )}
    </div>
  );
}

/** "How it works": the capability's own sentence and, where the playbook has a topic for it, this venue's version of it, loaded when first opened. */
function How({ capability: cap, topic, venueId, onGo }: { capability: Capability; topic: CatalogueItem["topic"]; venueId: number; onGo: (tab: DashboardTab) => void }) {
  const t = useStaffT();
  const [open, setOpen] = useState(false);
  const id = useId();
  const { state, load } = useTopic(venueId, topic ?? "buffers");
  const go = (link: GuideLink) => onGo(link.tab);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen(!open);
          if (!open && topic) load();
        }}
        className="min-h-8 rounded-md px-2 text-xs font-medium text-teal-700 underline"
      >
        {t("gh.disc.how")}
      </button>
      <div id={id} hidden={!open} className="mt-1 space-y-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
        <p>{t.customer(cap.blurbKey)}</p>
        {open && topic && state.status !== "gone" && <TopicStatus state={state} load={load} onGo={go} />}
      </div>
    </div>
  );
}

/** One item of "everything MySenam can do". */
function Row({ item, venueId, role, onGo, onSetUp }: { item: CatalogueItem; venueId: number; role: SetupView["role"]; onGo: (tab: DashboardTab) => void; onSetUp: (focus: string) => void }) {
  const t = useStaffT();
  const cap = item.capability;
  const limit = limitationOf(cap, t);
  const stateWord = item.state === "in-use" ? t("gh.state.inUse") : item.state === "available" ? t("gh.state.available") : t("gh.avail.unsupported");
  return (
    <li data-capability={cap.id} data-state={item.state} className="space-y-1 py-3 text-sm">
      <p>
        <span className="font-medium">{t.customer(cap.titleKey)}</span>{" "}
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">{stateWord}</span>
      </p>
      {item.state !== "unsupported" && <Needs capability={cap} />}
      {item.state === "unsupported" && (
        <>
          <p className="text-slate-700">{t("gh.disc.instead", { text: t.customer(cap.alternativeKey!) })}</p>
          {limit && <p className="text-xs text-slate-600">{t("gh.disc.limit", { text: limit })}</p>}
        </>
      )}
      {item.state === "available" && item.suggested && <p className="text-xs font-medium text-teal-700">{t("gh.catalog.suggested")}</p>}
      {item.state !== "unsupported" && !item.suggested && <Actions capability={cap} focus={item.focus} venueId={venueId} role={role} onGo={onGo} onSetUp={onSetUp} />}
      <How capability={cap} topic={item.topic} venueId={venueId} onGo={onGo} />
    </li>
  );
}
