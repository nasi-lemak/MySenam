"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import type { UrgentNotice } from "@/lib/urgent";
import type { OverdueRefunds } from "@/lib/payments";
import type { GuardianReviews, NoticeTask } from "@/lib/contact-guardians";
import type { ClassCoachConflict } from "@/lib/class-coaches";
import type { UncoveredSession } from "@/lib/rosters";
import { formatMinute } from "@/lib/interval";
import { money } from "@/lib/region";
import { formatHour } from "@/lib/time";
import type { Stranded } from "@/lib/launch-worklist";
import type { MoveRequestView } from "@/lib/class-move-requests";
import type { SafetyFlag } from "@/lib/safety-flags";
import { ClassMoveRequestList } from "./ClassMoveRequests";
import type { StaffT } from "@/lib/staff-i18n";
import { useStaffT } from "./StaffLanguage";
import type { CompetitionFixture, UndrawnTournament } from "@/lib/competition-fixtures";
import type { ModerationAttention } from "@/lib/message-moderation";
import type { OverdueInvoice } from "@/lib/accounts";
import type { PeopleAttention as PeopleData } from "@/lib/people-attention";
import { PeopleAttention, peopleLineCount } from "./PeopleAttention";

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
    classCoachConflicts?: ClassCoachConflict[];
    launchStranded?: { venueId: number; count: number; items: Stranded[] }[];
    /** Sessions to come with too few qualified people rostered (lib/rosters.ts), for a manager to decide. */
    uncovered?: UncoveredSession[];
    /** Front desk's class moves waiting for a manager, and a desk's own outcomes (lib/class-move-requests.ts). */
    classMoveRequests?: MoveRequestView[];
    /** Bookings a refused number or a sign-off, certification or induction taken back left for a decision; none cancelled (lib/safety-flags.ts, ADR 0058). */
    safetyFlags?: SafetyFlag[];
    /** A manager's: venues whose overrides of advisory windows in 7 days are past the venue's limit (lib/window-overrides.ts). */
    windowOverrideAlerts?: { venueId: number; count: number; limit: number }[];
    /** Safeguarding (ADR 0052): the owner's overdue restrictions and escalated cases, and what is waiting for a manager or the owner to decide. */
    safeguarding?: {
      overdue: { reportId: number | null; groupId: number; groupName: string }[];
      escalatedCases: { reportId: number; groupId: number; groupName: string; kind: string }[];
      appealsWaiting: number;
      reviewsOpen: number;
      retention: { cases: number; holds: number; months: number } | null;
    } | null;
    /** Fixtures left on a court out of service or a closed day, and tournaments past their first day with no draw (ADR 0059). */
    competitions?: { stranded: CompetitionFixture[]; undrawn: UndrawnTournament[] } | null;
    /** Open reports of messages, automatic suspensions to review and requests for a review (ADR 0059). */
    messageModeration?: ModerationAttention | null;
    /** Invoices to company and school accounts unpaid past their day, oldest first, and whether the venue's block stops new bookings on each (lib/accounts.ts). */
    accountsOverdue?: (OverdueInvoice & { blocking: boolean })[];
    /** No-show marks players answered, passes and memberships ending, strikes, coaches with no email (lib/people-attention.ts, ADR 0072). */
    people?: PeopleData;
  } | null>(null);
  const [showRecent, setShowRecent] = useState(false);
  const [moveTo, setMoveTo] = useState<Record<string, string>>({});
  const [moved, setMoved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/attention", { cache: "no-store" });
    if (res.ok) setData(await readJson(res));
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
  // Booked time a launch or tide window now leaves outside it (ADR 0037): nothing was cancelled.
  const stranded = data?.launchStranded ?? [];
  const coachConflicts = data?.classCoachConflicts ?? [];
  const uncovered = data?.uncovered ?? [];
  const moveRequests = data?.classMoveRequests ?? [];
  const overrideAlerts = data?.windowOverrideAlerts ?? [];
  const flags = data?.safetyFlags ?? [];
  const sg = data?.safeguarding ?? null;
  const sgLines = sg ? sg.overdue.length + sg.escalatedCases.length + sg.appealsWaiting + sg.reviewsOpen + (sg.retention ? 1 : 0) : 0;
  const comp = data?.competitions ?? null;
  // Stranded fixtures grouped by what they belong to and the day, so one action moves the day.
  const days = new Map<string, { kind: CompetitionFixture["kind"]; ownerId: number; name: string; date: string; why: CompetitionFixture["why"]; n: number }>();
  for (const f of comp?.stranded ?? []) {
    const k = `${f.kind}:${f.ownerId}:${f.date}`;
    const had = days.get(k);
    if (had) had.n++;
    else days.set(k, { kind: f.kind, ownerId: f.ownerId, name: f.name, date: f.date, why: f.why, n: 1 });
  }
  const mod = data?.messageModeration ?? null;
  const modLines = mod ? (mod.openReports > 0 ? 1 : 0) + mod.suspensionsToReview.length + (mod.reviewRequests > 0 ? 1 : 0) : 0;
  const compLines = days.size + (comp?.undrawn.length ?? 0) + modLines;
  const overdueAccounts = data?.accountsOverdue ?? [];
  const peopleLines = peopleLineCount(data?.people);
  if (!data?.open || !data.recent || (peopleLines === 0 && overdueAccounts.length === 0 && data.open.length === 0 && data.recent.length === 0 && overdue.length === 0 && !guardians && coachConflicts.length === 0 && stranded.length === 0 && uncovered.length === 0 && moveRequests.length === 0 && overrideAlerts.length === 0 && flags.length === 0 && sgLines === 0 && compLines === 0)) return null;

  /** Postpone a day's fixtures of a tournament or a team league to another day (ADR 0059). */
  async function postpone(d: { kind: CompetitionFixture["kind"]; ownerId: number; date: string }) {
    setError(null);
    setMoved(null);
    const to = moveTo[`${d.kind}:${d.ownerId}:${d.date}`];
    if (!to) return setError(t("fx10.att.pickDay"));
    const res = await fetch(d.kind === "tournament" ? `/api/admin/tournaments/${d.ownerId}` : `/api/admin/team-leagues/${d.ownerId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "postpone_day", from: d.date, to }),
    });
    const out = await readJson(res);
    if (!res.ok) return setError(t.err(out, t("fx10.att.postponeFailed")));
    setMoved(t("fx10.att.postponed", { n: out.moved ?? 0, date: to }) + (Array.isArray(out.left) && out.left.length > 0 ? ` ${t("fx10.att.left", { n: out.left.length })}` : ""));
    void load();
  }

  /** A guardian recorded by name and number, told by staff of a change (lib/contact-guardians.ts). */
  async function guardianTold(taskId: number) {
    setError(null);
    const res = await fetch("/api/admin/attention", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, action: "guardianTold", how: "told" }),
    });
    const out = await readJson(res);
    if (!res.ok) setError(t.err(out, t("att.saveFailed")));
    else setData((was) => (was ? { ...was, ...out } : was));
  }

  /** Cancel a flagged booking with a refund (the ordinary staff cancellation: what was paid goes back as it was paid). */
  async function cancelFlagged(f: SafetyFlag) {
    if (!window.confirm(t("fx9.att.cancelConfirm", { code: f.bookingCode }))) return;
    setError(null);
    const res = await fetch("/api/admin/bookings/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: f.bookingCode }),
    });
    const out = await readJson(res);
    if (!res.ok) setError(t.err(out, t("att.saveFailed")));
    else void load();
  }

  /** A manager leaves a flagged booking as it is, and says why (kept on record). */
  async function leaveFlagged(f: SafetyFlag) {
    const note = window.prompt(t("fx9.att.leavePrompt", { code: f.bookingCode }));
    if (note === null) return;
    setError(null);
    const res = await fetch("/api/admin/attention", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flagId: f.id, action: "safetyFlag", note }),
    });
    const out = await readJson(res);
    if (!res.ok) setError(t.err(out, t("att.saveFailed")));
    else setData((was) => (was ? { ...was, ...out } : was));
  }

  const reach = reachLabels(t);
  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-4" aria-label={t("att.title")}>
      {data.people && peopleLines > 0 && <PeopleAttention data={data.people} />}
      {compLines > 0 && (
        <div className="mb-3 space-y-1 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-amber-900" data-testid="competition-attention">
          <strong>{t("fx10.att.title")}</strong>
          {moved && <p role="status">{moved}</p>}
          {[...days.values()].map((d) => {
            const key = `${d.kind}:${d.ownerId}:${d.date}`;
            return (
              <p key={key} className="flex flex-wrap items-center gap-2">
                <span>{t("fx10.att.stranded", { name: d.name, n: d.n, date: d.date, why: t(d.why === "closure" ? "fx10.att.why.closure" : "fx10.att.why.outage") })}</span>
                <input type="date" aria-label={t("fx10.att.moveTo")} value={moveTo[key] ?? ""} onChange={(e) => setMoveTo((had) => ({ ...had, [key]: e.target.value }))} className="rounded-md border border-slate-300 px-2 py-1 text-xs" />
                <button type="button" onClick={() => void postpone(d)} className="font-semibold text-teal-700 underline">
                  {t("fx10.att.move")}
                </button>
              </p>
            );
          })}
          {(comp?.undrawn ?? []).map((u) => (
            <p key={`u${u.id}`}>
              {t("fx10.att.undrawn", { name: u.name, date: u.startsOn, n: u.entered })}
              {u.held.length > 0 && (
                <span className="block text-xs">
                  {t("fx10.att.held", { courts: u.held.slice(0, 6).map((h) => `${h.courtName} ${h.date} ${formatMinute(h.startMin, t.locale)}–${formatMinute(h.endMin, t.locale)}`).join("; ") })}
                  {u.held.length > 6 ? ` ${t("fx10.att.heldMore", { n: u.held.length - 6 })}` : ""}
                </span>
              )}
            </p>
          ))}
          {mod && mod.openReports > 0 && <p>{t("fx10.msg.att.reports", { n: mod.openReports, days: mod.waitingDays })}</p>}
          {mod?.suspensionsToReview.map((x) => (
            <p key={`s${x.id}`}>{t(x.overdue ? "fx10.msg.att.suspensionOverdue" : "fx10.msg.att.suspension", { id: x.id, date: x.reviewBy.slice(0, 10) })}</p>
          ))}
          {mod && mod.reviewRequests > 0 && <p>{t.plural("fx10.msg.att.requests", mod.reviewRequests)}</p>}
        </div>
      )}
      {sg && sgLines > 0 && (
        <div className="mb-3 space-y-1 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-amber-900" data-testid="safeguarding-attention">
          <strong>{t("msg4.att.title")}</strong>
          {sg.overdue.map((o) => (
            <p key={`o${o.groupId}-${o.reportId}`}>{t("msg4.att.overdue", { group: o.groupName, id: o.reportId ?? 0 })}</p>
          ))}
          {sg.escalatedCases.map((e) => (
            <p key={`e${e.reportId}`}>{t("msg4.att.escalated", { group: e.groupName, id: e.reportId, kind: t.known(`msg4.esc.${e.kind}`) ?? e.kind })}</p>
          ))}
          {sg.appealsWaiting > 0 && <p>{t.plural("msg4.att.appeals", sg.appealsWaiting)}</p>}
          {sg.reviewsOpen > 0 && <p>{t.plural("msg4.att.reviews", sg.reviewsOpen)}</p>}
          {sg.retention && <p>{t("msg4.att.retention", { cases: sg.retention.cases, holds: sg.retention.holds, months: sg.retention.months })}</p>}
        </div>
      )}
      {overdueAccounts.length > 0 && (
        <div className="mb-3 space-y-1 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-amber-900" data-testid="attention-overdue-accounts">
          <strong>{t("fx4.att.accTitle")}</strong>
          {overdueAccounts.slice(0, 20).map((o) => (
            <p key={o.id}>
              {t("fx4.att.accLine", { account: o.accountName, number: o.number, due: o.dueOn, days: o.daysOverdue, amount: money(o.balance) })}
              {o.blocking && <span className="ml-1 font-semibold text-red-700">{t("fx4.att.accBlocking")}</span>}
            </p>
          ))}
          <p className="text-xs">{t("fx4.att.accHelp")}</p>
        </div>
      )}
      {flags.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-amber-900" data-testid="attention-safety-flags">
          <strong>{t.plural("fx9.att.title", flags.length)}</strong>
          <p className="mt-0.5 text-xs">{t("fx9.att.help")}</p>
          <ul className="mt-1 space-y-2 text-xs">
            {flags.map((f) => (
              <li key={f.id} className="rounded-md bg-amber-50 px-2 py-1.5">
                <div>
                  {t("fx9.att.line", {
                    code: f.bookingCode,
                    name: f.name,
                    when: `${f.date} ${formatMinute(f.start, t.locale)}–${formatMinute(f.end, t.locale)}`,
                    court: f.courtName,
                  })}{" "}
                  <a href={`tel:${f.phone}`} className="text-teal-700 underline">
                    {f.phone}
                  </a>
                </div>
                <div className="mt-0.5">
                  {f.kind === "blocked"
                    ? f.reason
                      ? t("fx9.att.blockedWhy", { reason: f.reason })
                      : t("fx9.att.blocked")
                    : t(f.reason ? "fx9.att.lostWhy" : "fx9.att.lost", {
                        what: t(`fx9.att.what.${f.what}` as "fx9.att.what.sign-off"),
                        by: f.by ?? "",
                        when: f.createdAt.slice(0, 10),
                        reason: f.reason ?? "",
                      })}
                  {f.kind === "eligibility" && <> · {f.told ? t("fx9.att.told") : t("fx9.att.notTold")}</>}
                  {f.paid && <> · {t("fx9.att.paid")}</>}
                </div>
                <div className="mt-1 flex flex-wrap gap-2">
                  <button type="button" onClick={() => void cancelFlagged(f)} className="rounded-md border border-red-300 px-2 py-0.5 font-semibold text-red-700 hover:bg-red-50">
                    {t("fx9.att.cancel")}
                  </button>
                  <button type="button" onClick={() => void leaveFlagged(f)} className="rounded-md border border-teal-600 px-2 py-0.5 font-semibold text-teal-700 hover:bg-teal-50">
                    {t("fx9.att.leave")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {reviews.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-amber-900">
          <strong>{t("gw5.att.reviews")}</strong>{" "}
          {reviews.map((r) => t("gw5.att.reviewLine", { venue: r.venueName, waiting: r.waiting, due: r.datesDue })).join(" ")}
        </div>
      )}
      {moveRequests.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-amber-900" data-testid="attention-move-requests">
          <ClassMoveRequestList requests={moveRequests} onChanged={() => void load()} />
        </div>
      )}
      {overrideAlerts.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-amber-900">
          {overrideAlerts.map((a) => (
            <p key={a.venueId}>
              <strong>{t("safe1.att.alert", { n: a.count, limit: a.limit })}</strong>
            </p>
          ))}
          <p className="mt-0.5 text-xs">{t("safe1.att.help")}</p>
        </div>
      )}
      {uncovered.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-amber-900">
          <strong>{t.plural("rs1.att.title", uncovered.length)}</strong>
          <p className="mt-0.5 text-xs">{t("rs1.att.help")}</p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {uncovered.slice(0, 8).map((u) => (
              <li key={`${u.kind}:${u.id}`}>
                {t("rs1.att.line", {
                  when: `${u.date} ${formatMinute(u.startMin, t.locale)}`,
                  court: u.courtName,
                  what: u.kind === "booking" ? (u.code ?? u.name) : u.name,
                  roles: u.roles.map((r) => `${r.needed} × ${t.known(`rs1.role.${r.roleKey}`) ?? r.roleName}`).join(", "),
                })}
              </li>
            ))}
          </ul>
          {uncovered.length > 8 && <p className="mt-1 text-xs">{t("rs1.att.more", { n: uncovered.length - 8 })}</p>}
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
                  ({task.why === "not_delivered" ? t("fin6.att.why.not_delivered") : t(`gw5.att.why.${task.why}`)})
                </span>
                <button type="button" onClick={() => void guardianTold(task.id)} className="font-semibold text-teal-700 underline">
                  {t("gw5.att.told")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {coachConflicts.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-amber-900" data-testid="attention-coach-conflicts">
          <strong>{t("clsa.conf.title", { n: coachConflicts.length })}</strong>
          <ul className="mt-1 space-y-1 text-xs">
            {coachConflicts.map((c) => (
              <li key={c.classId}>
                {t("clsa.conf.line", {
                  name: c.name,
                  date: c.date,
                  time: `${formatHour(c.startMin / 60, t.locale)}–${formatHour(c.endMin / 60, t.locale)}`,
                  venue: c.venueName,
                  coach: c.coachName,
                  reasons: c.reasons.map((r) => t(`clsa.conf.${r}`)).join(", "),
                })}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs">{t("clsa.conf.help")}</p>
        </div>
      )}
      {stranded.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-amber-900" data-testid="attention-launch">
          <strong>{t("wtrs.att", { n: stranded.reduce((n, v) => n + v.count, 0) })}</strong>
          <ul className="mt-1 space-y-0.5 text-xs">
            {stranded.flatMap((v) =>
              v.items.map((s) => (
                <li key={`${v.venueId}-${s.kind}-${s.ref}`}>
                  {t("wtrs.wl.line", {
                    date: s.date,
                    time: formatMinute(s.startMin, t.locale),
                    end: formatMinute(s.endMin, t.locale),
                    court: s.court,
                    name: s.kind === "class" ? t("wtrs.wl.class", { name: s.name }) : s.name,
                  })}
                </li>
              ))
            )}
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
          {data.open.length > 0 ? t("att.titleCount", { n: data.open.length }) : overdue.length > 0 || guardians || coachConflicts.length > 0 || stranded.length > 0 || uncovered.length > 0 || moveRequests.length > 0 || overrideAlerts.length > 0 || flags.length > 0 ? t("att.title") : t("att.nothing")}
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
                {n.date} {formatHour(n.startHour, t.locale)}
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
                  const out = await readJson(res);
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
