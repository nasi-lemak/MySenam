"use client";

import { useCallback, useEffect, useState } from "react";
import { useStaffT } from "@/components/admin/StaffLanguage";
import type { MembershipFlag } from "@/lib/membership-flags";
import { formatMinute } from "@/lib/interval";

/**
 * Bookings to decide after a membership stopped covering somebody on them
 * (lib/membership-flags.ts): cancelled, voided by a chargeback, or a
 * dependant taken off a family membership. Flagged rather than cancelled:
 * staff cancel one the ordinary way (the venue's terms and refunds apply),
 * admit them at the desk, or keep it, and say which.
 */
export default function MembershipFlags({ venueId }: { venueId: number }) {
  const t = useStaffT();
  const [flags, setFlags] = useState<MembershipFlag[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    fetch(`/api/admin/memberships/flags?venueId=${venueId}`, { cache: "no-store" })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(t.err(data));
        setFlags(data.flags ?? []);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("c.failed")));
  }, [venueId, t]);
  useEffect(() => load(), [load]);

  async function resolve(f: MembershipFlag) {
    const note = window.prompt(t("mv6.flags.resolvePrompt", { code: f.bookingCode }));
    if (note === null || note.trim() === "") return;
    try {
      const res = await fetch("/api/admin/memberships/flags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, flagId: f.id, note }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      setFlags(data.flags ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }

  if (flags.length === 0 && !error) return null;
  const why = (f: MembershipFlag) =>
    t(f.reason === "revoked" ? "mv6.flags.revoked" : f.reason === "uncovered" ? "mv6.flags.uncovered" : f.reason === "suspended" ? "ms7.bk.flagSuspended" : "mv6.flags.cancelled");
  return (
    <section className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
      <h3 className="font-semibold text-amber-900">{t("mv6.flags.title")}</h3>
      <p className="text-xs text-amber-900">{t("mv6.flags.intro")}</p>
      {error && <p className="text-red-700">{error}</p>}
      <ul className="divide-y divide-amber-100">
        {flags.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span>
              {t("mv6.flags.line", { code: f.bookingCode, name: f.name, date: f.date, time: `${formatMinute(f.start, t.locale)}–${formatMinute(f.end, t.locale)}`, court: f.courtName })}
              {` · ${why(f)}`}
              {f.kind === "reservation" ? ` · ${t("mv6.flags.reservation")}` : ""}
            </span>
            <button type="button" onClick={() => void resolve(f)} className="rounded-md border border-amber-300 px-2 py-0.5 text-xs font-semibold text-amber-900">
              {t("mv6.flags.resolve")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
