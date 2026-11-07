import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";
process.env.MYSENAM_MARKETPLACE = "on";

import { NextRequest } from "next/server";
import { POST as mcpPost } from "../src/app/api/mcp/route";
import { GET as availabilityGet } from "../src/app/api/v1/availability/route";
import { GET as publicAvailabilityGet } from "../src/app/api/availability/route";
import { POST as bookingsPost } from "../src/app/api/v1/bookings/route";
import { createApiKey } from "../src/lib/api-keys";
import { getDb } from "../src/lib/db";
import { createBooking, createCourt, createVenue, findBookingByCode } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Hardening round B15: a booking held for payment that was not paid in time frees its slot for the venue's own system (its API key,
 * and the MCP server through it) the moment it is asked, exactly as the public grid does, not up to a minute later when the
 * scheduler gets there. The hold, and the slot, are the same ones the public grid frees (lib/holds.ts `releaseExpiredHolds`).
 */
let venueId: number;
let courtId: number;
let readKey: string;
let writeKey: string;
const day = addDays(todayISO(), 4);
let ip = 1;

const get = (key: string, url: string) =>
  new NextRequest(`http://localhost${url}`, { headers: { authorization: `Bearer ${key}`, "x-forwarded-for": `192.0.2.${ip++ % 250}` } });
const post = (key: string, body: unknown) =>
  new NextRequest("http://localhost/api/v1/bookings", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-forwarded-for": `192.0.2.${ip++ % 250}` },
    body: JSON.stringify(body),
  });
const rpc = async (key: string, name: string, args: Record<string, unknown>) => {
  const res = await mcpPost(
    new NextRequest("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}`, "x-forwarded-for": `198.51.100.${ip++ % 250}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    })
  );
  const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { text: body.result.content[0].text, isError: body.result.isError === true };
};

/** A booking at `hour`, unpaid, whose hold ran out five minutes ago and which nothing has released yet. */
async function lapsedHold(hour: number): Promise<string> {
  const made = await createBooking({ courtId, date: day, hours: [hour], name: "Held Tan", phone: `01230000${hour}` });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE bookings SET hold_until = datetime('now', '-5 minutes') WHERE id = ?").run(made.booking.id);
  return made.booking.code;
}
const slotFree = (body: { courts: { slots: { hour: number; available: boolean }[] }[] }, hour: number) => body.courts[0].slots.find((s) => s.hour === hour)!.available;
const status = async (code: string) => (await findBookingByCode(code))!.status;

beforeAll(async () => {
  const v = await createVenue({ name: "Lapsed Arena", area: "PJ", address: "1", phone: "0388880000", openMin: 7 * 60, closeMin: 23 * 60 });
  if (!v.ok) throw new Error(v.error);
  venueId = v.venue.id;
  const c = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 30 });
  if (!c.ok) throw new Error(c.error);
  courtId = c.court.id;
  const r = await createApiKey(venueId, { name: "Desk", scope: "read" }, null);
  const w = await createApiKey(venueId, { name: "Site", scope: "write" }, null);
  if (!r.ok || !w.ok) throw new Error("keys");
  readKey = r.key;
  writeKey = w.key;
});

describe("a lapsed hold and the venue's own system", () => {
  it("the public grid frees the slot on the way past (the behaviour to match)", async () => {
    const code = await lapsedHold(9);
    const res = await publicAvailabilityGet(new NextRequest(`http://localhost/api/availability?venueId=${venueId}&date=${day}`, { headers: { "x-forwarded-for": "203.0.113.5" } }));
    expect(res.status).toBe(200);
    expect(await status(code)).toBe("cancelled");
  });

  it("GET /api/v1/availability shows the slot free, and the booking is let go as the grid lets it go", async () => {
    const code = await lapsedHold(10);
    const res = await availabilityGet(get(readKey, `/api/v1/availability?date=${day}`));
    expect(res.status).toBe(200);
    expect(slotFree(await res.json(), 10)).toBe(true);
    expect(await status(code)).toBe("cancelled");
    expect((await getDb().prepare("SELECT released_unpaid FROM bookings WHERE code = ?").get(code)) as { released_unpaid: number }).toEqual({ released_unpaid: 1 });
  });

  it("POST /api/v1/bookings books the slot a lapsed hold was still sitting on", async () => {
    const code = await lapsedHold(11);
    const res = await bookingsPost(post(writeKey, { courtId, date: day, start: "11:00", end: "12:00", name: "Next Customer", phone: "0129990011" }));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    expect(await status(code)).toBe("cancelled");
  });

  it("the MCP server's my_availability and create_booking through a key do the same", async () => {
    const first = await lapsedHold(12);
    const seen = await rpc(readKey, "my_availability", { date: day });
    expect(seen.isError).toBe(false);
    const grid = JSON.parse(seen.text.slice(seen.text.indexOf("\n\n") + 2)) as { courts: { columns: { at: string; free: boolean }[] }[] };
    expect(grid.courts[0].columns.find((c) => c.at === "12:00")!.free).toBe(true);
    expect(await status(first)).toBe("cancelled");
    const second = await lapsedHold(13);
    const booked = await rpc(writeKey, "create_booking", { courtId, date: day, start: "13:00", end: "14:00", name: "Assistant Booked", phone: "0129990013", confirm: true });
    expect(booked.isError, booked.text).toBe(false);
    expect(await status(second)).toBe("cancelled");
  });

  it("a hold that has not lapsed, and one that was paid for, keep their slot", async () => {
    const live = await createBooking({ courtId, date: day, hours: [15], name: "Still Held", phone: "0123000015" });
    const paid = await createBooking({ courtId, date: day, hours: [16], name: "Paid Held", phone: "0123000016" });
    if (!live.ok || !paid.ok) throw new Error("booking");
    await getDb().prepare("UPDATE bookings SET hold_until = datetime('now', '+10 minutes') WHERE id = ?").run(live.booking.id);
    await getDb().prepare("UPDATE bookings SET hold_until = datetime('now', '-5 minutes'), payment_status = 'paid' WHERE id = ?").run(paid.booking.id);
    const body = await (await availabilityGet(get(readKey, `/api/v1/availability?date=${day}`))).json();
    expect(slotFree(body, 15)).toBe(false);
    expect(slotFree(body, 16)).toBe(false);
    const refused = await bookingsPost(post(writeKey, { courtId, date: day, start: "15:00", end: "16:00", name: "Too Early", phone: "0129990015" }));
    expect(refused.status).toBe(409);
    expect(await status(live.booking.code)).toBe("confirmed");
    expect(await status(paid.booking.code)).toBe("confirmed");
  });

  it("two calls at once release it once and both see the slot free", async () => {
    const code = await lapsedHold(17);
    const answers = await Promise.all([availabilityGet(get(readKey, `/api/v1/availability?date=${day}`)), availabilityGet(get(readKey, `/api/v1/availability?date=${day}`))]);
    for (const a of answers) expect(slotFree(await a.json(), 17)).toBe(true);
    expect(await status(code)).toBe("cancelled");
  });
});
