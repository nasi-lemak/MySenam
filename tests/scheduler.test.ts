import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";

process.env.MYSENAM_DB = ":memory:";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-"));
process.env.MYSENAM_BACKUP_DIR = dir;
// A data folder of its own, so the backup does not take whatever photos are on this machine.
process.env.MYSENAM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-data-"));

import { backupDue, backupHour, runScheduledWork, schedulerEnabled } from "../src/lib/scheduler";
import { listBackups } from "../src/lib/backup";
import { offsiteStatus } from "../src/lib/offsite";

/**
 * The once-a-minute tick: when the nightly backup is due, and that a due one
 * is taken and sent off-site.
 */

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

// 03:00 in Kuala Lumpur is 19:00 UTC the day before.
const at = (utc: string) => new Date(utc);

describe("when the nightly backup is due", () => {
  it("at the backup hour, once the last one is most of a day old", () => {
    expect(backupDue(at("2026-10-15T19:00:00Z"), 23, 3)).toBe(true);
    expect(backupDue(at("2026-10-15T19:59:00Z"), 20, 3)).toBe(true);
  });

  it("not twice in the same hour", () => {
    expect(backupDue(at("2026-10-15T19:30:00Z"), 0.5, 3)).toBe(false);
  });

  it("not at other hours", () => {
    expect(backupDue(at("2026-10-15T12:00:00Z"), 23, 3)).toBe(false);
  });

  it("straight away when there has never been one", () => {
    expect(backupDue(at("2026-10-15T12:00:00Z"), null, 3)).toBe(true);
  });

  it("straight away when the server was down at the hour", () => {
    expect(backupDue(at("2026-10-15T12:00:00Z"), 30, 3)).toBe(true);
  });

  it("at the hour the install asks for", () => {
    process.env.MYSENAM_BACKUP_HOUR = "5";
    try {
      expect(backupHour()).toBe(5);
      process.env.MYSENAM_BACKUP_HOUR = "25";
      expect(backupHour()).toBe(3);
    } finally {
      delete process.env.MYSENAM_BACKUP_HOUR;
    }
  });
});

describe("whether it runs at all", () => {
  afterEach(() => delete process.env.MYSENAM_SCHEDULER);

  it("is off in tests and development unless asked, and can always be switched off", () => {
    expect(schedulerEnabled()).toBe(false);
    process.env.MYSENAM_SCHEDULER = "on";
    expect(schedulerEnabled()).toBe(true);
    process.env.MYSENAM_SCHEDULER = "off";
    expect(schedulerEnabled()).toBe(false);
  });
});

describe("a tick", () => {
  let server: http.Server;
  const uploads: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      uploads.push(req.url!);
      req.resume();
      req.on("end", () => res.end());
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as { port: number };
    process.env.OFFSITE_S3_ENDPOINT = `http://127.0.0.1:${port}`;
    process.env.OFFSITE_S3_BUCKET = "backups";
    process.env.OFFSITE_S3_ACCESS_KEY_ID = "id";
    process.env.OFFSITE_S3_SECRET_ACCESS_KEY = "secret";
  });

  afterAll(() => {
    server.close();
    for (const k of Object.keys(process.env)) if (k.startsWith("OFFSITE_S3_")) delete process.env[k];
  });

  it("takes the first backup, verified, and copies it off-site", async () => {
    const result = await runScheduledWork();
    expect(result.backup).toMatchObject({ ok: true, offsite: { ok: true } });
    const [taken] = listBackups(dir);
    expect(result.backup?.name).toBe(taken.name);
    // The database, then its manifest, sent last.
    expect(uploads).toEqual([`/backups/mysenam/${taken.name}`, `/backups/mysenam/${taken.name.replace(/\.(dump|tar\.gz)$/, ".manifest.json")}`]);
    expect((await offsiteStatus()).lastCopied?.name).toBe(taken.name);
  });

  it("does nothing more a minute later", async () => {
    const result = await runScheduledWork();
    expect(result.backup).toBeNull();
    expect(listBackups(dir)).toHaveLength(1);
    expect(uploads).toHaveLength(2);
  });
});
