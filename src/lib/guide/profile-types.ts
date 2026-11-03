import type { StaffText } from "../staff-text";
import type { ResourceModel, SupportLevel } from "../activity-catalogue";
import type { CounterMethod } from "../types";

/**
 * The venue profile: what the venue has, as a read model of its REAL saved
 * configuration (`readVenueProfile`, src/lib/guide/profile.ts), and the
 * *illustrative* profiles the public guide shows for a kind of business
 * (src/lib/guide/business-types.ts) in the same shape. Everything the setup
 * plan, the readiness summary, the discoveries and the playbook say about a
 * venue is a function of one of these.
 *
 * Browser-safe: types and pure helpers only, no database. It holds counts,
 * flags and settings, never a key, a credential, a tax identifier, or the
 * name, number or address of a person.
 */

export type Visibility = "public" | "members" | "private";
export type OnlineRefunds = "staff" | "gateway" | "credit";

export interface ProfileActivity {
  key: string;
  /** From the activity catalogue, never copied; null for an activity of the venue's own (no support level is claimed for it). */
  support: SupportLevel | null;
  own: boolean;
}

export interface ScheduledRates {
  /** The first business date the new rates apply. */
  from: string;
  /** How many of the venue's resources change that day. */
  resources: number;
}

export interface ScheduledHours {
  from: string;
  openMin: number;
  closeMin: number;
}

export interface VenueProfile {
  venueId: number;
  /** The venue's own date (its time zone) the profile was read for: "in force" means in force on it. */
  today: string;
  /** True for the public guide's examples: nothing here was read from a venue. */
  illustrative: boolean;

  identity: {
    /** Not yet live: a draft only its staff can see. */
    draft: boolean;
    live: boolean;
    suspended: boolean;
    visibility: Visibility;
    /** Members-only and listed, so customers can find it and ask. */
    listedWhenMembersOnly: boolean;
    hasPin: boolean;
    timeZone: string;
    country: string;
    currency: string;
    /** The languages customers are offered on this install, the first the default. */
    customerLanguages: string[];
    /** The languages the staff dashboard is offered in. */
    staffLanguages: string[];
    marketplace: boolean;
    taxRegistered: boolean;
  };

  /** What has happened here, so an existing venue is told from an empty one. Real bookings only: a test booking is counted apart. */
  history: {
    bookings: number;
    paidBookings: number;
    onlinePayments: number;
    receipts: number;
    testBookings: number;
    /** Test bookings with a payment on them: real money is never a test. */
    paidTestBookings: number;
  };

  activities: ProfileActivity[];

  resources: {
    total: number;
    byModel: Record<ResourceModel, number>;
    /** Places for more than one booking at a time. */
    shared: number;
    /** Resources that take, or are taken by, another when booked. */
    linked: number;
    /** Resources under a rule with setup, cleaning or separation time. */
    withBuffers: number;
    priced: number;
    perPlayer: number;
    unmanned: number;
    /** Resources whose lane is given on arrival (lib/lanes.ts): the desk chooses the lane at check-in. */
    laneOnArrival?: number;
    /** Resources taking entries with no set time (lib/entries.ts): the desk admits and checks people out. */
    entry?: number;
  };

  hours: {
    openMin: number;
    closeMin: number;
    weekdayOverrides: boolean;
    /** Hours set from a later date, not yet in force. */
    scheduled: ScheduledHours[];
    closedDays: number;
  };

  rates: {
    /** Lowest and highest hourly rate in force today across resources; null with none. */
    lowest: number | null;
    highest: number | null;
    peakPricing: boolean;
    memberRates: boolean;
    lastMinute: boolean;
    holidays: number;
    /** Rates set from a later date, not yet in force. */
    scheduled: ScheduledRates[];
  };

  policies: {
    cancellation: {
      cutoffHours: number;
      /** Percent of what was paid the venue keeps on a late cancellation; null: none. */
      lateKeepPercent: number | null;
      /** What happens to money paid online when a customer cancels. */
      onlineRefunds: OnlineRefunds;
      refundWithinDays: number;
      strikeLimit: number | null;
    };
    /** Booking rules set at the venue, by activity or by resource (beyond the platform's own). */
    bookingRuleLevels: number;
    signOffRequired: boolean;
    bookAheadDays: number | null;
    limits: boolean;
    payToHold: boolean;
    depositPercent: number;
    discountStacking: string | null;
  };

