"use client";

import type { StaffPhrase } from "@/lib/staff-i18n";
import type { JourneyView } from "@/lib/guide/setup-journey";
import { takesCounterPayments, usesOnlinePayments } from "@/lib/guide/profile-types";
import type { DashboardTab } from "@/lib/guide/shell";
import { money } from "@/lib/region";
import { useStaffT } from "../StaffLanguage";
import { friendlyDate } from "./setup/say";
import { formatMinute } from "@/lib/interval";

/**
 * *Try it*: what to try as a customer and as staff before going live
 * (docs/features/venue-guide.md#the-setup-journey).
 *
 * Each check is ticked only from saved state where state exists (a test
 * booking exists, a counter payment was recorded on one, one was cancelled)
 * and says plainly "not checked by MySenam" where it cannot be (a message
 * arriving, a price compared by eye). It uses the test-booking model: a
 * booking made while the venue is a draft is a test, marked as one and kept
 * out of the figures, and a manager clears or keeps them from the banner at the
 * top of the dashboard. A live venue is told it is live and is never encouraged
 * to make a pretend booking: MySenam has no separate preview for one.
 */

type Mark = "done" | "todo" | "unchecked";

const MARK_PHRASES: Record<Mark, StaffPhrase> = { done: "gs.try.done", todo: "gs.try.todo", unchecked: "gs.try.unchecked" };
const MARK_ICONS: Record<Mark, string> = { done: "✓", todo: "○", unchecked: "?" };

export function SetupTryIt({ view, onGo }: { view: JourneyView; onGo: (tab: DashboardTab) => void }) {
  const t = useStaffT();
  const { tryIt, prices } = view.extras;
  const profile = view.profile;
  const live = tryIt.live;
  const counter = takesCounterPayments(profile) || view.answers.channels === undefined || view.answers.channels.includes("counter");
  const terms = profile.policies.cancellation;

  const checks: { id: string; mark: Mark; title: StaffPhrase; body: React.ReactNode; action?: React.ReactNode }[] = [];
  if (!live)
    checks.push({
      id: "customer",
      mark: tryIt.made > 0 ? "done" : "todo",
      title: "gs.try.customer.title",
      body: t("gs.try.customer.body"),
      action: (
        <a href={tryIt.publicPath} target="_blank" rel="noopener" className="inline-flex min-h-9 items-center rounded-md bg-teal-600 px-3 text-sm font-medium text-white hover:bg-teal-700">
          {t("set.openPage")}
        </a>
      ),
    });
  checks.push({
    id: "schedule",
    mark: tryIt.made > 0 ? "done" : "todo",
    title: "gs.try.schedule.title",
    body: t("gs.try.schedule.body", { n: tryIt.standing }),
    action: (
      <button type="button" onClick={() => onGo("bookings")} className="min-h-9 rounded-md border border-slate-300 px-3 text-sm font-medium hover:border-teal-400">
        {t("gd.openScreen", { screen: t("sh.tab.bookings") })}
      </button>
    ),
  });
  checks.push({
    id: "price",
    mark: "unchecked",
    title: "gs.try.price.title",
    body:
      prices.length > 0 ? (
        <>
          <span>{t("gs.try.price.body")}</span>
          <ul className="mt-1 list-disc pl-5">
            {prices.map((p) => (
              <li key={p.courtId}>
                {t(p.peak ? "gs.try.price.rowPeak" : "gs.try.price.row", { court: p.court, date: friendlyDate(p.date, t.locale), time: formatMinute(p.startMin, t.locale), amount: money(p.total) })}
              </li>
            ))}
          </ul>
        </>
      ) : (
        t("gs.try.price.none")
      ),
  });
  checks.push({ id: "change", mark: "unchecked", title: "gs.try.change.title", body: t("gs.try.change.body") });
  checks.push({
    id: "cancel",
    mark: tryIt.cancelled > 0 ? "done" : "todo",
    title: "gs.try.cancel.title",
    body: t("gs.try.cancel.body", {
      hours: terms.cutoffHours,
      keep: terms.lateKeepPercent === null ? t("gs.try.cancel.keepNone") : t("gs.try.cancel.keepSome", { percent: terms.lateKeepPercent }),
    }),
  });
  if (counter)
    checks.push({
      id: "counter",
      mark: tryIt.counterPaid > 0 ? "done" : "todo",
      title: "gs.try.counter.title",
      body: t("gs.try.counter.body"),
    });
  checks.push({
    id: "messages",
    mark: "unchecked",
    title: "gs.try.messages.title",
    body: t(tryIt.emailService ? "gs.try.messages.email" : "gs.try.messages.noEmail"),
  });
  if (usesOnlinePayments(profile) || profile.payments.online.accountExists) {
    const online = profile.payments.online;
    checks.push({
      id: "online",
      mark: online.firstPaymentTaken ? "done" : "unchecked",
      title: "gs.try.online.title",
      body: t(online.firstPaymentTaken ? "gs.try.online.taken" : online.sandbox ? "gs.try.online.sandbox" : "gs.try.online.connected"),
    });
  }

  return (
    <div className="space-y-3" data-tryit>
      {live ? (
        <p role="note" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {t("gs.try.live")}
        </p>
      ) : (
        <p className="text-sm text-slate-600">{t("gs.try.intro")}</p>
      )}
      {tryIt.made > 0 && !live && (
        <p className="text-xs text-slate-600">{t("gs.try.made", { n: tryIt.made, standing: tryIt.standing })}</p>
      )}
      <ul className="space-y-2">
        {checks.map((c) => (
          <li key={c.id} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" data-try={c.id} data-mark={c.mark}>
            <p className="font-medium">
              <span aria-hidden className="mr-1.5">
                {MARK_ICONS[c.mark]}
              </span>
              {t(c.title)} <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">{t(MARK_PHRASES[c.mark])}</span>
            </p>
            <div className="mt-0.5 text-slate-600">{c.body}</div>
            {c.action && <div className="mt-2">{c.action}</div>}
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-500">{t("gs.try.simulated")}</p>
    </div>
  );
}
