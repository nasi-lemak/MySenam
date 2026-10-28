import { getDb } from "./db";
import { DAY_MINUTES, LATEST_MINUTE } from "./interval";
import { isActivity } from "./activities";
import { MAX_COURT_HOURS, type Sport } from "./types";
import { parseWeekHours } from "./week-hours";
import { clockValue, lengthText, said, type StaffText, type StaffValue } from "./staff-text";
import {
  SETTING_KEYS,
  TURNOVERS,
  resolvePolicy,
  type BookingPolicy,
  type FixedPrice,
  type PolicyScope,
  type PolicySettings,
  type Turnover,
} from "./booking-rules";

export * from "./booking-rules";

/** `describePolicy` (lib/booking-rules.ts) as a phrase, for the staff screen in the staff language: the same words in English. */
export function policySummary(p: BookingPolicy): StaffText {
  const starts = p.startTimes
    ? said("srv.pol.startsAt", { times: p.startTimes.map(clockValue) })
    : p.startEvery === 60 && p.startOffset === 0
      ? said("srv.pol.onTheHour")
      : said("srv.pol.startsEvery", { length: lengthText(p.startEvery) });
  const lengths: StaffValue = p.lengths
    ? p.lengths.map(lengthText)
    : said("srv.pol.range", { min: lengthText(p.minLength), max: lengthText(p.maxLength), step: lengthText(p.lengthStep) });
  const around = (beforeMin: number, afterMin: number) => {
    const before = beforeMin ? said("srv.pol.before", { length: lengthText(beforeMin) }) : null;
    const after = afterMin ? said("srv.pol.after", { length: lengthText(afterMin) }) : null;
    return before && after ? said("srv.pol.beforeAndAfter", { before, after }) : (before ?? after);
  };
  // Minimum separation, shared with the neighbour; setup and cleaning, which add up.
  const separation = around(p.bufferBefore, p.bufferAfter);
  const operational = around(p.operationalBefore, p.operationalAfter);
  const kept = separation ? said("srv.pol.kept", { around: separation }) : null;
  const work = operational ? said("srv.pol.operational", { around: operational }) : null;
  if (kept && work) return said("srv.pol.summaryBoth", { starts, lengths, kept, work });
  if (kept) return said("srv.pol.summaryKept", { starts, lengths, kept });
  if (work) return said("srv.pol.summaryWork", { starts, lengths, work });
  return said("srv.pol.summary", { starts, lengths });
}

/**
 * Booking policies as stored (`booking_policies`, db/migrations/0089) and
 * looked up: each level's own settings, and a court's resolved policy. The
 * rules themselves are lib/booking-rules.ts.
 */

// ------------------------------------------------------------ storage

interface Row {
  business_id: number | null;
  venue_id: number | null;
  sport: string | null;
  court_id: number | null;
  start_every: number | null;
  start_offset: number | null;
  start_times: string | null;
  length_step: number | null;
  min_length: number | null;
  max_length: number | null;
  lengths: string | null;
  default_length: number | null;
  buffer_before: number | null;
  buffer_after: number | null;
  operational_before: number | null;
  operational_after: number | null;
  turnover: Turnover | null;
  week_hours: string | null;
  notice_minutes: number | null;
  rate_mode: "split" | "start" | null;
  bill_step: number | null;
  min_billed: number | null;
  min_charge: number | string | null;
  fixed_prices: string | null;
  setup_fee: number | string | null;
  cleanup_fee: number | string | null;
  sign_off: boolean | null;
  needs_certification: boolean | null;
  separate_places?: boolean | null;
}

const numbers = (raw: string | null): number[] | null => {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.every((n) => Number.isInteger(n)) ? v : null;
  } catch {
    return null;
  }
};
const money = (v: number | string | null): number | null => (v === null ? null : Number(v));

