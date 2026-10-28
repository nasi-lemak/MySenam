import { errorText, translator } from "./i18n";
import type { Refusal } from "./types";

/**
 * The name and email a customer gives where no account is needed (a booking,
 * an enrolment, a waiting list, signing up), checked once for every path that
 * keeps them: the booking form, the counter, the venue's API, the waiting
 * lists and sign-up. They go on to receipts, the staff day list, exports,
 * calendar feeds and message templates (whose providers cap each value), so
 * each has a bound.
 */

/** The longest name kept, after trimming: room for the longest full names in use (with bin/binti, ibni and titles). */
export const NAME_MAX = 100;
/** The longest an email address can be (RFC 5321). */
export const EMAIL_MAX = 254;
export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ENGLISH = translator("en");

/** A name too short to be one (`required`), or too long to keep: the refusal; else null. */
export function nameRefusal(name: unknown, required = true): Refusal | null {
  if (typeof name !== "string" || name.trim().length < 2) return required ? { ok: false, error: "Please provide your name." } : null;
  if (name.trim().length > NAME_MAX) return { ok: false, error: errorText(ENGLISH, "NAME_TOO_LONG", { max: NAME_MAX }), code: "NAME_TOO_LONG", vars: { max: NAME_MAX } };
  return null;
}

/**
 * An email address, where one is given (blank is none), that is not one or is
 * too long to be: the refusal; else null. `shape` false checks the length only
 * (the store, under callers that check the shape their own way).
 */
export function emailRefusal(email: unknown, shape = true): Refusal | null {
  if (email === undefined || email === null || email === "") return null;
  if (typeof email !== "string" || email.trim().length > EMAIL_MAX || (shape && !EMAIL_SHAPE.test(email.trim())))
    return { ok: false, error: "Please provide a valid email address." };
  return null;
}

/** Both, as a booking, enrolment or waiting list takes them. */
export function contactRefusal(input: { name: unknown; email?: unknown }): Refusal | null {
  return nameRefusal(input.name) ?? emailRefusal(input.email);
}
