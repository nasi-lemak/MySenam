import { getDb } from "../db";
import { BUILTIN_ACTIVITIES, RESOURCE_MODELS, SUPPORT_LEVELS, type ResourceModel, type SupportLevel } from "../activity-catalogue";
import { goLiveStatus, type ApplicationStatus } from "../applications";
import { cancelPolicy } from "../cancel-policy";
import { staffLocales } from "../staff-locales";
import { offeredLocales } from "../i18n";
import { isMarketplace } from "../mode";
import { ratesOn } from "../pricing";
import { region } from "../region";
import { venueSetup } from "../setup";
import { getVenue } from "../store";
import { policiesFor } from "../booking-policy";
import { hoursFor } from "../week-hours";
import { paidStandingTests, standingTestBookings } from "../test-bookings";
import { emailConfig, whatsappConfig } from "../transports";
import { COUNTER_METHODS, type CounterMethod } from "../types";
import { todayISO } from "../time";
import { deductionReview } from "../deposit-deductions";
import { venueZoneOf } from "../zones";
import {
  emptyProfile,
  type OnlineRefunds,
  type ProfileActivity,
  type ScheduledHours,
  type ScheduledRates,
  type Visibility,
  type VenueProfile,
} from "./profile-types";

export * from "./profile-types";

/**
 * The venue profile, read from the real saved configuration
 * (docs/features/venue-guide.md#the-venue-profile; ADR 0028).
 *
 * A read model: every fact comes from the table or lookup that already owns it
 * (`ratesOn` and `venueHours` for what is in force on a date, `cancelPolicy`,
 * `goLiveStatus`, `venueSetup`, `standingTestBookings` …), nothing is copied
 * anywhere, and nothing is written. It is strictly scoped to the venue asked
 * for, holds counts and settings only, and is computed on each request, so
 * there is nothing to invalidate and nothing that can be served to another
 * venue.
 *
 * It is not a secret-bearing object: no key, no credential, no tax
 * identifier, no name, phone number or address of a person ever enters it
 * (`tests/guide-profile.test.ts` holds that).
 */

async function count(sql: string, ...params: unknown[]): Promise<number> {
  const row = (await getDb().prepare(sql).get(...params)) as { n: number | string } | undefined;
  return Number(row?.n ?? 0);
}

const isModel = (v: unknown): v is ResourceModel => (RESOURCE_MODELS as readonly unknown[]).includes(v);
const isSupport = (v: unknown): v is SupportLevel => (SUPPORT_LEVELS as readonly unknown[]).includes(v);

/** The activity table's facts for the keys a venue uses: the catalogue's own, and any of the operator's. */
async function activityFacts(keys: string[]): Promise<Map<string, { model: ResourceModel; support: SupportLevel | null; own: boolean; supervised: boolean }>> {
  const out = new Map<string, { model: ResourceModel; support: SupportLevel | null; own: boolean; supervised: boolean }>();
  if (keys.length === 0) return out;
  const rows = (await getDb()
    .prepare(`SELECT key, template, support, builtin, supervised FROM activities WHERE key IN (${keys.map(() => "?").join(",")})`)
    .all(...keys)) as { key: string; template: string; support: string; builtin: boolean; supervised: boolean }[];
  const builtin = new Map(BUILTIN_ACTIVITIES.map((a) => [a.key, a]));
  for (const r of rows) {
    let model: ResourceModel = "exclusive";
    try {
      const parsed = (JSON.parse(r.template) as { model?: unknown }).model;
      if (isModel(parsed)) model = parsed;
    } catch {
      // a template that cannot be read is treated as the plainest resource
    }
    const own = builtin.get(r.key) === undefined;
    out.set(r.key, {
      model,
      // The catalogue is the source for a built-in activity; an operator's own claims no support level.
      support: own ? null : (builtin.get(r.key)!.support ?? (isSupport(r.support) ? r.support : null)),
      own,
      supervised: builtin.get(r.key)?.supervised ?? r.supervised === true,
    });
  }
  return out;
}

/**
 * What the venue has, today (or on `opts.today`, a business date in the
 * venue's own zone). A venue that does not exist reads as an empty profile
 * with `venueId` 0 rather than throwing, so a caller never has to guess.
 */
