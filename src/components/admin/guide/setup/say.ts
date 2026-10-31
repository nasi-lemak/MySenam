import { BUILTIN_ACTIVITIES } from "@/lib/activity-catalogue";
import { formatMinute } from "@/lib/interval";
import { money } from "@/lib/region";
import type { StaffT } from "@/lib/staff-i18n";
import type { Say } from "@/lib/guide/plan";

/**
 * A `Say` (a staff-dictionary phrase and its values) said in the reader's
 * language. The plan carries values, never words, so a value that is a
 * catalogue activity (`activity`), a time of day (`…Min`) or an amount of
 * money (`amount`) is written here as the reader's language and the install's
 * currency write it.
 */
export function activityName(t: StaffT, key: string): string {
  const a = BUILTIN_ACTIVITIES.find((x) => x.key === key);
  return a ? (a.names[t.locale as "en" | "ms" | "zh"] ?? a.names.en) : key;
}

export function renderSay(t: StaffT, say: Say): string {
  const vars: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(say.vars ?? {})) {
    vars[name] = name === "activity" ? activityName(t, String(value)) : name.endsWith("Min") ? formatMinute(Number(value), t.locale) : name === "amount" ? money(Number(value)) : value;
  }
  return t(say.key, vars);
}

/** A business date (YYYY-MM-DD) as a weekday and day for people, in the reader's language. */
export function friendlyDate(date: string, locale: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-Hans-MY" : locale === "ms" ? "ms-MY" : "en-MY", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" }).format(parsed);
}
