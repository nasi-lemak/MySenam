import { getDb } from "./db";
import { WHO, type Line } from "./documents";
import { ANONYMOUS } from "./privacy";
import type { StaffText, StaffValue } from "./staff-text";

/**
 * The people a receipt or credit note names, cleared with the rest of it
 * (docs/architecture/privacy.md#receipts-and-credit-notes).
 *
 * A receipt is the venue's record of a sale, kept for the books: what was
 * sold, the amounts and the tax stay. Who it was sold to, and whom its lines
 * were for (a guardian's children on the court time, a child taken off a
 * booking, the family a membership covers), go when the install stops
 * keeping names (retention) and when the person is erased.
 *
 * Lines written now keep those names apart from their words (lib/documents.ts
 * `Line.who`, `slot.for`, `place.name`), and every reader fills them in, so
 * clearing them clears them everywhere. Lines written before say some of them
 * in their words; each such shape is known and its name taken out where it
 * stands, and every name known for the receipt (from the line itself, its
 * customer, the booking's places and withdrawals, or the participant's own
 * record) is replaced wherever it appears as a word. Over-clearing a word that
 * happens to be the same as a name is the safer mistake; the amounts never
 * change.
 */

interface Row {
  id: number;
  source: string;
  user_id: number | null;
  customer_name: string;
  lines: string;
}

const COLUMNS = "id, source, user_id, customer_name, lines";

/** "Alya, taken off BK-1": a withdrawal's credit note written before names were kept apart. */
const OLD_TAKEN = /^(.+), taken off (\S+)$/;
/** "credit:12:BK-1, Alya": a deposit's part credited for a place, keyed by its name before names were kept apart. */
const OLD_PART = /^(credit:\d+:)(\S+), (.+)$/;
/** Places nobody was named on: "2 places". Not a name. */
const COUNT = /^\d+ places?$/;

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Which names come out: every one the receipt holds, or one person's (case and spacing aside). */
type Whom = { all: true; known: string[] } | { all: false; names: string[] };

function isTheirs(whom: Whom): (name: string) => boolean {
  if (whom.all) return () => true;
  const set = new Set(whom.names.map(norm));
  return (name) => set.has(norm(name));
}

/** Every name a stored line holds apart, or (written before that) says in one of the known shapes. */
function namesOf(line: Line, source: string): string[] {
  const out = [...(line.slot?.for ?? []), ...(line.place?.name ? [line.place.name] : []), ...(line.who ?? [])];
  const taken = line.description.includes(WHO) ? null : OLD_TAKEN.exec(line.description);
  if (taken && !COUNT.test(taken[1])) out.push(taken[1]);
  const who = line.phrase?.vars?.who;
  if (typeof who === "string" && who !== WHO) out.push(who, ...who.split(", "));
  const part = OLD_PART.exec(source);
  if (part && !COUNT.test(part[3])) out.push(part[3]);
  return out.filter((n) => n && n !== ANONYMOUS);
}

/**
 * A text with each of these names, standing as a word of its own, said as
 * `(removed)`. A name of one character is left to the shapes that place it
 * (it would match too much); `{who}` is never touched.
 */
