import { AsyncLocalStorage } from "async_hooks";
import fs from "fs";
import path from "path";
import { region } from "./region.ts";

/**
 * The database: Postgres.
 *
 * In production that is a real server, named by DATABASE_URL. Everywhere else
 * — development, the tests, a demo with nothing set up — it is PGlite: the
 * same Postgres, compiled to run inside this process, on a folder on disk or
 * in memory. One SQL dialect either way, so what passes the tests is what runs.
 *
 * The rest of the code talks to it through `getDb()`, in the shape it always
 * had — `prepare(sql).get / .all / .run`, `?` placeholders, `transaction(fn)` —
 * except that every call is now awaited.
 *
 * **Transactions are SERIALIZABLE, and retried.** The code was written when
 * one process answered one request at a time, so "read the balance, then
 * charge it" could never be interleaved. With an asynchronous database it can
 * be, and serializable isolation is what makes those reads and writes behave
 * as if nothing else were running — which is exactly the old guarantee. When
 * Postgres detects that two of them could not both have happened in some
 * order, one is rolled back and run again from the start, so the function
 * passed to `transaction` must do nothing but database work.
 */

export interface RunResult {
  changes: number;
  /** The `id` of the row an INSERT made, or null when it made none or has no id. */
  lastInsertRowid: number | null;
}

export interface Statement {
  get(...params: unknown[]): Promise<unknown>;
  all(...params: unknown[]): Promise<unknown[]>;
  run(...params: unknown[]): Promise<RunResult>;
}

export interface Db {
  prepare(sql: string): Statement;
  /** Several statements at once, with no parameters — schema work. */
  exec(sql: string): Promise<void>;
  /**
   * Wrap `fn` so each call runs in one serializable transaction, retried on a
   * serialization failure. Inside it, every query on this Db joins it; a
   * transaction started inside another becomes a savepoint within it.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R>;
  /** Which kind of Postgres this is, for the few things that differ. */
  readonly kind: "postgres" | "pglite";
  /** Close the connection. Tests and scripts only. */
  close(): Promise<void>;
  /** PGlite only: its whole data folder, gzipped, as a backup is taken. */
  dumpDataDir(): Promise<Uint8Array>;
}

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

/** Something that can run a query: the pool, PGlite, or a transaction's client. */
interface Runner {
  query(sql: string, params: unknown[]): Promise<QueryResult>;
  /** Several statements, no parameters. */
  exec(sql: string): Promise<void>;
}

interface Driver extends Runner {
  kind: "postgres" | "pglite";
  exec(sql: string): Promise<void>;
  /** Run fn on one connection inside BEGIN … COMMIT. */
  inTransaction<R>(fn: (runner: Runner) => Promise<R>): Promise<R>;
  close(): Promise<void>;
  /** For the migration runner: hold a lock other processes starting up will wait on. */
  lockMigrations?<R>(fn: () => Promise<R>): Promise<R>;
  dumpDataDir?(): Promise<Uint8Array>;
}

// ------------------------------------------------------------ configuration

/**
 * Where the database is.
 *
 * DATABASE_URL=postgres://… — a Postgres server. The production setting.
 * DATABASE_URL=pglite:/path — PGlite, kept in that folder.
 * DATABASE_URL=pglite:memory, or MYSENAM_DB=:memory: — PGlite in memory, gone
 *   when the process ends. What the tests use.
 * Nothing set — PGlite in data/pglite, so `npm run dev` needs no setup.
 */
