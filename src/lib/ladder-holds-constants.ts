/**
 * The caps on held court time as the install is seeded with them (migration 0283, `ladder_hold_limits`): holds a ladder may have live at once, and
 * holds made for one player's (or team's) challenges in any 7 days, moves included. Here, apart from lib/ladder-holds.ts, so a screen can say them.
 */
export const DEFAULT_HOLD_LIMITS = { maxLivePerLadder: 8, maxPerPlayerWeek: 4 };
