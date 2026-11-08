import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { closeNoticeTask, guardianReviews, openNoticeTasks } from "@/lib/contact-guardians";
import { markTold, noticeById, openNotices, recentlyClosed } from "@/lib/urgent";
import { overdueRefunds } from "@/lib/payments";
import { paymentChecksSummary } from "@/lib/payment-settlement";
import { counterOwedSummary } from "@/lib/counter-owed-visibility";
import { classCoachConflicts } from "@/lib/class-coaches";
import { uncoveredSessions } from "@/lib/rosters";
import { listMoveRequests } from "@/lib/class-move-requests";
import { jsonObject } from "@/lib/api";
import { strandedByLaunch } from "@/lib/launch-worklist";
import { listVenues } from "@/lib/store";
import { windowOverrideAlert } from "@/lib/window-overrides";
import { safeguardingAttention } from "@/lib/youth-restrictions";
import { resolveSafetyFlag, safetyFlags, safetyFlagVenue } from "@/lib/safety-flags";
import { strandedFixtures, undrawnTournaments } from "@/lib/competition-fixtures";
import { moderationAttention } from "@/lib/message-moderation";
import { overdueAccountsAttention } from "@/lib/accounts";
import { enquiriesAttention } from "@/lib/enquiries";
import { peopleAttention } from "@/lib/people-attention";

export const dynamic = "force-dynamic";

/** Bookings and classes to come outside a launch or tide window at these venues, the first few of each venue (lib/launch-worklist.ts). */
async function launchStranded(venueIds: number[] | null) {
  const out: { venueId: number; count: number; items: Awaited<ReturnType<typeof strandedByLaunch>>["stranded"] }[] = [];
  for (const venueId of venueIds ?? (await listVenues()).map((v) => v.id)) {
    const { stranded } = await strandedByLaunch(venueId);
    if (stranded.length > 0) out.push({ venueId, count: stranded.length, items: stranded.slice(0, 8) });
  }
  return out;
}

/** A manager's needs-attention lines for venues whose overrides of advisory windows in 7 days are past the venue's limit (lib/window-overrides.ts). */
async function windowOverrideAlerts(venueIds: number[] | null) {
  const out: NonNullable<Awaited<ReturnType<typeof windowOverrideAlert>>>[] = [];
  for (const venueId of venueIds ?? (await listVenues()).map((v) => v.id)) {
    const alert = await windowOverrideAlert(venueId);
    if (alert) out.push(alert);
  }
  return out;
}