function toSettings(r: Row): PolicySettings {
  let fixed: FixedPrice[] | null = null;
  if (r.fixed_prices) {
    try {
      const v = JSON.parse(r.fixed_prices) as FixedPrice[];
      fixed = Array.isArray(v) ? v.map((f) => ({ minutes: Number(f.minutes), price: Number(f.price), peakPrice: f.peakPrice === null || f.peakPrice === undefined ? null : Number(f.peakPrice) })) : null;
    } catch {
      fixed = null;
    }
  }
  return {
    startEvery: r.start_every,
    startOffset: r.start_offset,
    startTimes: numbers(r.start_times),
    lengthStep: r.length_step,
    minLength: r.min_length,
    maxLength: r.max_length,
    lengths: numbers(r.lengths),
    defaultLength: r.default_length,
    bufferBefore: r.buffer_before,
    bufferAfter: r.buffer_after,
    operationalBefore: r.operational_before ?? null,
    operationalAfter: r.operational_after ?? null,
    turnover: r.turnover ?? null,
    weekHours: parseWeekHours(r.week_hours),
    noticeMinutes: r.notice_minutes,
    rateMode: r.rate_mode,
    billStep: r.bill_step,
    minBilled: r.min_billed,
    minCharge: money(r.min_charge),
    fixedPrices: fixed,
    setupFee: money(r.setup_fee),
    cleanupFee: money(r.cleanup_fee),
    signOff: r.sign_off,
    certification: r.needs_certification,
    separatePlaces: r.separate_places ?? null,
  };
}

/** Every level that may apply at these venues: their own, their sports', their courts', their businesses'. */
async function rowsFor(venueIds: number[]): Promise<{ rows: Row[]; business: Map<number, number | null> }> {
  if (venueIds.length === 0) return { rows: [], business: new Map() };
  const list = venueIds.map(() => "?").join(",");
  const db = getDb();
  const venues = (await db.prepare(`SELECT id, business_id FROM venues WHERE id IN (${list})`).all(...venueIds)) as {
    id: number;
    business_id: number | null;
  }[];
  const businesses = [...new Set(venues.map((v) => v.business_id).filter((b): b is number => b !== null))];
  const rows = (await db
    .prepare(
      `SELECT * FROM booking_policies
        WHERE venue_id IN (${list})
           OR court_id IN (SELECT id FROM courts WHERE venue_id IN (${list}))
           ${businesses.length ? `OR business_id IN (${businesses.map(() => "?").join(",")})` : ""}`
    )
    .all(...venueIds, ...venueIds, ...businesses)) as Row[];
  return { rows, business: new Map(venues.map((v) => [v.id, v.business_id])) };
}

/**
 * Policies for many courts at once (a search, a venue's grid), each for the
 * activity given: the court's main one, or the one being booked on it.
 */
export async function policiesFor(courts: { id: number; venueId: number; sport: Sport }[]): Promise<Map<number, BookingPolicy>> {
  const out = new Map<number, BookingPolicy>();
  if (courts.length === 0) return out;
  const { rows, business } = await rowsFor([...new Set(courts.map((c) => c.venueId))]);
  for (const c of courts) {
    const levels = [
      rows.find((r) => r.court_id === c.id && r.sport === c.sport),
      rows.find((r) => r.court_id === c.id && r.sport === null),
      rows.find((r) => r.venue_id === c.venueId && r.sport === c.sport),
      rows.find((r) => r.venue_id === c.venueId && r.sport === null),
      rows.find((r) => r.business_id !== null && r.business_id === business.get(c.venueId)),
    ].filter((r): r is Row => r !== undefined);
    out.set(c.id, resolvePolicy(levels.map(toSettings), c.sport));
  }
  return out;
}

export async function policyFor(court: { id: number; venueId: number; sport: Sport }): Promise<BookingPolicy> {
  return (await policiesFor([court])).get(court.id)!;
}

