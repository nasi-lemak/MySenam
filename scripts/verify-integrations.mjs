#!/usr/bin/env node
/**
 * Check MySenam's integrations against the real providers' test or sandbox
 * services, with synthetic data, and say exactly what was proven:
 *
 *   node scripts/verify-integrations.mjs all
 *   node scripts/verify-integrations.mjs stripe [--through http://127.0.0.1:3900]
 *   node scripts/verify-integrations.mjs billplz [--through …]
 *   node scripts/verify-integrations.mjs email [--send]      (Amazon SES over HTTPS, or SMTP)
 *   node scripts/verify-integrations.mjs whatsapp [--send]
 *   node scripts/verify-integrations.mjs sms [--send]
 *   node scripts/verify-integrations.mjs b2
 *
 * Each provider is PASS, FAIL, PARTIAL (some steps could not run here) or
 * BLOCKED (its test credentials are not in the environment; the variables
 * needed are named). Nothing is ever printed of a credential: any value of
 * an environment variable that appears in an answer is replaced by ***.
 * Live keys are refused before anything is sent. Messages go only to the
 * test recipients named in VERIFY_*_TO, and only with --send.
 *
 * `--through <url>` drives a staging deployment (scripts/stage.mjs or
 * stage-remote.mjs) as a venue and a customer would, so the app's own
 * gateway code is what talks to the provider: the owner connects the
 * sandbox account, a customer books and pays on the provider's page in a
 * real browser, the booking is cancelled and refunded through the gateway.
 * Webhooks reach only a public address (stage-remote.mjs); on this machine
 * the payment is settled by the return page, which asks the provider.
 *
 * Results: artifacts/integrations/<provider>-<time>.json. Exit 1 if any FAIL.
 */
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "./lib/source.mjs";

/**
 * TXT records of a name, as strings; null when they could not be looked up at all (an empty list means the name has
 * none). Raw DNS (UDP) is refused from the cloud environment the checks run in, where every lookup then looks like
 * "no record" (the first run reported a DMARC record missing that was there), so this asks DNS over HTTPS when the
 * system resolver finds nothing, and says so when neither could answer.
 */
async function lookupTxt(name) {
  const direct = (await dns.resolveTxt(name).catch(() => [])).map((r) => r.join(""));
  if (direct.length > 0) return direct;
  for (const url of [`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=TXT`, `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`]) {
    try {
      const res = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const body = await res.json();
      return (body.Answer ?? []).filter((a) => a.type === 16).map((a) => String(a.data).replace(/^"|"$/g, "").replace(/"\s*"/g, ""));
    } catch {
      /* try the next */
    }
  }
  return null;
}

const args = process.argv.slice(2);
const which = args[0] ?? "all";
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? null;
};
const through = flag("--through");
const send = args.includes("--send");
const STRIPE = (process.env.STRIPE_API_URL ?? "https://api.stripe.com").replace(/\/$/, "");

/** Every value in the environment long enough to be a secret, so none is ever printed. */
const SECRETS = Object.entries(process.env)
  .filter(([k, v]) => v && v.length >= 8 && /KEY|TOKEN|SECRET|PASSWORD|AUTH|SMTP_URL|SIGNATURE/.test(k))
  .map(([, v]) => v);
export const redact = (text) => SECRETS.reduce((t, s) => t.split(s).join("***"), String(text));

function provider(name) {
  const result = { provider: name, status: "PASS", steps: [], needs: [] };
  return {
    result,
    step(stepName, ok, detail = "") {
      result.steps.push({ step: stepName, ok, detail: redact(detail) });
      console.log(`  ${ok === true ? "✔" : ok === false ? "✖" : "–"} ${stepName}${detail ? ` — ${redact(detail)}` : ""}`);
      if (ok === false) result.status = "FAIL";
      else if (ok === null && result.status === "PASS") result.status = "PARTIAL";
    },
    blocked(vars) {
      result.status = "BLOCKED";
      result.needs = vars;
      console.log(`  BLOCKED — set ${vars.join(", ")} (test or sandbox credentials) to run it`);
      return result;
    },
  };
}
const missing = (vars) => vars.filter((v) => !process.env[v]);

