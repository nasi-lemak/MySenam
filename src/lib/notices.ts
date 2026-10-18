import { getDb } from "./db";
import { addDays, isValidDateString, todayISO } from "./time";

/**
 * Notices: a line of text, for some days, with a link to a page here.
 *
 * A venue's staff put up their own — "Raya Open, 12–14 Nov: entries close
 * Friday" — and it shows on the venue's own page and its storefront. It
 * never shows on the marketplace's front page or in search, and nothing a
 * venue does or pays moves it up a list: every venue is found the same way.
 *
 * The platform owner has the one notice that shows on the marketplace's
 * front page, for what concerns everybody — a government programme, a
 * large collaboration — and it is not for sale.
 *
 * Text only, short, and a link only to a page on this site, so a notice
 * cannot send a customer somewhere that pretends to be the venue.
 */

export const MAX_TEXT = 160;
export const MAX_DAYS = 60;

export interface Notice {
  id: number;
  venueId: number | null;
  text: string;
  link: string | null;
  startsOn: string;
  endsOn: string;
}

interface NoticeRow {
  id: number;
  venue_id: number | null;
  text: string;
  link: string | null;
  starts_on: string;
  ends_on: string;
}

const toNotice = (r: NoticeRow): Notice => ({
  id: r.id,
  venueId: r.venue_id,
  text: r.text,
  link: r.link,
  startsOn: r.starts_on,
  endsOn: r.ends_on,
});

/** A path on this site, tidied, or null if it is not one. */
export function internalLink(raw: string | null | undefined): string | null {
  const link = raw?.trim() ?? "";
  if (link === "") return null;
  if (!/^\/(?!\/)[A-Za-z0-9/_\-.?=&%]*$/.test(link) || link.includes("\\") || link.length > 200) return null;
  return link;
}

export type NoticeResult = { ok: true; value: Notice } | { ok: false; error: string };

export async function createNotice(
  input: { venueId: number | null; text: string; link?: string | null; startsOn: string; endsOn: string },
  adminId: number
): Promise<NoticeResult> {
  const text = input.text.replace(/\s+/g, " ").trim();
  if (text.length < 3 || text.length > MAX_TEXT) return { ok: false, error: `Say it in ${MAX_TEXT} characters or fewer.` };
  const link = input.link?.trim() ? internalLink(input.link) : null;
  if (input.link?.trim() && !link) return { ok: false, error: "A link goes to a page on this site, like /tournaments/12." };
  const today = todayISO();
  if (!isValidDateString(input.startsOn) || !isValidDateString(input.endsOn) || input.endsOn < input.startsOn)
    return { ok: false, error: "Give the first and last day." };
  if (input.endsOn < today) return { ok: false, error: "That is over already." };
  if (input.endsOn > addDays(input.startsOn, MAX_DAYS - 1)) return { ok: false, error: `${MAX_DAYS} days at most; put it up again after.` };
  const info = await getDb()
    .prepare("INSERT INTO notices (venue_id, text, link, starts_on, ends_on, created_by) VALUES (?, ?, ?, ?, ?, ?)")
    .run(input.venueId, text, link, input.startsOn, input.endsOn, adminId);
  return { ok: true, value: (await noticeById(info.lastInsertRowid as number))! };
}

export async function noticeById(id: number): Promise<Notice | null> {
  const row = (await getDb().prepare("SELECT * FROM notices WHERE id = ?").get(id)) as NoticeRow | undefined;
  return row ? toNotice(row) : null;
}

export async function deleteNotice(id: number): Promise<void> {
  await getDb().prepare("DELETE FROM notices WHERE id = ?").run(id);
}

/** A venue's notices still to come or showing, or the site-wide ones, for staff. */
export async function listNotices(venueId: number | null): Promise<Notice[]> {
  const rows = (await getDb()
    .prepare(`SELECT * FROM notices WHERE ${venueId === null ? "venue_id IS NULL" : "venue_id = ?"} AND ends_on >= ? ORDER BY starts_on, id`)
    .all(...(venueId === null ? [] : [venueId]), todayISO())) as NoticeRow[];
  return rows.map(toNotice);
}

/** What shows today: the newest notice of each of these venues. */
export async function showingFor(venueIds: number[]): Promise<Notice[]> {
  if (venueIds.length === 0) return [];
  const today = todayISO();
  const rows = (await getDb()
    .prepare(
      `SELECT DISTINCT ON (venue_id) * FROM notices
        WHERE venue_id IN (${venueIds.map(() => "?").join(",")}) AND starts_on <= ? AND ends_on >= ?
        ORDER BY venue_id, id DESC`
    )
    .all(...venueIds, today, today)) as NoticeRow[];
  return rows.map(toNotice);
}

/** The platform's notice showing today, if any. */
export async function siteNotice(): Promise<Notice | null> {
  const today = todayISO();
  const row = (await getDb()
    .prepare("SELECT * FROM notices WHERE venue_id IS NULL AND starts_on <= ? AND ends_on >= ? ORDER BY id DESC LIMIT 1")
    .get(today, today)) as NoticeRow | undefined;
  return row ? toNotice(row) : null;
}
