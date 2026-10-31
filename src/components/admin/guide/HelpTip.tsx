"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Dialog from "@/components/Dialog";
import { readJson } from "@/lib/read-response";
import { HELP_PLACES, guideAddress, topicWrittenFor, type HelpPlaceId, type TopicId } from "@/lib/guide/help";
import { say, type Speaker } from "@/lib/guide/playbook/render";
import type { BuiltTopic, GuideLink } from "@/lib/guide/playbook/types";
import type { DashboardTab, GuideRole } from "@/lib/guide/shell";
import { setPlaceParams } from "../place";
import { useStaffT } from "../StaffLanguage";
import { BlockView } from "./PlaybookDocument";

/**
 * Contextual help (docs/features/venue-guide.md#contextual-help-and-discovery):
 * a small "?" beside the control or heading it explains. Opened, it says what
 * the operating playbook says of that subject, for this venue and this role,
 * with the playbook's own renderer (`BlockView`: there is no second one).
 *
 * It loads lazily, from `GET /api/admin/guide/topic`, only when it is first
 * opened and once however often it is opened again, so a screen that carries
 * tips pays nothing until one is used. The topic is the caller's own role's,
 * decided on the server; a role the topic is not written for is given no tip.
 * What a tip says is whatever the topic says, never text of its own.
 */

/** A topic as the route answers it. */
export interface TopicAnswer {
  venueId: number;
  role: GuideRole;
  topic: BuiltTopic;
  /** "Open this in the guide": null where the role may not open it. */
  guide: GuideLink | null;
}

export type TopicState = { status: "idle" } | { status: "loading" } | { status: "ready"; answer: TopicAnswer } | { status: "failed" } | { status: "gone" };

/**
 * Reads one topic of one venue, when `load` is first called and not again
 * (except after a failure: asking again tries again). `gone` is a topic the
 * server says there is none of for this role (404): its tip hides itself.
 */
export function useTopic(venueId: number, topic: TopicId): { state: TopicState; load: () => void } {
  const [state, setState] = useState<TopicState>({ status: "idle" });
  const started = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const load = useCallback(() => {
    if (started.current) return;
    started.current = true;
    setState({ status: "loading" });
    fetch(`/api/admin/guide/topic?venueId=${venueId}&id=${topic}`, { cache: "no-store" })
      .then(async (res) => {
        const body = await readJson(res);
        if (!alive.current) return;
        if (res.status === 404) return setState({ status: "gone" });
        if (!res.ok || !body?.topic) {
          started.current = false;
          return setState({ status: "failed" });
        }
        setState({ status: "ready", answer: body as TopicAnswer });
      })
      .catch(() => {
        started.current = false;
        if (alive.current) setState({ status: "failed" });
      });
  }, [venueId, topic]);
  return { state, load };
}

/**
 * Open a screen of the dashboard: where the dashboard is on the page, as its
 * own tabs do (the address, then the page reads it), and from another page a
 * staff member is on (the counter's booking page), by going there.
 */
export function openInDashboard(tab: DashboardTab, params: Record<string, string | null> = {}): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname.startsWith("/admin")) {
    setPlaceParams({ tab, ...params }, "push");
    window.dispatchEvent(new PopStateEvent("popstate"));
    return;
  }
  const url = new URL("/admin", window.location.origin);
  url.searchParams.set("tab", tab);
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  window.location.assign(url.toString());
}

/** What a topic says, drawn with the playbook's renderer; its links open the screen they name. */
export function TopicBody({ answer, onGo }: { answer: TopicAnswer; onGo: (link: GuideLink) => void }) {
  const t = useStaffT();
  const speaker: Speaker = useMemo(() => ({ t, locale: t.locale }), [t]);
  return (
    <div className="space-y-2" data-topic={answer.topic.id}>
      {answer.topic.blocks.map((block, i) => (
        <BlockView key={i} block={block} speaker={speaker} onGo={onGo} />
      ))}
      <p className="text-xs text-slate-500">{t("gh.tip.basis")}</p>
    </div>
  );
}

/** The loading, failure and ready states of a topic, for a place that shows one. */
export function TopicStatus({ state, load, onGo }: { state: TopicState; load: () => void; onGo: (link: GuideLink) => void }) {
  const t = useStaffT();
  if (state.status === "ready") return <TopicBody answer={state.answer} onGo={onGo} />;
  if (state.status === "failed")
    return (
      <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {t("gh.tip.failed")}{" "}
        <button type="button" onClick={load} className="underline">
          {t("q8b.tryAgain")}
        </button>
      </p>
    );
  return (
    <p role="status" className="text-sm text-slate-500">
      {t("gh.tip.loading")}
    </p>
  );
}

export function HelpTip({
  place,
  venueId,
  role,
  className = "",
}: {
  place: HelpPlaceId;
  /** The venue the screen is showing; without one there is nothing to explain from, and no tip. */
  venueId: number | null | undefined;
  /** The reader's role where the screen knows it: a role the topic is not written for sees no tip. The server decides regardless. */
  role?: GuideRole | null;
  className?: string;
}) {
  const t = useStaffT();
  const { topic: topicId, question } = HELP_PLACES[place];
  const [open, setOpen] = useState(false);
  const { state, load } = useTopic(venueId ?? 0, topicId);
  const titleId = useId();
  const speaker: Speaker = useMemo(() => ({ t, locale: t.locale }), [t]);

  // Where the topic is not written for the role, or the server has none for it, there is no tip at all.
  useEffect(() => {
    if (state.status === "gone") setOpen(false);
  }, [state.status]);
  if (!venueId || !topicWrittenFor(topicId, role) || state.status === "gone") return null;

  const go = (link: GuideLink) => {
    setOpen(false);
    openInDashboard(link.tab, { view: link.view ?? null });
  };
  const guide = state.status === "ready" ? state.answer.guide : null;

  return (
    <>
      <button
        type="button"
        data-help={place}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("gh.tip.name", { question: t(question) })}
        title={t(question)}
        onClick={() => {
          setOpen(true);
          load();
        }}
        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-teal-400 bg-white text-sm font-bold text-teal-700 hover:bg-teal-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-600 ${className}`}
      >
        <span aria-hidden="true">?</span>
      </button>
      {open &&
        createPortal(
          <Dialog labelledBy={titleId} onClose={() => setOpen(false)} className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 text-left font-normal text-slate-900 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <h2 id={titleId} className="text-base font-semibold">
                {t(question)}
              </h2>
              <button
                type="button"
                data-autofocus
                onClick={() => setOpen(false)}
                className="min-h-8 shrink-0 rounded-md border border-slate-300 px-3 text-sm font-medium hover:border-teal-400"
              >
                {t("gh.tip.close")}
              </button>
            </div>
            {state.status === "ready" && <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{say(speaker, state.answer.topic.title)}</p>}
            <div className="mt-3">
              <TopicStatus state={state} load={load} onGo={go} />
            </div>
            {guide && (
              <p className="mt-4 border-t border-slate-200 pt-3 text-sm">
                <a
                  href={guideAddress(venueId, topicId)}
                  data-guide-link
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                    e.preventDefault();
                    setOpen(false);
                    openInDashboard("guide", { view: "playbook", venue: String(venueId), topic: topicId });
                  }}
                  className="inline-block min-h-6 py-0.5 font-medium text-teal-700 underline"
                >
                  {t("gh.tip.openGuide")}
                </a>
              </p>
            )}
          </Dialog>,
          document.body
        )}
    </>
  );
}
