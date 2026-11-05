"use client";

import { readJson } from "@/lib/read-response";
import { useEffect, useState } from "react";
import { ACTION_LABELS, type StaffAction } from "@/lib/activity-labels";
import type { StaffPhrase } from "@/lib/staff-i18n";
import { useStaffClock, useStaffT } from "./StaffLanguage";

/** Each kind of entry's words in the staff dictionary; a kind not listed shows as lib/activity-labels.ts says it. */
const ACTION_PHRASES: Record<string, StaffPhrase> = {
  "booking.created": "act.a.bookingCreated",
  "integration.ai_personal_data": "int.act.aiPersonalData",
  "mcp.tool": "int.act.mcpTool",
  "mcp.staff_tool": "oa.act.staffTool",
  "oauth.granted": "oa.act.granted",
  "oauth.revoked": "oa.act.revoked",
  "competition.cancelled": "act.a.competitionCancelled",
  "retention.policy": "act.a.retentionPolicy",
  "retention.reviewed": "act.a.retentionReviewed",
  "einvoice.retention": "ei8.act.retention",
  "einvoice.retention_reviewed": "ei8.act.reviewed",
  "guide.answers": "gd.act.answers",
  "guide.acknowledged": "gd.act.acknowledged",
  "guide.dismissed": "gd.act.dismissed",
  "tournament.knockout_refilled": "act.a.knockoutRefilled",
  "tournament.match_moved": "act.a.matchMoved",
  "tournament.official_added": "act.a.officialAdded",
  "tournament.official_removed": "act.a.officialRemoved",
  "tournament.performances": "act.a.performances",
  "tournament.match_called": "dy1.act.called",
  "tournament.match_started": "dy1.act.started",
  "tournament.call_released": "dy1.act.released",
  "tournament.no_show_decided": "dy1.act.noShow",
  "tournament.day_settings": "dy1.act.settings",
  "booking.override": "act.a.bookingOverride",
  "booking.policy_overridden": "r9.act.policyOverridden",
  "booking.window_overridden": "safe1.act.windowOverridden",
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
  "roster.role": "rs1.act.role",
  "roster.qualification": "rs1.act.qualification",
  "roster.shift_added": "rs1.act.shiftAdded",
  "roster.shift_removed": "rs1.act.shiftRemoved",
  "roster.exception_added": "rs1.act.exceptionAdded",
  "roster.exception_removed": "rs1.act.exceptionRemoved",
  "roster.rule_set": "rs1.act.ruleSet",
  "roster.rule_removed": "rs1.act.ruleRemoved",
  "roster.cover": "rs1.act.cover",
  "roster.override": "rs1.act.override",
  "roster.decision_undone": "rs1.act.undone",
  "roster.calendar_link": "rs1.act.calendarLink",
  "activity.created": "act.a.activityCreated",
  "activity.changed": "act.a.activityChanged",
  "booking.cancelled": "act.a.bookingCancelled",
  "booking.moved": "act.a.bookingMoved",
  "booking.rescheduled": "act.a.bookingRescheduled",
  "booking.no_show": "act.a.bookingNoShow",
  "booking.games_added": "bowl.act.gamesAdded",
  "entry.admitted": "nbk.act.admitted",
  "entry.checked_out": "nbk.act.checkedOut",
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
  "attendance.marked": "clsb.s.act.marked",
  "attendance.corrected": "clsb.s.act.corrected",
  "attendance.locked": "clsb.s.act.locked",
  "attendance.unlocked": "clsb.s.act.unlocked",
  "attendance.exported": "clsb.s.act.exported",
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
  "einvoice.recorded": "ei10.act.recorded",
  "einvoice.not_at_lhdn": "ei10.act.notAtLhdn",
  "accounting.connect_started": "xr.act.connectStarted",
  "accounting.connected": "xr.act.connected",
  "accounting.disconnected": "xr.act.disconnected",
  "accounting.mapping": "xr.act.mapping",
  "accounting.start": "xr.act.start",
  "accounting.retried": "xr.act.retried",
  "accounting.send_now": "xr.act.sendNow",
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
  "participant.public_name_authorised": "pn1.act.authorised",
  "participant.public_name_withdrawn": "pn1.act.withdrawn",
  "guest_invitation.withdrawn": "rv7.act.withdrawn",
  "payment.gateway_refund": "rg7.act.gatewayRefund",
  "account.credit_settled": "rg7.act.creditSettled",
  "guest.registered": "gc8.act.registered",
  "booking.details_corrected": "p8a.act.detailsCorrected",
  "booking.series_cancelled": "p8a.act.seriesCancelled",
  "payment.paid_out": "p8a.act.paidOut",
  // p8c
  "day.closed": "p8c.act.dayClosed",
  "day.reopened": "p8c.act.dayReopened",
  "class.scheduled": "p8c.act.classScheduled",
  "class.changed": "p8c.act.classChanged",
  "class.cancelled": "p8c.act.classCancelled",
  "class.moved": "clsa.act.classMoved",
  "class.move_requested": "cls3.act.requested",
  "class.move_approved": "cls3.act.approved",
  "class.move_declined": "cls3.act.declined",
  "class.move_request_closed": "cls3.act.closed",
  "block.added": "p8c.act.blockAdded",
  "block.removed": "p8c.act.blockRemoved",
  "hire.taken": "p8c.act.hireTaken",
  "hire.returned": "p8c.act.hireReturned",
  "addon.created": "p8c.act.addonCreated",
  "addon.changed": "p8c.act.addonChanged",
  "addon.retired": "p8c.act.addonRetired",
  "notice.posted": "p8c.act.noticePosted",
  "notice.removed": "p8c.act.noticeRemoved",
  "induction.recorded": "p8c.act.inductionRecorded",
  "induction.revoked": "p8c.act.inductionRevoked",
  "venue.go_live": "p8c.act.venueGoLive",
  "venue.suspended": "p8c.act.venueSuspended",
  "venue.suspension_lifted": "p8c.act.venueSuspensionLifted",
  "tournament.created": "p8c.act.tournamentCreated",
  "tournament.changed": "p8c.act.tournamentChanged",
  "tournament.rules": "p8c.act.tournamentRules",
  "tournament.final_chosen": "p8c.act.tournamentFinalChosen",
  "tournament.result": "p8c.act.tournamentResult",
  "tournament.result_changed": "p8c.act.tournamentResultChanged",
  "tournament.corrected": "p8c.act.tournamentCorrected",
  "tournament.corrected_standings_only": "p8c.act.tournamentCorrectedStandings",
  "tournament.replay": "p8c.act.tournamentReplay",
  "tournament.results_stand": "p8c.act.tournamentResultsStand",
  "tournament.swiss_paired": "sw.act.paired",
  "tournament.swiss_round_closed": "sw.act.roundClosed",
  "tournament.swiss_ended": "sw.act.ended",
  "tournament.swiss_tiebreaks": "sw3.act.tiebreaks",
  "tournament.swiss_regrouped": "sw3.act.regrouped",
  "tournament.swiss_grouping_kept": "sw3.act.kept",
  "ladder.created": "lds.act.created",
  "ladder.settings": "lds.act.settings",
  "ladder.rated": "lds.act.rated",
  "ladder.season_ended": "lds.act.seasonEnded",
  "ladder.closed": "lds.act.closed",
  "ladder.result_decided": "lds.act.resultDecided",
  "ladder.moved": "lds.act.moved",
  "ladder.removed": "lds.act.removed",
  "ladder.frozen": "lds.act.frozen",
  "ladder.thawed": "lds.act.thawed",
  "ladder.joined_at_counter": "lds.act.joinedAtCounter",
  "messages.report_reviewed": "pmg.act.reportReviewed",
  "messages.thread_state": "pmg.act.threadState",
  "messages.suspended": "pmg.act.suspended",
  "messages.suspension_lifted": "pmg.act.suspensionLifted",
  "messages.suspension_confirmed": "pmg.act.suspensionConfirmed",
  "messages.youth_viewed": "ysg.act.viewed",
  "messages.youth_group_answered": "ysg.act.answered",
  "messages.youth_group_ended": "ysg.act.ended",
  "messages.youth_adult_removed": "ysg.act.adultRemoved",
  "messages.youth_authority": "msg3.act.authority",
  "messages.youth_safeguarding_viewed": "msg3.act.safeguardingViewed",
  "messages.youth_objection_resolved": "msg3.act.objectionResolved",
  "ladder.court_time": "lds.act.courtTime",
  "ladder.hold_released": "lds.act.holdReleased",
  "ladder.hold_moved": "lds.act.holdMoved",
  "ladder.hold_limits": "lds.act.holdLimits",
  "ladder.hold_confirmed": "lds.act.holdConfirmed",
  "ladder.hold_extended": "lds.act.holdExtended",
  "ladder.hold_cooldown": "lad5.act.holdPause",
  "ladder.hold_pause": "lad5.act.holdPause",
  "ladder.hold_pause_lifted": "lad5.act.holdPauseLifted",
  "ladder.forfeit_requested": "lds.act.forfeitRequested",
  "ladder.forfeit_request_withdrawn": "lds.act.forfeitRequestWithdrawn",
  "ladder.forfeit_declined": "lds.act.forfeitDeclined",
  "ladder.forfeit_confirmed": "lds.act.forfeitConfirmed",
  "competition.created": "p8c.act.competitionCreated",
  "league.created": "p8c.act.leagueCreated",
  "team_league.created": "tl.act.created",
  "team_league.fixtures_made": "tl.act.fixturesMade",
  "team_league.closed": "tl.act.closed",
  "team_league.fixture_moved": "tl.act.moved",
  "team_league.fixture_decided": "tl.act.decided",
  "team_league.fixture_forfeit": "tl.act.forfeit",
  "team_league.fixture_void": "tl.act.void",
  "team_league.fixture_cleared": "tl.act.cleared",
  "team_league.team_removed": "tl.act.teamRemoved",
  "team_league.forfeit_requested": "ofs1.act.forfeitRequested",
  "team_league.forfeit_request_withdrawn": "ofs1.act.forfeitWithdrawn",
  "team_league.forfeit_confirmed": "ofs1.act.forfeitConfirmed",
  "team_league.forfeit_declined": "ofs1.act.forfeitDeclined",
  "tournament.correction_requested": "ofs1.act.correctionRequested",
  "tournament.correction_applied": "ofs1.act.correctionApplied",
  "tournament.correction_declined": "ofs1.act.correctionDeclined",
  "ratings.event_rated": "rts.act.rated",
  "ratings.event_unrated": "rts.act.unrated",
  "ratings.business_board": "rts.act.business",
  "ratings.result_excluded": "rts.act.excluded",
  "ratings.exclusion_lifted": "rts.act.lifted",
  "ratings.rating_reset": "rts.act.reset",
  "ratings.seeded": "rts.act.seeded",
  "ratings.public_rankings": "rts.act.public",
  "ratings.show_provisional": "rts.act.provisional",
  "ratings.rank_after": "rts.act.rankAfter",
  "ratings.ledger_exported": "rts.act.exported",
  "league.joined": "p8c.act.leagueJoined",
  "league.fee_paid": "p8c.act.leagueFeePaid",
  "league.fee_unpaid": "p8c.act.leagueFeeUnpaid",
  "league.player_removed": "p8c.act.leaguePlayerRemoved",
  "league.start_box": "p8c.act.leagueStartBox",
  "league.result_decided": "p8c.act.leagueResultDecided",
  "league.result_void": "p8c.act.leagueResultVoid",
  "league.result_cleared": "p8c.act.leagueResultCleared",
  "message.resent": "p8c.act.messageResent",
  "whatsapp.pack": "p8c.act.whatsappPack",
  "pass_product.added": "p8b.act.productAdded",
  "pass_product.retired": "p8b.act.productRetired",
  "sale.price_set": "p8b.act.priceSet",
  "booking.price_adjusted": "p8b.act.priceAdjusted",
  "staff.invited": "r9a.act.invited",
  "staff.invitation_resent": "r9a.act.resent",
  "staff.invitation_withdrawn": "r9a.act.withdrawn",
  "staff.joined": "r9a.act.joined",
  "staff.corrected": "r9a.act.corrected",
  "staff.address_invited": "r9a.act.addressInvited",
  "staff.address_changed": "r9a.act.addressChanged",
  "hours.scheduled": "r9b.act.hoursScheduled",
  "hours.withdrawn": "r9b.act.hoursWithdrawn",
  "rates.scheduled": "r9b.act.ratesScheduled",
  "rates.withdrawn": "r9b.act.ratesWithdrawn",
  "venue.branch_added": "r9c.act.branchAdded",
  "booking.test_cleared": "r9c.act.testCleared",
  "booking.test_kept": "r9c.act.testKept",
  "booking.series_moved": "r9e.act.seriesMoved",
  "payment.owed_credited": "r9e.act.owedCredited",
  "pass.bought_online": "pso.act.boughtOnline",
  "pass_product.online": "pso.act.online",
  "pass_product.offline": "pso.act.offline",
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
      .then((r) => (r.ok ? readJson(r) : { actions: [] }))
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
