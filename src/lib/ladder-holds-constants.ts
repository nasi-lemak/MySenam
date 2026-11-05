/**
 * The caps on held court time as the install is seeded with them (migration 0283, `ladder_hold_limits`): holds a ladder may have live at once, and
 * holds made for one player's (or team's) challenges in any 7 days, moves included. Here, apart from lib/ladder-holds.ts, so a screen can say them.
 * They are the install defaults: a venue's setting and a ladder's own replace them (ADR 0048), inside the bounds below.
 */
export const DEFAULT_HOLD_LIMITS = { maxLivePerLadder: 8, maxPerPlayerWeek: 4 };

/** The least and most a venue or a ladder may set (migration 0290 seeds them in `ladder_hold_limits`; the row there replaces these). */
export const DEFAULT_HOLD_BOUNDS = { liveMin: 1, liveMax: 50, weekMin: 1, weekMax: 20 };

/** Expiry of a hold that has not been confirmed (migration 0290): hours to confirm, the notice before the match it must be settled by, and a manager's one extension. */
export const DEFAULT_HOLD_EXPIRY = { confirmHours: 48, minNoticeMinutes: 120, extendHours: 24 };
