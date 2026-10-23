import type { T } from "./i18n";

/** "1 h 30 min", in the reader's language: a booking's length on a customer's page. */
export function lengthLabel(t: T, minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return t("len.m", { m });
  return m === 0 ? t("len.h", { h }) : t("len.hm", { h, m });
}
