"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import type { EmailCheck, VenueApplication } from "@/lib/applications";
import { REVIEW_CHECKS } from "@/lib/review-checks";
import { googleMapsLink, streetViewLink } from "@/components/PinMap";

const PinMap = dynamic(() => import("@/components/PinMap"), { ssr: false });

const EMAIL_CHECK: Record<EmailCheck, { text: string; ok: boolean }> = {
  confirmed: { text: "Email confirmed", ok: true },
  account: { text: "Asked from their manager account", ok: true },
  unsent: { text: "Email not confirmed: this install cannot send email", ok: false },
  "not asked": { text: "Applied before emails were confirmed", ok: false },
  waiting: { text: "Email not confirmed yet", ok: false },
};

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
      if (!res.ok) throw new Error(data.error ?? "Could not load applications");
      setApplications(data.applications);
      setMarketplace(data.marketplace);
      setDrafts(data.drafts ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load applications");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(a: VenueApplication, decision: "approve" | "reject") {
    let reason = "";
    if (decision === "reject") {
      const given = window.prompt(`Not putting ${a.businessName} live? A reason for them (optional):`, "");
      if (given === null) return;
      reason = given;
    } else if (
      !window.confirm(
        a.forBusiness
          ? `Put ${a.businessName} live as a branch of ${a.forBusiness}?`
          : a.venueId === null
            ? `Approve ${a.businessName}? This creates the venue and ${a.email}'s account.`
            : `Put ${a.businessName} live? Customers can find, book and pay it from now, and its free months start.`
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
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      const told = data.emailed
        ? `${a.email} has been emailed.`
        : `Email is not set up, so let them know yourself: ${a.email}, ${a.venuePhone}.`;
      setNotice(
        decision === "approve"
          ? `${a.businessName} is live. ${told}`
          : `${a.businessName} is not live. ${told}`
      );
      await load();
      if (decision === "approve") onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  if (!applications || (!marketplace && applications.length === 0)) return null;
  const pending = applications.filter((a) => a.status === "pending");
  const decided = applications.filter((a) => a.status !== "pending").slice(0, 10);

  return (
    <section>
      <h2 className="text-lg font-bold">
        Going live{pending.length > 0 && ` (${pending.length} waiting)`}
      </h2>
      <p className="mt-1 text-sm text-slate-500">
        Businesses sign up at <span className="font-mono">/list-your-venue</span> and set their venue up as a draft
        nobody else sees, then ask to go live from their dashboard.{" "}
        {drafts === 1 ? "1 draft is being set up now." : `${drafts} drafts are being set up now.`}
      </p>
      {error && <p className="mt-3 text-sm font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-3 text-sm font-medium text-emerald-700">{notice}</p>}

      {pending.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">Nobody is waiting.</p>
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
                        new branch of {a.forBusiness}
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
                    {a.contactName} · <span className="font-mono text-xs">{a.email}</span> · asked{" "}
                    {a.createdAt.slice(0, 10)}
                  </div>
                  {a.setup && (
                    <div className="mt-1 text-sm text-slate-600">
                      {a.setup.courts === 1 ? "1 court" : `${a.setup.courts} courts`}
                      {a.setup.sports && ` · ${a.setup.sports}`}
                      {a.setup.lowRate !== null &&
                        ` · RM${a.setup.lowRate}${a.setup.highRate !== a.setup.lowRate ? `–${a.setup.highRate}` : ""} an hour`}
                      {a.venueId !== null && (
                        <>
                          {" · "}
                          <a href={`/venue/${a.venueId}`} target="_blank" rel="noopener" className="underline">
                            their page ↗
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
                    title="Tick every check below first"
                    onClick={() => decide(a, "approve")}
                    className="rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => decide(a, "reject")}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    Not yet
                  </button>
                </div>
              </div>
              <Evidence a={a} />
              <fieldset className="mt-3 space-y-1.5 border-t border-slate-100 pt-3">
                <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Before approving
                </legend>
                {REVIEW_CHECKS.map((c) => (
                  <label key={c.id} className="flex items-start gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={ticked[a.id]?.includes(c.id) ?? false}
                      onChange={() => tick(a.id, c.id)}
                    />
                    {c.label}
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
                  ? "live, on its own"
                  : "live"
                : "not live"}{" "}
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
  const email = EMAIL_CHECK[a.emailCheck];
  const warnings = a.location?.warnings ?? [];
  return (
    <div className="mt-3 grid gap-3 border-t border-slate-100 pt-3 md:grid-cols-2">
      <div className="space-y-2 text-sm">
        <p className={email.ok ? "text-emerald-700" : "text-amber-700"}>
          {email.ok ? "✓" : "!"} {email.text}
        </p>
        {a.pinPlace && (
          <p className="text-slate-600">
            <span className="font-medium text-slate-700">What the map says is at the pin:</span> {a.pinPlace}
          </p>
        )}
        {warnings.length === 0 ? (
          <p className="text-emerald-700">✓ The pin, the address and the area agree, and no other venue is listed there.</p>
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
              Open in Google Maps
            </a>
            <a href={streetViewLink(a.pin)} target="_blank" rel="noreferrer" className="text-teal-700 underline">
              Street View
            </a>
          </p>
        )}
      </div>
      {a.pin && (
        <div>
          <PinMap pin={a.pin} found={a.found} height={200} />
          <p className="mt-1 text-xs text-slate-500">
            Teal pin: where they say the venue is.{a.found && " Grey ring: where the address they typed leads."}
          </p>
        </div>
      )}
    </div>
  );
}
