import { accessRefusal, accountPhone, numberAccessRefusal } from "./access";
import { policiesFor, policyFor } from "./booking-policy";
import type { BookingPolicy } from "./booking-rules";
import { inSameBusiness } from "./branches";
import { lockCourts } from "./claims";
import { sellAtCounter } from "./counter-sales";
import { courtOffers, needsOf } from "./court-activities";
import { getDb, withTransaction } from "./db";
import { refuse } from "./entitlements";
import { isBlocked, phoneBlocked, venueNotOpen } from "./limits";
import { venueIsOpen } from "./listing";
import { suspendedOn } from "./membership-suspensions";
import { selectionAtVenue } from "./participant-bookings";
import { phoneKey } from "./phone";
import { signOffHolds } from "./sign-offs";
import { courtZone, getCourt, memberNumberTrusted } from "./store";
import { todayISO } from "./time";
import { busyness, COUNTER_METHODS, type Busyness, type Court, type CounterMethod, type Refusal } from "./types";
import { signWaiver, waiverSigned, waiverSignedFor } from "./waivers";
import { activityName } from "./activity-registry";
import type { ErrorCode } from "./i18n";

/**
 * Entry with no set time (docs/features/venue-operations.md#entry-with-no-set-time;
 * migration 0266): a climbing wall, a bouldering room or a gym floor that lets
 * people in as they come, rather than only for a booked time.
 *
 * Nothing here is a second booking engine. A resource takes entries where its
 * booking rules say so (`entryMode`, lib/booking-rules.ts, set at any level and
 * off for every resource until the venue turns it on), and only a resource
 * with places does. Bookings, classes, blocks and outages are made and claimed
 * as ever; the database still refuses an overbooking of them. An entry is a
 * row per person (`entries`), open from admission until checked out or until
 * the longest stay passes (`stay_until`), after which it simply stops counting:
 * no job has to close it for the count to be right (the scheduler tidies it
 * later, `closeEndedEntries`).
 *
 * **Capacity.** A person is let in only while open entries, and the places held
 * by claims overlapping now (bookings, classes, blocks, outages, offers), are
 * fewer than the resource's places: booked sessions keep their places, and an
 * entry never takes one a booking holds. Decided under the resource's lock
 * (the same advisory lock claims on it take, then its row), so two admissions
 * at once, or an admission and a booking being claimed, never both take the
 * last place.
 *
 * **What admits.** A membership whose plan admits with no booking
 * (`membership_plans.admits_entry`, for any resource or one activity); a pass
 * (each admission spends one entry, by the pass's scope: one person's pass
 * only its person, a pass for a booking or each place anybody its holder's
 * number brings); a day pass (one entry, then the whole of that day); or, at
 * the desk, a walk-in entry at the resource's price, sold as a counter sale
 * (lib/counter-sales.ts) with its receipt.
 *
 * **What every admission asks**, as a booking asks it for that person: the
 * venue is open; the number is not refused; who the venue is for (members
 * only, a private list); the venue's waiver (agreed for themself, or for a
 * participant by their guardian); the activity's sign-off or certification;
 * a participant is let in as themself, only under a live guardian's number.
 *
 * **Who admits.** The desk, always. The customer themself, by the resource's
 * check-in code, only where its rules allow self check-in, only for their own
 * entry, and only on a membership, pass or day pass (nobody takes money there).
 */

export type EntryAdmit = "membership" | "pass" | "day_pass" | "walk_in";
export type EntryChannel = "desk" | "self";

/** A resource taking entries, as its rules resolve today. */
export interface EntryResource {
  courtId: number;
  venueId: number;
  name: string;
  sport: string;
  capacity: number;
  /** What a walk-in entry costs at the counter; null: none sold. */
  price: number | null;
  maxStay: number;
  selfCheckIn: boolean;
}

/** Somebody to let in: the customer themself by their number, or a participant under their guardian's. */
export interface EntryPerson {
  participantId: number | null;
  name: string;
  /** The customer's own number, or the guardian's a participant comes in under. */
  phone: string;
  userId?: number | null;
}

