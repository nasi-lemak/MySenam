"use client";

import { useCallback, useEffect, useState } from "react";
import type { VenueApplication } from "@/lib/applications";

/**
 * Venues asking to join, for the platform owner to let in or turn away.
 *
 * Approving makes the venue and its operator's account in one go, with the
 * password they chose when applying. If the install cannot email, the owner is
 * told so, with the address to pass the news on to.
 */
export function ApplicationsPanel({ onChange }: { onChange: () => void }) {
  const [applications, setApplications] = useState<VenueApplication[] | null>(null);
  const [marketplace, setMarketplace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/venue-applications", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load applications");
      setApplications(data.applications);
      setMarketplace(data.marketplace);
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
      const given = window.prompt(`Turn down ${a.businessName}? A reason for them (optional):`, "");
      if (given === null) return;
      reason = given;
    } else if (!window.confirm(`Approve ${a.businessName}? This creates the venue and ${a.email}'s account.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/venue-applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: a.id, decision, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      const told = data.emailed
        ? `${a.email} has been emailed.`
        : `Email is not set up, so let them know yourself: ${a.email}, ${a.venuePhone}.`;
      setNotice(
        decision === "approve"
          ? `${a.businessName} is in. ${told}`
          : `${a.businessName} turned down. ${told}`
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
        Venue applications{pending.length > 0 && ` (${pending.length} waiting)`}
      </h2>
      <p className="mt-1 text-sm text-slate-500">
        Venues that asked to join at <span className="font-mono">/list-your-venue</span>.
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
                  <div className="font-semibold">{a.businessName}</div>
                  <div className="text-sm text-slate-600">
                    {a.area} · {a.address} · {a.venuePhone}
                  </div>
                  <div className="mt-1 text-sm text-slate-600">
                    {a.contactName} · <span className="font-mono text-xs">{a.email}</span> · applied{" "}
                    {a.createdAt.slice(0, 10)}
                  </div>
                  {a.message && (
                    <p className="mt-2 whitespace-pre-line rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
                      {a.message}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    disabled={busy}
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
                    Turn down
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {decided.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-slate-500">
          {decided.map((a) => (
            <li key={a.id}>
              {a.businessName} — {a.status === "approved" ? "approved" : "turned down"}{" "}
              {a.decidedAt?.slice(0, 10)}
              {a.reason ? ` (${a.reason})` : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
