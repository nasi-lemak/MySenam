import { getDb } from "./db";
import { inSameBusiness } from "./branches";
import { isLocale, translator, type Locale, type Phrase } from "./i18n";
import { linkIn } from "./link-locale";
import { accountLocale, baseUrl, enqueue } from "./outbox";
import { siteName } from "./site";
import { todayISO } from "./time";

/**
 * Telling a venue's customers that it has been taken off (ADR 0063).
 *
 * A venue suspended by the owner, or held for an invoice that is long overdue, is out of customers' sight (lib/listing.ts). Until now
 * only its staff were told. A customer who has an upcoming booking, class or lesson there, a pass or membership, or stored credit
 * hears once, by email, in their own language: what has happened, that it was not their doing, that bookings stand and can be
 * cancelled and refunded as usual, that passes, memberships and credit wait, and whom to ask.
 *
 * - **Once per suspension.** Each email is queued under a key of the venue, the stamp of the suspension (`suspended_at`) and the address,
 *   so telling again queues nothing more; the venue then records the stamp it has told for (`venues.suspension_told_for`), and the
 *   scheduler's sweep (`applyPaymentHolds` calls this) tells any suspension that was not told because a stop came between the two. A
 *   venue lifted and suspended again is a new suspension and is told again.
 * - **Urgent news** (`venue_suspension_notice`, lib/outbox.ts): not held to the day's limit per recipient, and email only.
 * - **Who.** An account is written to at the address it signed up with, in the language it last used; a guest with an upcoming booking at
 *   the address on the booking, in the language it was made in. An account that said it is under 18 is not written to (as the venue's
 *   other notices to account holders), and a pass or membership sold at the counter to nobody with an account has no address here:
 *   its venue tells them.
 * - **Nothing is promised that is not built:** passes and memberships are not extended for the time off (an owner's decision, recorded in
 *   docs/product/marketplace.md); the notice says they wait, and to ask the venue.
 */

type Kind = "bookings" | "pass" | "membership" | "credit";

interface Stake {
  userId: number | null;
  email: string | null;
  locale: string | null;
  kind: Kind;
}

/** Everyone who holds something at this venue that a suspension leaves waiting. */
async function stakesAt(venueId: number): Promise<Stake[]> {
  const today = todayISO();
  return (await getDb()
    .prepare(
      `SELECT user_id AS "userId", email, locale, kind FROM (
         SELECT b.user_id, b.email, b.locale, 'bookings' AS kind
           FROM bookings b JOIN courts c ON c.id = b.court_id
          WHERE c.venue_id = ? AND b.status = 'confirmed' AND b.date >= ? AND NOT b.test AND b.demo = 0
         UNION ALL
         SELECT p.user_id, NULL, NULL, 'pass' FROM passes p
          WHERE p.venue_id = ? AND p.status = 'active' AND p.user_id IS NOT NULL AND p.expires_on >= ?
            AND p.entries + COALESCE((SELECT SUM(e.delta) FROM pass_entries e WHERE e.pass_id = p.id), 0) > 0
         UNION ALL
         SELECT m.user_id, NULL, NULL, 'membership' FROM memberships m
          WHERE m.venue_id = ? AND m.status = 'active' AND m.user_id IS NOT NULL AND m.expires_on >= ?
         UNION ALL
         SELECT w.user_id, NULL, NULL, 'credit' FROM wallet_entries w
          WHERE ${inSameBusiness("w.venue_id")} GROUP BY w.user_id HAVING SUM(w.amount) > 0
       ) s`
    )
    .all(venueId, today, venueId, today, venueId, today, venueId)) as Stake[];
}

/** A notice is not worth sending a month on. */
const EXPIRES_MINUTES = 30 * 24 * 60;

/**
 * Tell the customers of these venues (every suspended venue not yet told for, when none are named) once. Answers how many people were
 * written to (including any already written to under the same suspension, which queues nothing more). What could not be written is
 * left for the next run.
 */
export async function tellSuspendedVenues(venueIds?: number[]): Promise<number> {
  if (venueIds && venueIds.length === 0) return 0;
  const db = getDb();
  const venues = (await db
    .prepare(
      `SELECT id, name, phone, suspended_at AS "suspendedAt" FROM venues
        WHERE suspended_at IS NOT NULL AND suspension_told_for IS DISTINCT FROM suspended_at${venueIds ? ` AND id IN (${venueIds.map(() => "?").join(",")})` : ""}
        ORDER BY id`
    )
    .all(...(venueIds ?? []))) as { id: number; name: string; phone: string; suspendedAt: string }[];
  let people = 0;
  for (const venue of venues) {
    const stakes = await stakesAt(venue.id);
    const { declaredAdult } = await import("./player-profiles");
    const accounts = new Map<number, { email: string; locale: Locale } | null>();
    for (const id of new Set(stakes.filter((s) => s.userId !== null).map((s) => s.userId as number))) {
      const user = (await db.prepare("SELECT email FROM users WHERE id = ?").get(id)) as { email: string | null } | undefined;
      accounts.set(id, user?.email && (await declaredAdult(id)) !== false ? { email: user.email, locale: await accountLocale(id) } : null);
    }
    // One notice per address: an account's own address and language win over a booking's.
    const readers = new Map<string, { account: boolean; email: string; locale: Locale; has: Set<Kind> }>();
    for (const s of stakes) {
      const account = s.userId !== null ? (accounts.get(s.userId) ?? null) : null;
      // An account that is under 18, or has no address, is not written to; nor by the address on a booking made under it.
      if (s.userId !== null && account === null) continue;
      const email = (account?.email ?? s.email ?? "").trim();
      if (!email) continue;
      const key = email.toLowerCase();
      const reader = readers.get(key) ?? { account: false, email, locale: "en" as Locale, has: new Set<Kind>() };
      if (account) Object.assign(reader, { account: true, email, locale: account.locale });
      else if (!reader.account && isLocale(s.locale)) reader.locale = s.locale;
      reader.has.add(s.kind);
      readers.set(key, reader);
    }
    for (const [key, reader] of readers) {
      const t = translator(reader.locale, siteName());
      const separator = reader.locale === "zh" ? "、" : ", ";
      const what = (["bookings", "pass", "membership", "credit"] as const)
        .filter((k) => reader.has.has(k))
        .map((k) => t(`fx11.has.${k}` as Phrase))
        .join(separator);
      const link = linkIn(`${baseUrl()}${reader.account ? "/account" : "/my-booking"}`, reader.locale);
      const text = `${t("fx11.mail.body", { venue: venue.name, what, phone: venue.phone, link })}\n\n${siteName()}`;
      await enqueue({
        venueId: venue.id,
        kind: "venue_suspension_notice",
        channel: "email",
        recipient: reader.email,
        locale: reader.locale,
        subject: "msg.programmeSubject",
        body: "msg.programmeBody",
        vars: { subject: t("fx11.mail.subject", { venue: venue.name }), text },
        dedupeKey: `venue-suspended:${venue.id}:${venue.suspendedAt}:${key}`,
        expiresMinutes: EXPIRES_MINUTES,
      });
      people++;
    }
    await db.prepare("UPDATE venues SET suspension_told_for = suspended_at WHERE id = ? AND suspended_at = ?").run(venue.id, venue.suspendedAt);
  }
  return people;
}