/** What a sport would get at a venue with no court of its own settings: for search across sports. */
export async function sportPolicyAt(venueId: number, sport: Sport): Promise<BookingPolicy> {
  const { rows, business } = await rowsFor([venueId]);
  const levels = [
    rows.find((r) => r.venue_id === venueId && r.sport === sport),
    rows.find((r) => r.venue_id === venueId && r.sport === null),
    rows.find((r) => r.business_id !== null && r.business_id === business.get(venueId)),
  ].filter((r): r is Row => r !== undefined);
  return resolvePolicy(levels.map(toSettings), sport);
}

/** One level's own settings, as stored (unset ones null), for the editor. */
export async function policySettings(scope: PolicyScope): Promise<PolicySettings> {
  const row = (await getDb().prepare(`SELECT * FROM booking_policies WHERE ${whereOf(scope).sql}`).get(...whereOf(scope).params)) as Row | undefined;
  return row ? toSettings(row) : {};
}

/** Every level stored at a venue, for the editor: its own, each sport's, each court's, and its business's. */
export async function venuePolicyLevels(venueId: number): Promise<{
  venue: PolicySettings;
  business: PolicySettings | null;
  sports: Partial<Record<Sport, PolicySettings>>;
  courts: Record<number, PolicySettings>;
  /** Each court's activities' own, by court and then activity. */
  products: Record<number, Record<string, PolicySettings>>;
}> {
  const { rows, business } = await rowsFor([venueId]);
  const b = business.get(venueId) ?? null;
  const sports: Partial<Record<Sport, PolicySettings>> = {};
  const courts: Record<number, PolicySettings> = {};
  const products: Record<number, Record<string, PolicySettings>> = {};
  for (const r of rows) {
    if (r.venue_id === venueId && r.sport) sports[r.sport as Sport] = toSettings(r);
    if (r.court_id !== null && r.sport === null) courts[r.court_id] = toSettings(r);
    if (r.court_id !== null && r.sport !== null) (products[r.court_id] ??= {})[r.sport] = toSettings(r);
  }
  const own = rows.find((r) => r.venue_id === venueId && r.sport === null);
  const biz = b === null ? undefined : rows.find((r) => r.business_id === b);
  return { venue: own ? toSettings(own) : {}, business: biz ? toSettings(biz) : b === null ? null : {}, sports, courts, products };
}

function whereOf(scope: PolicyScope): { sql: string; params: unknown[] } {
  if ("court" in scope && "sport" in scope) return { sql: "court_id = ? AND sport = ?", params: [scope.court, scope.sport] };
  if ("court" in scope) return { sql: "court_id = ? AND sport IS NULL", params: [scope.court] };
  if ("sport" in scope) return { sql: "venue_id = ? AND sport = ?", params: [scope.venue, scope.sport] };
  if ("venue" in scope) return { sql: "venue_id = ? AND sport IS NULL", params: [scope.venue] };
  return { sql: "business_id = ?", params: [scope.business] };
}

const isWhole = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const isAmount = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && Math.round(v * 100) === v * 100;

/**
 * A level's settings as given, checked. Anything absent or null is
 * inherited. Returns the settings to store, or what is wrong.
 */
