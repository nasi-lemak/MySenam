import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import {
  authenticateAdmin,
  canAccessVenue,
  createAdmin,
  createAdminSession,
  deleteAdmin,
  destroyAdminSession,
  ensureBootstrapAdmin,
  getAdminByToken,
  isOwner,
  listAdmins,
} from "../src/lib/admin-auth";
import {
  createBooking,
  createVenue,
  getVenueIdForBookingCode,
  getVenueIdsForSeriesCode,
  createBookingSeries,
  listBookingsForDate,
  listVenues,
  updateVenue,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

const PHONE = "0123456789";
const futureDate = (offset: number) => addDays(todayISO(), offset);

describe("bootstrap owner", () => {
  it("creates exactly one platform owner on a fresh database", () => {
    ensureBootstrapAdmin();
    ensureBootstrapAdmin(); // idempotent
    const owners = listAdmins().filter(isOwner);
    expect(owners).toHaveLength(1);
    expect(owners[0].venueId).toBeNull();

    expect(authenticateAdmin("admin@mysenam.my", "mysenam-admin")).toMatchObject({
      venueId: null,
    });
    expect(authenticateAdmin("admin@mysenam.my", "wrong")).toBeNull();
    expect(authenticateAdmin("nobody@example.com", "mysenam-admin")).toBeNull();
  });
});

describe("admin sessions", () => {
  it("round-trips a token and destroys it", () => {
    const owner = authenticateAdmin("admin@mysenam.my", "mysenam-admin")!;
    const { token } = createAdminSession(owner.id);
    expect(getAdminByToken(token)).toMatchObject({ id: owner.id });
    expect(getAdminByToken("nope")).toBeNull();
    destroyAdminSession(token);
    expect(getAdminByToken(token)).toBeNull();
  });
});

describe("venue scoping", () => {
  it("limits a venue admin to its own venue and lets the owner see all", () => {
    const [first, second] = listVenues();
    const venueAdmin = createAdmin({
      name: "Desk Staff",
      email: "desk@venue-one.com",
      password: "password1",
      venueId: first.id,
    });
    expect(venueAdmin.ok).toBe(true);
    if (!venueAdmin.ok) return;

    const owner = authenticateAdmin("admin@mysenam.my", "mysenam-admin")!;

    expect(isOwner(owner)).toBe(true);
    expect(isOwner(venueAdmin.admin)).toBe(false);
    expect(canAccessVenue(owner, first.id)).toBe(true);
    expect(canAccessVenue(owner, second.id)).toBe(true);
    expect(canAccessVenue(venueAdmin.admin, first.id)).toBe(true);
    expect(canAccessVenue(venueAdmin.admin, second.id)).toBe(false);
  });

  it("rejects a duplicate admin email", () => {
    expect(
      createAdmin({
        name: "Clash",
        email: "DESK@venue-one.com",
        password: "password1",
        venueId: null,
      })
    ).toMatchObject({ ok: false, error: expect.stringContaining("already exists") });
  });

  it("scopes the day's booking list to one venue", () => {
    const [first, second] = listVenues();
    const date = futureDate(5);
    createBooking({
      courtId: first.courts[0].id, date, hours: [10], name: "A", phone: PHONE,
    });
    createBooking({
      courtId: second.courts[0].id, date, hours: [10], name: "B", phone: PHONE,
    });

    expect(listBookingsForDate(date)).toHaveLength(2);
    const scoped = listBookingsForDate(date, first.id);
    expect(scoped).toHaveLength(1);
    expect(scoped[0].venueName).toBe(first.name);
  });

  it("resolves the owning venue of a booking code and a series code", () => {
    const venue = listVenues()[1];
    const date = futureDate(6);
    const booking = createBooking({
      courtId: venue.courts[0].id, date, hours: [11], name: "A", phone: PHONE,
    });
    expect(booking.ok).toBe(true);
    if (!booking.ok) return;
    expect(getVenueIdForBookingCode(booking.booking.code)).toBe(venue.id);
    expect(getVenueIdForBookingCode("MS-NOSUCH")).toBeNull();

    const series = createBookingSeries({
      courtId: venue.courts[1].id, date, hours: [12], weeks: 2, name: "L", phone: PHONE,
    });
    expect(series.ok).toBe(true);
    if (!series.ok) return;
    expect(getVenueIdsForSeriesCode(series.seriesCode!)).toEqual([venue.id]);
    expect(getVenueIdsForSeriesCode("SR-NOSUCH")).toEqual([]);
  });
});

describe("venue CRUD", () => {
  it("creates a venue and scopes a new admin to it", () => {
    const before = listVenues().length;
    const created = createVenue({
      name: "Cheras Smash Arena",
      area: "Cheras",
      address: "1 Jalan Cheras, 56000 Kuala Lumpur",
      phone: "+60 3-9999 0000",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(listVenues()).toHaveLength(before + 1);

    const staff = createAdmin({
      name: "Cheras Desk",
      email: "desk@cheras.com",
      password: "password1",
      venueId: created.venue.id,
    });
    expect(staff.ok).toBe(true);
    if (!staff.ok) return;
    expect(canAccessVenue(staff.admin, created.venue.id)).toBe(true);
    expect(canAccessVenue(staff.admin, listVenues()[0].id)).toBe(false);
  });

  it("updates venue details and rejects unknown venues", () => {
    const venue = listVenues()[0];
    const updated = updateVenue(venue.id, { area: "PJ Old Town", phone: "+60 3-1111 2222" });
    expect(updated).toMatchObject({
      ok: true,
      venue: { area: "PJ Old Town", phone: "+60 3-1111 2222", name: venue.name },
    });
    expect(updateVenue(99999, { area: "Nowhere" })).toMatchObject({ ok: false });
  });
});

describe("admin removal", () => {
  it("refuses to remove the last platform owner", () => {
    const owners = listAdmins().filter(isOwner);
    expect(owners).toHaveLength(1);
    expect(deleteAdmin(owners[0].id)).toMatchObject({
      ok: false,
      error: expect.stringContaining("last platform owner"),
    });

    // a second owner makes removal safe again
    const extra = createAdmin({
      name: "Co-owner", email: "co@mysenam.my", password: "password1", venueId: null,
    });
    expect(extra.ok).toBe(true);
    expect(deleteAdmin(owners[0].id)).toMatchObject({ ok: true });

    expect(deleteAdmin(99999)).toMatchObject({ ok: false, error: "Admin not found." });
  });
});
