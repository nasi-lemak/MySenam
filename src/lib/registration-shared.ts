/**
 * What the sign-up pages and the server share about signing up by an emailed
 * link (lib/registration.ts), kept apart so a page does not load the server's
 * code.
 */

/** How long a link to finish signing up works. Twice a reset's: mail can be slow, and nothing exists yet to take over. */
export const REGISTRATION_MINUTES = 60;

/** Where the browser that asked goes once the account is made, kept in that browser only. */
export const SIGN_UP_NEXT = "mysenam.signUpNext";
