"use client";

import { readJson } from "@/lib/read-response";
import { useEffect, useState } from "react";
import type { StaffText } from "@/lib/staff-text";
import { useStaffT } from "./StaffLanguage";
import { useStaffMay } from "./StaffMay";

interface GoLiveStatus {
  state: "draft" | "live" | "unlisted";
  suspension: { by: "payment" | "owner"; reason: string | null } | null;
  request: { status: "draft" | "pending" | "approved" | "rejected"; reason: string | null } | null;
  missing: string[];
  missingPhrases?: StaffText[];
}

/**
 * Whether customers can see this venue, and what to do if not.
 *
 * A draft says so, says what it still needs, and sends itself to the
 * platform owner when it is ready. It stays until the venue is live — unlike
 * the setup checklist, it cannot be hidden, because a business that never
 * finds this button never goes live.
 */
export function GoLiveBanner({
  venueId,
  venueName,
  refreshKey,
  onChange,
}: {
  venueId: number;
  /** Shown when there is more than one branch. */
  venueName?: string | null;
  refreshKey: string;
  onChange: () => void;
}) {
  const t = useStaffT();
  // Asking to go live is a manager's (lib/roles.ts): front desk sees where the branch stands, without the button.
  const may = useStaffMay();
  const [status, setStatus] = useState<GoLiveStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped when something is saved under Venue details ("setup:refresh"): a pin put down is no longer missing.
  const [saved, setSaved] = useState(0);

  useEffect(() => {
    const bump = () => setSaved((n) => n + 1);
    window.addEventListener("setup:refresh", bump);
    return () => window.removeEventListener("setup:refresh", bump);
  }, []);

  useEffect(() => {
    fetch(`/api/admin/go-live?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => (r.ok ? readJson(r) : null))
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [venueId, refreshKey, saved]);

  async function ask() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/go-live", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("live.couldNotSend")));
      setStatus(data.status);
      if (data.live) onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("live.couldNotSend"));
    } finally {
      setBusy(false);
    }
  }

  if (!status || status.state === "live") return null;
  const name = venueName ?? t("live.yourVenue");

  if (status.state === "unlisted" && status.suspension?.by === "owner")
    return (
      <section className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
        <p className="font-semibold">{t("live.suspended", { name })}</p>
        <p className="mt-1">
          {status.suspension.reason ? `${status.suspension.reason}. ` : ""}
          {t("live.suspendedBody")}
        </p>
      </section>
    );

  if (status.state === "unlisted")
    return (
      <section className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
        <p className="font-semibold">{t("live.unlisted", { name })}</p>
        <p className="mt-1">
          {t("live.unlistedBody")}
        </p>
      </section>
    );

  const waiting = status.request?.status === "pending";
  const turnedDown = status.request?.status === "rejected";
  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold">
            {waiting ? t("live.waiting", { name }) : t("live.draft", { name })}
          </p>
          {waiting ? (
            <p className="mt-1">{t("live.waitingBody")}</p>
          ) : turnedDown ? (
            <p className="mt-1">
              {status.request?.reason ? t("live.rejectedReason", { reason: status.request.reason }) : t("live.rejected")}
            </p>
          ) : (
            <p className="mt-1">
              {t("live.draftBody")}
            </p>
          )}
          {!waiting && status.missing.length > 0 && (
            <ul className="mt-2 list-inside list-disc">
              {status.missing.map((m, i) => (
                <li key={m}>{t.say(status.missingPhrases?.[i], m)}</li>
              ))}
            </ul>
          )}
          {error && <p className="mt-2 font-medium text-red-700">{error}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <a href={`/venue/${venueId}`} target="_blank" rel="noopener" className="underline">
            {t("live.seePage")}
          </a>
          {!waiting && may("goLive") && (
            <button
              onClick={ask}
              disabled={busy || status.missing.length > 0}
              className="rounded-lg bg-teal-600 px-3 py-1.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
            >
              {turnedDown ? t("live.askAgain") : t("live.ask")}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
