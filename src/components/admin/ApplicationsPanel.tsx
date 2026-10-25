"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import type { EmailCheck, VenueApplication } from "@/lib/applications";
import { REVIEW_CHECKS, type ReviewCheck } from "@/lib/review-checks";
import { googleMapsLink, streetViewLink } from "@/components/PinMap";
import { money } from "@/lib/region";
import type { StaffT } from "@/lib/staff-i18n";
import { useStaffT } from "./StaffLanguage";

const PinMap = dynamic(() => import("@/components/PinMap"), { ssr: false });

const emailChecks = (t: StaffT): Record<EmailCheck, { text: string; ok: boolean }> => ({
  confirmed: { text: t("app.email.confirmed"), ok: true },
  account: { text: t("app.email.account"), ok: true },
  unsent: { text: t("app.email.unsent"), ok: false },
  "not asked": { text: t("app.email.notAsked"), ok: false },
  waiting: { text: t("app.email.waiting"), ok: false },
});

const checkLabels = (t: StaffT): Record<ReviewCheck, string> => ({
  location: t("app.check.location"),
  phone: t("app.check.phone"),
  business: t("app.check.business"),
  photos: t("app.check.photos"),
});

/**
 * Venues asking to join, for the platform owner to let in or turn away.
 *
 * Each shows the evidence that it is real: its pin beside where its address
 * leads, anything about that which doesn't add up, and whether its email was
 * confirmed. Approving asks for the checks only a person can do — a look at
 * the map, a phone call, a search for the business — and makes the venue and
 * its operator's account in one go, with the password they chose when
 * applying. If the install cannot email, the owner is told so, with the
 * address to pass the news on to.
 */
