/**
 * The published limits and reasons of messages between players, apart from the code that enforces them (lib/messages.ts) so a page can show
 * them (docs/features/player-messages.md#limits). Nothing here is learned or changes by itself.
 */

export const LIMITS = {
  /** Characters in a message. */
  maxLength: 1000,
  /** Messages one person sends in an hour, in a day, and into one thread in an hour. */
  perHour: 30,
  perDay: 150,
  perThreadPerHour: 20,
  /** Threads one person may begin (by their first message) in a day. */
  newThreadsPerDay: 5,
  /** Emails a person is told of messages in a day; and the period within which a thread tells them once. */
  emailsPerDay: 5,
  digestHours: 6,
  /** An ended context's thread can be read but not written to for this long, and is then closed. */
  readOnlyDays: 14,
  /** Messages frozen with a report (those the reporter could see, the last ones). */
  reportLines: 20,
  /** Reports one person may make in a day. */
  reportsPerDay: 10,
  /** Different people reporting somebody within `autoSuspendDays` suspends their messaging until the platform owner reviews it. */
  autoSuspendReporters: 3,
  autoSuspendDays: 30,
  /** An automatic suspension is to be reviewed within this many days: a date on the owner's list, not a legal period, and passing it lifts nothing by itself (ADR 0059). */
  autoSuspendReviewDays: 14,
  /** What a person sees of a thread: the latest this many. */
  shown: 200,
} as const;

/** Hours in a digest period: `MESSAGE_DIGEST_HOURS` (an install's data), 6 by default, a whole number from 1 to 24. Read on the server only. */
export function digestHours(): number {
  const n = Number(process.env.MESSAGE_DIGEST_HOURS);
  return Number.isInteger(n) && n >= 1 && n <= 24 ? n : LIMITS.digestHours;
}

export const REPORT_REASONS = ["abuse", "spam", "contact", "safety", "other"] as const;
export type MessageReportReason = (typeof REPORT_REASONS)[number];

/**
 * Stricter limits for a minor's seat in a supervised youth group's thread, and for what is kept of it (docs/features/player-messages.md
 * #supervised-youth-groups; ADR 0044). Published constants: nothing learns or changes by itself. The rest hours are the install's
 * (`YOUTH_QUIET_HOURS`, 22:00 to 07:00 by default, in the group's venue's time zone, else the install's) and are read by lib/youth-messages.ts.
 */
export const YOUTH_LIMITS = {
  /** Characters in a minor's message. */
  maxLength: 300,
  /** Messages a minor sends in an hour, in a day, and into the one thread in an hour. */
  perHour: 12,
  perDay: 40,
  perThreadPerHour: 12,
  /** People who can read a thread with a minor in it, the writer included, and a supervisor among them: fewer is a private conversation. */
  minSeats: 3,
  /** Messages frozen with a report in a youth thread: more than an ordinary report's. */
  reportLines: 50,
} as const;

/** How a person is told of unread messages: at once, in a digest (one email per conversation per period), or daily. The period is `MESSAGE_DIGEST_HOURS`. */
export const NOTICE_CHOICES = ["immediate", "digest", "daily"] as const;
export type NoticeChoice = (typeof NOTICE_CHOICES)[number];
