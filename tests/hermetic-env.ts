/**
 * The suites never talk to a real service, and must not be able to: they run
 * in environments (the cloud sessions the real-service checks run in) that
 * hold test credentials for email, WhatsApp, payments and off-site storage.
 * A test that signs somebody up would then queue, and try to send, a real
 * message, and one that backs up would try to upload. Every variable that
 * names a provider's credential or address is taken out of the process the
 * tests run in, and out of the server the browser suites start; a test that
 * needs one sets it for itself.
 */
const PROVIDER = /^(SMTP_|MAIL_FROM$|SES_|WHATSAPP_|SMS_|BILLPLZ_|STRIPE_|OFFSITE_|PHOTOS_S3_|MYINVOIS_|GOOGLE_CLIENT_|SENTRY_|DKIM_|VERIFY_|MYSENAM_ALERT_WEBHOOK$)/;

export function withoutProviderEnv<T extends Record<string, string | undefined>>(env: T): T {
  const out = { ...env };
  for (const name of Object.keys(out)) if (PROVIDER.test(name)) delete out[name];
  return out;
}

export function scrubProviderEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of Object.keys(env)) if (PROVIDER.test(name)) delete env[name];
}
