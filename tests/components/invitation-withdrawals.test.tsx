// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import GamesPage from "../../src/app/games/page";
import GroupPage from "../../src/app/games/groups/[id]/page";
import { AccessEditor } from "../../src/components/admin/AccessEditor";
import { GuestInvites } from "../../src/components/GuestInvites";
import { LanguageProvider } from "../../src/components/Language";
import type { OpenGame } from "../../src/lib/games";
import type { Group } from "../../src/lib/groups";
import { translator } from "../../src/lib/i18n";
import { STAFF_DICTIONARIES } from "../../src/lib/staff-i18n";
import { addDays, todayISO } from "../../src/lib/time";

/**
 * The "Withdraw invitation" actions (the owner's decision of 28 October
 * 2026): on each emailed invitation not yet accepted where whoever sent it
 * lists them — the resident's guests, the host's game, the organiser's group
 * — and for the venue's manager on the list of a private venue. Each asks
 * first (a confirm; staff give a reason); nothing is sent when it is
 * cancelled; a withdrawn one is shown as such, with nothing more to do.
 */

const en = translator("en");
const staff = STAFF_DICTIONARIES.en;
type Reply = { status?: number; body: unknown };
let routes: Record<string, Reply | ((init?: RequestInit) => Reply)>;
let calls: { url: string; method: string; body: unknown }[];

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const path = String(url).split("?")[0];
      const route = routes[`${method} ${path}`] ?? routes[path];
      const reply = typeof route === "function" ? route(init) : (route ?? { status: 404, body: {} });
      const status = reply.status ?? 200;
      return { ok: status < 300, status, json: async () => reply.body };
    })
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = () => act(async () => {});
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.url.split("?")[0] === path);
const resolved = <V,>(value: V) => Object.assign(Promise.resolve(value), { status: "fulfilled", value });

describe("the resident's guests", () => {
  const guest = (id: number, name: string, over: Record<string, unknown> = {}) => ({ id, phone: `01300000${id}`, name, expiresOn: "2026-10-30", linked: false, invited: false, ...over });
  const venue = (guests: ReturnType<typeof guest>[]) => ({ id: 7, name: "Kondo Tujuh", policy: { perResident: 5, days: 3 }, guests });

  async function open(guests: ReturnType<typeof guest>[]) {
    routes["GET /api/my/guests"] = { body: { venues: [venue(guests)], phoneChecks: false } };
    render(
      <LanguageProvider locale="en">
        <GuestInvites />
      </LanguageProvider>
    );
    await settle();
  }
  const row = (name: string) => screen.getByText(name, { exact: false }).closest("li")!;

  it("offers withdrawing only an invitation out, asks first, and shows it withdrawn", async () => {
    await open([guest(1, "Ali", { invited: true }), guest(2, "Mei", { linked: true }), guest(3, "Raj")]);
    expect(within(row("Mei")).queryByRole("button", { name: en("rv7.withdraw") })).toBeNull();
    expect(within(row("Raj")).queryByRole("button", { name: en("rv7.withdraw") })).toBeNull();

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => void fireEvent.click(within(row("Ali")).getByRole("button", { name: en("rv7.withdraw") })));
    expect(confirm).toHaveBeenCalledWith(en("rv7.withdrawConfirm"));
    expect(sent("PATCH", "/api/my/guests")).toHaveLength(0);

    confirm.mockReturnValue(true);
    routes["PATCH /api/my/guests"] = { body: { withdrawn: true, venues: [venue([guest(1, "Ali", { withdrawn: true })])] } };
    await act(async () => void fireEvent.click(within(row("Ali")).getByRole("button", { name: en("rv7.withdraw") })));
    expect(sent("PATCH", "/api/my/guests").map((c) => c.body)).toEqual([{ action: "withdrawInvitation", id: 1 }]);
    expect(row("Ali").textContent).toContain(en("rv7.withdrawn"));
    expect(within(row("Ali")).queryByRole("button", { name: en("rv7.withdraw") })).toBeNull();
    // The guest is still there to take off.
    expect(within(row("Ali")).getByRole("button", { name: en("guests.remove") })).toBeTruthy();
  });

  it("says why it was refused: already accepted, take the guest off instead", async () => {
    await open([guest(1, "Ali", { invited: true })]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    routes["PATCH /api/my/guests"] = { status: 409, body: { error: en("err.INVITATION_ACCEPTED_GUEST"), code: "INVITATION_ACCEPTED_GUEST" } };
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: en("rv7.withdraw") })));
    expect(screen.getByText(en("err.INVITATION_ACCEPTED_GUEST"))).toBeTruthy();
  });
});

