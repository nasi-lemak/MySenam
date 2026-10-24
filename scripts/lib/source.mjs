/**
 * What source a build, an image or a test run was made from: the commit,
 * whether the working tree differed from it, and a digest of the exact
 * content (the commit's tree, any uncommitted change and any untracked file
 * git does not ignore). Two runs with the same digest tested the same code,
 * whatever the commit message; one change anywhere gives another.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });

export function sourceState() {
  // Outside a git checkout (a copy of the files), nothing can be said about the source.
  try {
    git("rev-parse", "HEAD");
  } catch {
    return { commit: "unknown", short: "unknown", dirty: null, digest: "unknown" };
  }
  const commit = git("rev-parse", "HEAD").toString().trim();
  const tree = git("rev-parse", "HEAD^{tree}").toString().trim();
  const diff = git("diff", "HEAD", "--binary");
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z").toString().split("\0").filter(Boolean).sort();
  const hash = crypto.createHash("sha256").update(tree).update("\0").update(diff);
  for (const file of untracked) {
    hash.update(`\0${file}\0`);
    try {
      hash.update(fs.readFileSync(path.join(ROOT, file)));
    } catch {
      // gone since it was listed
    }
  }
  return { commit, short: commit.slice(0, 12), dirty: diff.length > 0 || untracked.length > 0, digest: hash.digest("hex") };
}
