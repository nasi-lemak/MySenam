#!/usr/bin/env node
/**
 * Write the Render Blueprint for one venue business's own copy.
 *
 *   npm run new-tenant -- arena "Arena Sports Booking"
 *
 * Writes deploy/render/arena.yaml from deploy/render/tenant.template.yaml with
 * the service named mysenam-arena and SITE_NAME set. Refuses to overwrite one
 * that exists: that file is a live tenant's configuration.
 *
 * Usage: node scripts/new-tenant.mjs <slug> "<Site Name>" [--dir DIR] [--plan PLAN]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const [value] = args.splice(i, 2).slice(1);
  return value;
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = flag("dir", path.join(root, "deploy", "render"));
const plan = flag("plan", "0.5c-512mb");
const [slug, name] = args;

if (!slug || !name) {
  console.error('Usage: npm run new-tenant -- <slug> "<Site Name>"');
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(slug) || slug === "tenant") {
  console.error("The slug is lower-case letters, digits and dashes, 2 to 31 long: it names the service.");
  process.exit(1);
}
if (/["\\\n]/.test(name) || name.trim().length < 2 || name.length > 60) {
  console.error("The site name is 2 to 60 characters, without quotes or backslashes.");
  process.exit(1);
}

const target = path.join(dir, `${slug}.yaml`);
if (fs.existsSync(target)) {
  console.error(`${path.relative(process.cwd(), target)} already exists — that is a live tenant. Pick another slug.`);
  process.exit(1);
}

const template = fs.readFileSync(path.join(root, "deploy", "render", "tenant.template.yaml"), "utf8");
const body = template
  .replace(/^# One venue business[\s\S]*?(?=^services:)/m,
    `# ${name.trim()} — written by npm run new-tenant. In Render: New → Blueprint,\n` +
    `# this repository, Blueprint path ${path.relative(root, target)}.\n`)
  .replaceAll("__SERVICE__", `mysenam-${slug}`)
  .replaceAll("__PLAN__", plan)
  .replaceAll("__SITE_NAME__", name.trim());

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(target, body);
console.log(`Wrote ${path.relative(process.cwd(), target)}. Commit it, then create the Blueprint from it.`);
