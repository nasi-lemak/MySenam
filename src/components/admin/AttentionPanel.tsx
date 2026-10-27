"use client";

import { useCallback, useEffect, useState } from "react";
import type { UrgentNotice } from "@/lib/urgent";
import type { OverdueRefunds } from "@/lib/payments";
import type { GuardianReviews, NoticeTask } from "@/lib/contact-guardians";
import { money } from "@/lib/region";
import { formatHour } from "@/lib/time";
import type { StaffT } from "@/lib/staff-i18n";
import { useStaffT } from "./StaffLanguage";

const REACH_STYLE: Record<UrgentNotice["reach"], string> = {
  unreachable: "bg-red-100 text-red-800",
  failed: "bg-red-100 text-red-800",
  waiting: "bg-slate-100 text-slate-700",
  sent: "bg-amber-100 text-amber-800",
  delivered: "bg-amber-100 text-amber-800",
  read: "bg-sky-100 text-sky-800",
  acknowledged: "bg-emerald-100 text-emerald-800",
  told: "bg-emerald-100 text-emerald-800",
};

function reachLabels(t: StaffT): Record<UrgentNotice["reach"], string> {
  return {
    unreachable: t("att.reach.unreachable"),
    failed: t("att.reach.failed"),
    waiting: t("att.reach.waiting"),
    sent: t("att.reach.sent"),
    delivered: t("att.reach.delivered"),
    read: t("att.reach.read"),
    acknowledged: t("att.reach.acknowledged"),
    told: t("att.reach.told"),
  };
}

/** An outbox message's status as staff read it; one this screen does not know stays as stored. */
function statusLabel(t: StaffT, status: string): string {
  const known: Record<string, string> = {
    queued: t("att.state.queued"),
    sent: t("att.state.sent"),
    abandoned: t("att.state.abandoned"),
  };
  return known[status] ?? status;
}

function channelLine(t: StaffT, n: UrgentNotice) {
  return n.messages
    .map((m) => {
      const state = m.readAt
        ? t("att.state.read")
        : m.deliveredAt
          ? t("att.state.delivered")
          : m.error
            ? t("att.state.failed", { error: m.error })
            : statusLabel(t, m.status);
      return t("att.channelState", { channel: m.channel === "whatsapp" ? "WhatsApp" : t("c.email"), state });
    })
    .join(" · ");
}

/**
 * News the venue gave a customer that the customer must not miss — a
 * cancellation, a closure, a move — until the customer says they have seen
 * it or staff record that they told them. Soonest booking first: that is the
 * one somebody might turn up for.
 */