/**
 * Urgent news not yet known to have reached the customer, what closed this week, and refunds past the date customers were told.
 * And guardians (lib/contact-guardians.ts): `guardianTasks`, guardians recorded by name and number to be told of a change in
 * person; `guardianReviews` (managers only), relationships waiting for a manager's review and exception review dates come.
 * And `classCoachConflicts`: upcoming sessions of classes taught by one of the venue's coaches who has since been retired, is on
 * days off then, works other hours or is not held for it.
 * And `launchStranded`: bookings and classes to come that a launch or tide window now leaves outside it, by venue (ADR 0037).
 * And `uncovered`: sessions to come with too few qualified people rostered, for a manager to decide (lib/rosters.ts).
 * And `classMoveRequests`: front desk's class moves waiting for a manager's approval (a manager decides them here); a desk is shown those waiting and the outcome of its
 * own in the last three days (lib/class-move-requests.ts, ADR 0045).
 * And `windowOverrideAlerts` (managers only): venues whose managers overrode advisory windows more often in 7 days than the venue's limit (ADR 0046).
 * And `safetyFlags`: confirmed bookings a venue's own decision left in doubt, for staff to decide, none cancelled: a number the venue
 * refused after it booked, and a sign-off, certification or induction taken back since (lib/safety-flags.ts, ADR 0058).
 * And `safeguarding` (managers and the owner; null for front desk): `overdue` protective restrictions past their review date and `escalatedCases` (the owner's), `appealsWaiting`
 * and `reviewsOpen` that are the caller's to decide, and `retention` (the owner's: closed cases and holds kept longer than the review interval, for a decision) (ADR 0052).
 * And `competitions` (managers and the owner; null for front desk; ADR 0059): `stranded`, tournament matches and team-league fixtures still to play on a court out of service or on a
 * closed day, to be postponed or moved; and `undrawn`, tournaments whose first day has arrived and that nobody drew or called off, with the court time held for each.
 * And `accountsOverdue`: invoices to company and school accounts unpaid past their due day, oldest first, each with what is still to pay, the days
 * overdue and whether the venue's block now stops new bookings on that account (lib/accounts.ts; the desk sees them as it takes their payments).
 * And `enquiries` (everyone who may see enquiries, desk included): private hire enquiries nobody has answered, oldest first (`total`, and the first 20 as `items`
 * with their age and whether they have waited long enough to be nudged), whether or not the venue set an alert email (lib/enquiries.ts).
 * And `messageModeration` (same readers): open reports of messages by number and age, automatic suspensions to review with their date, and requests for a review (ADR 0059).
 * And `people` (ADR 0072): players' answers to hosts' no-show marks waiting for a decision, older marks that count everywhere, and hosts whose marks are
 * often reversed (managers and the owner); passes, memberships and vouchers ending within two weeks; passes nearly used; strikes lately and numbers at the limit;
 * coaches with lessons coming and no email address (lib/people-attention.ts).
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json({
    open: await openNotices(admin.venueIds),
    recent: await recentlyClosed(admin.venueIds),
    refundsOverdue: await overdueRefunds(admin.venueIds),
    // Payments received and not applied, an excess owed back, a payment after a hold was let go: waiting for a look (ADR 0065).
    paymentChecks: await paymentChecksSummary(admin.venueIds),
    // Counter payments still owed back to customers, per venue: how many, in all, the oldest age and how many are past REFUND_OVERDUE_DAYS; no names (lib/counter-owed-visibility.ts, ADR 0076).
    counterOwed: await counterOwedSummary(admin.venueIds, admin.role),
    guardianTasks: await openNoticeTasks(admin.venueIds),
    guardianReviews: admin.role === "desk" ? [] : await guardianReviews(admin.venueIds),
    // Upcoming class sessions whose coach cannot teach them as set (lib/class-coaches.ts): never silently dropped.
    classCoachConflicts: await classCoachConflicts(admin.venueIds),
    launchStranded: await launchStranded(admin.venueIds),
    uncovered: await uncoveredSessions(admin.venueIds),
    classMoveRequests: await listMoveRequests(admin, { decidedDays: admin.role === "desk" ? 3 : 0, mineOnly: admin.role === "desk" }),
    windowOverrideAlerts: admin.role === "desk" ? [] : await windowOverrideAlerts(admin.venueIds),
    // Bookings left for a decision after a refused number or a sign-off, certification or induction taken back (ADR 0058).
    safetyFlags: await safetyFlags(admin.venueIds),
    // Safeguarding (managers and the owner; ADR 0052): protective restrictions past their review date and cases escalated, for the owner; requests for a review and authority reviews waiting; closed cases kept long.
    safeguarding: admin.role === "desk" ? null : await safeguardingAttention(admin),
    // Competitions (ADR 0059): fixtures left on a court or day that is gone, and tournaments past their first day with no draw.
    competitions:
      admin.role === "desk" ? null : { stranded: await strandedFixtures(admin.venueIds ?? null), undrawn: await undrawnTournaments(admin.venueIds ?? null) },
    // Reports of messages between players and suspensions awaiting review (ADR 0059): counts, ages and numbers only.
    messageModeration: admin.role === "desk" ? null : await moderationAttention(admin),
    // Invoices to company and school accounts past their day (lib/accounts.ts).
    accountsOverdue: await overdueAccountsAttention(admin.venueIds ?? null),
    // Private hire enquiries nobody has answered, with a nudge for the ones waiting longest (lib/enquiries.ts).
    enquiries: await enquiriesAttention(admin.venueIds ?? null),
    // People (lib/people-attention.ts): no-show marks answered, what ends soon, strikes, coaches nobody can tell.
    people: await peopleAttention(admin),
  });
}

/**
 * `{ id, action: "told" }` — staff told the customer another way.
 * `{ taskId, action: "guardianTold", how: "told" | "not_needed" }` — staff told a guardian recorded by name and number of a change.
 * `{ flagId, action: "safetyFlag", note }` — a manager leaves a flagged booking as it is, on record with a note (cancelling it with a
 * refund is the ordinary staff cancellation, after which it leaves the list: `POST /api/admin/bookings/cancel`).
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let b: Record<string, unknown>;
  try {
    b = (await jsonObject(req)) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (b.action === "guardianTold") {
    const done = await closeNoticeTask(admin.venueIds, { id: admin.id, name: admin.name }, b.taskId, b.how);
    if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: done.status });
    await logAction(admin, { venueId: done.venueId, action: "participant.guardian_told", detail: `Guardian notice task ${String(b.taskId)}: ${String(b.how)}` });
    return NextResponse.json({ guardianTasks: await openNoticeTasks(admin.venueIds) });
  }
  if (b.action === "safetyFlag") {
    if (admin.role === "desk") return NextResponse.json({ error: "Only a manager decides a booking left like this.", code: "MANAGER_ONLY" }, { status: 403 });
    const venueId = Number.isInteger(b.flagId) ? await safetyFlagVenue(b.flagId as number) : null;
    if (venueId === null) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const denied = denyVenue(admin, venueId);
    if (denied) return denied;
    if (!(await resolveSafetyFlag(admin, b.flagId as number, b.note))) return NextResponse.json({ error: "Say why, in a few words.", code: "FX9_NOTE_NEEDED" }, { status: 400 });
    await logAction(admin, { venueId, action: "safety.flag_resolved", detail: `Flag ${String(b.flagId)}: ${String(b.note).trim().slice(0, 300)}` });
    return NextResponse.json({ safetyFlags: await safetyFlags(admin.venueIds) });
  }
  const notice = Number.isInteger(b.id) ? await noticeById(b.id as number) : null;
  if (!notice) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const denied = denyVenue(admin, notice.venueId);
  if (denied) return denied;
  if (b.action !== "told") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (!(await markTold(notice.id, admin.id))) return NextResponse.json({ error: "That is already closed." }, { status: 409 });
  return NextResponse.json({ open: await openNotices(admin.venueIds), recent: await recentlyClosed(admin.venueIds) });
}