describe("the host's game", () => {
  const day = addDays(todayISO(), 3);
  const game = (over: Partial<OpenGame> = {}) =>
    ({
      id: 15,
      bookingId: 70,
      bookingCode: "MS-HOST1",
      hostId: 5,
      hostName: "Aina",
      hostLevel: null,
      venueId: 1,
      venueName: "My Hall",
      area: "Petaling Jaya",
      timeZone: "Asia/Kuala_Lumpur",
      courtName: "Court 2",
      sport: "badminton",
      date: day,
      startHour: 20,
      endHour: 22,
      level: null,
      who: "anyone",
      spots: 3,
      joined: 0,
      held: 0,
      waiting: 0,
      visibility: "public",
      waitlist: true,
      intensity: "casual",
      adultsOnly: false,
      seriesId: null,
      share: 0,
      autoAccept: false,
      note: null,
      status: "open",
      payOnline: false,
      yours: true,
      players: [],
      ...over,
    }) as OpenGame;

  it("withdraws an invitation by email after a confirm; a withdrawn one is shown with nothing to do", async () => {
    const mine = {
      hosting: [game({ emailInvites: [{ id: 5, expiresAt: "2026-12-01 10:00:00" }, { id: 6, expiresAt: "2026-12-01 10:00:00", withdrawn: true }] })],
      playing: [],
      noShows: 0,
      maxNoShows: 3,
    };
    routes["/api/games"] = { body: { games: [], signedIn: true } };
    routes["/api/my/games"] = { body: mine };
    routes["/api/my/levels"] = { body: { levels: {} } };
    routes["/api/games/series"] = { body: { series: [] } };
    routes["/api/my/bookings"] = { body: { bookings: [] } };
    routes["/api/sports"] = { body: { sports: ["badminton"] } };
    routes["POST /api/games/15"] = { body: { withdrawn: true, game: game() } };
    render(<GamesPage />);
    await settle();
    const [out, gone] = within(screen.getByTestId("hosted-15")).getAllByTestId("email-invite");
    expect(gone.textContent).toBe(en("rv7.withdrawnEmail"));
    expect(within(gone).queryAllByRole("button")).toHaveLength(0);

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => void fireEvent.click(within(out).getByRole("button", { name: en("rv7.withdraw") })));
    expect(sent("POST", "/api/games/15")).toHaveLength(0);
    confirm.mockReturnValue(true);
    await act(async () => void fireEvent.click(within(out).getByRole("button", { name: en("rv7.withdraw") })));
    expect(sent("POST", "/api/games/15").map((c) => c.body)).toEqual([{ action: "withdrawInvitation", invitationId: 5 }]);
    expect(screen.getByText(en("rv7.withdrawnOk"))).toBeTruthy();
  });
});