async function json(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// ------------------------------------------------------------ the app, as a venue and a customer

/** Sign the owner in at a deployment, and find a court to book tomorrow evening. */
async function asOwner(base) {
  const login = await fetch(`${base}/api/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ email: process.env.E2E_OWNER_EMAIL, password: process.env.E2E_OWNER_PASSWORD }),
  });
  if (login.status !== 200) throw new Error(`owner sign-in at ${base} answered ${login.status} (set E2E_OWNER_EMAIL and E2E_OWNER_PASSWORD)`);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const venues = (await json(`${base}/api/venues`)).body.venues ?? [];
  const venue = venues.find((v) => (v.courts ?? []).length > 0);
  if (!venue) throw new Error("the deployment has no venue with a court");
  const court = venue.courts[0];
  return { cookie, venue, court, call: (route, method, body) => json(`${base}${route}`, { method, headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined }) };
}

/** A customer's booking, paid on the provider's page in a real browser; returns the booking code and phone. */
async function bookAndOpenPayment(base, court) {
  const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const phone = `0187${String(Date.now()).slice(-6)}`;
  for (const hour of [20, 21, 19, 18, 17]) {
    const made = await json(`${base}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ courtId: court.id, date: day, hours: [hour], name: "Integration Check", phone }),
    });
    if (made.status === 200 || made.status === 201) {
      const code = made.body.booking?.code ?? made.body.bookings?.[0]?.code;
      const pay = await json(`${base}/api/payments`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ code, phone }) });
      return { code, phone, payUrl: pay.body.url, payStatus: pay.status, payError: pay.body.error };
    }
  }
  throw new Error("no hour could be booked for the check");
}

async function browser() {
  const { chromium } = await import("playwright-core");
  const local = "/opt/pw-browsers/chromium";
  return chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? (fs.existsSync(local) ? local : undefined), headless: true });
}

// ------------------------------------------------------------ Stripe

