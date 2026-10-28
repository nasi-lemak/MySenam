"use client";

import { useEffect, useState } from "react";
import { ACTION_LABELS, type StaffAction } from "@/lib/activity-labels";
import type { StaffPhrase } from "@/lib/staff-i18n";
import { useStaffClock, useStaffT } from "./StaffLanguage";

/** Each kind of entry's words in the staff dictionary; a kind not listed shows as lib/activity-labels.ts says it. */
const ACTION_PHRASES: Record<string, StaffPhrase> = {
  "booking.created": "act.a.bookingCreated",
  "competition.cancelled": "act.a.competitionCancelled",
  "retention.policy": "act.a.retentionPolicy",
  "retention.reviewed": "act.a.retentionReviewed",
  "tournament.knockout_refilled": "act.a.knockoutRefilled",
  "tournament.match_moved": "act.a.matchMoved",
  "tournament.official_added": "act.a.officialAdded",
  "tournament.official_removed": "act.a.officialRemoved",
  "tournament.performances": "act.a.performances",
  "booking.override": "act.a.bookingOverride",
  "booking.policy_overridden": "r9.act.policyOverridden",
  "phone.blocked": "r9.act.phoneBlocked",
  "phone.unblocked": "r9.act.phoneUnblocked",
  "signoff.added": "act.a.signoffAdded",
  "signoff.revoked": "act.a.signoffRevoked",
  "approval.approved": "apr.act.approved",
  "approval.online_accepted": "apr.act.onlineAccepted",
  "approval.in_person": "apr.act.inPerson",
  "approval.asked": "apr.act.asked",
  "approval.rejected": "apr.act.rejected",
  "approval.expired": "apr.act.expired",
  "approval.settings": "apr.act.settings",
  "approval.checked": "apr.act.checked",
  "approval.revoked": "apr.act.revoked",
  "approval.late_payment": "apr.act.latePayment",
  "approval.reviewer_account": "apr.act.reviewerAccount",
  "booking.supervised": "apr.act.supervised",
  "booking.unsupervised": "apr.act.unsupervised",
  "activity.created": "act.a.activityCreated",
  "activity.changed": "act.a.activityChanged",
  "booking.cancelled": "act.a.bookingCancelled",
  "booking.moved": "act.a.bookingMoved",
  "booking.rescheduled": "act.a.bookingRescheduled",
  "booking.no_show": "act.a.bookingNoShow",
  "booking.concession": "act.a.bookingConcession",
  "waiver.signed": "act.a.waiverSigned",
  "enquiry.handled": "act.a.enquiryHandled",
  "customer.note": "act.a.customerNote",
  "block.repeated": "act.a.blockRepeated",
  "account.changed": "act.a.accountChanged",
  "account.charged": "act.a.accountCharged",
  "account.invoiced": "act.a.accountInvoiced",
  "account.paid": "act.a.accountPaid",
  "payment.paid": "act.a.paymentPaid",
  "payment.unpaid": "act.a.paymentUnpaid",
  "payment.refunded": "act.a.paymentRefunded",
  "court.created": "act.a.courtCreated",
  "court.changed": "act.a.courtChanged",
  "credit.changed": "act.a.creditChanged",
  "membership.sold": "act.a.membershipSold",
  "membership.voided": "act.a.membershipVoided",
  "membership.extended": "act.a.membershipExtended",
  "membership.cover_corrected": "mb6.act.coverCorrected",
  "membership.suspended": "ms7.act.suspended",
  "membership.reactivated": "ms7.act.reactivated",
  "checkin.membership_admitted": "mb6.act.memberAdmitted",
  "membership.flag_resolved": "mb6.act.flagResolved",
  "lesson.coach_changed": "mb6.act.coachChanged",
  "lesson.coach_difference_paid": "mb6.act.coachDifferencePaid",
  "membership.plan_added": "act.a.membershipPlanAdded",
  "membership.plan_retired": "act.a.membershipPlanRetired",
  "pass.sold": "act.a.passSold",
  "pass.voided": "act.a.passVoided",
  "sale.made": "act.a.saleMade",
  "sale.voided": "act.a.saleVoided",
  "voucher.sold": "act.a.voucherSold",
  "voucher.voided": "act.a.voucherVoided",
  "privacy.export": "act.a.privacyExport",
  "tournament.closed": "act.a.tournamentClosed",
  "tournament.drawn": "act.a.tournamentDrawn",
  "tournament.cancelled": "act.a.tournamentCancelled",
  "league.started": "act.a.leagueStarted",
  "league.ended": "act.a.leagueEnded",
  "league.planned": "act.a.leaguePlanned",
  "league.closed": "act.a.leagueClosed",
  "tournament.entered": "act.a.tournamentEntered",
  "tournament.entered_at_counter": "act.a.tournamentEnteredCounter",
  "league.joined_at_counter": "act.a.leagueJoinedCounter",
  "strikes.forgiven": "act.a.strikesForgiven",
  "einvoice.settings": "act.a.einvoiceSettings",
  "einvoice.consolidated": "act.a.einvoiceConsolidated",
  "einvoice.retried": "act.a.einvoiceRetried",
  "review.replied": "act.a.reviewReplied",
  "review.reported": "act.a.reviewReported",
  "review.requests": "act.a.reviewRequests",
  "review.hidden": "act.a.reviewHidden",
  "review.shown": "act.a.reviewShown",
  "campaign.sent": "act.a.campaignSent",
  "integration.changed": "act.a.integrationChanged",
  "promo.created": "act.a.promoCreated",
  "promo.voided": "act.a.promoVoided",
  "staff.added": "act.a.staffAdded",
  "staff.removed": "act.a.staffRemoved",
  "staff.role": "act.a.staffRole",
  "settings.changed": "act.a.settingsChanged",
  export: "act.a.export",
  "approval.hold": "apr.ret.act.hold",
  "approval.hold_released": "apr.ret.act.released",
  "approval.authority_reviewed": "apr.child.actReviewed",
  "participant.created": "ptc.act.created",
  "participant.guardian_revoked": "ptc.act.guardianRevoked",
  "participant.guardian_added": "pbk2.act.guardianAdded",
  "participant.linked": "ptc.act.linked",
  "induction.assigned": "ptc.act.inductionAssigned",
  "induction.kept": "ptc.act.inductionKept",
  "booking.for_participant": "pua.act.bookedFor",
  "class.enrol_participant": "pua.act.enrolledFor",
  "participant.guardian_requested": "gv.act.requested",
  "participant.guardian_exception": "gv.act.exception",
  "participant.guardian_request_closed": "gv.act.closed",
  "participant.guardian_suspended": "gv.act.suspended",
  "participant.guardian_confirmed": "gv.act.confirmed",
  "booking.place_withdrawn": "ent.act.placeWithdrawn",
  "waitlist.added": "wl5.act.added",
  "waitlist.removed": "wl5.act.removed",
  "participant.guardian_code_sent": "gw5.act.codeSent",
  "participant.guardian_agreed_by_code": "gw5.act.agreedByCode",
  "participant.guardian_agreed_in_person": "gw5.act.agreedInPerson",
  "participant.guardian_withdrawn": "gw5.act.withdrawn",
  "participant.guardian_number_checked": "gw5.act.numberChecked",
  "participant.guardian_claim_code": "gw5.act.claimCode",
  "participant.guardian_reported": "gw5.act.reported",
  "participant.guardian_told": "gw5.act.told",
  "guest_invitation.withdrawn": "rv7.act.withdrawn",
  "payment.gateway_refund": "rg7.act.gatewayRefund",
  "account.credit_settled": "rg7.act.creditSettled",
  "pass_product.added": "p8b.act.productAdded",
  "pass_product.retired": "p8b.act.productRetired",
  "sale.price_set": "p8b.act.priceSet",
  "booking.price_adjusted": "p8b.act.priceAdjusted",
};

