import { afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";
process.env.MYSENAM_MARKETPLACE = "on";

import { NextRequest } from "next/server";
import { POST as mcpPost, GET as mcpGet } from "../src/app/api/mcp/route";
import { GET as searchGet } from "../src/app/api/search/route";
import { GET as availabilityGet } from "../src/app/api/availability/route";
import { POST as v1BookingsPost } from "../src/app/api/v1/bookings/route";
import { GET as integrationsGet, POST as integrationsPost } from "../src/app/api/admin/integrations/route";
import { setAccessSettings } from "../src/lib/access";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { aiPersonalData } from "../src/lib/ai-personal-data";
import { createApiKey, revokeApiKey } from "../src/lib/api-keys";
import { getDb } from "../src/lib/db";
import { BUSINESS_TYPES } from "../src/lib/guide/business-types";
import { presentCapability, presentChip } from "../src/lib/guide/public/present";
import { applyAddress } from "../src/lib/guide/public/select";
import { fitView } from "../src/lib/guide/public/view";
import { translator } from "../src/lib/i18n";
import { LATEST_PROTOCOL } from "../src/lib/mcp/protocol";
import { resetRateLimits } from "../src/lib/rate-limit";
import { createBooking, createCourt, createVenue, findBookingByCode } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * The MCP server (docs/integrations/mcp.md): the protocol through the real
 * route handler, the public tools against the pages and routes they mirror,
 * the venue's tools against /api/v1 with its keys, customers' personal data
 * hidden until a manager turns it on, and the browser and cookie rules.
 */

let venueId: number;
let draftVenueId: number;
let privateVenueId: number;
let membersVenueId: number;
let courtId: number;
let otherCourtId: number;
let readKey: string;
let writeKey: string;
let writeKeyId: number;
let availabilityKey: string;
let managerCookie: string;
let deskCookie: string;
const day = addDays(todayISO(), 3);

let ip = 1;
interface Opts {
  key?: string;
  auth?: string;
  cookie?: string;
  origin?: string;
  version?: string;
  address?: string;
}
const request = (body: unknown, o: Opts = {}) =>
  new NextRequest("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-forwarded-for": o.address ?? `198.51.100.${ip++ % 250}`,
      ...(o.key ? { authorization: `Bearer ${o.key}` } : {}),
      ...(o.auth ? { authorization: o.auth } : {}),
      ...(o.cookie ? { cookie: o.cookie } : {}),
      ...(o.origin ? { origin: o.origin } : {}),
      ...(o.version ? { "mcp-protocol-version": o.version } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const rpc = async (method: string, params: unknown = {}, o: Opts = {}) => {
  const res = await mcpPost(request({ jsonrpc: "2.0", id: 7, method, params }, o));
  return { status: res.status, body: (await res.json()) as { id: number; result?: Record<string, unknown>; error?: { code: number; message: string } } };
};
interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
const tool = async (name: string, args: Record<string, unknown> = {}, o: Opts = {}): Promise<ToolResult> => {
  const { status, body } = await rpc("tools/call", { name, arguments: args }, o);
  expect(status).toBe(200);
  expect(body.error, JSON.stringify(body.error)).toBeUndefined();
  return body.result as unknown as ToolResult;
};
/** The JSON after the human sentence. */
const dataOf = (r: ToolResult) => {
  expect(r.isError, r.content[0].text).toBeFalsy();
  return JSON.parse(r.content[0].text.slice(r.content[0].text.indexOf("\n\n") + 2));
};
const textOf = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const toolNames = async (o: Opts = {}) => ((await rpc("tools/list", {}, o)).body.result!.tools as { name: string }[]).map((t) => t.name);

const admin = (url: string, cookie: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method: body ? "POST" : "GET",
    headers: { cookie, "content-type": "application/json", "x-forwarded-for": "192.0.2.9" },
    body: body ? JSON.stringify(body) : undefined,
  });
const v1 = (url: string, key: string, body: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-forwarded-for": "192.0.2.10" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  const venue = async (name: string) => {
    const made = await createVenue({ name, area: "Petaling Jaya", address: `1 Jalan ${name}`, phone: "0388880000", openMin: 7 * 60, closeMin: 23 * 60 });
    if (!made.ok) throw new Error(made.error);
    const c = await createCourt({ venueId: made.venue.id, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 30 });
    if (!c.ok) throw new Error(c.error);
    return { id: made.venue.id, court: c.court.id };
  };
  const v = await venue("MCP Arena");
  venueId = v.id;
  courtId = v.court;
  otherCourtId = (await venue("Other Arena")).court;
  draftVenueId = (await venue("Draft Hall")).id;
  await getDb().prepare("UPDATE venues SET published_at = NULL WHERE id = ?").run(draftVenueId);
  privateVenueId = (await venue("Private Club")).id;
  expect((await setAccessSettings(privateVenueId, { access: "private" })).ok).toBe(true);
  membersVenueId = (await venue("Members Club")).id;
  expect((await setAccessSettings(membersVenueId, { access: "members", listed: true })).ok).toBe(true);

  const r = await createApiKey(venueId, { name: "Assistant read", scope: "read" }, null);
  const w = await createApiKey(venueId, { name: "Assistant write", scope: "write" }, null);
  const a = await createApiKey(venueId, { name: "Widget", scope: "availability" }, null);
  if (!r.ok || !w.ok || !a.ok) throw new Error("keys");
  readKey = r.key;
  writeKey = w.key;
  writeKeyId = w.record.id;
  availabilityKey = a.key;

  const m = await createAdmin({ name: "Maya Manager", email: "mcp-mgr@mcp.test", password: "a long enough password", venueId, role: "manager" });
  const d = await createAdmin({ name: "Dan Desk", email: "mcp-desk@mcp.test", password: "a long enough password", venueId, role: "desk" });
  if (!m.ok || !d.ok) throw new Error("admins");
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(m.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(d.admin.id)).token}`;
});

afterEach(async () => {
  process.env.MYSENAM_MARKETPLACE = "on";
  await resetRateLimits();
});

describe("the protocol, through the route handler", () => {
  it("initialises with the client's version where it is one it speaks, else its newest, and keeps no session", async () => {
    const res = await mcpPost(request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const body = await res.json();
    expect(body).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "mysenam" } } });
    const old = await rpc("initialize", { protocolVersion: "1999-01-01" });
    expect(old.body.result!.protocolVersion).toBe(LATEST_PROTOCOL);
    // The notification that follows needs no answer.
    const note = await mcpPost(request({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");
    expect((await rpc("ping")).body.result).toEqual({});
  });

  it("answers bad JSON, unknown methods and tools with JSON-RPC errors, and bad arguments as a tool error", async () => {
    const bad = await mcpPost(request("{not json"));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe(-32700);
    expect((await rpc("resources/list")).body.error!.code).toBe(-32601);
    expect((await rpc("tools/call", { name: "no_such_tool" })).body.error!.code).toBe(-32602);
    expect((await rpc("tools/call", { name: "venue_details", arguments: "x" })).body.error!.code).toBe(-32602);
    const invalid = await mcpPost(request({ id: 3, method: "ping" }));
    expect((await invalid.json()).error.code).toBe(-32600);
    const wrong = await tool("venue_details", { venueId: "seven" });
    expect(wrong.isError).toBe(true);
    expect(textOf(wrong)).toBe("venueId must be a whole number from 1 to 9007199254740991.");
    const nowhere = await tool("search_venues", { activity: "badminton" });
    expect(textOf(nowhere)).toBe("Name an area, or give a point near which to search.");
  });

  it("refuses a protocol version it does not speak, has no event stream, and answers a batch", async () => {
    expect((await rpc("ping", {}, { version: "2020-01-01" })).status).toBe(400);
    expect((await rpc("ping", {}, { version: "2025-06-18" })).status).toBe(200);
    const get = await mcpGet();
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const batch = await mcpPost(request([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "ping" }]));
    expect((await batch.json()).map((r: { id: number }) => r.id)).toEqual([1, 2]);
  });

  it("lists the public tools without a key, each saying what it returns, and the venue's with one, up to its scope", async () => {
    const open = await toolNames();
    expect(open).toEqual(["guide_business_types", "guide_fit", "search_venues", "venue_details", "venue_availability"]);
    const listed = (await rpc("tools/list")).body.result!.tools as { description: string; annotations: { readOnlyHint: boolean } }[];
    for (const t of listed) {
      expect(t.description.length).toBeGreaterThan(60);
      expect(t.annotations.readOnlyHint).toBe(true);
    }
    expect(await toolNames({ key: availabilityKey })).toEqual([...open, "my_venue", "my_availability"]);
    expect(await toolNames({ key: readKey })).toEqual([...open, "my_venue", "my_availability", "my_bookings", "my_booking", "my_setup_status", "my_playbook"]);
    const write = (await rpc("tools/list", {}, { key: writeKey })).body.result!.tools as { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }[];
    for (const name of ["create_booking", "cancel_booking"]) expect(write.find((t) => t.name === name)!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("has the guide's tools only where the guide is, a marketplace", async () => {
    process.env.MYSENAM_MARKETPLACE = "off";
    expect(await toolNames()).toEqual(["search_venues", "venue_details", "venue_availability"]);
    expect((await rpc("tools/call", { name: "guide_fit", arguments: { businessTypes: ["swimming"] } })).body.error!.code).toBe(-32602);
  });
});

describe("the public tools answer what the public pages and routes do", () => {
  it("lists the thirteen business types with their activities as the guide's picker does", async () => {
    const { types } = dataOf(await tool("guide_business_types", { locale: "ms" }));
    const ms = translator("ms");
    expect(types).toHaveLength(13);
    expect(types.map((t: { id: string; name: string }) => [t.id, t.name])).toEqual(BUSINESS_TYPES.map((b) => [b.id, ms(b.titleKey)]));
    expect(types[0].activities.map((a: { key: string }) => a.key)).toEqual(BUSINESS_TYPES[0].activities);
  });

  it("gives the public guide's own labels, limits and alternatives for a choice, in the language asked, with the apply link", async () => {
    for (const locale of ["en", "zh"] as const) {
      const t = translator(locale);
      const selection = { types: ["badminton-and-pickleball" as const, "swimming" as const], activities: ["padel"] };
      const view = fitView(selection);
      const data = dataOf(await tool("guide_fit", { businessTypes: ["badminton-and-pickleball", "swimming", "made-up"], activities: ["padel"], locale }));
      for (const group of data.byAvailability) {
        expect(group.label).toBe(t(`fit.avail.${group.availability}` as Parameters<typeof t>[0]));
        expect(group.items.map((i: { title: string }) => i.title)).toEqual(view.byAvailability[group.availability as keyof typeof view.byAvailability].map((l) => presentChip(t, l).title));
      }
      expect(data.byAvailability.map((g: { availability: string }) => g.availability)).toContain("unsupported");
      expect(data.notSupported.forThisChoice.map((c: { title: string; instead?: string }) => [c.title, c.instead ?? null])).toEqual(
        view.limits.relevant.map((c) => [presentCapability(t, c).title, presentCapability(t, c).alternative])
      );
      expect(data.notSupported.otherwise).toHaveLength(view.limits.others.length);
      expect(data.ignored).toEqual(["made-up"]);
      expect(data.applyLink).toBe(`https://book.example.my${applyAddress(view.selection)}`);
      // What needs an outside service says which, as the page's chip does.
      for (const item of data.byAvailability.find((g: { availability: string }) => g.availability === "integration").items) expect(item.needs).toBeTruthy();
    }
    const none = await tool("guide_fit", { businessTypes: ["nothing-real"] });
    expect(none.isError).toBe(true);
  });

  it("searches as the public search does, in an area or near a point, never everywhere, and never a draft or private venue", async () => {
    const asked = await tool("search_venues", { activity: "badminton", date: day, area: "Petaling Jaya" });
    const data = dataOf(asked);
    const route = await (await searchGet(new NextRequest(`http://localhost/api/search?sport=badminton&date=${day}&area=Petaling%20Jaya`))).json();
    expect(data.results.map((r: { venue: { id: number }; start: string; totalPrice: number }) => [r.venue.id, r.totalPrice])).toEqual(
      route.results.map((r: { venue: { id: number }; totalPrice: number }) => [r.venue.id, r.totalPrice])
    );
    const ids = data.results.map((r: { venue: { id: number } }) => r.venue.id);
    expect(ids).toContain(venueId);
    expect(ids).toContain(membersVenueId);
    expect(ids).not.toContain(draftVenueId);
    expect(ids).not.toContain(privateVenueId);
    const words = dataOf(await tool("search_venues", { words: "badminton", date: day, near: { lat: 3.1, lng: 101.6, km: 5 } }));
    expect(words.activity).toBe("badminton");
  });

  it("shows a venue's page facts and day as signed-out visitors see them; drafts and private venues are not found", async () => {
    const facts = dataOf(await tool("venue_details", { venueId }));
    expect(facts).toMatchObject({ id: venueId, name: "MCP Arena", area: "Petaling Jaya", activities: ["badminton"], membersOnly: false, page: `https://book.example.my/venue/${venueId}` });
    expect(dataOf(await tool("venue_details", { venueId: membersVenueId })).membersOnly).toBe(true);
    for (const hidden of [draftVenueId, privateVenueId, 999999]) {
      expect(textOf(await tool("venue_details", { venueId: hidden }))).toBe("Venue not found.");
      expect(textOf(await tool("venue_availability", { venueId: hidden, date: day }))).toBe("Venue not found.");
    }
    const mine = dataOf(await tool("venue_availability", { venueId, date: day }));
    const route = await (await availabilityGet(new NextRequest(`http://localhost/api/availability?venueId=${venueId}&date=${day}`))).json();
    expect(mine.courts.map((c: { courtId: number }) => c.courtId)).toEqual(route.availability.map((a: { court: { id: number } }) => a.court.id));
    expect(mine.courts[0].columns.map((c: { price: number; free: boolean }) => [c.price, c.free])).toEqual(
      route.availability[0].slots.map((s: { rate: number; available: boolean }) => [s.rate, s.available])
    );
    expect(mine.courts[0].starts.length).toBe(route.availability[0].starts.length);
  });
});

