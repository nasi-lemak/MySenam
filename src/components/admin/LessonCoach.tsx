"use client";

import { useEffect, useState } from "react";
import type { Coach } from "@/lib/coaching";
import type { CoachChangeTerms, CoachMoney } from "@/lib/lesson-coaches";
import { money as formatMoney } from "@/lib/region";
import { useStaffT } from "./StaffLanguage";

/**
 * Which coach a lesson being moved goes with (`POST
 * /api/admin/bookings/reschedule`, `coachId`): its own, or, a manager
 * choosing, another active coach of the venue for its sport. The times
 * offered follow the coach chosen. Before any time is offered, what the
 * change does to the money is shown (`GET /api/admin/bookings/lesson-coach`):
 * not yet paid, the price follows the new fee; paid, the manager chooses to
 * keep the price as paid (the venue absorbs the difference) or to adjust it
 * (the difference owed, or given back with a credit note) (lib/lesson-coaches.ts).
 */
export function LessonCoach({
  venueId,
  sport,
  coachId,
  coachName,
  value,
  onChange,
  code,
  paid = false,
  money = null,
  onMoney,
}: {
  venueId: number;
  sport: string;
  /** The coach on the lesson now. */
  coachId: number;
  coachName: string;
  value: number;
  onChange: (coachId: number) => void;
  /** The lesson's code, to ask what another coach would do to its money. */
  code?: string;
  paid?: boolean;
  /** A paid lesson: keep the price as paid, or adjust it; null until chosen. */
  money?: CoachMoney | null;
  onMoney?: (money: CoachMoney) => void;
}) {
  const t = useStaffT();
  const [coaches, setCoaches] = useState<Coach[]>([]);
  const [terms, setTerms] = useState<{ keep: CoachChangeTerms; adjust: CoachChangeTerms } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/admin/coaches?venueId=${venueId}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { coaches?: Coach[] } | null) => live && setCoaches(data?.coaches ?? []))
      .catch(() => live && setCoaches([]));
    return () => {
      live = false;
    };
  }, [venueId]);

  // What the coach chosen would do to the money, each way.
  useEffect(() => {
    setTerms(null);
    setRefused(null);
    if (!code || value === coachId) return;
    let live = true;
    fetch(`/api/admin/bookings/lesson-coach?code=${encodeURIComponent(code)}&coachId=${value}`, { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json();
        if (!live) return;
        if (res.ok) setTerms(data);
        else setRefused(t.err(data, t("co6.bk.termsFailed")));
      })
      .catch(() => live && setRefused(t("co6.bk.termsFailed")));
    return () => {
      live = false;
    };
  }, [code, value, coachId, t]);

  const others = coaches.filter((c) => c.active && c.id !== coachId && c.sports.includes(sport));
  const k = terms?.keep;
  const a = terms?.adjust;
  const amount = (n: number) => formatMoney(Math.abs(n));
  const adjustLine = !a
    ? ""
    : a.owed > 0
      ? `${t("co6.bk.adjustOwed", { amount: amount(a.owed) })} ${t("cp7.bk.adjustOnlineToo")}`
      : a.refund > 0
        ? t(a.refundHow === "credit" ? "co6.bk.adjustCredit" : a.refundHow === "online" ? "co6.bk.adjustOnline" : "co6.bk.adjustHand", { amount: amount(a.refund) })
        : t("co6.bk.noDifference");
  const keepLine = !k
    ? ""
    : k.absorbed > 0
      ? t("co6.bk.keepAbsorb", { amount: amount(k.absorbed) })
      : k.absorbed < 0
        ? t("co6.bk.keepOver", { amount: amount(k.absorbed) })
        : t("co6.bk.noDifference");
  return (
    <div className="rounded-xl border border-teal-200 bg-teal-50/60 px-4 py-3 text-sm">
      <label className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-700">{t("fin6.bk.coach")}</span>
        <select
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
        >
          <option value={coachId}>{t("fin6.bk.coachAsBooked", { name: coachName })}</option>
          {others.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-1 text-xs text-slate-600">{t("fin6.bk.coachHelp")}</p>
      {refused && (
        <p className="mt-2 text-xs font-medium text-red-700" data-testid="coach-refused">
          {refused}
        </p>
      )}
      {k && (
        <div className="mt-2 space-y-1 text-xs text-slate-700" data-testid="coach-terms">
          <p>{t("co6.bk.fees", { from: k.fromCoach.name, fromFee: amount(k.fromFee), to: k.toCoach.name, toFee: amount(k.toFee) })}</p>
          {paid && k.earlierOwed > 0 && <p data-testid="coach-earlier-owed">{t("cp7.bk.earlierOwed", { amount: amount(k.earlierOwed) })}</p>}
          {!paid ? (
            <p>{k.difference === 0 ? t("co6.bk.noDifference") : t(k.difference > 0 ? "co6.bk.unpaidUp" : "co6.bk.unpaidDown", { amount: amount(k.difference) })}</p>
          ) : (
            <fieldset className="space-y-1">
              <legend className="font-medium">{t("co6.bk.paidAsk")}</legend>
              <label className="flex items-start gap-2">
                <input type="radio" name="coach-money" checked={money === "keep"} onChange={() => onMoney?.("keep")} />
                <span>
                  <span className="font-medium">{t("co6.bk.keep")}</span> {keepLine}
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="coach-money" checked={money === "adjust"} onChange={() => onMoney?.("adjust")} />
                <span>
                  <span className="font-medium">{t("co6.bk.adjust")}</span> {adjustLine}
                </span>
              </label>
            </fieldset>
          )}
          <p className="text-slate-500">{t("co6.bk.told")}</p>
        </div>
      )}
    </div>
  );
}
