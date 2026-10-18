import { CLOSE_HOUR, OPEN_HOUR } from "./types";

/** Start hours for each part of the day, as the search takes them. */
export const DAY_PARTS = {
  any: [OPEN_HOUR, CLOSE_HOUR - 1],
  morning: [6, 11],
  afternoon: [12, 16],
  evening: [17, 23],
} as const;
export type DayPart = keyof typeof DAY_PARTS;

/** Which part of the day a from–until window is, or null for a window of one's own. */
export function dayPartOf(from: number, to: number): DayPart | null {
  for (const [k, [a, b]] of Object.entries(DAY_PARTS)) if (a === from && b === to) return k as DayPart;
  return null;
}
