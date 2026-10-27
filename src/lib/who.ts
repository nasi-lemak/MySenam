import { getDb } from "./db";
import { errorText, translator, type ErrorCode } from "./i18n";
import type { Refusal } from "./types";

/**
 * Who may play: anyone, or women only, or men only — for an open game, a
 * league or a class — and, for a tournament, badminton's categories, with
 * mixed doubles as one woman and one man.
 *
 * Women-only matters most: ladies' nights, muslimah sessions, a woman who
 * would not otherwise join strangers. Men-only is there too, for contact
 * sports and those who keep apart, so the rule is the same both ways.
 *
 * It rests on what the player says about themselves, asked the first time it
 * matters — never at sign-up — and kept on the account: woman, man, or
 * prefer not to say, who can join anything open to anyone. Nobody else sees
 * it; a game shows only its own rule. Nothing can prove it, as with a
 * player's level: a host can still remove somebody, and that is the backstop.
 * A doubles partner is described by whoever enters, the same way.
 */

import { CATEGORIES, GENDERS, WHO, type Category, type Gender, type Who } from "./who-shared";
export { CATEGORIES, GENDERS, WHO, type Category, type Gender, type Who };

export const isGender = (x: unknown): x is Gender => typeof x === "string" && (GENDERS as readonly string[]).includes(x);
export const isWho = (x: unknown): x is Who => typeof x === "string" && (WHO as readonly string[]).includes(x);
export const isCategory = (x: unknown): x is Category => typeof x === "string" && (CATEGORIES as readonly string[]).includes(x);
export const isPartnerGender = (x: unknown): x is "woman" | "man" => x === "woman" || x === "man";

const ENGLISH = translator("en");
function refuse(code: ErrorCode): Refusal {
  return { ok: false, error: errorText(ENGLISH, code), code };
}

export async function playerGender(userId: number): Promise<Gender | null> {
  const row = (await getDb().prepare("SELECT gender FROM users WHERE id = ?").get(userId)) as { gender: Gender | null } | undefined;
  return row?.gender ?? null;
}

export async function setPlayerGender(userId: number, gender: Gender): Promise<void> {
  await getDb().prepare("UPDATE users SET gender = ? WHERE id = ?").run(gender, userId);
}

/** Whether somebody who says this may play where this is the rule. */
export function allows(who: Who, gender: Gender | null): boolean {
  return who === "anyone" || (who === "women" && gender === "woman") || (who === "men" && gender === "man");
}

/** Why this account may not play under this rule, or null if it may. Asks first if it never said. */
export async function whoRefusal(userId: number, who: Who): Promise<Refusal | null> {
  if (who === "anyone") return null;
  const gender = await playerGender(userId);
  if (gender === null) return refuse("GENDER_NEEDED");
  return allows(who, gender) ? null : refuse(who === "women" ? "WHO_WOMEN" : "WHO_MEN");
}

/**
 * For an entry with a partner: both must fit a women's or men's event, and
 * a mixed pair is one of each. Singles is the player alone.
 */
export async function categoryRefusal(
  userId: number,
  category: Category,
  pair: { partnerGender?: "woman" | "man" | null } | null
): Promise<Refusal | null> {
  if (category === "open") return null;
  return categoryRefusalFor(await playerGender(userId), category, pair);
}

/**
 * The same rule for a gender said some other way than on the player's own
 * account: what a guardian declares for a participant they enter, or what
 * staff are told at the counter. `GENDER_NEEDED` where it was not said.
 */
export function categoryRefusalFor(
  gender: Gender | null,
  category: Category,
  pair: { partnerGender?: "woman" | "man" | null } | null
): Refusal | null {
  if (category === "open") return null;
  if (gender === null) return refuse("GENDER_NEEDED");
  if (pair && !pair.partnerGender) return refuse("PARTNER_GENDER");
  if (category === "mixed") {
    if (gender === "unsaid") return refuse("WHO_MIXED");
    return pair?.partnerGender && pair.partnerGender !== gender ? null : refuse("WHO_MIXED");
  }
  const want = category === "women" ? "woman" : "man";
  if (gender !== want || (pair && pair.partnerGender !== want)) return refuse(category === "women" ? "WHO_WOMEN" : "WHO_MEN");
  return null;
}

/**
 * A place in a women-only or men-only class. Signed in, by what the account
 * says; a guest at the counter or online has no account to ask, so they say
 * it for themselves by ticking the box — which is all an account is too.
 */
export async function classRefusal(who: Who, userId: number | null, confirmed: boolean): Promise<Refusal | null> {
  if (who === "anyone") return null;
  if (userId !== null) return whoRefusal(userId, who);
  return confirmed ? null : refuse(who === "women" ? "WHO_CONFIRM_WOMEN" : "WHO_CONFIRM_MEN");
}
