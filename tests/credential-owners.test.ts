import dns from "dns";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin, createAdmin, ensureBootstrapAdmin, getAdminById, type Admin } from "../src/lib/admin-auth";
import { listActivity } from "../src/lib/activity";
import { apiCaller, createApiKey, listApiKeys, reassignApiKey, revokeApiKey, rotateApiKey, type ApiScope } from "../src/lib/api-keys";
import { getDb } from "../src/lib/db";
import { mayUse } from "../src/lib/mcp/registry";
import { changeRole, removeStaff } from "../src/lib/staff-accounts";
import { createVenue } from "../src/lib/store";
import { liftBusiness, suspendBusiness } from "../src/lib/suspensions";
import { addEndpoint, deliverWebhooks, listEndpoints, pingEndpoint, reassignEndpoint, rotateEndpointSecret, resumeEndpoint, transport } from "../src/lib/webhooks";
import { POST as integrationsPost } from "../src/app/api/admin/integrations/route";
import { createAdminSession, ADMIN_SESSION_COOKIE } from "../src/lib/admin-auth";

/**
 * Credentials and the people who made them (ADR 0064, audit A13): an API key or a webhook address is a person's (it stops when that person
 * stops managing the venue, at the very next use) or the venue's (it does not), and every request that authenticates with a key re-reads
 * who owns it, the venue and the business.
 */

let owner: Admin;
let b1: number;
let b2: number;
let v1: number;
let v2: number;
let v3: number;
let elsewhere: number;
let n = 0;

async function venue(name: string): Promise<number> {
  const made = await createVenue({ name, area: "PJ", address: "1 Jalan Kunci", phone: `03777${String(++n).padStart(5, "0")}` });
  if (!made.ok) throw new Error(made.error);
  return made.venue.id;
}
async function staff(input: { name: string; venueId?: number | null; businessId?: number | null; role?: "desk" | "manager" }): Promise<Admin> {
  const made = await createAdmin({ password: "a long enough password", email: `cred${++n}@keys.my`, venueId: null, ...input });
  if (!made.ok) throw new Error(made.error);
  return made.admin;
}
const request = (key: string) => new NextRequest("http://localhost/api/v1/venue", { headers: { authorization: `Bearer ${key}`, "x-forwarded-for": "203.0.113.9" } });
/** What a request with this key meets: the status it is answered with. */
async function use(key: string, need: ApiScope = "read"): Promise<number> {
  const caller = await apiCaller(request(key), need);
  return caller instanceof NextResponse ? caller.status : 200;
}
async function keyOf(venueId: number, by: Admin | null, scope: ApiScope = "write", ownership?: "venue" | "person"): Promise<string> {
  const made = await createApiKey(venueId, { name: `Key ${++n}`, scope, ownership }, by?.id ?? null);
  if (!made.ok) throw new Error(made.error);
  return made.key;
}
const logOf = async (venueId: number) => (await listActivity([venueId], { limit: 100 })).map((a) => `${a.action}: ${a.detail}`);

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const signedIn = await authenticateAdmin("admin@mysenam.my", "mysenam-admin");
  owner = (await getAdminById(signedIn!.id))!;
  v1 = await venue("Keys A");
  v2 = await venue("Keys B");
  v3 = await venue("Other Biz");
  elsewhere = await venue("Standalone");
  const db = getDb();
  b1 = ((await db.prepare("INSERT INTO businesses (name) VALUES ('Keys Chain') RETURNING id").get()) as { id: number }).id;
  b2 = ((await db.prepare("INSERT INTO businesses (name) VALUES ('Another Chain') RETURNING id").get()) as { id: number }).id;
  await db.prepare("UPDATE venues SET business_id = ? WHERE id IN (?, ?)").run(b1, v1, v2);
  await db.prepare("UPDATE venues SET business_id = ? WHERE id = ?").run(b2, v3);
});

afterEach(() => vi.restoreAllMocks());

