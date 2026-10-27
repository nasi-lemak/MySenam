"use client";

import { useStaffT } from "./StaffLanguage";

/**
 * What phone checks give a venue that relies on numbers, shown where it does:
 * a members-only or private venue's list and its residents' guests
 * (`where="access"`), and guardians recorded by name and number
 * (`where="guardians"`). Recommended, never required: without them every
 * one of these still works through staff (accounts linked by hand, codes to
 * a recorded number, an agreement given in person), and nothing here
 * switches anything on (lib/phone-check.ts `phoneChecksOn`;
 * docs/features/venue-operations.md#phone-checks-recommended-not-required).
 *
 * `on`: whether this install checks numbers. On, a short line saying so
 * where the list is edited (`access`), and nothing for guardians; off, what
 * they would enable, what happens without them, and the recommendation.
 */
export function PhoneCheckAdvice({ on, where }: { on: boolean; where: "access" | "guardians" }) {
  const t = useStaffT();
  if (on) return where === "access" ? <p className="text-xs text-slate-500" data-testid="phone-check-advice">{t("lo6.pc.on")}</p> : null;
  return (
    <div role="note" data-testid="phone-check-advice" className="space-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <p className="font-semibold">{t("lo6.pc.title")}</p>
      <p>{t("lo6.pc.enables")}</p>
      <p>{t(where === "access" ? "lo6.pc.withoutAccess" : "lo6.pc.withoutGuardians")}</p>
      <p>{t("lo6.pc.recommend")}</p>
    </div>
  );
}