export function databaseTarget(): { kind: "postgres"; url: string } | { kind: "pglite"; dir: string | null } {
  const url = process.env.DATABASE_URL?.trim();
  if (url && /^postgres(ql)?:\/\//i.test(url)) return { kind: "postgres", url };
  if (url?.startsWith("pglite:")) {
    const where = url.slice("pglite:".length);
    return { kind: "pglite", dir: where === "memory" || where === "" ? null : path.resolve(where) };
  }
  if (process.env.MYSENAM_DB === ":memory:") return { kind: "pglite", dir: null };
  return { kind: "pglite", dir: path.join(dataDirectory(), "pglite") };
}

/**
 * Where the install keeps what is not in the database: the key that unlocks
 * stored credentials, and backups unless told otherwise.
 */
export function dataDirectory(): string {
  return path.resolve(process.env.MYSENAM_DATA_DIR || path.join(process.cwd(), "data"));
}

/** Is everything kept in memory, so nothing should be written to disk? */
export function isEphemeral(): boolean {
  const target = databaseTarget();
  return target.kind === "pglite" && target.dir === null;
}

/** A description of where the data lives, without any password in it. */
export function databaseLabel(): string {
  const target = databaseTarget();
  if (target.kind === "pglite") return target.dir ? `PGlite ${target.dir}` : "PGlite (in memory)";
  try {
    const u = new URL(target.url);
    return `Postgres ${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "Postgres";
  }
}

// ------------------------------------------------------------ drivers

const INT8 = 20;
const NUMERIC = 1700;

async function postgresDriver(url: string): Promise<Driver> {
  const pg = (await import("pg")).default;
  // COUNT(*) and SUM() come back as int8, money as numeric; both are strings
  // by default, to protect values JavaScript cannot hold exactly. Nothing here
  // comes near that, and every caller expects a number.
  pg.types.setTypeParser(INT8, (v: string) => Number(v));
  pg.types.setTypeParser(NUMERIC, (v: string) => Number(v));
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    // No JIT: every query here is a short lookup, and a plan the planner merely
    // guesses is dear (a capacity sweep over claims easily is) would spend over
    // a second compiling to save a millisecond. Set before the pool hands the
    // connection out, so it never overlaps the caller's first query; a pooler
    // that refuses it only costs speed.
    onConnect: async (client) => {
      await client.query("SET jit = off").catch(() => {});
    },
  });
  // A connection sitting idle in the pool can be cut — the server restarting,
  // a network blip. Unheard, that error would take the whole process down;
  // the pool has already thrown the connection away and opens a new one.
  pool.on("error", (err) => console.error(`[db] idle connection lost: ${err.message}`));
  const toResult = (r: { rows: Record<string, unknown>[]; rowCount: number | null }): QueryResult => ({
    rows: r.rows,
    rowCount: r.rowCount ?? 0,
  });
  return {
    kind: "postgres",
    async query(sql, params) {
      return toResult(await pool.query(sql, params));
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async inTransaction(fn) {
      const client = await pool.connect();
      // Cut while checked out (the server restarting, an administrator ending
      // it): the pool's own listener is for idle connections only, and an error
      // nobody hears takes the whole process down. Heard here, the query in
      // hand fails, the transaction is not committed, and the connection is
      // thrown away rather than handed to the next request.
      let lost: Error | undefined;
      const onLost = (err: Error) => {
        lost = err;
        console.error(`[db] connection lost in a transaction: ${err.message}`);
      };
      client.on("error", onLost);
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        const result = await fn({
          query: async (sql, params) => toResult(await client.query(sql, params)),
          // No values: the simple protocol, which takes many statements at once.
          exec: async (sql) => {
            await client.query(sql);
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.off("error", onLost);
        client.release(lost);
      }
    },
    async lockMigrations(fn) {
      const client = await pool.connect();
      let lost: Error | undefined;
      const onLost = (err: Error) => {
        lost = err;
        console.error(`[db] connection lost while migrating: ${err.message}`);
      };
      client.on("error", onLost);
      try {
        // Any constant will do, as long as it is always the same one.
        await client.query("SELECT pg_advisory_lock(7419266)");
        try {
          return await fn();
        } finally {
          await client.query("SELECT pg_advisory_unlock(7419266)");
        }
      } finally {
        client.off("error", onLost);
        client.release(lost);
      }
    },
    async close() {
      await pool.end();
    },
  };
}

async function pgliteDriver(dir: string | null): Promise<Driver> {
  const { PGlite, types } = await import("@electric-sql/pglite");
  const { citext } = await import("@electric-sql/pglite/contrib/citext");
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const db = await PGlite.create(dir ?? undefined, {
    extensions: { citext },
    parsers: {
      [types.INT8]: (v: string) => Number(v),
      [types.NUMERIC]: (v: string) => Number(v),
    },
  });
  type Queryable = {
    query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>;
    exec: (sql: string) => Promise<unknown>;
  };
  const run = async (on: Queryable, sql: string, params: unknown[]): Promise<QueryResult> => {
    const r = await on.query(sql, params);
    return { rows: r.rows as Record<string, unknown>[], rowCount: r.affectedRows ?? r.rows.length };
  };
  return {
    kind: "pglite",
    query: (sql, params) => run(db as unknown as Queryable, sql, params),
    async exec(sql) {
      await db.exec(sql);
    },
    // PGlite is one connection, and holds everything else back while a
    // transaction runs on it, so it is serializable by construction.
    inTransaction: (fn) =>
      db.transaction((tx) =>
        fn({
          query: (sql, params) => run(tx as unknown as Queryable, sql, params),
          exec: async (sql) => {
            await (tx as unknown as Queryable).exec(sql);
          },
        })
      ),
    async close() {
      await db.close();
    },
    async dumpDataDir() {
      const blob = await db.dumpDataDir("gzip");
      return new Uint8Array(await blob.arrayBuffer());
    },
  };
}

// ------------------------------------------------------------ SQL

const converted = new Map<string, string>();

/**
 * `?` placeholders, as the queries are written, to Postgres's `$1, $2…`.
 * Question marks inside quoted strings or identifiers are left alone.
 */
export function toPostgresParams(sql: string): string {
  const cached = converted.get(sql);
  if (cached !== undefined) return cached;
  let out = "";
  let n = 0;
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    // A -- comment runs to the end of its line, and may say anything.
    if (!quote && c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (quote) {
      out += c;
      if (c === quote) quote = sql[i + 1] === quote ? (out += sql[++i], quote) : null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      out += c;
    } else if (c === "?") {
      out += `$${++n}`;
    } else {
      out += c;
    }
  }
  converted.set(sql, out);
  return out;
}

/** An INSERT that says nothing back is made to return its row, for its id. */
function withReturning(sql: string): string {
  return /^\s*insert\b/i.test(sql) && !/\breturning\b/i.test(sql) ? `${sql.replace(/;\s*$/, "")} RETURNING *` : sql;
}

/**
 * better-sqlite3 accepted booleans as 1/0 and undefined as NULL; keep both
 * true here so a caller's habits carry over.
 */
function param(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return Number(v);
  return v;
}

// ------------------------------------------------------------ the handle

/**
 * One connection per process, not per bundle.
 *
 * Next compiles the startup code (src/instrumentation.ts, which runs the
 * scheduler) apart from the routes, so a module-level variable here exists
 * once in each. Against Postgres that was two pools; against PGlite it was two
 * databases on one folder, in one process, which corrupts it. Everything that
 * must be one-per-process lives on globalThis instead.
 */
interface Shared {
  txStore: AsyncLocalStorage<Runner>;
  savepoints: number;
  driverPromise: Promise<Driver> | null;
  ready: Promise<void> | null;
  handle: Db | null;
}
const shared = ((globalThis as { __mysenamDb?: Shared }).__mysenamDb ??= {
  txStore: new AsyncLocalStorage<Runner>(),
  savepoints: 0,
  driverPromise: null,
  ready: null,
  handle: null,
});
const txStore = shared.txStore;

/** Serialization failure and deadlock: run the transaction again. */
const RETRYABLE = new Set(["40001", "40P01"]);
const MAX_ATTEMPTS = 10;
/**
 * Exponential backoff with full jitter: transactions that collided wait a
 * random time up to a ceiling that doubles each try (10, 20, 40… ms, capped
 * at 400), so they spread out rather than meeting again. Ten tries wait about
 * two seconds at most in all.
 */
const backoff = (attempt: number) => Math.random() * Math.min(400, 10 * 2 ** (attempt - 1));

/** How transactions have fared since the process started (or since `resetTransactionStats`). */
export interface TransactionStats {
  /** Outermost transactions run to the end, committed or not. */
  transactions: number;
  /** Tries that were run again, by the Postgres error code that ended them. */
  retries: Record<string, number>;
  /** Transactions that ran out of tries. */
  exhausted: number;
  /** Statements sent through `prepare`, in transactions or not. */
  queries: number;
}
const stats: TransactionStats = { transactions: 0, retries: {}, exhausted: 0, queries: 0 };
export function transactionStats(): TransactionStats {
  return { ...stats, retries: { ...stats.retries } };
}
export function resetTransactionStats(): void {
  stats.transactions = 0;
  stats.retries = {};
  stats.exhausted = 0;
  stats.queries = 0;
}

/**
 * A transaction that kept colliding with others until it ran out of tries.
 * Nothing it did was kept; the request can be made again (a route answers
 * `503` with `Retry-After`).
 */
export class BusyError extends Error {
  readonly code = "BUSY";
  // No parameter property: the scripts load this file through Node's type stripping, which cannot run one.
  constructor(cause: unknown) {
    super("The database was too busy to finish this; nothing was saved. Please try again.", { cause });
  }
}
export function isBusy(err: unknown): err is BusyError {
  return err instanceof BusyError;
}


/**
 * An install upgraded from the SQLite version, still pointed at its old file.
 *
 * Started as it is, it would open a new, empty database beside the old one,
 * seed the starter venues into it, and look to its staff as if everything had
 * gone. Better not to start, and to say how to bring the data across.
 */
function sqliteLeftBehind(): string | null {
  if (process.env.DATABASE_URL?.trim()) return null;
  const legacy = process.env.MYSENAM_DB ?? process.env.MUDAHTEMPAH_DB;
  const leftInDataFolder = () =>
    fs.existsSync(path.join(dataDirectory(), "pglite"))
      ? undefined
      : ["mysenam.db", "mudahtempah.db"].map((f) => path.join(dataDirectory(), f)).find((f) => fs.existsSync(f));
  const file = legacy && legacy !== ":memory:" ? path.resolve(legacy) : legacy ? undefined : leftInDataFolder();
  if (!file) return null;
  return (
    `MySenam now keeps its data in Postgres, and ${file} is from the SQLite version. ` +
    `Set DATABASE_URL (or MYSENAM_DATA_DIR for PGlite) instead of MYSENAM_DB, then bring the data ` +
    `across with: npm run import-sqlite -- ${file}`
  );
}

function driver(): Promise<Driver> {
  if (!shared.driverPromise) {
    const leftBehind = sqliteLeftBehind();
    if (leftBehind) return Promise.reject(new Error(leftBehind));
    const target = databaseTarget();
    shared.driverPromise = target.kind === "postgres" ? postgresDriver(target.url) : pgliteDriver(target.dir);
  }
  return shared.driverPromise;
}

/** The driver, with the schema migrated and the first venues seeded. */
function opened(): Promise<Driver> {
  if (!shared.ready) {
    shared.ready = (async () => {
      const d = await driver();
      await migrate(d);
      // The built-in activities, as this release has them, and the catalogue read (lib/activities.ts).
      // Under the same lock as migrations, taken again: servers starting together on an empty
      // database seed one after another, so the second finds the venues there rather than
      // colliding with the first's serializable seed.
      const { syncActivities } = await import("./activities.ts");
      const firstRun = async () => {
        await syncActivities(d);
        await seedIfEmpty();
      };
      await (d.lockMigrations ? d.lockMigrations(firstRun) : firstRun());
    })();
    // A failed start must not be remembered: the next query tries again.
    shared.ready.catch(() => {
      shared.ready = null;
    });
  }
  return shared.ready.then(driver);
}

async function runQuery(sql: string, params: unknown[]): Promise<QueryResult> {
  const inTx = txStore.getStore();
  const text = toPostgresParams(withReturning(sql));
  const values = params.map(param);
  stats.queries++;
  if (inTx) return inTx.query(text, values);
  return (await opened()).query(text, values);
}

export function getDb(): Db {
  if (shared.handle) return shared.handle;
  shared.handle = {
    get kind() {
      return databaseTarget().kind;
    },
    prepare(sql: string): Statement {
      return {
        async get(...params) {
          return (await runQuery(sql, params)).rows[0];
        },
        async all(...params) {
          return (await runQuery(sql, params)).rows;
        },
        async run(...params) {
          const r = await runQuery(sql, params);
          const id = r.rows[0]?.id;
          return { changes: r.rowCount, lastInsertRowid: typeof id === "number" ? id : null };
        },
      };
    },
    async exec(sql: string) {
      const inTx = txStore.getStore();
      await (inTx ?? (await opened())).exec(sql);
    },
    transaction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
      return async (...args: A): Promise<R> => {
        // Already inside one: become part of it, under a savepoint — so a
        // failure in here can be caught and handled the way it could be on
        // its own, rather than leaving the whole transaction unusable, which
        // is what any error does to a Postgres transaction.
        const outer = txStore.getStore();
        if (outer) {
          const savepoint = `sp_${++shared.savepoints}`;
          await outer.query(`SAVEPOINT ${savepoint}`, []);
          try {
            const result = await fn(...args);
            await outer.query(`RELEASE SAVEPOINT ${savepoint}`, []);
            return result;
          } catch (err) {
            await outer.query(`ROLLBACK TO SAVEPOINT ${savepoint}`, []).catch(() => {});
            throw err;
          }
        }
        const d = await opened();
        for (let attempt = 1; ; attempt++) {
          try {
            const result = await d.inTransaction((runner) => txStore.run(runner, () => fn(...args)));
            stats.transactions++;
            return result;
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (!code || !RETRYABLE.has(code)) {
              stats.transactions++;
              throw err;
            }
            stats.retries[code] = (stats.retries[code] ?? 0) + 1;
            if (attempt >= MAX_ATTEMPTS) {
              stats.transactions++;
              stats.exhausted++;
              throw new BusyError(err);
            }
            await new Promise((r) => setTimeout(r, backoff(attempt)));
          }
        }
      };
    },
    async dumpDataDir() {
      const d = await opened();
      if (!d.dumpDataDir) throw new Error("Only PGlite keeps its data in a folder to copy; use pg_dump.");
      return d.dumpDataDir();
    },
    async close() {
      if (!shared.driverPromise) return;
      const d = await shared.driverPromise;
      shared.driverPromise = null;
      shared.ready = null;
      shared.handle = null;
      await d.close();
    },
  };
  return shared.handle;
}

/** Run fn in one serializable transaction (or the one already open). */
export function withTransaction<R>(fn: () => Promise<R>): Promise<R> {
  return getDb().transaction(fn)();
}

/**
 * Is this the error a UNIQUE or PRIMARY KEY constraint raises — on `table`,
 * when one is named?
 */
export function isUniqueViolation(err: unknown, table?: string): boolean {
  const e = err as { code?: string; table?: string } | null;
  return e?.code === "23505" && (table === undefined || e.table === table);
}

// ------------------------------------------------------------ migrations

export function migrationsDirectory(): string {
  return path.join(process.cwd(), "db", "migrations");
}

/**
 * Apply every migration not yet applied, in filename order, each in its own
 * transaction. Several servers starting at once wait their turn on a lock, so
 * a migration is never run twice.
 */
async function migrate(d: Driver): Promise<void> {
  const work = async () => {
    await d.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
    );
    const applied = new Set(
      (await d.query("SELECT version FROM schema_migrations", [])).rows.map((r) => String(r.version))
    );
    const files = fs
      .readdirSync(migrationsDirectory())
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (applied.has(version)) continue;
      const sql = fs.readFileSync(path.join(migrationsDirectory(), file), "utf8");
      await d.inTransaction(async (runner) => {
        await runner.exec(sql);
        // What the migration needs from the application, in its transaction (lib/db-steps.ts).
        const { runStep } = await import("./db-steps.ts");
        await runStep(version, runner);
        await runner.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      });
    }
  };
  await (d.lockMigrations ? d.lockMigrations(work) : work());
}

// ------------------------------------------------------------ first run

/**
 * A fresh install gets four venues, so there is something to look at. They
 * are Malaysian (Klang Valley addresses, ringgit rates), so an install for
 * another country starts empty and its first-run checklist leads the way.
 */
async function seedIfEmpty(): Promise<void> {
  if (region().country !== "MY") return;
  const d = await driver();
  const { rows } = await d.query("SELECT COUNT(*) AS n FROM venues", []);
  if (Number(rows[0].n) > 0) return;

  await d.inTransaction(async (tx) => {
    const venue = async (
      name: string,
      area: string,
      address: string,
      phone: string,
      open: number,
      close: number,
      [lat, lng]: [number, number]
    ) =>
      (
        await tx.query(
          "INSERT INTO venues (name, area, address, phone, open_min, close_min, lat, lng) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
          [name, area, address, phone, open * 60, close * 60, lat, lng]
        )
      ).rows[0].id as number;
    const court = (
      venueId: number,
      name: string,
      sport: string,
      offPeak: number,
      peak: number,
      capacity = 1,
      deposit = 0
    ) =>
      tx.query(
        "INSERT INTO courts (venue_id, name, sport, off_peak_rate, peak_rate, capacity, deposit) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [venueId, name, sport, offPeak, peak, capacity, deposit]
      );

    // Another process may have seeded while this one waited for the lock.
    const again = await tx.query("SELECT COUNT(*) AS n FROM venues", []);
    if (Number(again.rows[0].n) > 0) return;

    const arena = await venue(
      "Arena MySenam @ Petaling Jaya",
      "Petaling Jaya",
      "12 Jalan SS2/61, 47300 Petaling Jaya, Selangor",
      "+60 3-1234 5678",
      8,
      23,
      [3.1185, 101.623]
    );
    for (let i = 1; i <= 4; i++) await court(arena, `Badminton Court ${i}`, "badminton", 15, 25, 1);
    for (let i = 1; i <= 2; i++) await court(arena, `Pickleball Court ${i}`, "pickleball", 20, 30, 1);
    await court(arena, "Futsal Pitch A", "futsal", 80, 120, 1);
    // Shared-capacity facilities: many people hold the same hour.
    await court(arena, "Gym Floor", "gym", 5, 8, 40);

    const sunway = await venue(
      "SmashPoint Sports Centre",
      "Subang Jaya",
      "8 Persiaran Kewajipan, USJ 1, 47600 Subang Jaya, Selangor",
      "+60 3-8765 4321",
      // The lap pool opens for the before-work swim.
      7,
      22,
      [3.059, 101.587]
    );
    for (let i = 1; i <= 6; i++) await court(sunway, `Badminton Court ${i}`, "badminton", 12, 22, 1);
    for (let i = 1; i <= 2; i++) await court(sunway, `Tennis Court ${i}`, "tennis", 25, 40, 1);
    await court(sunway, "Lap Pool", "swimming", 4, 6, 25);

    const bangsar = await venue(
      "Bangsar Racquet Club",
      "Bangsar",
      "3 Jalan Maarof, Bangsar, 59000 Kuala Lumpur",
      "+60 3-2222 3333",
      9,
      22,
      [3.146, 101.67]
    );
    for (let i = 1; i <= 3; i++) await court(bangsar, `Tennis Court ${i}`, "tennis", 30, 45, 1);
    for (let i = 1; i <= 4; i++) await court(bangsar, `Pickleball Court ${i}`, "pickleball", 18, 28, 1);

    const lakeside = await venue(
      "Putrajaya Lakeside Watersports",
      "Putrajaya",
      "Presint 5, Persiaran Perdana, 62000 Putrajaya",
      "+60 3-8888 1234",
      // Off the water before the afternoon storms.
      8,
      19,
      [2.926, 101.689]
    );
    // A fleet, not a court: eight hulls share the hour, and each one goes out
    // of the building, so the desk holds a deposit against it.
    await court(lakeside, "Kayak Fleet", "kayak", 15, 20, 8, 50);

    // What each offers and what its courts are like (lib/facilities.ts) —
    // the same as migration 0013 gives the starter venues of an older install.
    const describe = async (
      venueId: number,
      amenities: string[],
      courts: Record<string, { setting: string; aircon?: boolean; floodlit?: boolean; surface?: string }>
    ) => {
      await tx.query("UPDATE venues SET amenities = string_to_array($1, ',') WHERE id = $2", [amenities.join(","), venueId]);
      for (const [sport, f] of Object.entries(courts))
        await tx.query("UPDATE courts SET setting = $1, aircon = $2, floodlit = $3, surface = $4 WHERE venue_id = $5 AND sport = $6", [
          f.setting,
          f.aircon ? 1 : 0,
          f.floodlit ? 1 : 0,
          f.surface ?? null,
          venueId,
          sport,
        ]);
    };
    await describe(
      arena,
      ["showers", "changing_rooms", "lockers", "toilets", "free_parking", "surau", "drinking_water", "cafe", "equipment_rental", "wifi"],
      {
        badminton: { setting: "indoor", aircon: true, surface: "mat" },
        pickleball: { setting: "indoor", aircon: true, surface: "hard" },
        futsal: { setting: "indoor", aircon: true, surface: "tiles" },
        gym: { setting: "indoor", aircon: true },
      }
    );
    await describe(sunway, ["showers", "toilets", "paid_parking", "transit", "surau", "pro_shop", "stringing", "coaching"], {
      badminton: { setting: "indoor", surface: "mat" },
      tennis: { setting: "outdoor", floodlit: true, surface: "hard" },
      swimming: { setting: "outdoor" },
    });
    await describe(
      bangsar,
      ["showers", "changing_rooms", "lockers", "toilets", "paid_parking", "transit", "cafe", "pro_shop", "coaching", "seating"],
      {
        tennis: { setting: "outdoor", floodlit: true, surface: "hard" },
        pickleball: { setting: "indoor", aircon: true, surface: "hard" },
      }
    );
    await describe(lakeside, ["changing_rooms", "lockers", "toilets", "free_parking", "first_aid", "drinking_water"], {
      kayak: { setting: "outdoor" },
    });
  });
}