describe("a key a person owns", () => {
  it("is a person's unless the manager says it is the venue's, and says whose it is", async () => {
    const mgr = await staff({ name: "Mira Manager", venueId: v2, role: "manager" });
    const own = await createApiKey(v2, { name: "Mine", scope: "read" }, mgr.id);
    const venues = await createApiKey(v2, { name: "Website", scope: "write", ownership: "venue" }, mgr.id);
    if (!own.ok || !venues.ok) throw new Error("keys");
    expect(own.record).toMatchObject({ ownership: "person", ownerId: mgr.id, ownerName: "Mira Manager", madeBy: "Mira Manager", ownerLost: false });
    expect(venues.record).toMatchObject({ ownership: "venue", ownerId: null, madeBy: "Mira Manager" });
    expect(await use(own.key)).toBe(200);
  });

  it("stops at once when its owner is removed; the venue's key they made keeps working, and is counted for review", async () => {
    const mgr = await staff({ name: "Rina Removed", venueId: v2, role: "manager" });
    const personal = await keyOf(v2, mgr, "write", "person");
    const shared = await keyOf(v2, mgr, "write", "venue");
    const hook = await addEndpoint(v2, "https://hooks.example.com/rina", { adminId: mgr.id, ownership: "venue" });
    const mine = await addEndpoint(v2, "https://hooks.example.com/rina-own", { adminId: mgr.id, ownership: "person" });
    if (!hook.ok || !mine.ok) throw new Error("hooks");
    expect(await use(personal)).toBe(200);
    const done = await removeStaff(owner, mgr.id);
    expect(done).toMatchObject({ ok: true, credentials: { stopped: 2, review: { keys: 1, webhooks: 1 } } });
    expect(await use(personal)).toBe(401);
    expect(await use(shared)).toBe(200);
    // The log says what stopped, for whom, and holds no secret.
    const log = (await logOf(v2)).join("\n");
    expect(log).toContain("API key stopped");
    expect(log).toContain("Rina Removed");
    expect(log).not.toContain(personal);
    expect(log).not.toContain(mine.secret);
    // The stopped key is listed with why; the address is off with its reason.
    const keys = await listApiKeys(v2);
    expect(keys.find((k) => k.revokedReason === "owner_removed")).toMatchObject({ ownership: "person" });
    expect((await listEndpoints(v2)).find((e) => e.id === mine.endpoint.id)).toMatchObject({ active: false, stoppedReason: "owner_removed" });
    expect((await listEndpoints(v2)).find((e) => e.id === hook.endpoint.id)).toMatchObject({ active: true, ownership: "venue" });
    // Turning the stopped address back on is not a way round it.
    expect(await resumeEndpoint(mine.endpoint.id, v2)).toBe(false);
  });

  it("stops at the next use when its owner is made front desk, before or without any sweep", async () => {
    const swept = await staff({ name: "Dee Demoted", venueId: v2, role: "manager" });
    const key = await keyOf(v2, swept, "read", "person");
    expect(await use(key)).toBe(200);
    expect(await changeRole(owner, swept.id, "desk")).toEqual({ ok: true });
    expect(await use(key)).toBe(401);
    expect((await listApiKeys(v2)).find((k) => k.revokedReason === "owner_demoted")).toBeDefined();
    // The authority is read on every request: a role changed underneath, with nothing written down, stops it all the same.
    const quiet = await staff({ name: "Quiet Quinn", venueId: v2, role: "manager" });
    const quietKey = await keyOf(v2, quiet, "read", "person");
    expect(await use(quietKey)).toBe(200);
    await getDb().prepare("UPDATE admins SET role = 'desk' WHERE id = ?").run(quiet.id);
    expect(await use(quietKey)).toBe(401);
    const listed = (await listApiKeys(v2)).find((k) => k.prefix === quietKey.slice(0, 10));
    expect(listed).toMatchObject({ ownerLost: true, revokedAt: null });
    // Front desk can be made manager again; what stopped does not come back by itself.
    await getDb().prepare("UPDATE admins SET role = 'manager' WHERE id = ?").run(quiet.id);
    expect(await use(quietKey)).toBe(200);
  });

  it("stops when its owner no longer reaches the venue: moved to another venue, or the venue moved to another business", async () => {
    const moved = await staff({ name: "Mo Moved", venueId: v2, role: "manager" });
    const key = await keyOf(v2, moved, "read", "person");
    expect(await use(key)).toBe(200);
    await getDb().prepare("UPDATE admins SET venue_id = ? WHERE id = ?").run(elsewhere, moved.id);
    expect(await use(key)).toBe(401);

    const biz = await staff({ name: "Bea Business", businessId: b1 });
    const bizKey = await keyOf(v1, biz, "read", "person");
    const venueKey = await keyOf(v1, biz, "read", "venue");
    expect(await use(bizKey)).toBe(200);
    // No path in the app moves a venue between businesses (lib/branches.ts refuses it); were it done, a manager of the old business
    // owns nothing at it any more.
    await getDb().prepare("UPDATE venues SET business_id = ? WHERE id = ?").run(b2, v1);
    expect(await use(bizKey)).toBe(401);
    expect(await use(venueKey)).toBe(200);
    await getDb().prepare("UPDATE venues SET business_id = ? WHERE id = ?").run(b1, v1);
    expect(await use(bizKey)).toBe(200);
  });

  it("the platform owner's key works at every venue; a manager of another business does not own one here", async () => {
    const ownersKey = await keyOf(v1, owner, "read", "person");
    expect(await use(ownersKey)).toBe(200);
    const other = await staff({ name: "Otto Other", businessId: b2 });
    const wrong = await keyOf(v1, other, "read", "person");
    expect(await use(wrong)).toBe(401);
  });
});

