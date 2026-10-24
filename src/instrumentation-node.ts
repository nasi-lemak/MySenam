/**
 * Startup on the Node.js runtime: the scheduler, and checks. Imported only
 * from src/instrumentation.ts, inside its Node.js branch.
 */
export async function startNode(): Promise<void> {
  const { startScheduler } = await import("./lib/scheduler");
  startScheduler();

  if (process.env.NODE_ENV !== "production") return;

  const warn = (message: string) => console.warn(`[mysenam] ${message}`);

  const { adminPasswordProblem, replaceDefaultOwnerPasswords } = await import("./lib/admin-auth");
  const problem = adminPasswordProblem();
  if (problem)
    warn(`${problem} The published default is refused in production, so no owner can sign in with it — set ADMIN_PASSWORD and restart.`);
  else {
    const replaced = await replaceDefaultOwnerPasswords().catch(() => 0);
    if (replaced > 0) warn(`${replaced} owner account(s) still had the default password; it is now ADMIN_PASSWORD.`);
  }
  if (!process.env.ADMIN_EMAIL)
    warn("ADMIN_EMAIL is unset, so the first operator account is admin@mysenam.my.");
  if (!process.env.OFFSITE_S3_ENDPOINT || !process.env.OFFSITE_S3_BUCKET)
    warn(
      "Off-site copies are not set up (OFFSITE_S3_*), so every backup is on the same disk as the database it backs up."
    );
  else {
    const { offsiteTransferCheck } = await import("./lib/offsite");
    const paused = offsiteTransferCheck();
    if (paused) warn(paused);
  }
}