  channels: {
    /** Customers can reach the venue's booking page. */
    onlinePage: boolean;
    /** The counter has been used: a staff-taken payment, a counter sale. */
    counter: boolean;
    apiKeys: number;
  };

  payments: {
    online: {
      accountExists: boolean;
      accountEnabled: boolean;
      sandbox: boolean;
      provider: string | null;
      /** A payment really came in through it (a paid online payment exists). */
      firstPaymentTaken: boolean;
    };
    counterMethods: CounterMethod[];
    storedCredit: boolean;
    giftVouchers: boolean;
    onlineRefundsOwed: number;
  };

  staff: {
    managers: number;
    desk: number;
    pendingInvitations: number;
  };

  people: {
    coaches: number;
    coachesWithHours: number;
    /** Classes still to come. */
    upcomingClasses: number;
    classes: number;
    lessonsBooked: number;
  };

  commerce: {
    membershipPlans: number;
    activeMemberships: number;
    passProducts: number;
    concessions: number;
    promoCodes: number;
    extras: number;
    hireDeposits: boolean;
    companyAccounts: number;
  };

  programmes: {
    tournaments: number;
    leagues: number;
    openGames: number;
    /** Leagues of teams (lib/team-leagues.ts), not called off. */
    teamLeagues?: number;
  };

  guardians: {
    participants: number;
    approvalRequirements: number;
    familyPlans: number;
  };

  access: {
    /** Hours when nobody is behind the counter are set. */
    unstaffedHours: boolean;
    unmannedResources: number;
    emergencyDetails: boolean;
    /** Offered activities that are never left unstaffed (pools, water). */
    supervisedActivities: number;
  };

  compliance: {
    einvoicing: { enabled: boolean; sandbox: boolean; sent: number };
    deductionTaxReviewed: boolean;
    bookingAlerts: boolean;
  };

  branches: {
    /** Venues in this venue's business, itself included. */
    venues: number;
    /** Started from another branch's set-up (read from the staff log; absent once that is past its retention). */
    copiedFromBranch: boolean;
  };

  /** What this install can do, from its own configuration (never a secret). */
  install: {
    emailTransport: boolean;
    whatsappTransport: boolean;
  };

  /** The existing checklist's own answers (lib/setup.ts), not recomputed. */
  setup: {
    courts: number;
    detailsChecked: boolean;
    testBooking: boolean;
    onlinePayment: boolean;
    photos: boolean;
    facilities: boolean;
    dismissed: boolean;
    complete: boolean;
  };

  /** What stops the venue asking to go live (lib/applications.ts `goLiveStatus`), as phrases staff screens say. */
  goLive: {
    missing: StaffText[];
    request: "draft" | "pending" | "approved" | "rejected" | null;
  };
}

