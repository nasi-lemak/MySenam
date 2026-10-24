#!/usr/bin/env node
/**
 * Reset a staff account's two-factor sign-in from the server's console, for
 * when nobody above the account can (the last platform owner, who lost both
 * their authenticator and recovery codes). Running it means control of the
 * server already; it is recorded, the account is signed out everywhere, and
 * the account and every platform owner are emailed (lib/two-factor-reset.ts).
 * Anyone with somebody above them is reset from the dashboard instead.
 *
 * Usage: npm run reset-two-factor -- <staff email> --reason "how you confirmed who asked"
 */
import { resetFromConsole } from "../src/lib/two-factor-reset.ts";
import { tickOutbox } from "../src/lib/notify.ts";

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith("--"));
const at = args.indexOf("--reason");
const reason = at === -1 ? "" : (args[at + 1] ?? "");
if (!email || reason.trim().length < 10) {
  console.error('Usage: npm run reset-two-factor -- <staff email> --reason "how you confirmed who asked (10+ characters)"');
  process.exit(1);
}
const done = await resetFromConsole(email, reason);
if (!done.ok) {
  console.error(done.error);
  process.exit(1);
}
// Send the emails now rather than waiting for the app's next tick.
await tickOutbox();
console.log(`Two-factor sign-in reset for ${email}. They were signed out and emailed, and so were the platform owners.`);
process.exit(0);