async function stripe() {
  const p = provider("stripe");
  console.log("Stripe (test mode)");
  const need = missing(["STRIPE_TEST_SECRET_KEY"]);
  if (need.length) return p.blocked(need);
  const key = process.env.STRIPE_TEST_SECRET_KEY;
  if (!/^(sk|rk)_test_/.test(key)) {
    p.step("test key only", false, "the key is not a test-mode key (sk_test_… or rk_test_…): refused, nothing sent");
    return p.result;
  }
  const auth = { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" };
  const balance = await json(`${STRIPE}/v1/balance`, { headers: auth });
  p.step("key accepted, test mode", balance.status === 200 && balance.body.livemode === false, `${balance.status}${balance.body.livemode ? " (LIVE mode!)" : ""}`);
  if (balance.status !== 200) return p.result;
  const currency = (process.env.STRIPE_TEST_CURRENCY ?? "sgd").toLowerCase();
  const form = new URLSearchParams({
    mode: "payment",
    success_url: "https://example.invalid/return?stripe_session={CHECKOUT_SESSION_ID}",
    cancel_url: "https://example.invalid/return?stripe_session={CHECKOUT_SESSION_ID}",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": currency,
    "line_items[0][price_data][unit_amount]": "1000",
    "line_items[0][price_data][product_data][name]": "MySenam integration check (synthetic)",
  });
  const session = await json(`${STRIPE}/v1/checkout/sessions`, { method: "POST", headers: { ...auth, "Idempotency-Key": `mysenam-check-${Date.now()}` }, body: form });
  p.step("Checkout Session created", session.status === 200 && !!session.body.url, `${session.status} ${session.body.id ?? session.body.error?.message ?? ""}`);
  if (session.body.id) {
    const read = await json(`${STRIPE}/v1/checkout/sessions/${session.body.id}`, { headers: auth });
    p.step("Checkout Session read back", read.status === 200 && read.body.payment_status === "unpaid", `${read.body.payment_status ?? read.status}`);
    const expired = await json(`${STRIPE}/v1/checkout/sessions/${session.body.id}/expire`, { method: "POST", headers: auth });
    p.step("Checkout Session expired (a cancelled page)", expired.status === 200 && expired.body.status === "expired", `${expired.body.status ?? expired.status}`);
  }
  if (!through) {
    p.step("through the app: payment, webhook, refund", null, "not run: give --through <staging address>");
    return p.result;
  }
  // Through the app: the venue's own account, as a venue connects it.
  let endpoint = null;
  try {
    const owner = await asOwner(through);
    const publicAddress = through.startsWith("https://");
    let webhookSecret = process.env.STRIPE_TEST_WEBHOOK_SECRET ?? null;
    if (publicAddress) {
      const made = await json(`${STRIPE}/v1/webhook_endpoints`, {
        method: "POST",
        headers: auth,
        body: new URLSearchParams([["url", `${through}/api/payments/stripe/callback`], ...["checkout.session.completed", "checkout.session.expired", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed"].map((e) => ["enabled_events[]", e])]),
      });
      endpoint = made.body.id ?? null;
      webhookSecret = made.body.secret ?? webhookSecret;
      p.step("webhook endpoint registered for the staging address", made.status === 200, `${made.status}`);
    }
    if (!webhookSecret) webhookSecret = "whsec_" + "x".repeat(24); // signature checks cannot pass without a public endpoint; the return page settles instead
    const saved = await owner.call(`/api/admin/venues/${owner.venue.id}/payment-settings`, "PUT", { provider: "stripe", credentials: { secretKey: key, webhookSecret }, sandbox: true, enabled: true });
    p.step("venue's Stripe account connected and checked by the app", saved.status === 200, `${saved.status} ${saved.body.error ?? ""}`);
    if (saved.status !== 200) return p.result;
    const booking = await bookAndOpenPayment(through, owner.court);
    p.step("the app opened a Stripe Checkout page", booking.payStatus === 200 && /checkout\.stripe\.com/.test(booking.payUrl ?? ""), `${booking.payStatus} ${booking.payError ?? ""}`);
    if (!booking.payUrl) return p.result;
    const b = await browser();
    try {
      const page = await b.newPage();
      await page.goto(booking.payUrl);
      await page.fill("#email", "integration-check@seed.mysenam.test");
      await page.fill("#cardNumber", "4242 4242 4242 4242");
      await page.fill("#cardExpiry", "12 / 34");
      await page.fill("#cardCvc", "123");
      await page.fill("#billingName", "Integration Check");
      await page.locator(".SubmitButton").click();
      await page.waitForURL(new RegExp(`^${through.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), { timeout: 60_000 });
      p.step("paid on Stripe's page with the test card, sent back to the app", true, page.url().replace(/stripe_session=[^&]+/, "stripe_session=…"));
    } finally {
      await b.close();
    }
    let paid = false;
    for (let i = 0; i < 30 && !paid; i++) {
      const look = await json(`${through}/api/bookings?code=${booking.code}&phone=${booking.phone}`);
      paid = look.body.booking?.paymentStatus === "paid";
      if (!paid) await new Promise((r) => setTimeout(r, 2000));
    }
    p.step(`booking marked paid (${publicAddress ? "webhook or return page" : "return page asking Stripe"})`, paid);
    const cancelled = await json(`${through}/api/bookings/cancel`, { method: "POST", headers: { "Content-Type": "application/json", Origin: through }, body: JSON.stringify({ code: booking.code, phone: booking.phone }) });
    p.step("customer cancelled; refund owed", cancelled.status === 200, `${cancelled.status}`);
    const owed = (await owner.call(`/api/admin/online-payments?venueId=${owner.venue.id}`, "GET")).body.refundsOwed ?? [];
    const payment = owed[0];
    if (payment) {
      const refunded = await owner.call("/api/admin/online-payments", "POST", { venueId: owner.venue.id, paymentId: payment.id, through: "gateway" });
      p.step("refunded through Stripe by the app", refunded.status === 200, `${refunded.status} ${refunded.body.error ?? (refunded.body.pending ? "pending" : "")}`);
    } else p.step("refunded through Stripe by the app", null, "no refund was owed (the venue may refund automatically): check the Stripe dashboard");
    if (!publicAddress) p.step("signed webhook delivery", null, "needs a public address: run against stage-remote.mjs");
  } catch (err) {
    p.step("through the app", false, err instanceof Error ? err.message : String(err));
  } finally {
    if (endpoint) await json(`${STRIPE}/v1/webhook_endpoints/${endpoint}`, { method: "DELETE", headers: auth });
  }
  return p.result;
}

// ------------------------------------------------------------ Billplz

async function billplz() {
  const p = provider("billplz");
  console.log("Billplz (sandbox)");
  const need = missing(["BILLPLZ_SANDBOX_API_KEY", "BILLPLZ_SANDBOX_COLLECTION_ID", "BILLPLZ_SANDBOX_X_SIGNATURE_KEY"]);
  if (need.length) return p.blocked(need);
  const host = (process.env.BILLPLZ_SANDBOX_URL ?? "https://www.billplz-sandbox.com").replace(/\/$/, "");
  if (/billplz\.com/.test(host) && !/sandbox/.test(host)) {
    p.step("sandbox only", false, "the address is not Billplz's sandbox: refused, nothing sent");
    return p.result;
  }
  const auth = { Authorization: `Basic ${Buffer.from(`${process.env.BILLPLZ_SANDBOX_API_KEY}:`).toString("base64")}` };
  const collection = await json(`${host}/api/v3/collections/${encodeURIComponent(process.env.BILLPLZ_SANDBOX_COLLECTION_ID)}`, { headers: auth });
  p.step("key and collection accepted by the sandbox", collection.status === 200, `${collection.status}`);
  if (collection.status !== 200) return p.result;
  const bill = await json(`${host}/api/v3/bills`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ collection_id: process.env.BILLPLZ_SANDBOX_COLLECTION_ID, email: "integration-check@seed.mysenam.test", name: "Integration Check", amount: "100", callback_url: "https://example.invalid/api/payments/billplz/callback", description: "MySenam integration check (synthetic)" }),
  });
  p.step("bill created", bill.status === 200 && !!bill.body.url, `${bill.status}`);
  if (bill.body.id) {
    const read = await json(`${host}/api/v3/bills/${bill.body.id}`, { headers: auth });
    p.step("bill read back, unpaid", read.status === 200 && read.body.paid === false, `${read.body.state ?? read.status}`);
    // The fields the app's settlement check (docs/integrations/payment-gateways.md#billplz, ADR 0065) relies on in the bill it fetches
    // for a redirect: its collection, its amount and what was paid, in sen. Whether a bill can be paid short or over is not proven here:
    // pay the sandbox bill that way by hand and compare the callback (see the step below).
    p.step(
      "bill carries collection_id, amount and paid_amount as the settlement check reads them",
      read.status === 200 && read.body.collection_id === process.env.BILLPLZ_SANDBOX_COLLECTION_ID && read.body.amount === 100 && read.body.paid_amount === 0,
      `collection_id ${read.body.collection_id ?? "missing"}, amount ${read.body.amount ?? "missing"}, paid_amount ${read.body.paid_amount ?? "missing"}`
    );
    const deleted = await fetch(`${host}/api/v3/bills/${bill.body.id}`, { method: "DELETE", headers: auth });
    p.step("bill deleted (an abandoned payment)", deleted.status === 200, `${deleted.status}`);
  }
  if (!through) {
    p.step("through the app: callback, redirect and manual refund record", null, "not run: give --through <staging address>");
    return p.result;
  }
  try {
    const owner = await asOwner(through);
    const saved = await owner.call(`/api/admin/venues/${owner.venue.id}/payment-settings`, "PUT", {
      provider: "billplz",
      credentials: { apiKey: process.env.BILLPLZ_SANDBOX_API_KEY, collectionId: process.env.BILLPLZ_SANDBOX_COLLECTION_ID, xSignatureKey: process.env.BILLPLZ_SANDBOX_X_SIGNATURE_KEY },
      sandbox: true,
      enabled: true,
    });
    p.step("venue's Billplz sandbox account connected and checked by the app", saved.status === 200, `${saved.status} ${saved.body.error ?? ""}`);
    const booking = await bookAndOpenPayment(through, owner.court);
    p.step("the app opened a Billplz sandbox bill", booking.payStatus === 200 && /billplz-sandbox\.com/.test(booking.payUrl ?? ""), `${booking.payStatus} ${booking.payError ?? ""}`);
    // Billplz's sandbox payment simulator is a page of its own, not an API: paying on it is the manual step.
    p.step("pay on the sandbox page; callback and signed redirect", null, `open the bill URL from the app (booking ${booking.code}) and pay with the sandbox bank; the callback needs a public address (stage-remote.mjs). Also record what the callback carried (id, collection_id, state, amount, paid_amount) and whether the sandbox can pay a bill short or over: until then settlement amounts are PENDING (docs/integrations/payment-gateways.md#billplz)`);
  } catch (err) {
    p.step("through the app", false, err instanceof Error ? err.message : String(err));
  }
  return p.result;
}

// ------------------------------------------------------------ email

async function email() {
  // Amazon SES over HTTPS is what the app uses when its four settings are all present (it wins over SMTP).
  const sesNames = ["SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "SES_REGION", "MAIL_FROM"];
  if (missing(sesNames).length === 0) return await emailSes();
  const p = provider("email");
  console.log("Email (SMTP and the sending domain's DNS)");
  const need = missing(["SMTP_URL", "MAIL_FROM"]);
  if (need.length) {
    // Neither way is set up: name both. If some SES settings are set, the missing SES ones are what is needed.
    const someSes = sesNames.slice(0, 3).some((v) => process.env[v]);
    console.log(`  (Amazon SES over HTTPS needs ${sesNames.join(", ")}; SMTP needs SMTP_URL and MAIL_FROM)`);
    return p.blocked(someSes && !process.env.SMTP_URL ? missing(sesNames) : need);
  }
  const domain = /@([^>\s]+)/.exec(process.env.MAIL_FROM)?.[1];
  if (!domain) {
    p.step("sender address", false, "MAIL_FROM has no address in it");
    return p.result;
  }
  const spfRecords = await lookupTxt(domain);
  const spf = spfRecords?.find((r) => r.startsWith("v=spf1"));
  p.step(`SPF for ${domain}`, spfRecords === null ? null : !!spf, spf ?? (spfRecords === null ? "could not look up DNS from here" : "no v=spf1 record"));
  const dmarcRecords = await lookupTxt(`_dmarc.${domain}`);
  const dmarc = dmarcRecords?.find((r) => r.startsWith("v=DMARC1"));
  const dmarcCount = dmarcRecords?.filter((r) => r.startsWith("v=DMARC1")).length ?? 0;
  p.step(`DMARC for ${domain}`, dmarcRecords === null ? null : dmarcCount === 1, dmarcCount > 1 ? `${dmarcCount} v=DMARC1 records: a receiver ignores them all, keep one` : dmarc ?? (dmarcRecords === null ? "could not look up DNS from here" : "no v=DMARC1 record"));
  if (process.env.DKIM_SELECTOR) {
    const dkim = (await txt(`${process.env.DKIM_SELECTOR}._domainkey.${domain}`)).find((r) => r.includes("p="));
    p.step(`DKIM key at ${process.env.DKIM_SELECTOR}._domainkey.${domain}`, !!dkim, dkim ? "published" : "no key found");
  } else p.step("DKIM", null, "set DKIM_SELECTOR to look its key up");
  const nodemailer = (await import("nodemailer")).default;
  const transport = nodemailer.createTransport(process.env.SMTP_URL);
  try {
    await transport.verify();
    p.step("SMTP connection and sign-in", true);
  } catch (err) {
    p.step("SMTP connection and sign-in", false, err instanceof Error ? err.message : String(err));
    return p.result;
  }
  if (send && process.env.VERIFY_EMAIL_TO) {
    const info = await transport.sendMail({ from: process.env.MAIL_FROM, to: process.env.VERIFY_EMAIL_TO, subject: `MySenam integration check ${new Date().toISOString()}`, text: "A synthetic message from scripts/verify-integrations.mjs. Check it arrived in the inbox, not spam, and that SPF, DKIM and DMARC pass in its headers." });
    p.step("message accepted for the test address", info.accepted.length > 0, info.messageId);
    p.step("arrived in the inbox, with SPF/DKIM/DMARC passing", null, "read the message's headers at the test address: not visible from here");
  } else p.step("send a message", null, "give --send and VERIFY_EMAIL_TO (an address you control)");
  p.step("bounces", null, "not read back by the app: watch the provider's dashboard (known limitations)");
  return p.result;
}

/** What AWS answers when the key itself is refused (not merely not allowed to read something). */
const SES_KEY_REFUSED = /UnrecognizedClient|InvalidSignature|SignatureDoesNotMatch|InvalidClientTokenId|ExpiredToken|IncompleteSignature|MissingAuthenticationToken/i;

/** Amazon SES over its HTTPS API, with the app's own client (src/lib/ses.ts). */
async function emailSes() {
  const p = provider("email");
  console.log("Email (Amazon SES over HTTPS, and the sending domain's DNS)");
  const { sesConfigFromEnv, sesCall, sendRawEmail } = await import("../src/lib/ses.ts");
  const config = sesConfigFromEnv();
  const domain = /@([^>\s]+)/.exec(config.from)?.[1];
  if (!domain) {
    p.step("sender address", false, "MAIL_FROM has no address in it");
    return p.result;
  }
  const said = (reply) => `${reply.status} ${reply.json?.message ?? reply.json?.Message ?? reply.type ?? ""}`.trim();
  const call = async (path) => {
    try {
      return { reply: await sesCall(config, { method: "GET", path }) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  // The account: is the key accepted, sandbox or production, the 24-hour quota, sending enabled.
  const account = await call("/v2/email/account");
  if (account.error) {
    p.step("Amazon SES reached with the key", false, account.error);
    return p.result;
  }
  const a = account.reply;
  if (a.status === 200) {
    p.step(`Amazon SES accepted the key in ${config.region}`, true);
    p.step("sending enabled for the account", a.json?.SendingEnabled === true, `SendingEnabled=${a.json?.SendingEnabled}`);
    const production = a.json?.ProductionAccessEnabled === true;
    p.step("production access (not the sandbox)", production ? true : null, production ? "production" : "sandbox: SES sends only to verified addresses and domains, and typically 200 a day; request production access in the SES console");
    const quota = a.json?.SendQuota ?? {};
    p.step("24-hour sending quota", null, `${quota.SentLast24Hours ?? "?"} sent of ${quota.Max24HourSend ?? "?"}, at most ${quota.MaxSendRate ?? "?"} a second`);
  } else if (SES_KEY_REFUSED.test(a.type ?? "")) {
    p.step(`Amazon SES accepted the key in ${config.region}`, false, said(a));
    return p.result;
  } else if (a.status === 403) {
    p.step("account details (sandbox or production, quota)", null, `could not read: the key may not be allowed ses:GetAccount (${said(a)}); sending is not affected`);
  } else {
    p.step("account details (sandbox or production, quota)", null, `could not read (${said(a)})`);
  }

  // The sending identity: the MAIL_FROM domain (or the address itself), its DKIM and whether it may send.
  const address = /<?([^<>\s]+@[^<>\s]+)>?\s*$/.exec(config.from)?.[1];
  let identity = await call(`/v2/email/identities/${encodeURIComponent(domain)}`);
  let named = domain;
  if (identity.reply?.status === 404 && address) {
    identity = await call(`/v2/email/identities/${encodeURIComponent(address)}`);
    named = address;
  }
  if (identity.error) p.step(`sending identity ${named}`, null, `could not read: ${identity.error}`);
  else if (identity.reply.status === 200) {
    const i = identity.reply.json ?? {};
    p.step(`${named} verified for sending in SES`, i.VerifiedForSendingStatus === true, `VerifiedForSendingStatus=${i.VerifiedForSendingStatus}`);
    const dkim = i.DkimAttributes?.Status;
    if (dkim === undefined) p.step(`DKIM for ${named}`, null, "none reported (an address identity has no DKIM of its own)");
    else p.step(`DKIM for ${named}`, dkim === "SUCCESS", `status ${dkim}${i.DkimAttributes?.SigningEnabled === false ? ", signing disabled" : ""}`);
    if (i.MailFromAttributes?.MailFromDomain)
      p.step(`custom MAIL FROM ${i.MailFromAttributes.MailFromDomain}`, i.MailFromAttributes.MailFromDomainStatus === "SUCCESS" ? true : null, `status ${i.MailFromAttributes.MailFromDomainStatus}`);
  } else if (identity.reply.status === 404) {
    p.step(`sending identity ${domain}`, false, "SES has no identity for the MAIL_FROM domain or address: it will refuse to send from it (verify the domain in the SES console)");
  } else {
    p.step(`sending identity ${named}`, null, `could not read: the key may not be allowed ses:GetEmailIdentity (${said(identity.reply)}); sending is not affected`);
  }

  // DMARC and SPF in the domain's DNS (SES signs with DKIM; SPF matters only for a custom MAIL FROM domain).
  const dmarcRecords = await lookupTxt(`_dmarc.${domain}`);
  const dmarc = dmarcRecords?.find((r) => r.startsWith("v=DMARC1"));
  const dmarcCount = dmarcRecords?.filter((r) => r.startsWith("v=DMARC1")).length ?? 0;
  p.step(`DMARC for ${domain}`, dmarcRecords === null ? null : dmarcCount === 1, dmarcCount > 1 ? `${dmarcCount} v=DMARC1 records: a receiver ignores them all, keep one` : dmarc ?? (dmarcRecords === null ? "could not look up DNS from here" : "no v=DMARC1 record"));
  const spfRecords = await lookupTxt(domain);
  const spf = spfRecords?.find((r) => r.startsWith("v=spf1"));
  p.step(`SPF for ${domain}`, spf ? true : null, spf ?? (spfRecords === null ? "could not look up DNS from here" : "no v=spf1 record on the domain itself (SES's own or a custom MAIL FROM domain carries SPF; DMARC passes through DKIM)"));

  if (send && process.env.VERIFY_EMAIL_TO) {
    try {
      const nodemailer = (await import("nodemailer")).default;
      const mime = await nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" }).sendMail({
        from: config.from,
        to: process.env.VERIFY_EMAIL_TO,
        subject: `MySenam integration check ${new Date().toISOString()}`,
        text: "A synthetic message from scripts/verify-integrations.mjs. Check it arrived in the inbox, not spam, and that SPF, DKIM and DMARC pass in its headers.",
      });
      const sent = await sendRawEmail(config, { from: config.from, to: process.env.VERIFY_EMAIL_TO, raw: mime.message });
      p.step("message accepted by SES for the test address", !!sent.providerId, sent.providerId ?? "no message id");
      p.step("arrived in the inbox, with SPF/DKIM/DMARC passing", null, "read the message's headers at the test address: not visible from here");
    } catch (err) {
      p.step("message accepted by SES for the test address", false, err instanceof Error ? err.message : String(err));
    }
  } else p.step("send a message", null, "give --send and VERIFY_EMAIL_TO (an address you control; in the sandbox it must be verified in SES)");
  p.step("bounces", null, "not read back by the app: watch the SES console's reputation dashboard, or a configuration set's event destination (known limitations)");
  return p.result;
}

// ------------------------------------------------------------ WhatsApp and SMS

async function whatsapp() {
  const p = provider("whatsapp");
  console.log("WhatsApp Cloud API");
  const need = missing(["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]);
  if (need.length) return p.blocked(need);
  const version = process.env.WHATSAPP_API_VERSION ?? "v23.0";
  const graph = (process.env.WHATSAPP_GRAPH_URL ?? "https://graph.facebook.com").replace(/\/$/, "");
  const auth = { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
  const number = await json(`${graph}/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,quality_rating,verified_name`, { headers: auth });
  p.step("token and phone number accepted", number.status === 200, `${number.status} ${number.body.display_phone_number ?? number.body.error?.message ?? ""}`);
  if (send && process.env.VERIFY_WHATSAPP_TO && number.status === 200) {
    const sent = await json(`${graph}/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: process.env.VERIFY_WHATSAPP_TO, type: "template", template: { name: process.env.VERIFY_WHATSAPP_TEMPLATE ?? "hello_world", language: { code: "en_US" } } }),
    });
    p.step("template sent to the test number", sent.status === 200, `${sent.status} ${sent.body.messages?.[0]?.id ?? sent.body.error?.message ?? ""}`);
  } else p.step("send a template", null, "give --send and VERIFY_WHATSAPP_TO (an approved test number)");
  return p.result;
}

async function sms() {
  const p = provider("sms");
  console.log("SMS (Twilio)");
  const need = missing(["SMS_TWILIO_ACCOUNT_SID", "SMS_TWILIO_AUTH_TOKEN"]);
  if (need.length) return p.blocked(need);
  const base = (process.env.TWILIO_API_URL ?? "https://api.twilio.com").replace(/\/$/, "");
  const auth = { Authorization: `Basic ${Buffer.from(`${process.env.SMS_TWILIO_ACCOUNT_SID}:${process.env.SMS_TWILIO_AUTH_TOKEN}`).toString("base64")}` };
  const account = await json(`${base}/2010-04-01/Accounts/${process.env.SMS_TWILIO_ACCOUNT_SID}.json`, { headers: auth });
  p.step("account credentials accepted", account.status === 200, `${account.status} ${account.body.status ?? ""}`);
  if (send && process.env.VERIFY_SMS_TO && process.env.SMS_FROM && account.status === 200) {
    const sent = await json(`${base}/2010-04-01/Accounts/${process.env.SMS_TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: process.env.VERIFY_SMS_TO, From: process.env.SMS_FROM, Body: "MySenam integration check (synthetic)." }),
    });
    p.step("message sent to the test number", sent.status === 201, `${sent.status} ${sent.body.sid ?? sent.body.message ?? ""}`);
  } else p.step("send a message", null, "give --send, VERIFY_SMS_TO (a number you control) and SMS_FROM");
  return p.result;
}

// ------------------------------------------------------------ Backblaze B2

async function b2() {
  const p = provider("b2");
  console.log("Off-site backups (Backblaze B2 or S3): scripts/verify-offsite.mjs");
  const need = missing(["OFFSITE_S3_ENDPOINT", "OFFSITE_S3_BUCKET", "OFFSITE_S3_ACCESS_KEY_ID", "OFFSITE_S3_SECRET_ACCESS_KEY", "OFFSITE_S3_READ_ACCESS_KEY_ID", "OFFSITE_S3_READ_SECRET_ACCESS_KEY", "OFFSITE_ENCRYPTION_PUBLIC_KEY_FILE", "OFFSITE_ENCRYPTION_PRIVATE_KEY_FILE", "OFFSITE_DATA_LOCATION"]);
  if (need.length) return p.blocked(need);
  const report = path.join(ROOT, "artifacts", "integrations", `b2-offsite-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(report), { recursive: true });
  const run = spawnSync(process.execPath, [path.join(ROOT, "scripts", "verify-offsite.mjs"), "--go", "--report", report], { encoding: "utf8" });
  console.log(redact(run.stdout ?? ""));
  p.step("verify-offsite against the real bucket", run.status === 0, `report ${path.relative(ROOT, report)}`);
  return p.result;
}

const ALL = { stripe, billplz, email, whatsapp, sms, b2 };
const chosen = which === "all" ? Object.keys(ALL) : [which];
if (chosen.some((c) => !ALL[c])) {
  console.error(`Providers: ${Object.keys(ALL).join(", ")}, or all.`);
  process.exit(2);
}
const results = [];
for (const name of chosen) {
  try {
    results.push(await ALL[name]());
  } catch (err) {
    results.push({ provider: name, status: "FAIL", steps: [{ step: "run", ok: false, detail: redact(err instanceof Error ? err.message : String(err)) }], needs: [] });
    console.log(`  ✖ ${redact(err instanceof Error ? err.message : String(err))}`);
  }
}
const out = path.join(ROOT, "artifacts", "integrations", `${which}-${Date.now()}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), through, results }, null, 2));
console.log(`\n${results.map((r) => `${r.provider}: ${r.status}`).join(", ")}\nReport: ${path.relative(ROOT, out)}`);
process.exit(results.some((r) => r.status === "FAIL") ? 1 : 0);