export function validateSettings(input: Record<string, unknown>): { ok: true; settings: PolicySettings } | { ok: false; error: string } {
  const s: PolicySettings = {};
  const set = <K extends keyof PolicySettings>(key: K, value: PolicySettings[K]) => {
    s[key] = value;
  };
  for (const key of SETTING_KEYS) {
    const v = input[key];
    if (v === undefined || v === null || v === "") continue;
    switch (key) {
      case "startEvery":
      case "lengthStep":
        if (!isWhole(v, 1, DAY_MINUTES)) return { ok: false, error: "Steps are whole minutes, 1 to 1440." };
        set(key, v as number);
        break;
      case "startOffset":
        if (!isWhole(v, 0, DAY_MINUTES - 1)) return { ok: false, error: "The first start is 0 to 1439 minutes past midnight." };
        set(key, v as number);
        break;
      case "minLength":
      case "maxLength":
      case "defaultLength":
      case "billStep":
      case "minBilled":
        if (!isWhole(v, 1, MAX_COURT_HOURS * 60)) return { ok: false, error: `Lengths are whole minutes, up to ${MAX_COURT_HOURS} hours.` };
        set(key, v as number);
        break;
      case "bufferBefore":
      case "bufferAfter":
      case "operationalBefore":
      case "operationalAfter":
        if (!isWhole(v, 0, 240)) return { ok: false, error: "Buffers are 0 to 240 minutes." };
        set(key, v as number);
        break;
      case "noticeMinutes":
        if (!isWhole(v, 0, 7 * DAY_MINUTES)) return { ok: false, error: "Notice is 0 minutes to a week." };
        set(key, v as number);
        break;
      case "startTimes":
        if (!Array.isArray(v) || v.length === 0 || v.length > 96 || !v.every((n) => isWhole(n, 0, LATEST_MINUTE - 1)))
          return { ok: false, error: "List start times as minutes of the day." };
        set(key, [...new Set(v as number[])].sort((a, b) => a - b));
        break;
      case "lengths":
        if (!Array.isArray(v) || v.length === 0 || v.length > 24 || !v.every((n) => isWhole(n, 1, MAX_COURT_HOURS * 60)))
          return { ok: false, error: "List lengths as whole minutes." };
        set(key, [...new Set(v as number[])].sort((a, b) => a - b));
        break;
      case "weekHours": {
        const week = parseWeekHours(v);
        if (!week) return { ok: false, error: "Give the court's hours for seven days, Sunday first." };
        for (const d of week)
          if (d && d !== "closed" && (!isWhole(d.open, 0, DAY_MINUTES - 1) || !isWhole(d.close, 1, LATEST_MINUTE) || d.close <= d.open))
            return { ok: false, error: "Each day's hours open before they close, by 4 AM the next morning." };
        set(key, week);
        break;
      }
      case "turnover":
        if (!TURNOVERS.includes(v as Turnover)) return { ok: false, error: "turnover is place, unit or facility." };
        set(key, v as Turnover);
        break;
      case "rateMode":
        if (v !== "split" && v !== "start") return { ok: false, error: "Price each part at its own rate, or all at the rate when it starts." };
        set(key, v);
        break;
      case "signOff":
      case "certification":
        if (typeof v !== "boolean") return { ok: false, error: "A sign-off is needed, or not." };
        set(key, v);
        break;
      case "separatePlaces":
        if (typeof v !== "boolean") return { ok: false, error: "One person can be taken off a booking here, or not." };
        set(key, v);
        break;
      case "minCharge":
      case "setupFee":
      case "cleanupFee":
        if (!isAmount(v)) return { ok: false, error: "Amounts are positive, to the cent." };
        set(key, v as number);
        break;
      case "fixedPrices": {
        if (!Array.isArray(v) || v.length > 24) return { ok: false, error: "List prices by length." };
        const list: FixedPrice[] = [];
        for (const f of v as Record<string, unknown>[]) {
          if (!f || !isWhole(f.minutes, 1, MAX_COURT_HOURS * 60) || !isAmount(f.price) || (f.peakPrice !== null && f.peakPrice !== undefined && !isAmount(f.peakPrice)))
            return { ok: false, error: "Each fixed price is a length in minutes and an amount." };
          list.push({ minutes: f.minutes as number, price: f.price as number, peakPrice: (f.peakPrice as number | null | undefined) ?? null });
        }
        if (new Set(list.map((f) => f.minutes)).size !== list.length) return { ok: false, error: "One price per length." };
        set(key, list.sort((a, b) => a.minutes - b.minutes));
        break;
      }
    }
  }
  if (s.minLength && s.maxLength && s.maxLength < s.minLength) return { ok: false, error: "The longest booking is shorter than the shortest." };
  return { ok: true, settings: s };
}