export function AttentionPanel() {
  const t = useStaffT();
  const [data, setData] = useState<{
    open: UrgentNotice[];
    recent: UrgentNotice[];
    refundsOverdue?: OverdueRefunds[];
    guardianTasks?: NoticeTask[];
    guardianReviews?: GuardianReviews[];
  } | null>(null);
  const [showRecent, setShowRecent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/attention", { cache: "no-store" });
    if (res.ok) setData(await res.json());
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    // Straight after staff cancel or move something.
    const now = () => void load();
    window.addEventListener("attention:refresh", now);
    return () => {
      clearInterval(timer);
      window.removeEventListener("attention:refresh", now);
    };
  }, [load]);

  const overdue = data?.refundsOverdue ?? [];
  const tasks = data?.guardianTasks ?? [];
  const reviews = data?.guardianReviews ?? [];
  const guardians = tasks.length + reviews.length > 0;
  if (!data?.open || !data.recent || (data.open.length === 0 && data.recent.length === 0 && overdue.length === 0 && !guardians)) return null;

  /** A guardian recorded by name and number, told by staff of a change (lib/contact-guardians.ts). */
  async function guardianTold(taskId: number) {
    setError(null);
    const res = await fetch("/api/admin/attention", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, action: "guardianTold", how: "told" }),
    });
    const out = await res.json();
    if (!res.ok) setError(t.err(out, t("att.saveFailed")));
    else setData((was) => (was ? { ...was, ...out } : was));
  }

  const reach = reachLabels(t);
  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-4" aria-label={t("att.title")}>
      {reviews.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-amber-900">
          <strong>{t("gw5.att.reviews")}</strong>{" "}
          {reviews.map((r) => t("gw5.att.reviewLine", { venue: r.venueName, waiting: r.waiting, due: r.datesDue })).join(" ")}
        </div>
      )}
      {tasks.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-amber-900">
          <strong>{t("gw5.att.tasks", { n: tasks.length })}</strong>
          <ul className="mt-1 space-y-1 text-xs">
            {tasks.map((task) => (
              <li key={task.id} className="flex flex-wrap items-center gap-2">
                <span>
                  {t("gw5.att.taskLine", { guardian: task.guardianName, name: task.displayName, change: t(`gw5.att.change.${task.change}`) })}{" "}
                  <a href={`tel:${task.phone}`} className="text-teal-700 underline">
                    {task.phone}
                  </a>{" "}
                  ({t(`gw5.att.why.${task.why}`)})
                </span>
                <button type="button" onClick={() => void guardianTold(task.id)} className="font-semibold text-teal-700 underline">
                  {t("gw5.att.told")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {overdue.length > 0 && (
        <div className="mb-3 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm text-red-800">
          <strong>{t("att.refundsOverdue")}</strong>{" "}
          {t("att.overdueHelp", {
            list: overdue
              .map((v) => t.plural("att.overdueVenue", v.oldestDays, { venue: v.venueName, count: v.count, amount: money(v.amount) }))
              .join("; "),
          })}
        </div>
      )}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-bold text-amber-900">
          {data.open.length > 0 ? t("att.titleCount", { n: data.open.length }) : overdue.length > 0 || guardians ? t("att.title") : t("att.nothing")}
        </h2>
        {data.recent.length > 0 && (
          <button onClick={() => setShowRecent(!showRecent)} className="text-xs text-amber-800 underline">
            {showRecent ? t("c.hide") : t("att.closedWeek", { n: data.recent.length })}
          </button>
        )}
      </div>
      {data.open.length > 0 && (
        <p className="mt-1 text-xs text-amber-800">
          {t("att.intro")}
        </p>
      )}
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      <ul className="mt-3 space-y-2">
        {[...data.open, ...(showRecent ? data.recent : [])].map((n) => (
          <li key={n.id} className="rounded-lg bg-white p-3 text-sm shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">
                {n.date} {formatHour(n.startHour)}
              </span>
              <span className="text-slate-500">{n.kind === "cancelled" ? t("att.cancelled") : t("att.moved")}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${REACH_STYLE[n.reach]}`}>{reach[n.reach]}</span>
            </div>
            <div className="mt-1">
              {n.name} ·{" "}
              <a href={`tel:${n.phone}`} className="text-teal-700 underline">
                {n.phone}
              </a>
              {n.email && <span className="text-slate-500"> · {n.email}</span>}
            </div>
            <div className="mt-1 text-xs text-slate-500">{t.say(n.summaryPhrase, n.summary)}</div>
            {n.messages.length > 0 && <div className="mt-1 text-xs text-slate-500">{channelLine(t, n)}</div>}
            {n.resolvedAt === null && (
              <button
                onClick={async () => {
                  setError(null);
                  const res = await fetch("/api/admin/attention", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id: n.id, action: "told" }),
                  });
                  const out = await res.json();
                  if (!res.ok) setError(t.err(out, t("att.saveFailed")));
                  else setData((was) => ({ ...was, ...out }));
                }}
                className="mt-2 rounded-md border border-teal-600 px-2.5 py-1 text-xs font-semibold text-teal-700 hover:bg-teal-50"
              >
                {t("att.told")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