/** A venue with nothing set up: the base the illustrative profiles are written over. */
export function emptyProfile(venueId = 0): VenueProfile {
  return {
    venueId,
    today: "1970-01-01",
    illustrative: false,
    identity: {
      draft: true,
      live: false,
      suspended: false,
      visibility: "public",
      listedWhenMembersOnly: false,
      hasPin: false,
      timeZone: "Asia/Kuala_Lumpur",
      country: "MY",
      currency: "MYR",
      customerLanguages: ["en"],
      staffLanguages: ["en"],
      marketplace: false,
      taxRegistered: false,
    },
    history: { bookings: 0, paidBookings: 0, onlinePayments: 0, receipts: 0, testBookings: 0, paidTestBookings: 0 },
    activities: [],
    resources: { total: 0, byModel: { exclusive: 0, lanes: 0, shared: 0, class: 0, hire: 0 }, shared: 0, linked: 0, withBuffers: 0, priced: 0, perPlayer: 0, unmanned: 0 },
    hours: { openMin: 480, closeMin: 1380, weekdayOverrides: false, scheduled: [], closedDays: 0 },
    rates: { lowest: null, highest: null, peakPricing: false, memberRates: false, lastMinute: false, holidays: 0, scheduled: [] },
    policies: {
      cancellation: { cutoffHours: 24, lateKeepPercent: null, onlineRefunds: "staff", refundWithinDays: 7, strikeLimit: null },
      bookingRuleLevels: 0,
      signOffRequired: false,
      bookAheadDays: null,
      limits: false,
      payToHold: false,
      depositPercent: 0,
      discountStacking: null,
    },
    channels: { onlinePage: false, counter: false, apiKeys: 0 },
    payments: {
      online: { accountExists: false, accountEnabled: false, sandbox: false, provider: null, firstPaymentTaken: false },
      counterMethods: [],
      storedCredit: false,
      giftVouchers: false,
      onlineRefundsOwed: 0,
    },
    staff: { managers: 0, desk: 0, pendingInvitations: 0 },
    people: { coaches: 0, coachesWithHours: 0, upcomingClasses: 0, classes: 0, lessonsBooked: 0 },
    commerce: { membershipPlans: 0, activeMemberships: 0, passProducts: 0, concessions: 0, promoCodes: 0, extras: 0, hireDeposits: false, companyAccounts: 0 },
    programmes: { tournaments: 0, leagues: 0, openGames: 0 },
    guardians: { participants: 0, approvalRequirements: 0, familyPlans: 0 },
    access: { unstaffedHours: false, unmannedResources: 0, emergencyDetails: false, supervisedActivities: 0 },
    compliance: { einvoicing: { enabled: false, sandbox: false, sent: 0 }, deductionTaxReviewed: false, bookingAlerts: false },
    branches: { venues: 1, copiedFromBranch: false },
    install: { emailTransport: false, whatsappTransport: false },
    setup: { courts: 0, detailsChecked: false, testBooking: false, onlinePayment: false, photos: false, facilities: false, dismissed: false, complete: false },
    goLive: { missing: [], request: null },
  };
}

// ---------------------------------------------------------------- pure derived helpers

/** Nothing has happened and nothing is set up: a venue the journey may lead through from the start. */
export function isEmptyVenue(p: VenueProfile): boolean {
  return !hasHistory(p) && p.resources.total === 0;
}

/** Real bookings, payments or receipts exist: whatever is set must not be overwritten by a wizard. */
export function hasHistory(p: VenueProfile): boolean {
  const h = p.history;
  return h.bookings > 0 || h.paidBookings > 0 || h.onlinePayments > 0 || h.receipts > 0;
}

/** Customers can pay through the venue's own online account, or the venue has said it will. */
export function usesOnlinePayments(p: VenueProfile): boolean {
  const o = p.payments.online;
  return o.accountEnabled || p.policies.payToHold || p.history.onlinePayments > 0;
}

export const takesCounterPayments = (p: VenueProfile): boolean => p.channels.counter || p.payments.counterMethods.length > 0;

export const usesEInvoicing = (p: VenueProfile): boolean => p.compliance.einvoicing.enabled;

export const hasCoaching = (p: VenueProfile): boolean => p.people.coaches > 0 || p.people.lessonsBooked > 0;

export const hasMultipleBranches = (p: VenueProfile): boolean => p.branches.venues > 1;

export const hasProgrammes = (p: VenueProfile): boolean => p.programmes.tournaments + p.programmes.leagues + p.programmes.openGames + (p.programmes.teamLeagues ?? 0) > 0;

/** Whether an activity (by key) is among those offered. */
export const offersActivity = (p: VenueProfile, key: string): boolean => p.activities.some((a) => a.key === key);

/** The resource models in use, in the catalogue's order. */
export function modelsInUse(p: VenueProfile): ResourceModel[] {
  return (Object.keys(p.resources.byModel) as ResourceModel[]).filter((m) => p.resources.byModel[m] > 0);
}

/** A change of rates or hours is on its way, not yet in force: today's policy is not the scheduled one. */
export const hasScheduledChanges = (p: VenueProfile): boolean => p.rates.scheduled.length > 0 || p.hours.scheduled.length > 0;