function replaceNames(text: string, names: string[]): string {
  const words = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 2 && norm(n) !== norm(ANONYMOUS) && norm(n) !== "who"))].sort(
    (a, b) => b.length - a.length
  );
  if (words.length === 0) return text;
  const pattern = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${words.map(escape).join("|")})(?![\\p{L}\\p{M}\\p{N}])`, "giu");
  return text
    .split(WHO)
    .map((piece) => piece.replace(pattern, ANONYMOUS))
    .join(WHO);
}

/** A list of names with theirs said as `(removed)`; with everybody's, one `(removed)` where there were any. */
function clearList(list: string[], theirs: (n: string) => boolean, all: boolean): string[] {
  if (all) return list.length > 0 ? [ANONYMOUS] : [];
  return list.map((n) => (theirs(n) ? ANONYMOUS : n));
}

function clearValue(v: StaffValue, names: string[], theirs: (n: string) => boolean, all: boolean, key?: string): StaffValue {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    if (key === "who" && v !== WHO && all) return ANONYMOUS;
    return replaceNames(v, names);
  }
  if (Array.isArray(v)) return v.map((x) => clearPhrase(x, names, theirs, all));
  return clearPhrase(v, names, theirs, all);
}

function clearPhrase(text: StaffText, names: string[], theirs: (n: string) => boolean, all: boolean): StaffText {
  if (!text.vars) return text;
  return { ...text, vars: Object.fromEntries(Object.entries(text.vars).map(([k, v]) => [k, clearValue(v, names, theirs, all, k)])) };
}

function clearLine(line: Line, names: string[], theirs: (n: string) => boolean, all: boolean): Line {
  const next: Line = { ...line };
  if (line.slot) next.slot = { ...line.slot, for: clearList(line.slot.for, theirs, all) };
  if (line.who) next.who = clearList(line.who, theirs, all);
  let text = line.description;
  // The shapes written before names were kept apart, each name taken out where it stands.
  const taken = text.includes(WHO) ? null : OLD_TAKEN.exec(text);
  if (taken && !COUNT.test(taken[1]) && theirs(taken[1])) text = `${ANONYMOUS}, taken off ${taken[2]}`;
  const own = line.place?.name;
  if (own && theirs(own)) {
    if (text.endsWith(`, ${own}`)) text = `${text.slice(0, -own.length)}${ANONYMOUS}`;
    next.place = { ...line.place!, name: null };
  }
  next.description = replaceNames(text, names);
  if (line.phrase) next.phrase = clearPhrase(line.phrase, names, theirs, all);
  return next;
}

/**
 * Clear one receipt's names: in its lines, its source where a name was part
 * of it, and its customer where `customer` says so (or, clearing one person,
 * where the customer is that person: a child's own entry). With `whom.all`
 * the receipt names nobody afterwards and is marked so.
 */
async function clearReceipt(row: Row, whom: Whom, customer: boolean): Promise<void> {
  const db = getDb();
  const theirs = isTheirs(whom);
  let lines: Line[];
  try {
    lines = JSON.parse(row.lines) as Line[];
  } catch {
    lines = [];
  }
  const names = whom.all
    ? [...lines.flatMap((l) => namesOf(l, row.source)), row.customer_name, ...whom.known]
    : whom.names;
  const cleared = lines.map((l) => clearLine(l, names, theirs, whom.all));
  // A deposit's part, keyed by the name of the place it was for: the key names nobody, and stays one of a kind.
  const part = OLD_PART.exec(row.source);
  const source = part && !COUNT.test(part[3]) && theirs(part[3]) ? `${part[1]}${part[2]}, ${ANONYMOUS} ${row.id}` : row.source;
  const anonymous = customer || (!whom.all && theirs(row.customer_name));
  await db
    .prepare(
      `UPDATE receipts SET lines = ?, source = ?,
         customer_name = CASE WHEN ? THEN ? ELSE customer_name END,
         customer_phone = CASE WHEN ? THEN NULL ELSE customer_phone END,
         user_id = CASE WHEN ? THEN NULL ELSE user_id END,
         names_cleared_at = CASE WHEN ? THEN COALESCE(names_cleared_at, now()) ELSE names_cleared_at END
       WHERE id = ?`
    )
    .run(JSON.stringify(cleared), source, anonymous, ANONYMOUS, customer, customer, whom.all, row.id);
}

/** The bookings a receipt is about, by its source: their people's names are names it may hold. */
async function bookingsOf(source: string, depth = 0): Promise<number[]> {
  const db = getDb();
  const [kind, rest] = source.split(":");
  const id = Number.parseInt(rest ?? "", 10);
  if (!Number.isInteger(id)) return [];
  const ids = async (sql: string) => ((await db.prepare(sql).all(id)) as { id: number }[]).map((r) => Number(r.id));
  switch (kind) {
    case "booking":
    case "booking-paid":
      return [id];
    case "lesson-coach":
      return ids("SELECT booking_id AS id FROM lesson_coach_changes WHERE id = ?");
    case "account-credit":
      return ids("SELECT booking_id AS id FROM account_credits WHERE id = ? AND booking_id IS NOT NULL");
    case "payment":
      return ids("SELECT pb.booking_id AS id FROM online_payment_bookings pb JOIN online_payments p ON p.id = pb.payment_id WHERE p.id = ? AND p.purpose = 'booking'");
    case "credit": {
      if (depth > 0) return [];
      const original = (await db.prepare("SELECT source FROM receipts WHERE id = ?").get(id)) as { source: string } | undefined;
      return original ? bookingsOf(original.source, depth + 1) : [];
    }
    default:
      return [];
  }
}

/** Every name the bookings still hold: who booked, whom the places were for, who was taken off. */
async function bookingNames(bookingIds: number[]): Promise<string[]> {
  const db = getDb();
  const out: string[] = [];
  for (const id of bookingIds) {
    const rows = (await db
      .prepare(
        `SELECT name FROM bookings WHERE id = ? UNION SELECT participant_name FROM bookings WHERE id = ?
         UNION SELECT name FROM booking_participants WHERE booking_id = ? UNION SELECT name FROM place_withdrawals WHERE booking_id = ?`
      )
      .all(id, id, id, id)) as { name: string | null }[];
    for (const r of rows) if (r.name) out.push(...r.name.split(", "), r.name);
  }
  return out.filter((n) => n !== ANONYMOUS);
}

async function clearAll(row: Row, customer: boolean): Promise<void> {
  await clearReceipt(row, { all: true, known: await bookingNames(await bookingsOf(row.source)) }, customer);
}

/** The receipts about these bookings: their own, their credit notes, their deposits' and coach changes', and credit notes of each. */
async function receiptsOfBookings(bookingIds: number[], extra: Row[] = []): Promise<Row[]> {
  const db = getDb();
  const found = new Map<number, Row>(extra.map((r) => [r.id, r]));
  for (const b of bookingIds) {
    const rows = (await db
      .prepare(
        `SELECT ${COLUMNS} FROM receipts
          WHERE source = ? OR source LIKE ? OR source LIKE ?
             OR source IN (SELECT 'lesson-coach:' || id FROM lesson_coach_changes WHERE booking_id = ?)
             OR EXISTS (SELECT 1 FROM lesson_coach_changes l WHERE l.booking_id = ? AND receipts.source LIKE 'lesson-coach:' || l.id || ':%')
             OR source IN (SELECT 'account-credit:' || id FROM account_credits WHERE booking_id = ?)
             OR source IN (SELECT 'payment:' || p.id FROM online_payments p JOIN online_payment_bookings pb ON pb.payment_id = p.id
                            WHERE pb.booking_id = ? AND p.purpose = 'booking')`
      )
      .all(`booking:${b}`, `booking:${b}:%`, `booking-paid:${b}:%`, b, b, b, b)) as Row[];
    for (const r of rows) found.set(Number(r.id), r);
  }
  return withCreditNotes([...found.values()]);
}

/** These, and the credit notes that reverse any of them (which copy their lines). */
async function withCreditNotes(rows: Row[]): Promise<Row[]> {
  const db = getDb();
  const found = new Map<number, Row>(rows.map((r) => [Number(r.id), r]));
  for (const r of rows) {
    const notes = (await db.prepare(`SELECT ${COLUMNS} FROM receipts WHERE credits_id = ?`).all(r.id)) as Row[];
    for (const n of notes) found.set(Number(n.id), n);
  }
  return [...found.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

/**
 * The retention rule (lib/privacy.ts): every receipt matching `where` (one
 * `?`, the cutoff) stops naming anybody: its customer, and whom its lines
 * were for. A few hundred at a time, so the first run after a long while
 * holds nothing in memory it need not.
 */
export async function anonymiseReceipts(where: string, cutoff: string): Promise<void> {
  const db = getDb();
  let after = 0;
  for (;;) {
    const rows = (await db.prepare(`SELECT ${COLUMNS} FROM receipts WHERE (${where}) AND id > ? ORDER BY id LIMIT 200`).all(cutoff, after)) as Row[];
    if (rows.length === 0) return;
    for (const r of rows) await clearAll(r, true);
    after = Number(rows[rows.length - 1].id);
  }
}

/**
 * An account erased (lib/privacy.ts eraseCustomer), before its bookings stop
 * being linked to it: its receipts and credit notes, and those of its
 * bookings that carry no account (a deposit paid online, a credit note on a
 * company account the booking was charged to), stop naming anybody. A
 * company's own name stays on the company's credit note.
 */
export async function clearReceiptNamesForUser(userId: number): Promise<number> {
  const db = getDb();
  const own = (await db.prepare(`SELECT ${COLUMNS} FROM receipts WHERE user_id = ?`).all(userId)) as Row[];
  const bookings = ((await db.prepare("SELECT id FROM bookings WHERE user_id = ?").all(userId)) as { id: number }[]).map((b) => Number(b.id));
  const rows = await receiptsOfBookings(bookings, own);
  for (const r of rows) await clearAll(r, !r.source.startsWith("account-credit:"));
  return rows.length;
}

/**
 * A participant erased (lib/participants.ts eraseParticipant), before their
 * places and entries are unlinked: their name comes out of every receipt and
 * credit note about them (the bookings they had or were taken off a place on,
 * memberships naming them, their entries and league places), and off a
 * receipt made out to them (a child's own entry). Other people those receipts
 * name stay named.
 */
export async function clearReceiptNamesForParticipant(participantId: number): Promise<number> {
  const db = getDb();
  const p = participantId;
  const names = ((await db
    .prepare(
      `SELECT display_name AS name FROM participants WHERE id = ?
       UNION SELECT name FROM booking_participants WHERE participant_id = ? AND name IS NOT NULL
       UNION SELECT name FROM place_withdrawals WHERE participant_id = ? AND name IS NOT NULL
       UNION SELECT name FROM tournament_entries WHERE participant_id = ?
       UNION SELECT name FROM league_players WHERE participant_id = ?`
    )
    .all(p, p, p, p, p)) as { name: string | null }[])
    .map((r) => r.name ?? "")
    .filter((n) => n && n !== ANONYMOUS);
  if (names.length === 0) return 0;
  const bookings = ((await db
    .prepare(
      `SELECT booking_id AS id FROM booking_participants WHERE participant_id = ?
       UNION SELECT booking_id FROM place_withdrawals WHERE participant_id = ?
       UNION SELECT booking_id FROM place_benefits WHERE participant_id = ?`
    )
    .all(p, p, p)) as { id: number }[]).map((r) => Number(r.id));
  // Memberships theirs, naming them now, or naming them when sold (the cover history).
  const others = (await db
    .prepare(
      `SELECT ${COLUMNS} FROM receipts
        WHERE source IN (SELECT 'membership:' || id FROM memberships WHERE holder_participant_id = ?
                         UNION SELECT 'membership:' || membership_id FROM membership_participants WHERE participant_id = ?
                         UNION SELECT 'membership:' || membership_id FROM membership_cover_changes WHERE participant_id = ?)
           OR source IN (SELECT 'payment:' || op.id FROM online_payments op JOIN tournament_entries e ON e.id = op.tournament_entry_id WHERE e.participant_id = ?)
           OR source IN (SELECT 'payment:' || op.id FROM online_payments op JOIN league_places lp ON lp.id = op.league_place_id
                           JOIN league_players lpl ON lpl.id = lp.player_id WHERE lpl.participant_id = ?)
           OR EXISTS (SELECT 1 FROM tournament_entries e WHERE e.participant_id = ? AND receipts.source LIKE 'entry:' || e.id || '@%')
           OR EXISTS (SELECT 1 FROM league_places lp JOIN league_players lpl ON lpl.id = lp.player_id
                       WHERE lpl.participant_id = ? AND receipts.source LIKE 'place:' || lp.id || '@%')`
    )
    .all(p, p, p, p, p, p, p)) as Row[];
  const rows = await receiptsOfBookings(bookings, await withCreditNotes(others));
  for (const r of rows) await clearReceipt(r, { all: false, names }, false);
  return rows.length;
}