/**
 * Who did what at this venue over the period: what squares the till at the
 * end of a shift, and answers "who cancelled that booking?". One booking's
 * history by its code.
 */
export function ActivityPanel({ venueId, from, to }: { venueId: number; from: string; to: string }) {
  const t = useStaffT();
  const clock = useStaffClock();
  const [actions, setActions] = useState<StaffAction[] | null>(null);
  const [code, setCode] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    // Only the latest venue and period asked for: an earlier answer arriving later is dropped.
    let live = true;
    setActions(null);
    const params = new URLSearchParams({ venueId: String(venueId), from, to, limit: "300" });
    if (query) params.set("code", query);
    void fetch(`/api/admin/activity?${params}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { actions: [] }))
      .then((d: { actions?: StaffAction[] }) => live && setActions(d.actions ?? []));
    return () => {
      live = false;
    };
  }, [venueId, from, to, query]);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">{t("act.title")}</h2>
          <p className="text-sm text-slate-500">
            {t("act.intro")}
          </p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(code.trim());
          }}
          className="flex gap-2"
        >
          <input
            aria-label={t("act.code")}
            placeholder={t("act.code")}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-36 rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
          <button className="rounded-md border border-slate-300 px-3 py-1 text-sm">{query ? t("c.search") : t("act.find")}</button>
          {query && (
            <button
              type="button"
              onClick={() => {
                setCode("");
                setQuery("");
              }}
              className="text-xs text-slate-500 underline"
            >
              {t("c.all")}
            </button>
          )}
        </form>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2">{t("act.colWhen")}</th>
              <th className="px-3 py-2">{t("act.colWho")}</th>
              <th className="px-3 py-2">{t("act.colWhat")}</th>
              <th className="px-3 py-2">{t("act.colBooking")}</th>
              <th className="px-3 py-2">{t("act.colDetail")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {actions === null ? (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-slate-500">
                  {t("c.loading")}
                </td>
              </tr>
            ) : actions.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-slate-500">
                  {query ? t("act.nothingFor", { code: query }) : t("act.nothingInPeriod")}
                </td>
              </tr>
            ) : (
              actions.map((a) => (
                <tr key={a.id}>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                    {clock.when(a.createdAt, venueId)}
                  </td>
                  <td className="px-3 py-2 font-medium">{a.adminName}</td>
                  <td className="px-3 py-2">{Object.hasOwn(ACTION_PHRASES, a.action) ? t(ACTION_PHRASES[a.action]) : (ACTION_LABELS[a.action] ?? a.action)}</td>
                  <td className="px-3 py-2 font-mono text-xs text-teal-700">{a.bookingCode ?? ""}</td>
                  <td className="px-3 py-2 text-slate-600">{a.detail ?? ""}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
