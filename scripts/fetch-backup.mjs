#!/usr/bin/env node
/**
 * Bring a backup set back down from off-site storage and check it, before
 * anything is restored from it.
 *
 *   node scripts/fetch-backup.mjs --list
 *   node scripts/fetch-backup.mjs mysenam-2026-10-16-030000.dump --to /srv/restore
 *
 * The bucket is the one in OFFSITE_S3_* (docs/operations/backups.md), read
 * with a key that may list and read (OFFSITE_S3_READ_ACCESS_KEY_ID and
 * OFFSITE_S3_READ_SECRET_ACCESS_KEY): the server's own key may only upload,
 * so run this where you restore, with the read key in the environment. The
 * set's manifest comes first, then each part it names — decrypted with
 * OFFSITE_ENCRYPTION_PRIVATE_KEY_FILE if it was encrypted before upload;
 * then every part is hashed against the manifest. Exits non-zero if anything is missing or
 * differs. Where the bucket keeps versions, each part is fetched as first
 * uploaded, and a name written again since (by anybody holding the upload
 * key) is reported. Next: `node scripts/restore.mjs <file> --drill` restores
 * it somewhere harmless and counts what came back.
 */
import path from "node:path";
import { verifyBackupSet } from "../src/lib/backup.ts";
import { fetchOffsiteSet, listOffsite, offsiteReadConfig } from "../src/lib/offsite.ts";

const args = process.argv.slice(2);
const config = offsiteReadConfig();
if (!config) {
  console.error(
    "Off-site storage is not set: OFFSITE_S3_ENDPOINT, OFFSITE_S3_BUCKET, and a read key in OFFSITE_S3_READ_ACCESS_KEY_ID and OFFSITE_S3_READ_SECRET_ACCESS_KEY."
  );
  process.exit(1);
}

if (args.includes("--list") || args.length === 0) {
  let objects;
  try {
    objects = await listOffsite(config);
  } catch (err) {
    console.error(`Could not list the bucket: ${err instanceof Error ? err.message : String(err)}. Listing needs the read key (OFFSITE_S3_READ_*).`);
    process.exit(1);
  }
  const names = new Set(objects.map((o) => o.name));
  const sets = objects.filter((o) => /^mysenam-[\d-]+\.(dump|tar\.gz)(\.enc)?$/.test(o.name));
  if (sets.length === 0) console.log(`Nothing under ${config.prefix} in ${config.bucket}.`);
  for (const o of sets) {
    const snapshot = o.name.replace(/\.enc$/, "");
    const manifest = snapshot.replace(/\.(dump|tar\.gz)$/, ".manifest.json");
    console.log(
      `${snapshot}  ${(o.bytes / 1024 / 1024).toFixed(1)} MB  ${o.lastModified}  ${names.has(manifest) ? "whole (manifest)" : "no manifest: older, or not fully sent"}${o.name.endsWith(".enc") ? ", encrypted" : ""}${
        objects.some((p) => p.rewritten && (p.name === o.name || p.name === manifest)) ? ", WRITTEN AGAIN after upload: see docs/operations/backups.md" : ""
      }`
    );
  }
  process.exit(0);
}

const name = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--to");
const i = args.indexOf("--to");
const to = i === -1 ? path.join(process.cwd(), "restore") : args[i + 1];
if (!name) {
  console.error("Usage: node scripts/fetch-backup.mjs --list | <snapshot name> [--to DIR]");
  process.exit(1);
}

try {
  const fetched = await fetchOffsiteSet(config, path.basename(name), to);
  for (const f of fetched.files) console.log(`fetched ${f}`);
  if (!fetched.versioned) console.log("The bucket's versions could not be listed: these are the current copies, which the upload key could have replaced.");
  if (fetched.rewritten.length > 0)
    console.log(
      `Written again after upload, so the first upload was used: ${fetched.rewritten.join(", ")}. The server writes each name once: treat the upload key as stolen (docs/operations/backups.md).`
    );
  const check = await verifyBackupSet(fetched.snapshot);
  if (!check.ok) {
    console.error(`The set is not whole:\n  ${check.problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`Whole: every part matches its manifest. Next: node scripts/restore.mjs ${fetched.snapshot} --drill`);
} catch (err) {
  console.error(`Could not fetch it: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