/** Store one level's settings; with none left set, the level goes and everything is inherited. */
export async function savePolicy(scope: PolicyScope, settings: PolicySettings): Promise<void> {
  const db = getDb();
  const where = whereOf(scope);
  const any = SETTING_KEYS.some((k) => settings[k] !== undefined && settings[k] !== null);
  if (!any) {
    await db.prepare(`DELETE FROM booking_policies WHERE ${where.sql}`).run(...where.params);
    return;
  }
  const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
  const values = [
    settings.startEvery ?? null,
    settings.startOffset ?? null,
    json(settings.startTimes),
    settings.lengthStep ?? null,
    settings.minLength ?? null,
    settings.maxLength ?? null,
    json(settings.lengths),
    settings.defaultLength ?? null,
    settings.bufferBefore ?? null,
    settings.bufferAfter ?? null,
    settings.operationalBefore ?? null,
    settings.operationalAfter ?? null,
    settings.turnover ?? null,
    json(settings.weekHours),
    settings.noticeMinutes ?? null,
    settings.rateMode ?? null,
    settings.billStep ?? null,
    settings.minBilled ?? null,
    settings.minCharge ?? null,
    json(settings.fixedPrices),
    settings.setupFee ?? null,
    settings.cleanupFee ?? null,
    settings.signOff ?? null,
    settings.certification ?? null,
    settings.separatePlaces ?? null,
  ];
  const cols = `start_every = ?, start_offset = ?, start_times = ?, length_step = ?, min_length = ?, max_length = ?, lengths = ?,
    default_length = ?, buffer_before = ?, buffer_after = ?, operational_before = ?, operational_after = ?, turnover = ?, week_hours = ?,
    notice_minutes = ?, rate_mode = ?, bill_step = ?,
    min_billed = ?, min_charge = ?, fixed_prices = ?, setup_fee = ?, cleanup_fee = ?, sign_off = ?, needs_certification = ?, separate_places = ?, updated_at = datetime('now')`;
  const done = await db.prepare(`UPDATE booking_policies SET ${cols} WHERE ${where.sql}`).run(...values, ...where.params);
  if (done.changes > 0) return;
  const scopeCols =
    "court" in scope
      ? { business: null, venue: null, sport: "sport" in scope ? scope.sport : null, court: scope.court }
      : "sport" in scope
        ? { business: null, venue: scope.venue, sport: scope.sport, court: null }
        : "venue" in scope
          ? { business: null, venue: scope.venue, sport: null, court: null }
          : { business: scope.business, venue: null, sport: null, court: null };
  await db
    .prepare(
      `INSERT INTO booking_policies (business_id, venue_id, sport, court_id, start_every, start_offset, start_times, length_step,
         min_length, max_length, lengths, default_length, buffer_before, buffer_after, operational_before, operational_after,
         turnover, week_hours, notice_minutes, rate_mode, bill_step, min_billed, min_charge, fixed_prices, setup_fee, cleanup_fee,
         sign_off, needs_certification, separate_places)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(scopeCols.business, scopeCols.venue, scopeCols.sport, scopeCols.court, ...values);
}

/** Change some of a level's settings, keeping the rest; a null unsets one (inherit). */
export async function updatePolicy(
  scope: PolicyScope,
  changes: Record<string, unknown>
): Promise<{ ok: true; settings: PolicySettings } | { ok: false; error: string }> {
  if ("sport" in scope && !(await isActivity(scope.sport))) return { ok: false, error: "Unknown sport." };
  const checked = validateSettings(changes);
  if (!checked.ok) return checked;
  const current = await policySettings(scope);
  const next: PolicySettings = { ...current };
  for (const key of SETTING_KEYS) {
    if (!(key in changes)) continue;
    const v = checked.settings[key];
    (next as Record<string, unknown>)[key] = v === undefined ? null : v;
  }
  if (next.minLength && next.maxLength && next.maxLength < next.minLength)
    return { ok: false, error: "The longest booking is shorter than the shortest." };
  await savePolicy(scope, next);
  return { ok: true, settings: next };
}