export async function readVenueProfile(venueId: number, opts: { today?: string } = {}): Promise<VenueProfile> {
  const db = getDb();
  const venue = await getVenue(venueId);
  if (!venue) return emptyProfile(0);
  const row = (await db
    .prepare(
      `SELECT access, access_listed, time_zone, lat, lng, business_id, tax_registered, emergency_phone, emergency_info,
              staffed_from, staffed_to, pay_to_hold, deposit_percent, book_ahead_days, discount_stacking,
              limit_upcoming, limit_per_week, limit_per_day, last_minute_hours, alert_email, alert_phone
         FROM venues WHERE id = ?`
    )
    .get(venueId)) as {
    access: string | null;
    access_listed: number | null;
    time_zone: string | null;
    lat: number | null;
    lng: number | null;
    business_id: number | null;
    tax_registered: number | null;
    emergency_phone: string | null;
    emergency_info: string | null;
    staffed_from: number | null;
    staffed_to: number | null;
    pay_to_hold: number | null;
    deposit_percent: number | null;
    book_ahead_days: number | null;
    discount_stacking: string | null;
    limit_upcoming: number | null;
    limit_per_week: number | null;
    limit_per_day: number | null;
    last_minute_hours: number | null;
    alert_email: string | null;
    alert_phone: string | null;
  };
  const zone = venueZoneOf({ time_zone: row.time_zone, lat: row.lat, lng: row.lng });
  const today = opts.today ?? todayISO(zone);
  const p = emptyProfile(venueId);
  p.today = today;
  const region_ = region();

  // ------------------------------------------------------------ identity
  const published = venue.publishedAt !== null;
  const suspended = venue.suspendedAt !== null;
  const visibility: Visibility = row.access === "members" || row.access === "private" ? row.access : "public";
  p.identity = {
    draft: !published,
    live: published && !suspended,
    suspended,
    visibility,
    listedWhenMembersOnly: visibility === "members" && row.access_listed === 1,
    hasPin: row.lat !== null && row.lng !== null,
    timeZone: zone,
    country: region_.country,
    currency: region_.currency.code,
    customerLanguages: offeredLocales(),
    staffLanguages: staffLocales(),
    marketplace: isMarketplace(),
    taxRegistered: row.tax_registered === 1,
  };

  // ------------------------------------------------------------ history
  const realBookings = "FROM bookings b JOIN courts c ON c.id = b.court_id WHERE c.venue_id = ? AND NOT b.test AND b.demo = 0";
  const tests = await standingTestBookings(venueId);
  p.history = {
    bookings: await count(`SELECT COUNT(*)::int AS n ${realBookings} AND b.status = 'confirmed'`, venueId),
    paidBookings: await count(`SELECT COUNT(*)::int AS n ${realBookings} AND b.payment_status = 'paid'`, venueId),
    onlinePayments: await count("SELECT COUNT(*)::int AS n FROM online_payments WHERE venue_id = ? AND status = 'paid'", venueId),
    receipts: await count("SELECT COUNT(*)::int AS n FROM receipts WHERE venue_id = ?", venueId),
    testBookings: tests.bookings.length,
    paidTestBookings: (await paidStandingTests(venueId)).length,
  };

  // ------------------------------------------------------------ activities and resources
  const keys = new Set<string>();
  for (const court of venue.courts) {
    keys.add(court.sport);
    for (const a of court.activities ?? []) keys.add(a.sport);
  }
  const facts = await activityFacts([...keys]);
  p.activities = [...keys].sort().map<ProfileActivity>((key) => ({
    key,
    support: facts.get(key)?.support ?? null,
    own: facts.get(key)?.own ?? true,
  }));
  const linkedIds = new Set<number>();
  for (const r of (await db
    .prepare("SELECT whole_id, part_id FROM court_links WHERE whole_id IN (SELECT id FROM courts WHERE venue_id = ?)")
    .all(venueId)) as { whole_id: number; part_id: number }[]) {
    linkedIds.add(r.whole_id);
    linkedIds.add(r.part_id);
  }
  const bufferRows = (await db
    .prepare(
      `SELECT court_id, venue_id, business_id FROM booking_policies
        WHERE (venue_id = ? OR court_id IN (SELECT id FROM courts WHERE venue_id = ?) OR business_id = ?)
          AND (COALESCE(buffer_before, 0) > 0 OR COALESCE(buffer_after, 0) > 0 OR COALESCE(operational_before, 0) > 0
               OR COALESCE(operational_after, 0) > 0 OR COALESCE(setup_fee, 0) > 0 OR COALESCE(cleanup_fee, 0) > 0)`
    )
    .all(venueId, venueId, row.business_id ?? -1)) as { court_id: number | null; venue_id: number | null; business_id: number | null }[];
  const bufferAll = bufferRows.some((r) => r.court_id === null);
  const bufferCourts = new Set(bufferRows.map((r) => r.court_id).filter((id): id is number => id !== null));
  const byModel = { exclusive: 0, lanes: 0, shared: 0, class: 0, hire: 0 } as Record<ResourceModel, number>;
  let shared = 0;
  let perPlayer = 0;
  let unmanned = 0;
  let memberRates = false;
  let peakPricing = false;
  let priced = 0;
  let lowest: number | null = null;
  let highest: number | null = null;
  const dated = new Map<string, number>();
  for (const court of venue.courts) {
    byModel[court.classesOnly ? "class" : (facts.get(court.sport)?.model ?? "exclusive")]++;
    if (court.capacity > 1) shared++;
    if (court.perPlayer) perPlayer++;
    if (court.unmanned) unmanned++;
    // The rates in force on the day, by the same lookup a booking's price uses (ADR 0027).
    const now = ratesOn(court, today);
    for (const rate of [now.offPeakRate, now.peakRate]) {
      if (rate > 0) {
        lowest = lowest === null ? rate : Math.min(lowest, rate);
        highest = highest === null ? rate : Math.max(highest, rate);
      }
    }
    if (now.offPeakRate > 0 || now.peakRate > 0) priced++;
    if (now.peakRate !== now.offPeakRate) peakPricing = true;
    if (now.memberOffPeakRate !== null || now.memberPeakRate !== null) memberRates = true;
    for (const change of court.rateChanges ?? []) if (change.from > today) dated.set(change.from, (dated.get(change.from) ?? 0) + 1);
  }
  p.resources = {
    total: venue.courts.length,
    byModel,
    shared,
    linked: venue.courts.filter((c) => linkedIds.has(c.id)).length,
    withBuffers: bufferAll ? venue.courts.length : venue.courts.filter((c) => bufferCourts.has(c.id)).length,
    priced,
    perPlayer,
    unmanned,
    // Lanes the desk gives on arrival (lib/lanes.ts), as each one's booking rules resolve.
    laneOnArrival: [...(await policiesFor(venue.courts.filter((c) => !c.classesOnly))).values()].filter((p) => p.laneOnArrival).length,
  };

  // ------------------------------------------------------------ hours and rates
  // The usual hours in force on the day asked (a change from that date or an earlier one applies), as every lookup of hours resolves them.
  const hours = hoursFor({ openMin: venue.openMin, closeMin: venue.closeMin, weekHours: venue.weekHours ?? null, hoursChanges: venue.hoursChanges ?? [] }, today);
  const scheduledHours: ScheduledHours[] = (venue.hoursChanges ?? [])
    .filter((c) => c.from > today)
    .map((c) => ({ from: c.from, openMin: c.openMin, closeMin: c.closeMin }));
  p.hours = {
    openMin: hours.openMin,
    closeMin: hours.closeMin,
    weekdayOverrides: (hours.weekHours ?? []).some((d) => d !== null),
    scheduled: scheduledHours,
    closedDays: await count("SELECT COUNT(*)::int AS n FROM venue_closures WHERE venue_id = ? AND date >= ?", venueId, today),
  };
  const scheduledRates: ScheduledRates[] = [...dated.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([from, resources]) => ({ from, resources }));
  p.rates = {
    lowest,
    highest,
    peakPricing,
    memberRates,
    lastMinute: (row.last_minute_hours ?? 0) > 0,
    holidays: await count("SELECT COUNT(*)::int AS n FROM venue_holidays WHERE venue_id = ? AND date >= ?", venueId, today),
    scheduled: scheduledRates,
  };

  // ------------------------------------------------------------ policies
  const cancel = await cancelPolicy(venueId);
  p.policies = {
    cancellation: {
      cutoffHours: venue.cancelCutoffHours,
      lateKeepPercent: cancel.lateKeep,
      onlineRefunds: cancel.onlineRefunds as OnlineRefunds,
      refundWithinDays: cancel.refundWithinDays,
      strikeLimit: cancel.strikeLimit,
    },
    bookingRuleLevels: await count(
      "SELECT COUNT(*)::int AS n FROM booking_policies WHERE venue_id = ? OR court_id IN (SELECT id FROM courts WHERE venue_id = ?)",
      venueId,
      venueId
    ),
    signOffRequired:
      (await count(
        "SELECT COUNT(*)::int AS n FROM booking_policies WHERE sign_off AND (venue_id = ? OR court_id IN (SELECT id FROM courts WHERE venue_id = ?))",
        venueId,
        venueId
      )) > 0,
    bookAheadDays: row.book_ahead_days,
    limits: row.limit_upcoming !== null || row.limit_per_week !== null || row.limit_per_day !== null,
    payToHold: row.pay_to_hold === 1,
    depositPercent: row.deposit_percent ?? 0,
    discountStacking: row.discount_stacking,
  };

  // ------------------------------------------------------------ channels and payments
  const account = (await db
    .prepare("SELECT provider, sandbox, enabled FROM venue_payment_accounts WHERE venue_id = ?")
    .get(venueId)) as { provider: string; sandbox: number; enabled: number } | undefined;
  const counterUsed = (await db
    .prepare(
      `SELECT DISTINCT b.paid_via FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id = ? AND NOT b.test AND b.demo = 0 AND b.payment_status = 'paid' AND b.paid_via IS NOT NULL`
    )
    .all(venueId)) as { paid_via: string }[];
  const counterMethods = COUNTER_METHODS.filter((m) => counterUsed.some((r) => r.paid_via === m)) as CounterMethod[];
  const counterSales = await count("SELECT COUNT(*)::int AS n FROM counter_sales WHERE venue_id = ? AND voided_at IS NULL", venueId);
  p.channels = {
    onlinePage: p.identity.live && visibility !== "private",
    counter: counterMethods.length > 0 || counterSales > 0,
    apiKeys: await count("SELECT COUNT(*)::int AS n FROM venue_api_keys WHERE venue_id = ? AND revoked_at IS NULL", venueId),
  };
  p.payments = {
    online: {
      accountExists: account !== undefined,
      accountEnabled: account?.enabled === 1,
      sandbox: account?.sandbox === 1,
      provider: account?.provider ?? null,
      firstPaymentTaken: p.history.onlinePayments > 0,
    },
    counterMethods,
    storedCredit: (await count("SELECT COUNT(*)::int AS n FROM wallet_entries WHERE venue_id = ?", venueId)) > 0,
    giftVouchers: (await count("SELECT COUNT(*)::int AS n FROM gift_vouchers WHERE venue_id = ?", venueId)) > 0,
    onlineRefundsOwed: await count(
      "SELECT COUNT(*)::int AS n FROM online_payments WHERE venue_id = ? AND status = 'paid' AND refund_due > COALESCE(refunded, 0)",
      venueId
    ),
  };

  // ------------------------------------------------------------ people
  p.staff = {
    managers: await count(
      `SELECT COUNT(*)::int AS n FROM admins WHERE (venue_id = ? AND role = 'manager') OR (business_id IS NOT NULL AND business_id = ?)`,
      venueId,
      row.business_id ?? -1
    ),
    desk: await count("SELECT COUNT(*)::int AS n FROM admins WHERE venue_id = ? AND role = 'desk'", venueId),
    pendingInvitations: await count(
      "SELECT COUNT(*)::int AS n FROM staff_invitations WHERE venue_id = ? AND accepted_at IS NULL AND withdrawn_at IS NULL AND expires_at > datetime('now')",
      venueId
    ),
  };
  p.people = {
    coaches: await count("SELECT COUNT(*)::int AS n FROM coaches WHERE venue_id = ? AND active = 1", venueId),
    coachesWithHours: await count(
      "SELECT COUNT(*)::int AS n FROM coaches WHERE venue_id = ? AND active = 1 AND EXISTS (SELECT 1 FROM coach_hours h WHERE h.coach_id = coaches.id)",
      venueId
    ),
    upcomingClasses: await count(
      "SELECT COUNT(*)::int AS n FROM classes k JOIN courts c ON c.id = k.court_id WHERE c.venue_id = ? AND k.status <> 'cancelled' AND k.date >= ?",
      venueId,
      today
    ),
    classes: await count("SELECT COUNT(*)::int AS n FROM classes k JOIN courts c ON c.id = k.court_id WHERE c.venue_id = ? AND k.status <> 'cancelled'", venueId),
    lessonsBooked: await count(`SELECT COUNT(*)::int AS n ${realBookings} AND b.coach_id IS NOT NULL AND b.status = 'confirmed'`, venueId),
  };
  p.commerce = {
    membershipPlans: await count("SELECT COUNT(*)::int AS n FROM membership_plans WHERE venue_id = ? AND retired_at IS NULL", venueId),
    activeMemberships: await count("SELECT COUNT(*)::int AS n FROM memberships WHERE venue_id = ? AND status = 'active' AND expires_on >= ?", venueId, today),
    passProducts: await count("SELECT COUNT(*)::int AS n FROM pass_products WHERE venue_id = ? AND retired_at IS NULL", venueId),
    concessions: await count("SELECT COUNT(*)::int AS n FROM concessions WHERE venue_id = ? AND retired_at IS NULL", venueId),
    promoCodes: await count("SELECT COUNT(*)::int AS n FROM promo_codes WHERE venue_id = ? AND status = 'active'", venueId),
    extras: await count("SELECT COUNT(*)::int AS n FROM venue_addons WHERE venue_id = ? AND active = 1", venueId),
    hireDeposits: venue.courts.some((c) => c.deposit > 0),
    companyAccounts: await count("SELECT COUNT(*)::int AS n FROM venue_accounts WHERE venue_id = ? AND closed_at IS NULL", venueId),
  };
  p.programmes = {
    tournaments: await count("SELECT COUNT(*)::int AS n FROM tournaments WHERE venue_id = ? AND status <> 'cancelled'", venueId),
    leagues: await count("SELECT COUNT(*)::int AS n FROM leagues WHERE venue_id = ? AND status <> 'cancelled'", venueId),
    openGames: await count("SELECT COUNT(*)::int AS n FROM open_games g JOIN bookings b ON b.id = g.booking_id JOIN courts c ON c.id = b.court_id WHERE c.venue_id = ?", venueId),
  };
  p.guardians = {
    participants: await count("SELECT COUNT(*)::int AS n FROM participants WHERE venue_id = ?", venueId),
    approvalRequirements: await count("SELECT COUNT(*)::int AS n FROM approval_requirements WHERE venue_id = ? AND open = 1", venueId),
    familyPlans: await count("SELECT COUNT(*)::int AS n FROM membership_plans WHERE venue_id = ? AND retired_at IS NULL AND COALESCE(family_limit, 0) > 0", venueId),
  };
  p.access = {
    unstaffedHours: row.staffed_from !== null || row.staffed_to !== null,
    unmannedResources: unmanned,
    emergencyDetails: !!(row.emergency_phone || row.emergency_info),
    supervisedActivities: p.activities.filter((a) => facts.get(a.key)?.supervised).length,
  };

  // ------------------------------------------------------------ compliance, branches, install
  const einvoice = (await db.prepare("SELECT enabled, sandbox FROM einvoice_settings WHERE venue_id = ?").get(venueId)) as { enabled: number; sandbox: number } | undefined;
  p.compliance = {
    einvoicing: {
      enabled: einvoice?.enabled === 1,
      sandbox: einvoice?.sandbox === 1,
      sent: await count("SELECT COUNT(*)::int AS n FROM e_invoices WHERE venue_id = ? AND status = 'valid'", venueId),
    },
    deductionTaxReviewed: (await deductionReview(venueId)) !== null,
    bookingAlerts: !!(row.alert_email || row.alert_phone),
  };
  p.branches = {
    venues: row.business_id === null ? 1 : Math.max(1, await count("SELECT COUNT(*)::int AS n FROM venues WHERE business_id = ?", row.business_id)),
    copiedFromBranch:
      (await count(
        "SELECT COUNT(*)::int AS n FROM staff_actions WHERE venue_id = ? AND action = 'venue.branch_added' AND detail LIKE 'Added this branch as a draft, from venue #%'",
        venueId
      )) > 0,
  };
  p.install = { emailTransport: emailConfig() !== null, whatsappTransport: whatsappConfig() !== null };

  // ------------------------------------------------------------ the checklist, and going live: their own answers, not recomputed
  const setup = await venueSetup(venueId);
  p.setup = {
    courts: setup.courts,
    detailsChecked: setup.detailsChecked,
    testBooking: setup.testBooking,
    onlinePayment: setup.onlinePayment,
    photos: setup.photos,
    facilities: setup.facilities,
    dismissed: setup.dismissed,
    complete: setup.complete,
  };
  const live = await goLiveStatus(venueId);
  p.goLive = { missing: live?.missingPhrases ?? [], request: (live?.request?.status as ApplicationStatus | undefined) ?? null };
  return p;
}
