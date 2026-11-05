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
  /** What a person sees of a thread: the latest this many. */
  shown: 200,
} as const;

export const REPORT_REASONS = ["abuse", "spam", "contact", "safety", "other"] as const;
export type MessageReportReason = (typeof REPORT_REASONS)[number];
