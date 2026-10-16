/**
 * Which way this install is being run.
 *
 * The same code is the MySenam marketplace — many independent venues, players
 * booking across them — and a single venue business's own booking site. Most
 * of it does not care which. What does: whether venues may sign themselves up
 * and be billed for it, and whose money stored credit is.
 */

/** MYSENAM_MARKETPLACE=on: venues apply to join, and are invoiced monthly. */
export function isMarketplace(): boolean {
  return process.env.MYSENAM_MARKETPLACE === "on";
}

export type CreditScope = "venue" | "platform";

/**
 * Whose stored credit is.
 *
 * `platform`: bought at any counter, spendable at any venue — so the install
 * owes it, which is right when every venue is one business's branch.
 *
 * `venue`: bought at a venue, spendable only there — so that venue owes it.
 * This is the marketplace default, because a platform holding money that
 * strangers paid to other businesses is a payments business, with the licence
 * that needs.
 *
 * Credit bought before an install switched to `venue` stays spendable at any
 * venue, so nobody's balance shrinks when the setting changes.
 */
export function creditScope(): CreditScope {
  const setting = process.env.MYSENAM_CREDIT_SCOPE;
  if (setting === "venue" || setting === "platform") return setting;
  return isMarketplace() ? "venue" : "platform";
}
