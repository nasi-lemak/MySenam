/**
 * Startup checks.
 *
 * Next calls this once per server process, before the first request, which
 * makes it the right place to say out loud that a deployment is still holding
 * its factory settings — the kind of thing nobody notices until it is being
 * exploited.
 *
 * Deliberately free of any database import: this module is compiled for every
 * runtime, including the edge one, where a native module like better-sqlite3
 * cannot be resolved. Anything that needs to read the database — how stale the
 * newest backup is, for instance — belongs behind a request instead.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV !== "production") return;

  const warn = (message: string) => console.warn(`[mysenam] ${message}`);

  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === "mysenam-admin")
    warn(
      "ADMIN_PASSWORD is unset or still the default. Anyone who knows this project owns every venue — set it and restart."
    );
  if (!process.env.ADMIN_EMAIL)
    warn("ADMIN_EMAIL is unset, so the first operator account is admin@mysenam.my.");
  if (!process.env.MYSENAM_BACKUP_DIR)
    warn(
      "MYSENAM_BACKUP_DIR is unset, so backups land beside the database. Keep a copy somewhere that is not this machine."
    );
}
