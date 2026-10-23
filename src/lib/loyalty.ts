import { getDb } from "./db";
import { isLocale, type Locale } from "./i18n";
import { enqueue } from "./outbox";
import { siteName } from "./site";
import { issuePass } from "./store";
import { venueBaseUrl } from "./storefront";
import { addDays, todayISO } from "./time";

/**
 * A free hour for regulars, the friendly way to reward coming back: every
 * `loyalty_every` paid hours somebody plays at a venue earns them one hour
 * free, given as a one-entry pass at that venue (90 days to use it) and
 * told by email. Off unless the venue turns it on.
 *
 * What counts is an hour that went ahead and was paid for: a court booking
 * (not a class), not cancelled, not a no-show, dated before today, at a price
 * above nothing, and not itself paid with a free hour. Counted by phone
 * number however typed, worked out once a day by the scheduler.
 *
 * Rather than lowering prices when it is busy and raising them when it is
 * quiet, which teaches regulars to wait and feels like a trick, this gives
 * something back to the people who keep a venue going.
 */

export const LOYALTY_MIN = 5;
export const LOYALTY_MAX = 50;
export const REWARD_DAYS = 90;

export async function loyaltyEvery(venueId: number): Promise<number | null> {
  const r = (await getDb().prepare("SELECT loyalty_every FROM venues WHERE id = ?").get(venueId)) as
    | { loyalty_every: number | null }
    | undefined;
  return r?.loyalty_every ?? null;
}

export async function setLoyalty(venueId: number, every: unknown): Promise<{ ok: true; every: number | null } | { ok: false; error: string }> {
  if (every !== null && (!Number.isInteger(every) || (every as number) < LOYALTY_MIN || (every as number) > LOYALTY_MAX))
    return { ok: false, error: `One free hour for every ${LOYALTY_MIN} to ${LOYALTY_MAX} hours played, or off.` };
  const done = await getDb().prepare("UPDATE venues SET loyalty_every = ? WHERE id = ?").run(every, venueId);
  if (done.changes !== 1) return { ok: false, error: "Venue not found." };
  return { ok: true, every: every as number | null };
}

/** Played, paid hours at this venue by this number, and free hours given so far. */
export async function loyaltyStanding(venueId: number, phoneKey: string): Promise<{ hours: number; rewards: number }> {
  const db = getDb();
  const played = (await db.prepare(`${PLAYED} AND b.phone_key = ?`).get(venueId, todayISO(), phoneKey)) as { hours: number | string | null } | undefined;
  const given = (await db.prepare("SELECT COUNT(*) AS n FROM loyalty_rewards WHERE venue_id = ? AND phone_key = ?").get(venueId, phoneKey)) as {
    n: number | string;
  };
  return { hours: Number(played?.hours ?? 0), rewards: Number(given.n) };
}

const PLAYED = `
  SELECT COALESCE((SUM(b.end_min - b.start_min) / 60.0), 0)::float AS hours
    FROM bookings b JOIN courts c ON c.id = b.court_id
   WHERE c.venue_id = ? AND b.date < ? AND b.status = 'confirmed' AND b.no_show = 0 AND b.demo = 0
     AND b.class_id IS NULL AND b.payment_status = 'paid' AND b.total_price > 0
     AND NOT EXISTS (SELECT 1 FROM pass_entries pe JOIN loyalty_rewards lr ON lr.pass_id = pe.pass_id WHERE pe.booking_id = b.id)`;

/** Give every free hour now earned, at every venue that gives them. How many were given. */
export async function grantLoyalty(): Promise<number> {
  const db = getDb();
  const venues = (await db.prepare("SELECT id, name, loyalty_every FROM venues WHERE loyalty_every IS NOT NULL").all()) as {
    id: number;
    name: string;
    loyalty_every: number;
  }[];
  let given = 0;
  for (const v of venues) {
    const rows = (await db
      .prepare(
        `SELECT b.phone_key, (SUM(b.end_min - b.start_min) / 60.0)::float AS hours,
                (SELECT COUNT(*) FROM loyalty_rewards lr WHERE lr.venue_id = c.venue_id AND lr.phone_key = b.phone_key) AS rewards
           FROM bookings b JOIN courts c ON c.id = b.court_id
          WHERE c.venue_id = ? AND b.date < ? AND b.status = 'confirmed' AND b.no_show = 0 AND b.demo = 0
            AND b.class_id IS NULL AND b.payment_status = 'paid' AND b.total_price > 0 AND b.phone_key <> ''
            AND NOT EXISTS (SELECT 1 FROM pass_entries pe JOIN loyalty_rewards lr ON lr.pass_id = pe.pass_id WHERE pe.booking_id = b.id)
          GROUP BY c.venue_id, b.phone_key
         HAVING (SUM(b.end_min - b.start_min) / 60.0) >= ?`
      )
      .all(v.id, todayISO(), v.loyalty_every)) as { phone_key: string; hours: number; rewards: number | string }[];
    for (const r of rows) {
      const due = Math.floor(Number(r.hours) / v.loyalty_every) - Number(r.rewards);
      if (due <= 0) continue;
      // Whose it is: the latest booking from this number here, for the name, account and address.
      const who = (await db
        .prepare(
          `SELECT b.name, b.phone, b.email, b.user_id, b.locale FROM bookings b JOIN courts c ON c.id = b.court_id
            WHERE c.venue_id = ? AND b.phone_key = ? ORDER BY b.date DESC, b.id DESC LIMIT 1`
        )
        .get(v.id, r.phone_key)) as { name: string; phone: string; email: string | null; user_id: number | null; locale: string | null };
      for (let i = 0; i < due; i++) {
        const pass = await issuePass({
          venueId: v.id,
          name: "Loyalty: one free hour",
          entries: 1,
          price: 0,
          holderName: who.name,
          holderPhone: who.phone,
          expiresOn: addDays(todayISO(), REWARD_DAYS),
          adminId: null,
          ...(who.user_id ? { userId: who.user_id } : {}),
        });
        if (!pass.ok) break;
        await db.prepare("INSERT INTO loyalty_rewards (venue_id, phone_key, pass_id) VALUES (?, ?, ?)").run(v.id, r.phone_key, pass.pass.id);
        given++;
        if (who.email) {
          const locale: Locale = who.locale && isLocale(who.locale) ? who.locale : "en";
          await enqueue({
            venueId: v.id,
            kind: "loyalty_reward",
            channel: "email",
            recipient: who.email,
            locale,
            subject: "msg.loyaltySubject",
            body: "msg.loyalty",
            dedupeKey: `loyalty:${pass.pass.id}`,
            vars: {
              name: who.name.trim().split(/\s+/)[0],
              venue: v.name,
              every: v.loyalty_every,
              code: pass.pass.code,
              until: pass.pass.expiresOn,
              link: `${await venueBaseUrl(v.id)}/venue/${v.id}`,
              site: siteName(),
            },
          });
        }
      }
    }
  }
  return given;
}

/** Once a day is enough: hours are counted after the day they were played. */
export async function grantLoyaltyIfDue(): Promise<number> {
  const db = getDb();
  const today = todayISO();
  const last = (await db.prepare("SELECT value FROM settings WHERE key = 'loyalty_last_run'").get()) as { value: string } | undefined;
  if (last?.value === today) return 0;
  await db
    .prepare("INSERT INTO settings (key, value) VALUES ('loyalty_last_run', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(today);
  return grantLoyalty();
}
