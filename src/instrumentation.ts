/**
 * Startup: the scheduler, and checks.
 *
 * Next calls this once per server process, before the first request, which
 * makes it the right place to start the nightly backup and the outbox, and to
 * say out loud that a deployment is still holding its factory settings — the
 * kind of thing nobody notices until it is being exploited.
 *
 * Free of any database import at the top: this module is compiled for every
 * runtime, including the edge one, where the database drivers cannot be
 * resolved. The scheduler is imported inside the Node.js branch,
 * which is the one place it can be.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startScheduler } = await import("./lib/scheduler");
  startScheduler();

  if (process.env.NODE_ENV !== "production") return;

  const warn = (message: string) => console.warn(`[mysenam] ${message}`);

  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === "mysenam-admin")
    warn(
      "ADMIN_PASSWORD is unset or still the default. Anyone who knows this project owns every venue — set it and restart."
    );
  if (!process.env.ADMIN_EMAIL)
    warn("ADMIN_EMAIL is unset, so the first operator account is admin@mysenam.my.");
  if (!process.env.OFFSITE_S3_ENDPOINT || !process.env.OFFSITE_S3_BUCKET)
    warn(
      "Off-site copies are not set up (OFFSITE_S3_*), so every backup is on the same disk as the database it backs up."
    );
}