describe("the venue's tools, with its API key", () => {
  it("refuses an unknown, malformed or revoked key with an authentication error, never answering as nobody", async () => {
    for (const o of [{ key: "ms_r_notarealkeynotarealkey12345" }, { auth: "Basic dXNlcjpwYXNz" }, { auth: "Bearer " }]) {
      const res = await mcpPost(request({ jsonrpc: "2.0", id: 1, method: "tools/list" }, o));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer realm="mysenam", error="invalid_token"/);
      expect(JSON.stringify(await res.json())).not.toContain("search_venues");
    }
    const k = await createApiKey(venueId, { name: "Old", scope: "read" }, null);
    if (!k.ok) throw new Error(k.error);
    expect((await rpc("tools/list", {}, { key: k.key })).status).toBe(200);
    expect(await revokeApiKey(k.record.id, venueId)).toBe(true);
    expect((await rpc("tools/call", { name: "my_venue" }, { key: k.key })).status).toBe(401);
  });

  it("never signs anybody in by cookie: a manager's session alone gets the public tools only", async () => {
    expect(await toolNames({ cookie: managerCookie })).toEqual(["guide_business_types", "guide_fit", "search_venues", "venue_details", "venue_availability"]);
    const r = await tool("my_venue", {}, { cookie: managerCookie });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("my_venue needs the venue's API key: send Authorization: Bearer <key>.");
    expect(textOf(await tool("my_bookings", { from: day }, { cookie: managerCookie }))).not.toContain("MCP Arena");
  });

  it("keeps each key to its own scope and its own venue", async () => {
    expect(dataOf(await tool("my_venue", {}, { key: availabilityKey })).name).toBe("MCP Arena");
    expect(textOf(await tool("my_bookings", { from: day }, { key: availabilityKey }))).toBe("This key can only see availability and the venue.");
    expect(textOf(await tool("create_booking", { courtId, date: day, start: "09:00", end: "10:00", name: "Read Only", phone: "0123000000" }, { key: readKey }))).toBe("This key can only read.");
    const theirs = await createBooking({ courtId: otherCourtId, date: day, start: 9 * 60, end: 10 * 60, name: "Elsewhere", phone: "0123000001" });
    if (!theirs.ok) throw new Error(theirs.error);
    expect(textOf(await tool("my_booking", { code: theirs.booking.code }, { key: readKey }))).toBe("Booking not found.");
    expect(textOf(await tool("cancel_booking", { code: theirs.booking.code, confirm: true }, { key: writeKey }))).toBe("Booking not found.");
    expect(textOf(await tool("create_booking", { courtId: otherCourtId, date: day, start: "09:00", end: "10:00", name: "Wrong Venue", phone: "0123000002", confirm: true }, { key: writeKey }))).toBe(
      "That court is not at this key's venue."
    );
    expect((await findBookingByCode(theirs.booking.code))!.status).toBe("confirmed");
    const avail = dataOf(await tool("my_availability", { date: day }, { key: availabilityKey }));
    expect(avail.courts.map((c: { courtId: number }) => c.courtId)).toEqual([courtId]);
  });

  it("limits calls: 60 a minute per address without a key, 120 a minute per key", async () => {
    const address = "203.0.113.77";
    for (let i = 0; i < 60; i++) expect((await rpc("ping", {}, { address })).status).toBe(200);
    expect((await rpc("ping", {}, { address })).status).toBe(429);
    for (let i = 0; i < 120; i++) expect((await rpc("ping", {}, { address: "203.0.113.78", key: readKey })).status).toBe(200);
    expect((await rpc("ping", {}, { address: "203.0.113.78", key: readKey })).status).toBe(429);
  });

  it("gives the setup plan, launch readiness and the manager's playbook as text, with screens named and no links", async () => {
    const setup = dataOf(await tool("my_setup_status", {}, { key: readKey }));
    expect(setup.steps.length).toBeGreaterThan(0);
    expect(setup.steps[0]).toHaveProperty("status");
    expect(Object.keys(setup.readiness)).toEqual(["configurationComplete", "optionalEnhancements", "requiredMissing", "unverifiedExternal", "legalPrerequisite", "featureSpecific"]);
    const book = dataOf(await tool("my_playbook", { locale: "ms" }, { key: readKey }));
    expect(book.sections.length).toBeGreaterThan(0);
    const text = JSON.stringify(book);
    expect(text).not.toMatch(/href|\/admin\?|https?:\/\//);
    expect(text).not.toContain(readKey);
  });
});

