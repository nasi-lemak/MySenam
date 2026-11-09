"use client";

import { readJson } from "@/lib/read-response";
import { useEffect, useState } from "react";
import type { SchedulerHeartbeat, SystemAlert } from "@/lib/alerts";
import type { EmailHealth } from "@/lib/email-health";
import type { StaffT } from "@/lib/staff-i18n";
import { useStaffClock, useStaffT } from "./StaffLanguage";

/** A length of time since, as a staff member reads it: the largest whole unit. */
function ago(t: StaffT, seconds: number): string {
  if (seconds < 60) return t("vis.hb.ago.s", { n: seconds });
  if (seconds < 90 * 60) return t("vis.hb.ago.m", { n: Math.round(seconds / 60) });
  if (seconds < 48 * 3600) return t("vis.hb.ago.h", { n: Math.round(seconds / 3600) });
  return t("vis.hb.ago.d", { n: Math.round(seconds / 86400) });
}

/**
 * The *Email* section (ADR 0079): read-only, what lib/email-health.ts `emailHealth` reads from the outbox and the configuration. The words are
 * Queued, Accepted by provider, Failed, Abandoned and Delivery verified (separately confirmed); a provider's acceptance is never called delivery.
 * Amber with the warnings when there are any, slim otherwise. Nothing secret is in what it is given.
 */