export function ApplicationsPanel({ onChange }: { onChange: () => void }) {
  const t = useStaffT();
  const [applications, setApplications] = useState<VenueApplication[] | null>(null);
  const [marketplace, setMarketplace] = useState(false);
  const [drafts, setDrafts] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ticked, setTicked] = useState<Record<number, string[]>>({});
  const tick = (id: number, check: string) =>
    setTicked((all) => {
      const now = all[id] ?? [];
      return { ...all, [id]: now.includes(check) ? now.filter((c) => c !== check) : [...now, check] };
    });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/venue-applications", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("app.loadFailed")));
      setApplications(data.applications);
      setMarketplace(data.marketplace);
      setDrafts(data.drafts ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.loadFailed"));
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(a: VenueApplication, decision: "approve" | "reject") {
    let reason = "";
    if (decision === "reject") {
      const given = window.prompt(t("app.rejectPrompt", { name: a.businessName }), "");
      if (given === null) return;
      reason = given;
    } else if (
      !window.confirm(
        a.forBusiness
          ? t("app.confirmBranch", { name: a.businessName, business: a.forBusiness })
          : a.venueId === null
            ? t("app.confirmApprove", { name: a.businessName, email: a.email })
            : t("app.confirmLive", { name: a.businessName })
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/venue-applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: a.id, decision, reason, checks: ticked[a.id] ?? [] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("app.requestFailed")));
      const told = data.emailed
        ? t("app.emailed", { email: a.email })
        : t("app.tellThem", { email: a.email, phone: a.venuePhone });
      setNotice(
        decision === "approve"
          ? t("app.isLive", { name: a.businessName, told })
          : t("app.isNotLive", { name: a.businessName, told })
      );
      await load();
      if (decision === "approve") onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.requestFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (!applications || (!marketplace && applications.length === 0)) return null;
  const pending = applications.filter((a) => a.status === "pending");
  const decided = applications.filter((a) => a.status !== "pending").slice(0, 10);
  const labels = checkLabels(t);
  const [introBefore, introAfter] = t("app.intro", { path: "{path}" }).split("{path}");

  return (
    <section>
      <h2 className="text-lg font-bold">
        {pending.length > 0 ? t("app.titleWaiting", { n: pending.length }) : t("app.title")}
      </h2>
      <p className="mt-1 text-sm text-slate-500">
        {introBefore}
        <span className="font-mono">/list-your-venue</span>
        {introAfter}{" "}
        {t.plural("app.drafts", drafts)}
      </p>
      {error && <p className="mt-3 text-sm font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-3 text-sm font-medium text-emerald-700">{notice}</p>}

      {pending.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">{t("app.nobody")}</p>
      ) : (
        <div className="mt-3 space-y-3">
          {pending.map((a) => (
            <div key={a.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="font-semibold">
                    {a.businessName}
                    {a.forBusiness && (
                      <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">
                        {t("app.newBranch", { business: a.forBusiness })}
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-slate-600">
                    {a.area} · {a.address} ·{" "}
                    <a href={`tel:${a.venuePhone.replace(/[^+\d]/g, "")}`} className="underline">
                      {a.venuePhone}
                    </a>
                  </div>
                  <div className="mt-1 text-sm text-slate-600">
                    {a.contactName} · <span className="font-mono text-xs">{a.email}</span> ·{" "}
                    {t("app.asked", { date: a.createdAt.slice(0, 10) })}
                  </div>
                  {a.setup && (
                    <div className="mt-1 text-sm text-slate-600">
                      {t.plural("app.courts", a.setup.courts)}
                      {a.setup.sports && ` · ${a.setup.sports}`}
                      {a.setup.lowRate !== null &&
                        ` · ${t("app.perHour", {
                          rate: `${money(a.setup.lowRate)}${a.setup.highRate !== a.setup.lowRate ? `–${a.setup.highRate}` : ""}`,
                        })}`}
                      {a.venueId !== null && (
                        <>
                          {" · "}
                          <a href={`/venue/${a.venueId}`} target="_blank" rel="noopener" className="underline">
                            {t("app.theirPage")}
                          </a>
                        </>
                      )}
                    </div>
                  )}
                  {a.message && (
                    <p className="mt-2 whitespace-pre-line rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
                      {a.message}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    disabled={busy || !REVIEW_CHECKS.every((c) => ticked[a.id]?.includes(c.id))}
                    title={t("app.tickFirst")}
                    onClick={() => decide(a, "approve")}
                    className="rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                  >
                    {t("app.approve")}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => decide(a, "reject")}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {t("app.notYet")}
                  </button>
                </div>
              </div>
              <Evidence a={a} />
              <fieldset className="mt-3 space-y-1.5 border-t border-slate-100 pt-3">
                <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {t("app.beforeApproving")}
                </legend>
                {REVIEW_CHECKS.map((c) => (
                  <label key={c.id} className="flex items-start gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={ticked[a.id]?.includes(c.id) ?? false}
                      onChange={() => tick(a.id, c.id)}
                    />
                    {labels[c.id]}
                  </label>
                ))}
              </fieldset>
            </div>
          ))}
        </div>
      )}

      {decided.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-slate-500">
          {decided.map((a) => (
            <li key={a.id}>
              {a.businessName} —{" "}
              {a.status === "approved"
                ? a.reviewChecks.includes("auto")
                  ? t("app.liveAuto")
                  : t("app.live")
                : t("app.notLive")}{" "}
              {a.decidedAt?.slice(0, 10)}
              {a.reason ? ` (${a.reason})` : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Where it says it is, and what about that doesn't add up. */
function Evidence({ a }: { a: VenueApplication }) {
  const t = useStaffT();
  const email = emailChecks(t)[a.emailCheck];
  const warnings = a.location?.warnings ?? [];
  return (
    <div className="mt-3 grid gap-3 border-t border-slate-100 pt-3 md:grid-cols-2">
      <div className="space-y-2 text-sm">
        <p className={email.ok ? "text-emerald-700" : "text-amber-700"}>
          {email.ok ? "✓" : "!"} {email.text}
        </p>
        {a.pinPlace && (
          <p className="text-slate-600">
            <span className="font-medium text-slate-700">{t("app.pinPlace")}</span> {a.pinPlace}
          </p>
        )}
        {warnings.length === 0 ? (
          <p className="text-emerald-700">✓ {t("app.allAgree")}</p>
        ) : (
          <ul className="space-y-1 text-amber-800">
            {warnings.map((w) => (
              <li key={w}>! {w}</li>
            ))}
          </ul>
        )}
        {a.pin && (
          <p className="flex gap-3 text-xs font-semibold">
            <a href={googleMapsLink(a.pin)} target="_blank" rel="noreferrer" className="text-teal-700 underline">
              {t("app.openMaps")}
            </a>
            <a href={streetViewLink(a.pin)} target="_blank" rel="noreferrer" className="text-teal-700 underline">
              {t("app.streetView")}
            </a>
          </p>
        )}
      </div>
      {a.pin && (
        <div>
          <PinMap pin={a.pin} found={a.found} height={200} />
          <p className="mt-1 text-xs text-slate-500">
            {t("app.tealPin")}
            {a.found && ` ${t("app.greyRing")}`}
          </p>
        </div>
      )}
    </div>
  );
}
