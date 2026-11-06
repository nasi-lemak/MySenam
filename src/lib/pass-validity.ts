import { getDb, withTransaction } from "./db";
import { refuse } from "./entitlements";
import { getPassById } from "./store";
import { addDays, isValidDateString, todayISO } from "./time";
import { MAX_PASS_MONTHS, type Pass, type Refusal } from "./types";

/**
 * How long a pass is valid for, after it was sold (ADR 0062; docs/features/pricing.md#passes).
 *
 * - **Entries given back to a pass that has ended** (a cancellation, the venue's or the customer's) are not dead: the pass is
 *   extended to today plus `venues.pass_restore_grace_days` (default 30, the recommended value; 0 turns it off), written in its history
 *   with the reason (lib/store.ts `giveBackToPass`). This module holds the setting.
 * - **A manager can extend a pass's end** with a reason: for a customer who lost days to a closure, or a pass sold with the wrong
 *   end. It is a line of the pass's history and in the activity log; never for a cancelled pass, which is not revived.
 */

/** The most days an ended pass is extended by when entries are given back to it. */
export const MAX_RESTORE_GRACE_DAYS = 365;
/** The venue's grace for entries given back to an ended pass, in days; 0: none. */
export const DEFAULT_RESTORE_GRACE_DAYS = 30;

export async function passRestoreGraceDays(venueId: number): Promise<number> {
  const row = (await getDb().prepare("SELECT pass_restore_grace_days AS n FROM venues WHERE id = ?").get(venueId)) as { n: number } | undefined;
  return row?.n ?? DEFAULT_RESTORE_GRACE_DAYS;
}

/** Set the grace (a manager's): whole days, 0 to 365. Returns the days now set and whether they changed. */
export async function setPassRestoreGraceDays(venueId: number, days: unknown): Promise<{ ok: true; days: number; was: number } | Refusal> {
  if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > MAX_RESTORE_GRACE_DAYS) return refuse("FX8_GRACE_RANGE", { max: MAX_RESTORE_GRACE_DAYS });
  const was = await passRestoreGraceDays(venueId);
  await getDb().prepare("UPDATE venues SET pass_restore_grace_days = ? WHERE id = ?").run(days, venueId);
  return { ok: true, days, was };
}

/** The most days a reason is kept to. */
const MAX_REASON = 200;

export type ExtendPassResult = { ok: true; pass: Pass; from: string; to: string } | Refusal;

/**
 * Extend a pass's end, with a reason. Either the day it should run until
 * (`expiresOn`) or the days to add (`days`: to its end, or to today where it
 * has already ended). Must move the end later, to today or after, and not past
 * what a pass may run (`MAX_PASS_MONTHS`). A cancelled pass is refused. The
 * change is under the pass's row lock and is a line in its history.
 */
export async function extendPass(
  admin: { name: string },
  passId: number,
  input: { expiresOn?: unknown; days?: unknown; reason?: unknown }
): Promise<ExtendPassResult> {
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, MAX_REASON) : "";
  if (reason.length < 3) return refuse("FX8_PASS_REASON");
  return withTransaction(async () => {
    const db = getDb();
    const locked = (await db.prepare("SELECT status, expires_on FROM passes WHERE id = ? FOR UPDATE").get(passId)) as { status: string; expires_on: string } | undefined;
    if (!locked) return refuse("PASS_NOT_FOUND");
    if (locked.status === "void") return refuse("FX8_PASS_VOID");
    const today = todayISO();
    const limit = addDays(today, MAX_PASS_MONTHS * 31);
    let to: string;
    if (typeof input.expiresOn === "string" && input.expiresOn !== "") {
      if (!isValidDateString(input.expiresOn)) return refuse("FX8_PASS_DATE");
      to = input.expiresOn;
    } else if (typeof input.days === "number" && Number.isInteger(input.days) && input.days >= 1 && input.days <= MAX_PASS_MONTHS * 31) {
      to = addDays(locked.expires_on > today ? locked.expires_on : today, input.days);
    } else return refuse("FX8_PASS_DATE");
    if (to <= locked.expires_on || to < today) return refuse("FX8_PASS_NOT_LATER", { date: locked.expires_on });
    if (to > limit) return refuse("FX8_PASS_TOO_FAR", { date: limit });
    await db.prepare("UPDATE passes SET expires_on = ? WHERE id = ?").run(to, passId);
    await db.prepare("INSERT INTO pass_entries (pass_id, delta, reason) VALUES (?, 0, ?)").run(passId, `Valid until ${locked.expires_on} → ${to}, extended by ${admin.name}: ${reason}`);
    return { ok: true as const, pass: (await getPassById(passId))!, from: locked.expires_on, to };
  });
}
