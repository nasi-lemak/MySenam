#!/usr/bin/env node
/**
 * Bring a backup set back down from off-site storage and check it, before
 * anything is restored from it.
 *
 *   node scripts/fetch-backup.mjs --list
 *   node scripts/fetch-backup.mjs mysenam-2026-10-16-030000.dump --to /srv/restore
 *
 * The bucket is the one in OFFSITE_S3_* (docs/operations/backups.md), read
 * with a key that may list and read: the server's own key may only upload,
 * so run this where you restore, with the read key in the environment. The
 * set's manifest comes first, then each part it names; then every part is
 * hashed against the manifest. Exits non-zero if anything is missing or
 * differs. Next: `node scripts/restore.mjs <file> --drill` restores it
 * somewhere harmless and counts what came back.
 */
import path from "node:path";
import { verifyBackupSet } from "../src/lib/backup.ts";
import { fetchOffsiteSet, listOffsite, offsiteConfig } from "../src/lib/offsite.ts";

const args = process.argv.slice(2);
const config = offsiteConfig();
if (!config) {
  console.error("Off-site storage is not set: OFFSITE_S3_ENDPOINT, OFFSITE_S3_BUCKET, OFFSITE_S3_ACCESS_KEY_ID and OFFSITE_S3_SECRET_ACCESS_KEY.");
  process.exit(1);
}

if (args.includes("--list") || args.length === 0) {
  const objects = await listOffsite(config);
  const names = new Set(objects.map((o) => o.name));
  const sets = objects.filter((o) => /^mysenam-[\d-]+\.(dump|tar\.gz)$/.test(o.name));
  if (sets.length === 0) console.log(`Nothing under ${config.prefix} in ${config.bucket}.`);
  for (const o of sets) {
    const manifest = o.name.replace(/\.(dump|tar\.gz)$/, ".manifest.json");
    console.log(`${o.name}  ${(o.bytes / 1024 / 1024).toFixed(1)} MB  ${o.lastModified}  ${names.has(manifest) ? "whole (manifest)" : "no manifest: older, or not fully sent"}`);
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
