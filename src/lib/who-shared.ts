/** What pages in the browser need of lib/who.ts, which reaches the database. */

export const GENDERS = ["woman", "man", "unsaid"] as const;
export type Gender = (typeof GENDERS)[number];
export const WHO = ["anyone", "women", "men"] as const;
export type Who = (typeof WHO)[number];
export const CATEGORIES = ["open", "women", "men", "mixed"] as const;
export type Category = (typeof CATEGORIES)[number];
