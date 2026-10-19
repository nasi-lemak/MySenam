import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { getDb } from "../src/lib/db";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { accessList, accessRefusal, addAccess, setAccessSettings } from "../src/lib/access";
import { cancelGuest, inviteGuest, myInviteVenues, setGuestPolicy } from "../src/lib/guest-invites";
import { houseRuleRefusal, setHouseRules } from "../src/lib/house-rules";
import { createBooking, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { DELETE as uninvite, GET as guestsGet, POST as invitePost } from "../src/app/api/my/guests/route";

/**
 * A condominium resident putting their own visitors on the courts' list, a
 * few days at a time, rather than asking the management office for each.
 */

let venueId: number;
let courtId: number;
let host: { id: number; phone: string };
let neighbour: { id: number; phone: string };
let cookie: string;
const today = todayISO();

async function newUser(email: string, phone: string) {
  const made = await registerUser({ name: email.split("@")[0], email, phone, password: "rahsia-123" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

const entry = async (phone: string) => (await accessList(venueId)).find((e) => e.phone === phone);

beforeAll(async () => {
  const made = await createVenue({ name: "Taman Indah Courts", area: "Cheras", address: "x", phone: "0300000000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 0, peakRate: 0 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
  await setAccessSettings(venueId, { access: "private" });
  host = await newUser("hafiz@example.my", "0121110000");
  neighbour = await newUser("mei@example.my", "0122220000");
  const added = await addAccess(
    venueId,
    [
      { phone: "0121110000", name: "Hafiz", label: "A-12-3", kind: "resident" },
      { phone: "0122220000", name: "Mei Ling", label: "B-5-1", kind: "resident" },
    ],
    null
  );
  if (!added.ok) throw new Error(added.error);
  cookie = `${SESSION_COOKIE}=${(await createSession(host.id)).token}`;
});

describe("residents inviting guests", () => {
  it("is off until the venue allows it", async () => {
    expect(await myInviteVenues(host.id)).toEqual([]);
    expect(await inviteGuest(host.id, { venueId, phone: "0133330000", days: 1 })).toMatchObject({ ok: false, code: "GUEST_NOT_HOST" });
    expect(await setGuestPolicy(venueId, { perResident: 11, days: 3 })).toMatchObject({ ok: false });
    expect(await setGuestPolicy(venueId, { perResident: 2, days: 15 })).toMatchObject({ ok: false });
    expect(await setGuestPolicy(venueId, { perResident: 2, days: 3 })).toMatchObject({ ok: true, policy: { perResident: 2, days: 3 } });
  });

  it("puts the guest on the list under the host's unit, so they can book", async () => {
    const guest = await newUser("ali@example.my", "0133330000");
    expect(await accessRefusal(venueId, guest.id)).toMatchObject({ code: "PRIVATE_VENUE" });
    const res = await invitePost(
      new NextRequest("http://localhost/api/my/guests", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ venueId, phone: "013-333 0000", name: "Ali", days: 3 }),
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.guest).toMatchObject({ name: "Ali", expiresOn: addDays(today, 2) });
    expect(body.venues).toMatchObject([{ id: venueId, policy: { perResident: 2, days: 3 }, guests: [{ name: "Ali" }] }]);
    expect(await entry("013-333 0000")).toMatchObject({ kind: "guest", label: "A-12-3", invitedBy: "Hafiz", expiresOn: addDays(today, 2) });
    expect(await accessRefusal(venueId, guest.id)).toBeNull();
  });

  it("keeps to the venue's limits", async () => {
    expect(await inviteGuest(host.id, { venueId, phone: "0134440000", days: 4 })).toMatchObject({ code: "GUEST_DAYS", vars: { n: 3 } });
    expect(await inviteGuest(host.id, { venueId, phone: "012-111 0000", days: 1 })).toMatchObject({ code: "GUEST_SELF" });
    expect(await inviteGuest(host.id, { venueId, phone: "0122220000", days: 1 })).toMatchObject({ code: "GUEST_LISTED" });
    expect(await inviteGuest(host.id, { venueId, phone: "0134440000", days: 1 })).toMatchObject({ ok: true });
    expect(await inviteGuest(host.id, { venueId, phone: "0135550000", days: 1 })).toMatchObject({ code: "GUEST_LIMIT", vars: { n: 2 } });
    // Their own guest staying longer is the same invitation, not another.
    expect(await inviteGuest(host.id, { venueId, phone: "0134440000", days: 3 })).toMatchObject({ ok: true, guest: { expiresOn: addDays(today, 2) } });
    // Another resident's guest is theirs, until the invitation runs out.
    expect(await inviteGuest(neighbour.id, { venueId, phone: "0134440000", days: 1 })).toMatchObject({ code: "GUEST_LISTED" });
    await getDb().prepare("UPDATE venue_access_list SET expires_on = ? WHERE phone_key = phone_key('0134440000')").run(addDays(today, -1));
    expect(await inviteGuest(neighbour.id, { venueId, phone: "0134440000", days: 1 })).toMatchObject({ ok: true });
    expect(await entry("0134440000")).toMatchObject({ label: "B-5-1", invitedBy: "Mei Ling" });
  });

  it("does not let a guest invite guests", async () => {
    const guest = (await getDb().prepare("SELECT id FROM users WHERE email = 'ali@example.my'").get()) as { id: number };
    expect(await inviteGuest(guest.id, { venueId, phone: "0136660000", days: 1 })).toMatchObject({ code: "GUEST_NOT_HOST" });
  });

  it("counts a guest's bookings with the host's household", async () => {
    await setHouseRules(venueId, { upcoming: 1 });
    const booked = await createBooking({ courtId, date: addDays(today, 1), hours: [9], name: "Hafiz", phone: "0121110000", userId: host.id });
    expect(booked.ok).toBe(true);
    expect(await houseRuleRefusal({ venueId, phone: "0133330000", dates: [addDays(today, 2)] })).toMatchObject({ code: "LIMIT_UPCOMING" });
    // The other unit's allowance is its own.
    expect(await houseRuleRefusal({ venueId, phone: "0122220000", dates: [addDays(today, 2)] })).toBeNull();
    await setHouseRules(venueId, { upcoming: null });
  });

  it("lets the host take a guest off, and only their own", async () => {
    const neighboursGuest = (await entry("0134440000"))!;
    expect(await cancelGuest(host.id, neighboursGuest.id)).toBe(false);
    const res = await uninvite(new NextRequest(`http://localhost/api/my/guests?id=${(await entry("013-333 0000"))!.id}`, { method: "DELETE", headers: { cookie } }));
    expect(res.status).toBe(200);
    expect(await entry("013-333 0000")).toBeUndefined();
  });

  it("removes a host's guests with the host, and staff adding the number makes it theirs", async () => {
    expect(await inviteGuest(host.id, { venueId, phone: "0137770000", days: 2 })).toMatchObject({ ok: true });
    expect(await inviteGuest(host.id, { venueId, phone: "0138880000", days: 2 })).toMatchObject({ ok: true });
    await addAccess(venueId, [{ phone: "0138880000", name: "Driver", kind: "resident", label: "A-12-3" }], null);
    expect(await entry("0138880000")).toMatchObject({ kind: "resident" });
    expect((await entry("0138880000"))!.invitedBy).toBeUndefined();
    await getDb().prepare("DELETE FROM venue_access_list WHERE phone_key = phone_key('0121110000')").run();
    expect(await entry("0137770000")).toBeUndefined();
    expect(await entry("0138880000")).toBeDefined();
  });

  it("needs an account", async () => {
    expect((await guestsGet(new NextRequest("http://localhost/api/my/guests"))).status).toBe(401);
  });
});