describe("customers' personal data", () => {
  const customer = { name: "Siti Personal", phone: "0129998877", email: "siti.personal@example.my" };
  const leaks = (r: ToolResult) => [customer.name, customer.phone, customer.email, "Siti"].filter((s) => JSON.stringify(r).includes(s));

  it("is never in any tool's answer until a manager turns it on, and then is as the API gives it", async () => {
    const made = await v1BookingsPost(v1("/api/v1/bookings", writeKey, { courtId, date: day, start: "14:00", end: "15:00", ...customer }));
    expect(made.status).toBe(201);
    const { booking } = await made.json();
    expect(booking.name).toBe(customer.name); // the API, unchanged

    expect((await aiPersonalData(venueId)).on).toBe(false);
    const answers = [
      await tool("my_bookings", { from: day }, { key: readKey }),
      await tool("my_booking", { code: booking.code }, { key: readKey }),
      await tool("cancel_booking", { code: booking.code }, { key: writeKey }),
      await tool("create_booking", { courtId, date: day, start: "16:00", end: "17:00", ...customer }, { key: writeKey }),
    ];
    for (const a of answers) {
      expect(a.isError, textOf(a)).toBeFalsy();
      expect(leaks(a)).toEqual([]);
    }
    const listed = dataOf(answers[0]).bookings.find((b: { code: string }) => b.code === booking.code);
    expect(listed).toMatchObject({ code: booking.code, status: "confirmed", paymentStatus: "unpaid", totalPrice: booking.totalPrice, courtName: "Court 1" });

    // Front desk may not switch it; a manager may, and it is recorded with who.
    expect((await integrationsPost(admin("/api/admin/integrations", deskCookie, { venueId, action: "aiPersonalData", on: true }))).status).toBe(403);
    expect((await aiPersonalData(venueId)).on).toBe(false);
    expect((await integrationsPost(admin("/api/admin/integrations", managerCookie, { venueId, action: "aiPersonalData", on: "yes" }))).status).toBe(400);
    const on = await integrationsPost(admin("/api/admin/integrations", managerCookie, { venueId, action: "aiPersonalData", on: true }));
    expect(on.status).toBe(200);
    expect((await on.json()).aiPersonalData).toMatchObject({ on: true, changedBy: "Maya Manager" });
    expect((await (await integrationsGet(admin(`/api/admin/integrations?venueId=${venueId}`, managerCookie))).json()).aiPersonalData.on).toBe(true);
    const log = await listActivity([venueId]);
    expect(log.find((e) => e.action === "integration.ai_personal_data")).toMatchObject({ adminName: "Maya Manager", detail: "Customers' personal data shown to AI assistants (MCP): on" });

    const shown = dataOf(await tool("my_booking", { code: booking.code }, { key: readKey }));
    expect(shown.booking).toMatchObject({ name: customer.name, phone: customer.phone, email: customer.email });

    // And off again.
    expect((await integrationsPost(admin("/api/admin/integrations", managerCookie, { venueId, action: "aiPersonalData", on: false }))).status).toBe(200);
    expect(leaks(await tool("my_booking", { code: booking.code }, { key: readKey }))).toEqual([]);
  });
});