function EmailSection({ email }: { email: EmailHealth }) {
  const t = useStaffT();
  const clock = useStaffClock();
  const c = email.config;
  const warn = email.warnings.length > 0;
  const provider = c.provider === "ses" ? t("eh.provider.ses") : c.provider === "smtp" ? t("eh.provider.smtp") : t("eh.provider.none");
  return (
    <section
      className={`rounded-xl border px-4 py-3 text-sm ${warn ? "border-amber-300 bg-amber-50 text-amber-950" : "border-slate-200 bg-white"}`}
      data-testid="email-health"
      data-warnings={email.warnings.join(" ")}
    >
      <h2 className="font-bold">{t("eh.title")}</h2>
      <p className="mt-1">{t("eh.config", { state: t(`eh.state.${c.state}`), provider, marketplace: c.productionMarketplace ? t("eh.yes") : t("eh.no") })}</p>
      <p>{t(`eh.verified.${c.deliveryCheck}`)}</p>
      {c.blocksAccountEmail && <p className="font-semibold">{t("eh.blocks")}</p>}
      {c.syntheticLog && <p>{t("eh.synthetic")}</p>}
      {c.problems.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {c.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {warn && (
        <ul className="mt-2 space-y-1 font-semibold" data-testid="email-warnings">
          {email.warnings.map((w) => (
            <li key={w}>
              ⚠{" "}
              {w === "failing"
                ? t("eh.warn.failing", { failed: email.lastHour.failed, total: email.lastHour.failed + email.lastHour.sent })
                : w === "backlog"
                  ? t("eh.warn.backlog", { minutes: email.queued.oldestMinutes ?? 0, limit: email.thresholds.backlogMinutes })
                  : t(`eh.warn.${w}`)}
            </li>
          ))}
        </ul>
      )}
      {email.noData ? (
        <p className="mt-2" data-testid="email-no-data">
          {t("eh.noData")}
        </p>
      ) : (
        <div className="mt-2 space-y-0.5" data-testid="email-counts">
          <p>{email.queued.count > 0 ? t("eh.queued", { n: email.queued.count, minutes: email.queued.oldestMinutes ?? 0 }) : t("eh.queuedNone")}</p>
          <p>{t("eh.accepted", { hour: email.lastHour.sent, day: email.lastDay.sent })}</p>
          <p>{email.lastDay.lastSentAt ? t("eh.lastAccepted", { when: clock.when(email.lastDay.lastSentAt) }) : t("eh.lastAcceptedNone")}</p>
          <p>{t("eh.failed", { hour: email.lastHour.failed, day: email.lastDay.failed })}</p>
          <p>
            {t("eh.abandoned", {
              n: email.givenUp24h.total,
              security: email.givenUp24h.security,
              expired: email.givenUp24h.securityExpired,
              allowance: email.givenUp24h.securityAllowance,
            })}
          </p>
          {email.securityRetrying > 0 && <p>{t("eh.securityRetry", { n: email.securityRetrying })}</p>}
          <p className="text-xs">{t("eh.accNote")}</p>
        </div>
      )}
      {email.recentFailures.length > 0 && (
        <div className="mt-2" data-testid="email-failures">
          <h3 className="font-semibold">{t("eh.reasons")}</h3>
          <ul className="text-xs">
            {email.recentFailures.map((f) => (
              <li key={`${f.kind}|${f.status}|${f.reason}`}>
                {t("eh.reason", {
                  kind: f.kind === "auth_email" ? t("eh.kind.security") : f.kind,
                  status: t(`eh.status.${f.status}`),
                  reason: f.reason,
                  n: f.count,
                  when: clock.when(f.lastAt),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {email.openAlerts.length > 0 && (
        <p className="mt-2">{t("eh.alerts", { list: email.openAlerts.map((a) => t.say(a.subjectPhrase, a.subject)).join("; ") })}</p>
      )}
      {(warn || email.recentFailures.length > 0 || email.openAlerts.length > 0) && <p className="mt-1 text-xs">{t("eh.procedure")}</p>}
    </section>
  );
}

/**
 * What has broken lately, for the platform owner, and one read-only line on the scheduler (lib/alerts.ts `schedulerHeartbeat`): healthy, stale,
 * never stamped, just started, or switched off. The line is always there, so a scheduler that has gone quiet is a red line and not an absence.
 * The same news also went by email. Below it, the *Email* section (`EmailSection`). The route is the owner's only: anybody else is answered 403
 * and sees none of this.
 */
export function SystemHealth() {
  const t = useStaffT();
  const clock = useStaffClock();
  const [state, setState] = useState<{
    alerts: SystemAlert[];
    scheduler: { enabled: boolean; alive: boolean; heartbeat?: SchedulerHeartbeat };
    email?: EmailHealth;
  } | null>(null);

  useEffect(() => {
    void fetch("/api/admin/system", { cache: "no-store" })
      .then((r) => (r.ok ? readJson(r) : null))
      .then(setState)
      .catch(() => setState(null));
  }, []);

  if (!state) return null;
  const stalled = state.scheduler.enabled && !state.scheduler.alive;
  const hb = state.scheduler.heartbeat;
  const quiet = !!hb && hb.state !== "healthy" && hb.state !== "off";

  async function clear(key: string) {
    const res = await fetch("/api/admin/system", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (res.ok) {
      const data = await readJson(res);
      setState((s) => (s ? { ...s, alerts: data.alerts } : s));
    }
  }

  const heartbeatLine = hb && (
    <p className={`mt-1 ${hb.state === "healthy" ? "text-emerald-800" : hb.state === "starting" ? "text-amber-800" : "font-semibold"}`} data-testid="scheduler-heartbeat" data-state={hb.state}>
      {t("vis.hb.label")}:{" "}
      {hb.state === "healthy" || hb.state === "stale"
        ? t(hb.state === "healthy" ? "vis.hb.healthy" : "vis.hb.stale", { ago: ago(t, hb.ageSeconds ?? 0), when: clock.when(hb.lastAt ?? "") })
        : t(`vis.hb.${hb.state}`)}
      {hb.lastFailure && (
        <span className="block font-normal">
          {t("vis.hb.failure", { what: t.say(hb.lastFailure.subjectPhrase, hb.lastFailure.subject), when: clock.when(hb.lastFailure.at), n: hb.lastFailure.count })}
        </span>
      )}
      {(quiet || state.alerts.length > 0 || !!hb.lastFailure) && <span className="block text-xs font-normal">{t("vis.hb.where")}</span>}
    </p>
  );

  const emailSection = state.email ? <EmailSection email={state.email} /> : null;

  // Nothing wrong and the scheduler healthy (or off by choice): a slim line, not a warning box.
  if (state.alerts.length === 0 && !stalled && !quiet && !hb?.lastFailure)
    return hb || emailSection ? (
      <>
        {hb && <section className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm">{heartbeatLine}</section>}
        {emailSection}
      </>
    ) : null;

  return (
    <>
    <section className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
      <h2 className="font-bold">⚠ {t("sys.title")}</h2>
      {heartbeatLine}
      {stalled && <p className="mt-1">{t("sys.stalled")}</p>}
      <ul className="mt-2 space-y-2">
        {state.alerts.map((a) => (
          <li key={a.key} className="rounded-lg bg-white/70 px-3 py-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold">
                {t.say(a.subjectPhrase, a.subject)} <span className="font-normal text-red-700">
                  · {t("sys.countLast", { n: a.count, date: clock.day(a.lastAt), time: clock.time(a.lastAt) })}
                </span>
              </span>
              <button onClick={() => clear(a.key)} className="text-xs font-semibold text-red-800 underline">
                {t("sys.dealtWith")}
              </button>
            </div>
            {/* An error's own text stays as it came; what MySenam wrote, in the staff language. */}
            {a.lastDetail && (
              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-xs text-red-800">
                {a.detailPhrases ? a.detailPhrases.map((p) => t.say(p)).join("\n") : a.lastDetail}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </section>
    {emailSection}
    </>
  );
}
