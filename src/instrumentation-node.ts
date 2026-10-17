/**
 * Startup on the Node.js runtime: the scheduler, and checks. Imported only
 * from src/instrumentation.ts, inside its Node.js branch.
 */
export async function startNode(): Promise<void> {
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