describe("booking and cancelling through the assistant", () => {
  const countBookings = async () => Number(((await getDb().prepare("SELECT COUNT(*) AS n FROM bookings").get()) as { n: number | string }).n);

  it("previews without confirm, changing nothing, then books with the API's own result and refusals", async () => {
    const before = await countBookings();
    const ask = { courtId, date: day, start: "18:00", end: "19:00", name: "Preview Person", phone: "0127776655" };
    const preview = await tool("create_booking", ask, { key: writeKey });
    const p = dataOf(preview);
    expect(textOf(preview)).toMatch(/^Nothing was booked\./);
    expect(p).toMatchObject({ courtId, courtName: "Court 1", date: day, startMin: 18 * 60, endMin: 19 * 60, paymentStatus: "unpaid" });
    expect([20, 30]).toContain(p.totalPrice);
    expect(p.customerTold).toMatch(/confirmation/);
    expect(await countBookings()).toBe(before);

    const made = dataOf(await tool("create_booking", { ...ask, confirm: true }, { key: writeKey }));
    expect(await countBookings()).toBe(before + 1);
    expect(made.booking).toMatchObject({ status: "confirmed", paymentStatus: "unpaid", totalPrice: p.totalPrice, startMin: 18 * 60 });
    const log = await listActivity([venueId], { bookingCode: made.booking.code });
    expect(log.find((e) => e.action === "booking.created")).toMatchObject({ adminName: `API key ${writeKeyId}`, detail: expect.stringContaining("MCP") });

    // The same request again: the same refusal as the API gives, the same words and code.
    const again = await tool("create_booking", { ...ask, confirm: true }, { key: writeKey });
    const api = await (await v1BookingsPost(v1("/api/v1/bookings", writeKey, ask))).json();
    expect(again.isError).toBe(true);
    expect(textOf(again)).toBe(api.code ? `${api.error} (${api.code})` : api.error);
    // An override is refused, never ignored, here as there; and in a preview too.
    const override = { ...ask, start: "20:00", end: "21:00", overridePolicies: true };
    const viaApi = await (await v1BookingsPost(v1("/api/v1/bookings", writeKey, override))).json();
    for (const confirm of [false, true]) expect(textOf(await tool("create_booking", { ...override, confirm }, { key: writeKey }))).toBe(`${viaApi.error} (R9_API_NO_OVERRIDE)`);
    expect(await countBookings()).toBe(before + 1);
  });

  it("previews a cancellation, changing nothing, then cancels as the API does, and logs every call under the key", async () => {
    const made = await createBooking({ courtId, date: day, start: 12 * 60, end: 13 * 60, name: "Cancel Me", phone: "0125554433", by: "api" });
    if (!made.ok) throw new Error(made.error);
    const code = made.booking.code;
    const preview = dataOf(await tool("cancel_booking", { code }, { key: writeKey }));
    expect(preview).toMatchObject({ alreadyCancelled: false, booking: { code, status: "confirmed" } });
    expect(preview.consequence).toMatch(/cancelled in full/);
    expect((await findBookingByCode(code))!.status).toBe("confirmed");
    const done = dataOf(await tool("cancel_booking", { code, confirm: true }, { key: writeKey }));
    expect(done.booking.status).toBe("cancelled");
    expect((await findBookingByCode(code))!.status).toBe("cancelled");
    const twice = await tool("cancel_booking", { code, confirm: true }, { key: writeKey });
    expect(twice.isError).toBe(true);
    const log = await listActivity([venueId]);
    expect(log.find((e) => e.action === "booking.cancelled" && e.bookingCode === code)).toMatchObject({ adminName: `API key ${writeKeyId}` });
    expect(log.some((e) => e.action === "mcp.tool" && e.detail === "cancel_booking through an AI assistant (MCP): preview, nothing cancelled")).toBe(true);
    // A read through a key is logged too, by tool and never with what was asked.
    await tool("my_venue", {}, { key: readKey });
    const read = (await listActivity([venueId])).find((e) => e.action === "mcp.tool" && e.detail?.startsWith("my_venue"));
    expect(read).toMatchObject({ adminName: expect.stringMatching(/^API key \d+$/) });
    expect((await listActivity([venueId])).filter((e) => e.action === "mcp.tool").every((e) => !/Siti|0129998877|Preview Person/.test(e.detail ?? ""))).toBe(true);
  });
});

describe("a browser on another site", () => {
  it("is refused when it sends an Origin that is not the site's; a client with no Origin, or the site's own, is not", async () => {
    const foreign = await mcpPost(request({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { origin: "https://evil.example" }));
    expect(foreign.status).toBe(403);
    // A name rebound to this server says its own name as the Host: it is still not the site.
    const rebound = new NextRequest("http://evil.example/api/mcp", {
      method: "POST",
      headers: { host: "evil.example", origin: "http://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect((await mcpPost(rebound)).status).toBe(403);
    expect((await rpc("ping", {}, { origin: "https://book.example.my" })).status).toBe(200);
    expect((await rpc("ping")).status).toBe(200);
    // With a key too: the Origin is refused before the key is looked at.
    expect((await mcpPost(request({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example", key: readKey }))).status).toBe(403);
  });
});