/** How full a resource is now. */
export interface EntryCount {
  courtId: number;
  capacity: number;
  /** People in on entries now. */
  entries: number;
  /** Places held now by bookings, classes, blocks and outages. */
  held: number;
  free: number;
  level: Busyness;
}

/** One person in now, for the desk (never shown to customers). */
export interface OpenEntry {
  id: number;
  courtId: number;
  courtName: string;
  name: string;
  participantId: number | null;
  admittedBy: EntryAdmit;
  channel: EntryChannel;
  admittedAt: string;
  stayUntil: string;
}

/** What could let a person in here now. */
export interface EntryOptions {
  membership: { id: number; code: string; plan: string } | null;
  passes: { id: number; code: string; name: string; remaining: number; dayPass: boolean; usedToday: boolean; expiresOn: string }[];
  walkIn: number | null;
  alreadyIn: boolean;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

/** Does this court take entries under these rules? Only a resource with places, and not a room run as classes only. */
function takesEntries(court: Pick<Court, "capacity" | "classesOnly">, policy: Pick<BookingPolicy, "entryMode">): boolean {
  return policy.entryMode && court.capacity > 1 && !court.classesOnly;
}

const toResource = (c: Court, p: BookingPolicy): EntryResource => ({
  courtId: c.id,
  venueId: c.venueId,
  name: c.name,
  sport: c.sport,
  capacity: c.capacity,
  price: p.entryPrice,
  maxStay: p.entryMaxStay,
  selfCheckIn: p.entrySelfCheckIn,
});

/** The venue's resources taking entries, in their order. */
export async function entryResources(venueId: number): Promise<EntryResource[]> {
  const courts = (await getDb().prepare("SELECT id FROM courts WHERE venue_id = ? ORDER BY id").all(venueId)) as { id: number }[];
  const full = (await Promise.all(courts.map((c) => getCourt(c.id)))).filter((c): c is Court => c !== null);
  const policies = await policiesFor(full);
  return full.filter((c) => takesEntries(c, policies.get(c.id)!)).map((c) => toResource(c, policies.get(c.id)!));
}

/** One resource, if it takes entries. */
export async function entryResource(courtId: number): Promise<EntryResource | null> {
  const court = await getCourt(courtId);
  if (!court) return null;
  const policy = await policyFor(court);
  return takesEntries(court, policy) ? toResource(court, policy) : null;
}

/** SQL: an entry `e` counting at `?` (a moment): admitted, not checked out, and its longest stay not past. */
const OPEN = "e.checked_out_at IS NULL AND e.admitted_at <= ?::timestamptz AND e.stay_until > ?::timestamptz";

/** How full a resource taking entries is at `at` (now): entries, and places claims overlapping it hold. */
export async function entryCount(resource: Pick<EntryResource, "courtId" | "capacity">, at: Date = new Date()): Promise<EntryCount> {
  const when = at.toISOString();
  const db = getDb();
  const { n } = (await db.prepare(`SELECT COUNT(*)::int AS n FROM entries e WHERE e.court_id = ? AND ${OPEN}`).get(resource.courtId, when, when)) as { n: number };
  const { held } = (await db
    .prepare(
      `SELECT COALESCE(SUM(places), 0)::int AS held FROM claims
        WHERE court_id = ? AND active AND places IS NOT NULL AND during @> ?::timestamptz AND (expires_at IS NULL OR expires_at > ?::timestamptz)`
    )
    .get(resource.courtId, when, when)) as { held: number };
  const taken = Number(n) + Number(held);
  return {
    courtId: resource.courtId,
    capacity: resource.capacity,
    entries: Number(n),
    held: Number(held),
    free: Math.max(0, resource.capacity - taken),
    level: busyness(taken, resource.capacity),
  };
}

/** Everybody in now at a venue, for its desk. */
export async function openEntries(venueId: number, at: Date = new Date()): Promise<OpenEntry[]> {
  const when = at.toISOString();
  const rows = (await getDb()
    .prepare(
      `SELECT e.id, e.court_id, c.name AS court_name, e.name, e.participant_id, e.admitted_by, e.channel, e.admitted_at, e.stay_until
         FROM entries e JOIN courts c ON c.id = e.court_id
        WHERE e.venue_id = ? AND ${OPEN} ORDER BY e.admitted_at, e.id`
    )
    .all(venueId, when, when)) as {
    id: number;
    court_id: number;
    court_name: string;
    name: string;
    participant_id: number | null;
    admitted_by: EntryAdmit;
    channel: EntryChannel;
    admitted_at: unknown;
    stay_until: unknown;
  }[];
  return rows.map((r) => ({
    id: r.id,
    courtId: r.court_id,
    courtName: r.court_name,
    name: r.name,
    participantId: r.participant_id,
    admittedBy: r.admitted_by,
    channel: r.channel,
    admittedAt: iso(r.admitted_at),
    stayUntil: iso(r.stay_until),
  }));
}

/** Is this person in at this resource now? */
async function alreadyIn(courtId: number, person: EntryPerson, when: string): Promise<boolean> {
  const who = person.participantId !== null ? "e.participant_id = ?" : "e.takes_part_as = 'customer' AND phone_key(e.phone) = phone_key(?)";
  return !!(await getDb()
    .prepare(`SELECT 1 FROM entries e WHERE e.court_id = ? AND ${who} AND ${OPEN} LIMIT 1`)
    .get(courtId, person.participantId ?? person.phone, when, when));
}

/**
 * The membership that lets this person in here today with no booking: active,
 * covering them (a participant's own or a family one naming them; the
 * customer's own by their number, which online must be the account's proved
 * one), not suspended, on a plan that admits here. Null: none.
 */
async function admittingMembership(
  court: Court,
  person: EntryPerson,
  channel: EntryChannel,
  date: string
): Promise<{ id: number; code: string; plan: string } | null> {
  const whose =
    person.participantId !== null
      ? `(m.holder_participant_id = ? OR EXISTS (SELECT 1 FROM membership_participants mp WHERE mp.membership_id = m.id AND mp.participant_id = ?))`
      : `m.holder_kind = 'customer' AND phone_key(m.holder_phone) = phone_key(?)`;
  const rows = (await getDb()
    .prepare(
      `SELECT m.id, m.code, t.name AS plan, t.admits_entry_sport AS sport FROM memberships m JOIN membership_plans t ON t.id = m.tier_id
        WHERE ${inSameBusiness("m.venue_id")} AND m.status = 'active' AND m.starts_on <= ? AND m.expires_on >= ?
          AND t.admits_entry AND ${whose} AND NOT ${suspendedOn("m")}
        ORDER BY m.id`
    )
    .all(
      court.venueId,
      date,
      date,
      ...(person.participantId !== null ? [person.participantId, person.participantId] : [person.phone]),
      date,
      date
    )) as { id: number; code: string; plan: string; sport: string | null }[];
  const fits = rows.find((r) => r.sport === null || courtOffers(court, r.sport));
  if (!fits) return null;
  // The customer's own: on their word at the desk; online, the account's proved number.
  if (person.participantId === null && !(await memberNumberTrusted(person.phone, { userId: person.userId ?? null, by: channel === "desk" ? "staff" : "customer" })))
    return null;
  return { id: fits.id, code: fits.code, plan: fits.plan };
}

interface PassRow {
  id: number;
  code: string;
  name: string;
  entries: number;
  spent: number;
  day_pass: boolean;
  day_used_on: string | null;
  expires_on: string;
  sport: string | null;
  scope: string;
  holder_kind: string;
  holder_participant_id: number | null;
  user_id: number | null;
  holder_phone: string;
}

/**
 * The passes that could let this person in here today, by each pass's scope
 * (ADR 0025): one person's pass only its own person; a pass for a booking or
 * for each place anybody its holder's number brings (one entry each); never
 * a pass for a resource hired whole, a lesson pack or a time pass. Online,
 * only the account's own: bought on it, or held on its proved number.
 */
async function admittingPasses(court: Court, person: EntryPerson, channel: EntryChannel, date: string): Promise<EntryOptions["passes"]> {
  const rows = (await getDb()
    .prepare(
      `SELECT p.id, p.code, p.name, p.entries, COALESCE((SELECT SUM(delta) FROM pass_entries pe WHERE pe.pass_id = p.id), 0)::int AS spent,
              p.day_pass, p.day_used_on::text AS day_used_on, p.expires_on, p.sport, p.scope, p.holder_kind, p.holder_participant_id, p.user_id, p.holder_phone
         FROM passes p
        WHERE ${inSameBusiness("p.venue_id")} AND p.status = 'active' AND p.expires_on >= ? AND p.kind = 'session' AND p.coach_id IS NULL
          AND p.scope <> 'resource' AND phone_key(p.holder_phone) = phone_key(?)
        ORDER BY p.day_pass DESC, p.expires_on, p.id`
    )
    .all(court.venueId, date, person.phone)) as PassRow[];
  const verified =
    channel === "self" && person.userId
      ? ((await getDb().prepare("SELECT verified_phone FROM users WHERE id = ?").get(person.userId)) as { verified_phone: string | null } | undefined)?.verified_phone ?? null
      : null;
  const out: EntryOptions["passes"] = [];
  for (const r of rows) {
    if (r.sport && !courtOffers(court, r.sport)) continue;
    // Whose it is to use.
    if (r.scope === "participant") {
      if (r.holder_kind === "participant" ? r.holder_participant_id !== person.participantId : person.participantId !== null) continue;
    }
    // Online, only the account's own pass.
    if (channel === "self" && r.user_id !== person.userId && !(verified && phoneKey(verified) === phoneKey(r.holder_phone))) continue;
    const remaining = Number(r.entries) + Number(r.spent);
    const usedToday = r.day_pass && r.day_used_on === date;
    if (remaining <= 0 && !usedToday) continue;
    out.push({ id: r.id, code: r.code, name: r.name, remaining, dayPass: r.day_pass === true, usedToday, expiresOn: r.expires_on });
  }
  return out;
}

/** What could let this person in at this resource now (for the desk's screen, and the customer's own). */
export async function entryOptions(resource: EntryResource, person: EntryPerson, channel: EntryChannel): Promise<EntryOptions> {
  const court = (await getCourt(resource.courtId))!;
  const date = todayISO(await courtZone(court.id));
  return {
    membership: await admittingMembership(court, person, channel, date),
    passes: await admittingPasses(court, person, channel, date),
    walkIn: channel === "desk" ? resource.price : null,
    alreadyIn: await alreadyIn(court.id, person, new Date().toISOString()),
  };
}

/**
 * What a booking would ask of this person before they take part, asked of an
 * entry (null: nothing stands in the way): the venue open; the number not
 * refused; who the venue is for; a participant let in only under a live
 * guardian's number; the waiver; the activity's sign-off or certification.
 */
async function entryRefusal(
  court: Court,
  policy: BookingPolicy,
  person: EntryPerson,
  channel: EntryChannel,
  date: string,
  agreeWaiver: boolean
): Promise<Refusal | null> {
  if (!(await venueIsOpen(court.venueId))) return venueNotOpen();
  if (await isBlocked(court.venueId, person.phone)) return phoneBlocked();
  if (channel === "self") {
    if (person.participantId !== null) return refuse("NBK_SELF_ONLY");
    const notHere = await accessRefusal(court.venueId, person.userId ?? null);
    if (notHere) return notHere;
  } else {
    if (person.participantId !== null) {
      const chosen = await selectionAtVenue(court.venueId, person.phone, [person.participantId], false);
      if ("error" in chosen) return { ok: false, error: chosen.error, code: chosen.code as ErrorCode, ...(chosen.vars ? { vars: chosen.vars } : {}) };
    }
    const notHere = await numberAccessRefusal(
      court.venueId,
      {
        phone: person.phone,
        by: "staff",
        participants: person.participantId !== null ? [{ id: person.participantId, name: person.name }] : [],
        customerTakesPart: person.participantId === null,
      },
      [date]
    );
    if (notHere) return notHere;
  }
  const signed = person.participantId !== null ? await waiverSignedFor(court.venueId, person.participantId) : await waiverSigned(court.venueId, person.phone);
  if (!signed && !agreeWaiver) return refuse("WAIVER_NEEDED");
  const need = needsOf(policy);
  if (need) {
    const holds = await signOffHolds({
      venueId: court.venueId,
      sport: court.sport,
      until: date,
      phone: person.phone,
      userId: person.userId ?? null,
      channel: channel === "desk" ? "staff" : "customer",
      need: need === "certification" ? "certification" : "any",
      participant: person.participantId,
    });
    if (!holds) {
      const sport = activityName(court.sport);
      const code = need === "certification" ? "CERTIFICATION_NEEDED" : "SIGN_OFF_NEEDED";
      return person.participantId !== null ? refuse(`${code}_FOR` as ErrorCode, { sport, name: person.name }) : refuse(code, { sport });
    }
  }
  return null;
}

export interface AdmitInput {
  courtId: number;
  person: EntryPerson;
  /** What lets them in: a membership, a pass (or day pass) by its id, or a walk-in entry paid at the counter. */
  by: { kind: "membership" } | { kind: "pass"; passId: number } | { kind: "walk_in"; via: unknown };
  channel: EntryChannel;
  /** The person (or their guardian) agrees to the venue's waiver now: online by ticking it, at the desk on paper. */
  agreeWaiver?: boolean;
  /** Staff admitting, or null where the customer let themself in. */
  staff?: { id: number | null; name: string } | null;
}

export interface Admission {
  id: number;
  courtId: number;
  name: string;
  admittedBy: EntryAdmit;
  stayUntil: string;
  /** What it used: the membership's code, the pass's code (and what is left on it), or the counter sale's receipt. */
  membershipCode?: string;
  pass?: { code: string; remaining: number; dayPass: boolean };
  receipt?: { number: string; path: string } | null;
  saleId?: number;
  count: EntryCount;
}

export type AdmitResult = ({ ok: true } & Admission) | Refusal;

/**
 * Let somebody in. Everything a booking would ask of them first; then, under
 * the resource's lock, room for them (entries and places held by claims
 * overlapping now, against its places), and what lets them in is used: a
 * pass's entry spent (once a day for a day pass), a walk-in entry sold and
 * receipted. All or nothing.
 */
export async function admitEntry(input: AdmitInput): Promise<AdmitResult> {
  const court = await getCourt(input.courtId);
  if (!court) return refuse("COURT_NOT_FOUND");
  const policy = await policyFor(court);
  const resource = takesEntries(court, policy) ? toResource(court, policy) : null;
  if (!resource) return refuse("NBK_NOT_ENTRY", { name: court.name });
  const person = { ...input.person, name: input.person.name.trim().slice(0, 80), phone: input.person.phone.trim() };
  if (person.name.length < 2 || phoneKey(person.phone).length < 6) return refuse("NBK_WHO");
  if (input.channel === "self") {
    if (!resource.selfCheckIn) return refuse("NBK_SELF_OFF", { name: court.name });
    if (input.by.kind === "walk_in") return refuse("NBK_SELF_PAID");
  }
  if (input.by.kind === "walk_in") {
    if (resource.price === null) return refuse("NBK_NO_WALK_IN", { name: court.name });
    if (resource.price > 0 && !COUNTER_METHODS.includes(input.by.via as CounterMethod)) return refuse("NBK_VIA");
  }
  const zone = await courtZone(court.id);
  const date = todayISO(zone);
  const refusal = await entryRefusal(court, policy, person, input.channel, date, input.agreeWaiver === true);
  if (refusal) return refusal;

  return withTransaction(async (): Promise<AdmitResult> => {
    const db = getDb();
    // The resource's lock: the one claims on it take, then its row (lib/claims.ts lockCourts).
    await lockCourts([{ id: court.id, venueId: court.venueId, capacity: court.capacity }]);
    await db.prepare("SELECT id FROM courts WHERE id = ? FOR UPDATE").get(court.id);
    const now = new Date();
    if (await alreadyIn(court.id, person, now.toISOString())) return refuse("NBK_ALREADY_IN", { name: person.name });
    const count = await entryCount(resource, now);
    if (count.free <= 0) return refuse("NBK_FULL", { name: court.name });

    // What lets them in.
    let admittedBy: EntryAdmit;
    let membership: { id: number; code: string } | null = null;
    let pass: { id: number; code: string; remaining: number; dayPass: boolean; spend: boolean } | null = null;
    let saleId: number | null = null;
    let receipt: { number: string; path: string } | null = null;
    if (input.by.kind === "membership") {
      membership = await admittingMembership(court, person, input.channel, date);
      if (!membership) return refuse("NBK_NO_MEMBERSHIP", { name: person.name });
      admittedBy = "membership";
    } else if (input.by.kind === "pass") {
      const passId = input.by.passId;
      // The pass's row first, so two admissions on it at once spend it one after the other.
      await db.prepare("SELECT id FROM passes WHERE id = ? FOR UPDATE").get(passId);
      const usable = (await admittingPasses(court, person, input.channel, date)).find((p) => p.id === passId);
      if (!usable) return refuse("NBK_PASS");
      pass = { id: usable.id, code: usable.code, remaining: usable.remaining, dayPass: usable.dayPass, spend: !usable.usedToday };
      admittedBy = usable.dayPass ? "day_pass" : "pass";
    } else {
      admittedBy = "walk_in";
      if (resource.price !== null && resource.price > 0) {
        const sold = await sellAtCounter({
          venueId: court.venueId,
          adminId: input.staff?.id ?? null,
          items: [{ name: `Entry: ${court.name}`.slice(0, 60), price: resource.price, quantity: 1 }],
          via: input.by.via,
          customerName: person.name,
          customerPhone: person.phone,
        });
        if (!sold.ok) return { ok: false, error: sold.error };
        saleId = sold.sale.id;
        receipt = sold.sale.receipt;
      }
    }

    const row = (await db
      .prepare(
        `INSERT INTO entries (venue_id, court_id, takes_part_as, participant_id, user_id, name, phone, admitted_by, membership_id, pass_id, sale_id,
                              channel, admin_id, admin_name, admitted_at, stay_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz, ?::timestamptz) RETURNING id`
      )
      .get(
        court.venueId,
        court.id,
        person.participantId !== null ? "participant" : "customer",
        person.participantId,
        person.participantId === null ? (person.userId ?? null) : null,
        person.name,
        person.phone,
        admittedBy,
        membership?.id ?? null,
        pass?.id ?? null,
        saleId,
        input.channel,
        input.staff?.id ?? null,
        input.staff?.name ?? null,
        now.toISOString(),
        new Date(now.getTime() + resource.maxStay * 60_000).toISOString()
      )) as { id: number };
    if (pass?.spend) {
      await db.prepare("INSERT INTO pass_entries (pass_id, delta, reason, entry_id) VALUES (?, -1, ?, ?)").run(pass.id, `Entry: ${court.name}`, row.id);
      pass.remaining -= 1;
      if (pass.dayPass) await db.prepare("UPDATE passes SET day_used_on = ?::date WHERE id = ?").run(date, pass.id);
    }
    // Agreed now: on the record, as a booking's agreement is (lib/waivers.ts).
    if (input.agreeWaiver === true)
      await signWaiver(court.venueId, {
        phone: person.phone,
        // A participant's is agreed by the guardian whose number they came in under.
        name: person.participantId !== null ? `Guardian of ${person.name}` : person.name,
        adminId: input.staff?.id ?? null,
        participant: person.participantId !== null ? { id: person.participantId, name: person.name } : null,
      });
    return {
      ok: true,
      id: row.id,
      courtId: court.id,
      name: person.name,
      admittedBy,
      stayUntil: new Date(now.getTime() + resource.maxStay * 60_000).toISOString(),
      ...(membership ? { membershipCode: membership.code } : {}),
      ...(pass ? { pass: { code: pass.code, remaining: pass.remaining, dayPass: pass.dayPass } } : {}),
      ...(saleId !== null ? { saleId, receipt } : {}),
      count: await entryCount(resource, now),
    };
  });
}

/** Somebody leaving: their entry stops counting. Refused where it is not open (gone already, or never here). */
export async function checkOutEntry(venueId: number, entryId: number): Promise<{ ok: true; name: string; courtId: number } | Refusal> {
  const now = new Date().toISOString();
  const row = (await getDb()
    .prepare(
      `UPDATE entries e SET checked_out_at = ?::timestamptz, out_reason = 'checked_out'
        WHERE e.id = ? AND e.venue_id = ? AND ${OPEN} RETURNING e.name, e.court_id`
    )
    .get(now, entryId, venueId, now, now)) as { name: string; court_id: number } | undefined;
  if (!row) return refuse("NBK_NOT_IN");
  return { ok: true, name: row.name, courtId: row.court_id };
}

/**
 * The scheduler's tidy: entries past their longest stay closed, as having
 * ended then. They had already stopped counting; this only keeps the table
 * saying so. Returns how many.
 */
export async function closeEndedEntries(now: Date = new Date()): Promise<number> {
  const done = await getDb()
    .prepare("UPDATE entries SET checked_out_at = stay_until, out_reason = 'stay_ended' WHERE checked_out_at IS NULL AND stay_until <= ?::timestamptz")
    .run(now.toISOString());
  return done.changes;
}

/** People let in on a day at each resource of a venue (the occupancy grid), in the venue's date. */
export async function entriesOn(venueId: number, date: string, zone: string): Promise<Map<number, number>> {
  const rows = (await getDb()
    .prepare(
      `SELECT court_id, COUNT(*)::int AS n FROM entries
        WHERE venue_id = ? AND (admitted_at AT TIME ZONE ?)::date = ?::date GROUP BY court_id`
    )
    .all(venueId, zone, date)) as { court_id: number; n: number }[];
  return new Map(rows.map((r) => [r.court_id, Number(r.n)]));
}

/**
 * What a customer's page says of each resource taking entries: no booking
 * needed, the walk-in price, what admits, and how full it is now as a level
 * (never who is there).
 */
export interface PublicEntry {
  courtId: number;
  name: string;
  sport: string;
  price: number | null;
  selfCheckIn: boolean;
  level: Busyness;
  /** The plans admitting here, and the passes sold online for it (day passes first). */
  plans: string[];
  passes: { name: string; price: number; dayPass: boolean }[];
}

export async function publicEntries(venueId: number): Promise<PublicEntry[]> {
  const resources = await entryResources(venueId);
  if (resources.length === 0) return [];
  const plans = (await getDb()
    .prepare(`SELECT name, admits_entry_sport AS sport FROM membership_plans WHERE venue_id = ? AND retired_at IS NULL AND admits_entry ORDER BY months, price, id`)
    .all(venueId)) as { name: string; sport: string | null }[];
  const products = (await getDb()
    .prepare(
      `SELECT name, price::float AS price, day_pass, sport FROM pass_products
        WHERE venue_id = ? AND retired_at IS NULL AND kind = 'session' AND coach_id IS NULL AND scope <> 'resource'
        ORDER BY day_pass DESC, price, id`
    )
    .all(venueId)) as { name: string; price: number; day_pass: boolean; sport: string | null }[];
  const out: PublicEntry[] = [];
  for (const r of resources) {
    const court = (await getCourt(r.courtId))!;
    out.push({
      courtId: r.courtId,
      name: r.name,
      sport: r.sport,
      price: r.price,
      selfCheckIn: r.selfCheckIn,
      level: (await entryCount(r)).level,
      plans: plans.filter((p) => p.sport === null || courtOffers(court, p.sport)).map((p) => p.name),
      passes: products.filter((p) => p.sport === null || courtOffers(court, p.sport)).map((p) => ({ name: p.name, price: Number(p.price), dayPass: p.day_pass === true })),
    });
  }
  return out;
}

/** The account as the person a self check-in lets in: their own name and number. */
export async function selfPerson(userId: number): Promise<EntryPerson | null> {
  const user = (await getDb().prepare("SELECT name, phone FROM users WHERE id = ?").get(userId)) as { name: string; phone: string } | undefined;
  if (!user) return null;
  return { participantId: null, name: user.name, phone: (await accountPhone(userId)) ?? user.phone, userId };
}
