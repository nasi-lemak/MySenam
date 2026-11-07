/**
 * Startup on the Node.js runtime: the scheduler, and checks. Imported only
 * from src/instrumentation.ts, inside its Node.js branch.
 */
export async function startNode(): Promise<void> {
  // After a restore: erasures recorded since the backup, the newest retention
  // periods and the retention policy, applied again before anything is served
  // (lib/erasure-ledger.ts). Until that has succeeded, and while a restore
  // that could not show the ledger complete is not acknowledged, the app
  // does not serve at all.
  const { reapplyIfRestored, restoreGate } = await import("./lib/erasure-ledger");
  await reapplyIfRestored();
  const blocked = await restoreGate();
  if (blocked) {
    console.error(`[mysenam] Not serving.\n${blocked}`);
    process.exit(78);
  }

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
  // Staff two-factor sign-in is on for managers of a production marketplace and cannot be switched off by a setting: a setting that tried
  // is refused, said here and to the owners, and left on (ADR 0064).
  const { checkStaffTwoFactorSetting } = await import("./lib/two-factor");
  const refusedTwoFactor = await checkStaffTwoFactorSetting();
  if (refusedTwoFactor) console.error(`[mysenam] ${refusedTwoFactor}`);
  const { scanMode, withdrawnOptOutSet } = await import("./lib/document-scanner");
  if (scanMode() === "unconfigured")
    warn("No malware scanner is configured (MYSENAM_CLAMD): supporting documents sent with applications wait in quarantine, and nobody can open them, until one is.");
  if (withdrawnOptOutSet())
    warn("MYSENAM_DOCUMENT_SCAN=off is no longer read: supporting documents are never released without a malware scan. Remove it from the environment.");
  const { onDemandProblem } = await import("./lib/document-scanning");
  const onDemand = onDemandProblem();
  if (onDemand) warn(`The malware scanner to start on demand cannot be used (${onDemand}): supporting documents wait in quarantine until it can.`);
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
