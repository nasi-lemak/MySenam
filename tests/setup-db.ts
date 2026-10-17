/**
 * A database of its own for every test file.
 *
 * Without a server, each file gets a fresh PGlite in memory and this does
 * nothing. With TEST_DATABASE_URL pointing at a Postgres server, the suite runs
 * against real Postgres instead: each file gets a new, empty database there —
 * files run side by side, and each expects to start from the four seeded
 * venues and nothing else — which is dropped again when the file is done.
 */
import { afterAll } from "vitest";
import pg from "pg";

const server = process.env.TEST_DATABASE_URL;

if (server) {
  const name = `mysenam_test_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
  const admin = async (sql: string) => {
    const client = new pg.Client({ connectionString: server });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };
  await admin(`CREATE DATABASE ${name}`);
  const url = new URL(server);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();

  afterAll(async () => {
    const { getDb } = await import("../src/lib/db");
    await getDb().close();
    await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  });
}