describe("a suspended venue or business", () => {
  it("lets its keys read but not write, through the API and through the MCP server's tools, until it is back", async () => {
    const mgr = await staff({ name: "Sue Suspended", businessId: b2 });
    const write = await keyOf(v3, mgr, "write", "venue");
    const read = await keyOf(v3, mgr, "read", "person");
    expect(await use(write, "write")).toBe(200);
    expect(await suspendBusiness(b2, "A dispute")).toMatchObject({ ok: true });
    expect(await use(write, "write")).toBe(403);
    expect(await use(read, "read")).toBe(200);
    const caller = await apiCaller(request(write), "read");
    if (caller instanceof NextResponse) throw new Error("read");
    expect(caller.suspended).toBe(true);
    const tool = { authority: "write" as const, scope: undefined, staffAction: undefined };
    expect(mayUse({ caller, person: undefined }, tool)).toBe(false);
    expect(mayUse({ caller, person: undefined }, { ...tool, authority: "read" as const })).toBe(true);
    expect(await liftBusiness(b2)).toMatchObject({ ok: true });
    expect(await use(write, "write")).toBe(200);
  });
});

describe("handing a credential over, and rotating it", () => {
  it("makes a person's key the venue's, so it outlives them, and a venue's key a person's, on the record", async () => {
    const mgr = await staff({ name: "Hanna Handover", venueId: v2, role: "manager" });
    const key = await keyOf(v2, mgr, "read", "person");
    const id = (await listApiKeys(v2)).find((k) => k.prefix === key.slice(0, 10))!.id;
    expect(await reassignApiKey(id, v2, "venue", owner)).toMatchObject({ ok: true });
    expect(await removeStaff(owner, mgr.id)).toMatchObject({ ok: true, credentials: { stopped: 0 } });
    expect(await use(key)).toBe(200);
    const other = await staff({ name: "Taylor Takeover", venueId: v2, role: "manager" });
    expect(await reassignApiKey(id, v2, other.id, other)).toMatchObject({ ok: true });
    expect((await listApiKeys(v2)).find((k) => k.id === id)).toMatchObject({ ownership: "person", ownerName: "Taylor Takeover" });
    const desk = await staff({ name: "Desk Dan", venueId: v2, role: "desk" });
    expect(await reassignApiKey(id, v2, desk.id, other)).toMatchObject({ ok: false, status: 409 });
    expect(await reassignApiKey(id, v1, "venue", owner)).toMatchObject({ ok: false, status: 404 });
  });

  it("never revives a key whose owner has lost the authority: it is rotated, and the old one stays dead", async () => {
    const mgr = await staff({ name: "Lena Lost", venueId: v2, role: "manager" });
    const key = await keyOf(v2, mgr, "write", "person");
    const id = (await listApiKeys(v2)).find((k) => k.prefix === key.slice(0, 10))!.id;
    await getDb().prepare("UPDATE admins SET role = 'desk' WHERE id = ?").run(mgr.id);
    expect(await reassignApiKey(id, v2, "venue", owner)).toMatchObject({ ok: false, status: 409 });
    expect(await use(key)).toBe(401);
    // Rotating a working key: the new one works, the old one is dead at once, nothing else changed.
    const working = await staff({ name: "Wanda Working", venueId: v2, role: "manager" });
    const wk = await keyOf(v2, working, "read", "person");
    const wid = (await listApiKeys(v2)).find((k) => k.prefix === wk.slice(0, 10))!.id;
    const rotated = await rotateApiKey(wid, v2, owner);
    if (!rotated.ok) throw new Error(rotated.error);
    expect(await use(wk)).toBe(401);
    expect(await use(rotated.key)).toBe(200);
    expect(rotated.record).toMatchObject({ scope: "read", ownership: "person", ownerName: owner.name });
    expect(await rotateApiKey(wid, v2, owner)).toMatchObject({ ok: false, status: 404 });
    // A key already revoked cannot be handed on or rotated.
    const gone = await keyOf(v2, null, "read");
    const gid = (await listApiKeys(v2)).find((k) => k.prefix === gone.slice(0, 10))!.id;
    expect(await revokeApiKey(gid, v2)).toBe(true);
    expect(await reassignApiKey(gid, v2, "venue", owner)).toMatchObject({ ok: false, status: 404 });
  });

  it("is done through the integrations route by a manager of that venue only, and logged", async () => {
    const mgr = await staff({ name: "Route Rita", venueId: v2, role: "manager" });
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(mgr.id)).token}`;
    const post = (body: unknown) =>
      integrationsPost(new NextRequest("http://localhost/api/admin/integrations", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));
    const made = await (await post({ venueId: v2, action: "key", name: "Via route", scope: "read" })).json();
    expect(made.record).toMatchObject({ ownership: "person", ownerId: mgr.id });
    const venueMade = await (await post({ venueId: v2, action: "key", name: "Via route 2", scope: "read", ownership: "venue" })).json();
    expect(venueMade.record).toMatchObject({ ownership: "venue" });
    const handed = await post({ venueId: v2, action: "handOver", kind: "key", id: made.record.id, to: "venue" });
    expect(handed.status).toBe(200);
    const rotated = await post({ venueId: v2, action: "rotate", kind: "key", id: made.record.id });
    expect((await rotated.json()).key).toMatch(/^ms_r_/);
    expect((await post({ venueId: v1, action: "handOver", kind: "key", id: made.record.id, to: "venue" })).status).toBe(403);
    expect((await post({ venueId: v2, action: "handOver", kind: "key", id: 1, to: "someone" })).status).toBe(400);
    const log = (await logOf(v2)).join("\n");
    expect(log).toContain("handed from");
    expect(log).toContain("rotated by Route Rita");
    expect(log).not.toMatch(/ms_[rwa]_[A-Za-z0-9_-]{20,}/);
  });
});

describe("a webhook address a person owns", () => {
  it("is sent nothing after its owner leaves, including what was queued before; the venue's address carries on", async () => {
    const mgr = await staff({ name: "Wes Webhook", venueId: v2, role: "manager" });
    const own = await addEndpoint(v2, "https://hooks.example.com/wes-own", { adminId: mgr.id, ownership: "person" });
    const shared = await addEndpoint(v2, "https://hooks.example.com/wes-venue", { adminId: mgr.id, ownership: "venue" });
    if (!own.ok || !shared.ok) throw new Error("hooks");
    await getDb().prepare("DELETE FROM webhook_deliveries").run();
    expect(await pingEndpoint(own.endpoint.id, v2)).toBe(true);
    await getDb().prepare("INSERT INTO webhook_deliveries (endpoint_id, event, payload) VALUES (?, 'ping', '{}')").run(shared.endpoint.id);
    // Queued, then the owner is demoted without anything being swept: still not delivered.
    await getDb().prepare("UPDATE admins SET role = 'desk' WHERE id = ?").run(mgr.id);
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    const urls: string[] = [];
    vi.spyOn(transport, "post").mockImplementation(async (url) => {
      urls.push(url.toString());
      return 200;
    });
    expect(await deliverWebhooks()).toEqual({ sent: 1, failed: 0 });
    expect(urls).toEqual(["https://hooks.example.com/wes-venue"]);
    expect(await pingEndpoint(own.endpoint.id, v2)).toBe(false);
    // Rotating gives the address a new owner and secret, and it is on again.
    const rotated = await rotateEndpointSecret(own.endpoint.id, v2, owner);
    expect(rotated).toMatchObject({ ok: true });
    expect((await listEndpoints(v2)).find((e) => e.id === own.endpoint.id)).toMatchObject({ active: true, ownerName: owner.name, ownerLost: false });
    expect(await reassignEndpoint(shared.endpoint.id, v2, owner.id, owner)).toMatchObject({ ok: true });
  });
});

describe("a key used while its owner is being removed", () => {
  it("is answered, or refused, never an error; and once the removal is done every use is refused", async () => {
    const room = await venue("Concurrent Keys");
    const mgr = await staff({ name: "Cara Concurrent", venueId: room, role: "manager" });
    const key = await keyOf(room, mgr, "write", "person");
    const during: Promise<number>[] = [];
    for (let i = 0; i < 25; i++) during.push(use(key));
    const removal = removeStaff(owner, mgr.id);
    for (let i = 0; i < 25; i++) during.push(use(key));
    const [results, done] = await Promise.all([Promise.all(during), removal]);
    expect(done.ok).toBe(true);
    for (const status of results) expect([200, 401]).toContain(status);
    const after = await Promise.all(Array.from({ length: 10 }, () => use(key)));
    expect(after.every((s) => s === 401)).toBe(true);
  });
});

describe("keys from before ownership was recorded", () => {
  it("are the venue's: they keep working when whoever made them leaves, and are listed as made by them", async () => {
    const mgr = await staff({ name: "Old Olive", venueId: v2, role: "manager" });
    // A row as it stood before migration 0312: the columns it adds are at their defaults.
    const key = `ms_w_${"legacyLEGACYlegacy12345678".padEnd(32, "x")}`;
    const crypto = await import("crypto");
    await getDb()
      .prepare("INSERT INTO venue_api_keys (venue_id, name, prefix, key_hash, scope, admin_id) VALUES (?, 'Old website', ?, ?, 'write', ?)")
      .run(v2, key.slice(0, 10), crypto.createHash("sha256").update(key, "utf8").digest("hex"), mgr.id);
    expect(await use(key, "write")).toBe(200);
    expect(await removeStaff(owner, mgr.id)).toMatchObject({ ok: true, credentials: { stopped: 0, review: { keys: 1 } } });
    expect(await use(key, "write")).toBe(200);
    expect((await listApiKeys(v2)).find((k) => k.name === "Old website")).toMatchObject({ ownership: "venue", madeBy: null, ownerLost: false });
    // The ownership column only takes the two values.
    await expect(getDb().prepare("UPDATE venue_api_keys SET ownership = 'nobody' WHERE name = 'Old website'").run()).rejects.toThrow();
  });
});
