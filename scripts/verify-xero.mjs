#!/usr/bin/env node
/**
 * Check the Xero adapter (src/lib/xero.ts, the code the live accounting push uses) against a real Xero DEMO COMPANY, with
 * synthetic documents, and say exactly what was proven:
 *
 *   node scripts/verify-xero.mjs consent              prints the address to approve the app at (the one manual step)
 *   node scripts/verify-xero.mjs consent --code <c>   trades the code Xero sent back for a refresh token, kept in the token file
 *   node scripts/verify-xero.mjs [check]              runs the scripted check
 *
 * OAuth needs a person to approve the app once, in a browser, signed in to Xero. That is `consent`; nothing here can do it.
 * After it, `check` needs no person: it uses the refresh token kept in the token file (Xero rotates a refresh token every
 * time it is used, so the file is rewritten each run and must be somewhere that survives, such as the execution
 * environment's secret store mounted as a file; it is written with mode 0600 and never printed).
 *
 * What it needs, all from the environment (never typed into a chat, never printed; any value of such a variable that
 * would appear in an answer is replaced by ***):
 *   XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_REDIRECT_URI   the app's, as registered at developer.xero.com
 *   XERO_VERIFY_TOKEN_FILE                                  where the rotating refresh token is kept (0600)
 *   XERO_VERIFY_REFRESH_TOKEN                               optional: seeds the file the first time, if it does not exist
 *   XERO_VERIFY_DEMO_COMPANY_ONLY=yes                       required where Xero does not say whether the organisation is a demo one
 *   XERO_VERIFY_CODE                                        optional: the consent code, instead of --code
 *
 * It REFUSES, before anything is created, an organisation Xero says is not a demo company, and one Xero does not label
 * unless XERO_VERIFY_DEMO_COMPANY_ONLY=yes. Each of the steps is PASS or FAIL on its own evidence; the whole is BLOCKED
 * (what is missing is named), FAIL, PARTIAL (a step could not run here) or PASS. Nothing is recorded as passed unless it
 * passed. Exit 1 on FAIL.
 *
 * It creates an invoice, its payment, a credit note and its refund in the demo company, and leaves them there: Xero does not
 * let a paid document be deleted, and a demo company is disposable. Result: artifacts/integrations/xero-<time>.json.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const mode = args[0] === "consent" ? "consent" : "check";
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
};

const env = (name) => process.env[name]?.trim() ?? "";
const SECRETS = new Set();
const remember = (value) => {
  if (value && value.length >= 8) SECRETS.add(value);
};
for (const [k, v] of Object.entries(process.env)) if (v && /XERO_(CLIENT_SECRET|VERIFY_REFRESH_TOKEN|VERIFY_CODE)/.test(k)) remember(v);
const redact = (text) => [...SECRETS].reduce((t, s) => t.split(s).join("***"), String(text));

const { xero, xeroScopes } = await import("../src/lib/xero.ts");
const { ProviderError } = await import("../src/lib/accounting-provider.ts");

const result = { provider: "xero", status: "PASS", steps: [], needs: [], notes: [] };
function step(name, ok, detail = "") {
  result.steps.push({ step: name, ok, detail: redact(detail) });
  console.log(`  ${ok === true ? "✔" : ok === false ? "✖" : "–"} ${name}${detail ? ` — ${redact(detail)}` : ""}`);
  if (ok === false) result.status = "FAIL";
  else if (ok === null && result.status === "PASS") result.status = "PARTIAL";
}
function finish(code) {
  const out = path.join(env("XERO_VERIFY_REPORT_DIR") || path.join(ROOT, "artifacts", "integrations"), `xero-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), mode, result }, null, 2));
  console.log(`\nxero: ${result.status}\nReport: ${path.relative(ROOT, out)}`);
  process.exit(code ?? (result.status === "FAIL" ? 1 : 0));
}
function blocked(vars) {
  result.status = "BLOCKED";
  result.needs = vars;
  console.log(`  BLOCKED — set ${vars.join(", ")} (the Xero app's and the demo company's, from the secret store) to run it`);
  finish(0);
}
const missing = (vars) => vars.filter((v) => !env(v));

// ------------------------------------------------------------ the token file (mode 0600, rotated every run)

const tokenFile = env("XERO_VERIFY_TOKEN_FILE");
const readToken = () => {
  try {
    const kept = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    return typeof kept.refreshToken === "string" ? kept.refreshToken : null;
  } catch {
    return null;
  }
};
const keepToken = (refreshToken) => {
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, JSON.stringify({ refreshToken, savedAt: new Date().toISOString() }), { mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);
  remember(refreshToken);
};

// ------------------------------------------------------------ consent: the one manual step

if (mode === "consent") {
  console.log("Xero consent (the one step a person does)");
  const need = missing(["XERO_CLIENT_ID", "XERO_CLIENT_SECRET", "XERO_REDIRECT_URI", "XERO_VERIFY_TOKEN_FILE"]);
  if (need.length) blocked(need);
  const pkce = `${tokenFile}.pkce`;
  const code = flag("--code") ?? (env("XERO_VERIFY_CODE") || null);
  if (code === null) {
    const state = crypto.randomBytes(16).toString("base64url");
    const verifier = crypto.randomBytes(48).toString("base64url");
    fs.mkdirSync(path.dirname(pkce), { recursive: true });
    fs.writeFileSync(pkce, JSON.stringify({ state, verifier }), { mode: 0o600 });
    const url = xero.authorizeUrl({ state, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") });
    console.log(`  Open this in a browser signed in to Xero, choose the DEMO COMPANY (only), and allow access:\n\n  ${url}\n`);
    console.log("  Xero then sends the browser to XERO_REDIRECT_URI with ?code=… in the address. Run again with that code:");
    console.log("  node scripts/verify-xero.mjs consent --code <the code>   (the code works once, for a few minutes)");
    result.notes.push("consent address printed; waiting for the code");
    finish(0);
  }
  remember(code);
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(pkce, "utf8"));
  } catch {
    step("start consent first", false, "no pending consent: run `consent` without --code first");
    finish(1);
  }
  try {
    const tokens = await xero.exchangeCode({ code, verifier: saved.verifier });
    keepToken(tokens.refreshToken);
    fs.rmSync(pkce, { force: true });
    step("code exchanged for a refresh token, kept in the token file (mode 0600)", true, `scopes: ${tokens.scopes}`);
  } catch (err) {
    step("code exchanged for a refresh token", false, err instanceof Error ? err.message : String(err));
  }
  finish();
}

// ------------------------------------------------------------ the scripted check

console.log("Xero, against a demo company");
const need = missing(["XERO_CLIENT_ID", "XERO_CLIENT_SECRET", "XERO_REDIRECT_URI", "XERO_VERIFY_TOKEN_FILE"]);
if (need.length) blocked(need);
let refresh = readToken() ?? (env("XERO_VERIFY_REFRESH_TOKEN") || null);
if (!refresh) blocked(["XERO_VERIFY_REFRESH_TOKEN (or run `consent` once)"]);
remember(refresh);

let tokens;
try {
  tokens = await xero.refresh(refresh);
  // The old refresh token is spent the moment Xero answers: the new one is kept before anything else is done.
  keepToken(tokens.refreshToken);
  remember(tokens.accessToken);
  step("refresh token accepted and rotated, the new one kept (mode 0600)", true, `scopes: ${tokens.scopes}`);
} catch (err) {
  step("refresh token accepted", false, `${err instanceof Error ? err.message : String(err)} (run \`consent\` again)`);
  finish();
}
if (xeroScopes().split(" ").some((s) => !tokens.scopes.split(" ").includes(s))) step("every scope asked for was granted", false, `asked ${xeroScopes()}, granted ${tokens.scopes}`);
else step("every scope asked for was granted", true);

const orgs = await xero.organisations(tokens.accessToken).catch((e) => {
  step("the organisations the sign-in reached", false, e.message);
  return [];
});
if (orgs.length !== 1) {
  step("exactly one organisation was chosen at consent", false, `${orgs.length} reached: consent again, choosing only the demo company`);
  finish();
}
step("exactly one organisation was chosen at consent", true);
const session = { accessToken: tokens.accessToken, tenantId: orgs[0].tenantId };
const call = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProviderError && err.kind === "rate_limited") {
      step("Xero asked for fewer calls (429)", null, `Retry-After ${err.retryAfterSeconds}s: run again later`);
      finish();
    }
    throw err;
  }
};

const org = await call(() => xero.organisation(session));
// Refused before anything is created.
if (org.isDemo === false) {
  step("the organisation is a demo company", false, "Xero says it is NOT a demo company: refused, nothing was sent");
  finish(1);
}
if (org.isDemo === null && env("XERO_VERIFY_DEMO_COMPANY_ONLY") !== "yes") {
  step("the organisation is a demo company", false, "Xero does not say; set XERO_VERIFY_DEMO_COMPANY_ONLY=yes to confirm it is one: refused, nothing was sent");
  finish(1);
}
step("the organisation is a demo company", true, org.isDemo === true ? "Xero says so" : "confirmed by XERO_VERIFY_DEMO_COMPANY_ONLY=yes");
step("the organisation's currency is read", true, org.currency);

let chart;
try {
  chart = await call(() => xero.chart(session));
  step("accounts and tax rates read", chart.accounts.length > 0 && chart.taxRates.length > 0, `${chart.accounts.length} accounts, ${chart.taxRates.length} tax rates`);
} catch (err) {
  step("accounts and tax rates read", false, err.message);
  finish();
}
const income = chart.accounts.find((a) => a.class === "REVENUE");
const bank = chart.accounts.find((a) => a.acceptsPayments && a.class === "ASSET");
const tax = chart.taxRates.find((t) => t.rate > 0) ?? chart.taxRates[0];
if (!income || !bank || !tax) {
  step("the demo company has an income account, a bank account and a tax rate to try", false, "none found");
  finish();
}
step("the demo company has an income account, a bank account and a tax rate to try", true, `income ${income.code}, bank ${bank.code}, tax ${tax.type} at ${tax.rate}%`);

// A sale of 10.60 with the tax inside it, as the app would send it.
const stamp = Date.now();
const day = new Date().toISOString().slice(0, 10);
const gross = 1060;
const taxCents = Math.round((gross * tax.rate) / (100 + tax.rate));
const doc = (kind) => ({
  number: `MYSENAM-VERIFY-${kind}-${stamp}`,
  reference: `MySenam verification ${kind} ${stamp}`,
  date: day,
  contact: { name: "MySenam verification (synthetic)", email: null },
  lines: [{ description: "Synthetic check, not a sale", grossCents: gross, taxCents, accountCode: income.code, taxType: tax.type }],
});
const key = (kind) => crypto.createHash("sha256").update(`verify|${stamp}|${kind}`).digest("hex");
const attempt = async (name, fn) => {
  try {
    return await call(fn);
  } catch (err) {
    step(name, false, err instanceof Error ? err.message : String(err));
    return null;
  }
};

const invoice = await attempt("a sales invoice is created (authorised, tax inside)", () => xero.createInvoice(session, doc("INV"), key("INV")));
if (invoice) {
  step("a sales invoice is created (authorised, tax inside)", true, `number ${invoice.number}`);
  step("Xero's total is what was sent, to the cent", invoice.totalCents === gross, `sent ${gross}, Xero ${invoice.totalCents}`);
  step("Xero booked the tax as sent, not its own rounding", invoice.taxCents === taxCents, `sent ${taxCents}, Xero ${invoice.taxCents}`);
  const replay = await call(() => xero.createInvoice(session, doc("INV"), key("INV"))).catch((e) => e);
  if (replay instanceof ProviderError) step("sending the same invoice again is harmless", replay.kind === "duplicate", `Xero refused it: ${replay.kind}`);
  else step("sending the same invoice again is harmless (the same Idempotency-Key answers the same document)", replay.id === invoice.id, replay.id === invoice.id ? "same document" : "a second document was made");
  const found = await attempt("the invoice is found again by its number", () => xero.findInvoice(session, `MYSENAM-VERIFY-INV-${stamp}`));
  if (found) step("the invoice is found again by its number, and its reference is ours", found.id === invoice.id && found.reference === doc("INV").reference);
  const clash = await call(() => xero.createInvoice(session, doc("INV"), `${key("INV")}x`)).catch((e) => e);
  step("a second invoice of the same number is refused as a duplicate", clash instanceof ProviderError && clash.kind === "duplicate", clash instanceof ProviderError ? clash.kind : "it was accepted");
  const payment = await attempt("the payment is recorded against the invoice", () => xero.createPayment(session, { documentId: invoice.id, accountCode: bank.code, date: day, amountCents: gross, reference: doc("INV").reference }, key("PAY")));
  if (payment) {
    step("the payment is recorded against the invoice", true);
    const state = await attempt("the invoice reads as settled", () => xero.invoiceState(session, invoice.id));
    if (state) step("the invoice reads as settled", state.settled === true);
  }
}

const credit = await attempt("a credit note is created", () => xero.createCreditNote(session, doc("CN"), key("CN")));
if (credit) {
  step("a credit note is created", credit.totalCents === gross && credit.taxCents === taxCents, `Xero ${credit.totalCents} / tax ${credit.taxCents}`);
  const refund = await attempt("the refund is recorded against the credit note", () => xero.createRefund(session, { documentId: credit.id, accountCode: bank.code, date: day, amountCents: gross, reference: doc("CN").reference }, key("REF")));
  if (refund) {
    step("the refund is recorded against the credit note", true);
    const state = await attempt("the credit note reads as settled", () => xero.creditNoteState(session, credit.id));
    if (state) step("the credit note reads as settled", state.settled === true);
  }
}

result.notes.push("Not exercised here, and so not proven: 429 and Retry-After under real load, a 401 mid-run, Xero's daily limit. The demo company keeps the documents above.");
finish();
