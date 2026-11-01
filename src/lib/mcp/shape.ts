/**
 * Shaping what the pages and routes answer into the MCP server's concise JSON
 * (lib/mcp): fewer fields, times also as HH:MM, nothing added and nothing
 * worked out again.
 */

/** A minute of the business day as HH:MM; past midnight (1440 and on) as the next day's hour with "+1". */
export function clock(minute: number): string {
  const day = minute >= 1440 ? 1 : 0;
  const m = minute - day * 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}${day ? " +1" : ""}`;
}

interface PolicyLike {
  lengths: number[] | null;
  minLength: number;
  maxLength: number;
  lengthStep: number;
  noticeMinutes: number;
  needs?: string | null;
}
interface SlotLike {
  minute: number;
  rate: number;
  available: boolean;
  partly?: boolean;
  booked: number;
  capacity: number;
}
interface StartLike {
  minute: number;
  maxLength: number;
  lengths?: number[];
}
interface CourtDayLike {
  id?: number;
  name?: string;
  sport?: string;
  court?: { id: number; name: string; sport: string };
  policy: PolicyLike;
  slots: SlotLike[];
  starts: StartLike[];
  grid: number;
}

/**
 * One court's day, from the public availability route's answer or the API's
 * (`apiCourtDays`): which lengths its rules take, each start a booking may
 * have with the longest it may run, and the day in columns with what each
 * costs and whether it is free.
 */
export function courtDay(d: CourtDayLike): Record<string, unknown> {
  const id = d.court?.id ?? d.id;
  const name = d.court?.name ?? d.name;
  const sport = d.court?.sport ?? d.sport;
  return {
    courtId: id,
    name,
    sport,
    lengths: d.policy.lengths ?? { from: d.policy.minLength, to: d.policy.maxLength, step: d.policy.lengthStep },
    noticeMinutes: d.policy.noticeMinutes,
    ...(d.policy.needs ? { needs: d.policy.needs === "signOff" ? "the venue's sign-off" : "a recorded certification" } : {}),
    starts: d.starts.map((s) => ({ at: clock(s.minute), start: s.minute, maxMinutes: s.maxLength, ...(s.lengths ? { lengths: s.lengths } : {}) })),
    columnMinutes: d.grid,
    columns: d.slots.map((s) => ({
      at: clock(s.minute),
      // What the column of time costs, at the court's rates.
      price: s.rate,
      free: s.available,
      ...(s.partly ? { partly: true } : {}),
      ...(s.capacity > 1 ? { placesLeft: Math.max(0, s.capacity - s.booked) } : {}),
    })),
  };
}