describe("the organiser's group", () => {
  const group = (over: Partial<Group> = {}) =>
    ({
      id: 7,
      name: "Tuesday Smashers",
      sport: "badminton",
      area: null,
      description: null,
      privacy: "public",
      capacity: 12,
      members: 1,
      organiserId: 5,
      organiserName: "Aina",
      status: "active",
      mine: { memberId: 30, role: "organiser", status: "member" },
      roster: [{ memberId: 30, userId: 5, name: "Aina", role: "organiser", status: "member" }],
      ...over,
    }) as Group;

  it("withdraws an invitation by email after a confirm; a refusal is said in the reader's words", async () => {
    routes["GET /api/groups/7"] = { body: { group: group({ emailInvites: [{ id: 9, expiresAt: "2026-12-01 10:00:00" }] }), signedIn: true } };
    routes["POST /api/groups/7"] = { status: 409, body: { error: en("err.INVITATION_ACCEPTED_GROUP"), code: "INVITATION_ACCEPTED_GROUP" } };
    render(<GroupPage params={resolved({ id: "7" })} />);
    await settle();
    await settle();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => void fireEvent.click(within(screen.getByTestId("email-invite")).getByRole("button", { name: en("rv7.withdraw") })));
    expect(sent("POST", "/api/groups/7").map((c) => c.body)).toEqual([{ action: "withdrawInvitation", invitationId: 9 }]);
    expect(screen.getByText(en("err.INVITATION_ACCEPTED_GROUP"))).toBeTruthy();
  });

  it("offers nothing to a member who is not the organiser", async () => {
    routes["GET /api/groups/7"] = {
      body: { group: group({ mine: { memberId: 31, role: "member", status: "member" }, emailInvites: [{ id: 9, expiresAt: "2026-12-01 10:00:00" }] }), signedIn: true },
    };
    render(<GroupPage params={resolved({ id: "7" })} />);
    await settle();
    await settle();
    expect(screen.queryByRole("button", { name: en("rv7.withdraw") })).toBeNull();
  });
});

describe("a private venue's list, for its manager", () => {
  const entry = (id: number, name: string, invitation?: "pending" | "withdrawn") => ({
    id,
    phone: `01300000${id}`,
    name,
    label: "A-1-1",
    kind: "guest",
    expiresOn: "2026-10-30",
    createdAt: "2026-10-28",
    hasAccount: false,
    account: null,
    proved: false,
    invitedBy: "Hafiz",
    ...(invitation ? { invitation } : {}),
  });
  const state = (list: ReturnType<typeof entry>[]) => ({ settings: { access: "private", listed: true, note: null }, list, phoneChecks: false, guests: { perResident: 2, days: 3 } });

  it("withdraws a guest's invitation with a reason as the confirm step; cancelled, nothing is sent", async () => {
    routes["GET /api/admin/venue-access"] = { body: state([entry(1, "Ali", "pending"), entry(2, "Mei", "withdrawn"), entry(3, "Raj")]) };
    routes["POST /api/admin/venue-access"] = { body: { withdrawn: true, ...state([entry(1, "Ali", "withdrawn")]) } };
    render(
      <LanguageProvider locale="en">
        <AccessEditor venueId={7} />
      </LanguageProvider>
    );
    await act(async () => void fireEvent.click(screen.getByRole("button")));
    const rowOf = (name: string) => screen.getByText(name).closest("tr")!;
    expect(within(rowOf("Ali")).getByTestId("guest-invitation").textContent).toBe(staff["rv7.pending"]);
    expect(within(rowOf("Mei")).getByTestId("guest-invitation").textContent).toBe(staff["rv7.withdrawn"]);
    expect(within(rowOf("Mei")).queryByRole("button", { name: staff["rv7.withdraw"] })).toBeNull();
    expect(within(rowOf("Raj")).queryByTestId("guest-invitation")).toBeNull();

    const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
    await act(async () => void fireEvent.click(within(rowOf("Ali")).getByRole("button", { name: staff["rv7.withdraw"] })));
    expect(prompt).toHaveBeenCalledWith(staff["rv7.reasonPrompt"].replace("{name}", "Ali"));
    prompt.mockReturnValue("  ");
    await act(async () => void fireEvent.click(within(rowOf("Ali")).getByRole("button", { name: staff["rv7.withdraw"] })));
    expect(sent("POST", "/api/admin/venue-access")).toHaveLength(0);

    prompt.mockReturnValue("Owner asked us to");
    await act(async () => void fireEvent.click(within(rowOf("Ali")).getByRole("button", { name: staff["rv7.withdraw"] })));
    expect(sent("POST", "/api/admin/venue-access").map((c) => c.body)).toEqual([{ venueId: 7, action: "withdrawInvitation", id: 1, reason: "Owner asked us to" }]);
    expect(screen.getByText(staff["rv7.withdrawnOk"])).toBeTruthy();
    expect(within(rowOf("Ali")).getByTestId("guest-invitation").textContent).toBe(staff["rv7.withdrawn"]);
  });
});
