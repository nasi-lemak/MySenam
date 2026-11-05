/**
 * The limits on held court time as the install is seeded with them (migration 0283, `ladder_hold_limits`; the second in migration 0292): holds a ladder may have
 * live at once, holds one player's (or team's) challenges may have live at once (the **active** limit, which replaced the old "holds made in 7 days" quota,
 * ADR 0050), and the **anti-abuse** threshold: the player's own cancellations of holds that really reserved court capacity inside the window (ADR 0051). Here, apart from lib/ladder-holds.ts, so a screen can say
 * them. They are the install defaults: a venue's setting and a ladder's own replace them (ADR 0048), inside the bounds below.
 * `maxPerPlayerWeek` is the old name of `maxActivePerPlayer`, kept so what read it still reads the same number.
 */
export const DEFAULT_HOLD_LIMITS = { maxLivePerLadder: 8, maxActivePerPlayer: 4, maxPerPlayerWeek: 4, cancelThreshold: 6 };

/** The least and most a venue or a ladder may set (migrations 0290 and 0292 seed them in `ladder_hold_limits`; the row there replaces these). `weekMin`/`weekMax` are the active limit's, under its old name. */
export const DEFAULT_HOLD_BOUNDS = { liveMin: 1, liveMax: 50, activeMin: 1, activeMax: 20, weekMin: 1, weekMax: 20, cancelMin: 2, cancelMax: 50 };

/** The anti-abuse rule's own numbers (install data, migration 0292): the rolling window, in days, and the pause on creating new capacity-reserving holds once the threshold is reached, in hours (ADR 0051). */
export const DEFAULT_HOLD_ABUSE = { windowDays: 7, cooldownHours: 24 };

/** Expiry of a hold that has not been confirmed (migration 0290): hours to confirm, the notice before the match it must be settled by, and a manager's one extension. */
export const DEFAULT_HOLD_EXPIRY = { confirmHours: 48, minNoticeMinutes: 120, extendHours: 24 };
