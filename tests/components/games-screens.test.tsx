// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import GamesPage from "../../src/app/games/page";
import GroupsPage from "../../src/app/games/groups/page";
import GroupPage from "../../src/app/games/groups/[id]/page";
import PreferencesPage from "../../src/app/games/preferences/page";
import type { OpenGame } from "../../src/lib/games";
import type { Group } from "../../src/lib/groups";
import type { PlayerProfile } from "../../src/lib/player-profiles";
import { addDays, todayISO } from "../../src/lib/time";

/**
 * The matchmaking screens (ADR 0016): `/games` (open games to find and join,
 * your own games to run, a booking to open), the groups list and one group,
 * and the playing preferences. What each sends is checked, and what each
 * shows or withholds for who is looking: signed out, a player, the host, the
 * organiser; the opt-ins to being found and invited for declared adults only.
 */

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
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const path = url.split("?")[0];
      const route = routes[`${method} ${url}`] ?? routes[`${method} ${path}`] ?? routes[path];
      const reply = typeof route === "function" ? route(init) : (route ?? { status: 404, body: {} });
      const status = reply.status ?? 200;
      return { ok: status < 300, status, json: async () => reply.body };
    })
  );
  routes["/api/sports"] = { body: { sports: ["badminton", "pickleball"] } };
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const settle = () => act(async () => {});
/** A page's params as Next passes them, already settled, so React's use() reads them at once. */
const resolved = <V,>(value: V) => Object.assign(Promise.resolve(value), { status: "fulfilled", value });
const posts = (path?: string) => calls.filter((c) => c.method !== "GET" && (!path || c.url === path));

const day = addDays(todayISO(), 3);
function game(over: Partial<OpenGame> = {}): OpenGame {
  return {
    id: 12,
    bookingId: 70,
    bookingCode: "MS-HOST1",
    hostId: 5,
    hostName: "Aina",
    hostLevel: "intermediate",
    venueId: 1,
    venueName: "Arena PJ",
    area: "Petaling Jaya",
    timeZone: "Asia/Kuala_Lumpur",
    courtName: "Court 2",
    sport: "badminton",
    date: day,
    startHour: 20,
    endHour: 22,
    level: "intermediate",
    who: "anyone",
    spots: 3,
    joined: 1,
    held: 0,
    waiting: 0,
    visibility: "public",
    waitlist: true,
    intensity: "casual",
    adultsOnly: true,
    seriesId: null,
    share: 12.5,
    autoAccept: false,
    note: "Doubles, friendly",
    status: "open",
    payOnline: false,
    ...over,
  } as OpenGame;
}

describe("the /games page, signed out", () => {
  beforeEach(() => {
    routes["/api/games"] = { body: { games: [game()], signedIn: false } };
  });

  it("lists open games with their share, places left and host, and asks to sign in to join", async () => {
    render(<GamesPage />);
    await settle();
    const card = screen.getByTestId("game-12");
    expect(within(card).getByText("Arena PJ")).toBeTruthy();
    expect(within(card).getByText("RM12.50 each")).toBeTruthy();
    expect(within(card).getByText("2 spots left")).toBeTruthy();
    expect(within(card).getByText("18+")).toBeTruthy();
    expect(within(card).getByText(/Hosted by Aina/)).toBeTruthy();
    expect(within(card).getByText("“Doubles, friendly”")).toBeTruthy();
    expect(within(card).getByRole("link", { name: "Sign in to join" }).getAttribute("href")).toBe("/login?next=%2Fgames");
    // Nothing of an account is asked for or offered.
    expect(calls.some((c) => c.url.startsWith("/api/my/"))).toBe(false);
    expect(screen.queryByText("Playing preferences")).toBeNull();
    expect(screen.queryByText("Need players? Open one of your bookings")).toBeNull();
  });

  it("asks again with the filters chosen", async () => {
    render(<GamesPage />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Pickleball/ }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Beginner" }));
    await settle();
    expect(calls.filter((c) => c.url.startsWith("/api/games?")).map((c) => c.url).at(-1)).toBe("/api/games?sport=pickleball&level=beginner");
  });

  it("shows a private game shared by a link on top, the sign-in coming back to that link", async () => {
    window.history.replaceState(null, "", "/games?game=44&link=abc123");
    routes["/api/games/44"] = { body: { game: game({ id: 44, visibility: "private", venueName: "Hall Cheras" }) } };
    render(<GamesPage />);
    await settle();
    const shared = screen.getByTestId("shared-game");
    expect(within(shared).getByText(/Hall Cheras/)).toBeTruthy();
    expect(calls.some((c) => c.url === "/api/games/44?link=abc123")).toBe(true);
    expect(within(shared).getByRole("link", { name: "Sign in to join" }).getAttribute("href")).toBe(`/login?next=${encodeURIComponent("/games?game=44&link=abc123")}`);
  });
});

describe("the /games page, signed in", () => {
  let mine: { hosting: OpenGame[]; playing: OpenGame[]; noShows: number; maxNoShows: number };
  let games: OpenGame[];
  beforeEach(() => {
    games = [
      game(),
      game({ id: 13, autoAccept: true, venueName: "Court Hub" }),
      game({ id: 14, joined: 3, venueName: "Full House" }),
      game({ id: 15, yours: true, venueName: "My Hall" }),
      game({ id: 16, mine: { playerId: 9, status: "requested", paid: false, expiresAt: null }, venueName: "Asked Arena" }),
    ];
    mine = { hosting: [], playing: [], noShows: 0, maxNoShows: 3 };
    routes["/api/games"] = () => ({ body: { games, signedIn: true } });
    routes["/api/my/games"] = () => ({ body: mine });
    routes["/api/my/levels"] = { body: { levels: {} } };
    routes["/api/games/series"] = { body: { series: [] } };
    routes["/api/games/recommended"] = { status: 404, body: {} };
    routes["/api/my/bookings"] = { body: { bookings: [] } };
  });

  it("offers each game what fits it: ask, join at once, the waiting list, nothing on your own, withdrawing a request", async () => {
    render(<GamesPage />);
    await settle();
    const label = (id: number) => within(screen.getByTestId(`game-${id}`)).getAllByRole("button").map((b) => b.textContent);
    expect(label(12)).toEqual(["Ask to join"]);
    expect(label(13)).toEqual(["Join"]);
    expect(label(14)).toEqual(["Join the waiting list"]);
    expect(within(screen.getByTestId("game-15")).getByText("Your game")).toBeTruthy();
    expect(within(screen.getByTestId("game-16")).getByText(/Asked: waiting for Aina/)).toBeTruthy();
    expect(label(16)).toEqual(["Withdraw"]);
    expect(screen.getByRole("link", { name: "Playing preferences" })).toBeTruthy();
  });

  it("asks to join, then reads the games again; a refusal is shown", async () => {
    routes["POST /api/games/12"] = { body: { ok: true } };
    routes["POST /api/games/13"] = { status: 403, body: { error: "This game is for players who say they are 18 or over.", code: "ADULTS_ONLY" } };
    render(<GamesPage />);
    await settle();
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("game-12")).getByRole("button", { name: "Ask to join" }));
    });
    expect(posts("/api/games/12")[0].body).toEqual({ action: "join" });
    expect(calls.filter((c) => c.url.startsWith("/api/games?")).length).toBe(2);
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("game-13")).getByRole("button", { name: "Join" }));
    });
    expect(screen.getByText("This game is for players who say they are 18 or over.")).toBeTruthy();
  });

  it("lets the host accept or decline who asked, and stop taking players", async () => {
    mine.hosting = [
      game({
        id: 15,
        yours: true,
        players: [
          { id: 101, userId: 21, name: "Bala", level: "beginner", status: "requested", paid: false, noShow: false, expiresAt: null, invited: false, toConfirm: false },
          { id: 102, userId: 22, name: "Chen", level: null, status: "accepted", paid: true, noShow: false, expiresAt: null, invited: false, toConfirm: false },
        ],
        emailInvites: [{ id: 5, expiresAt: "2026-12-01 10:00:00" }],
      }),
    ];
    routes["POST /api/games/15/players/101"] = { body: { ok: true } };
    routes["POST /api/games/15"] = { body: { ok: true } };
    render(<GamesPage />);
    await settle();
    const hosted = screen.getByTestId("hosted-15");
    expect(within(hosted).getByText(/1 of 3 joined/)).toBeTruthy();
    expect(within(hosted).getByText(/Bala \(Beginner\) · wants to join/)).toBeTruthy();
    expect(within(hosted).getByText(/Chen · joined, share paid/)).toBeTruthy();
    // Somebody invited by email: nothing about who until they accept; the one thing to do is withdraw it (tests/components/invitation-withdrawals.test.tsx).
    const emailed = within(hosted).getByTestId("email-invite");
    expect(emailed.textContent).toBe("Invited by email, not yet acceptedWithdraw invitation");
    expect(within(emailed).getAllByRole("button").map((b) => b.textContent)).toEqual(["Withdraw invitation"]);
    const bala = within(hosted).getByText(/Bala/).closest("li")!;
    await act(async () => {
      fireEvent.click(within(bala).getByRole("button", { name: "Accept" }));
    });
    expect(posts("/api/games/15/players/101")[0].body).toEqual({ action: "accept" });
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("hosted-15")).getByRole("button", { name: "Stop taking players" }));
    });
    expect(posts("/api/games/15")[0].body).toEqual({ action: "close" });
  });

  it("tells a player in a game with no online payment to pay their share at the venue", async () => {
    mine.playing = [game({ id: 17, mine: { playerId: 9, status: "accepted", paid: false, expiresAt: null } })];
    render(<GamesPage />);
    await settle();
    const playing = screen.getByTestId("playing-17");
    expect(within(playing).getByText("Pay your RM12.50 share at the venue")).toBeTruthy();
    expect(within(playing).queryByRole("button", { name: /Pay my/ })).toBeNull();
  });

  it("opens one of the player's upcoming bookings, suggesting a share that splits the court evenly", async () => {
    routes["/api/my/bookings"] = {
      body: {
        bookings: [
          { code: "MS-OPEN1", date: day, startHour: 19, endHour: 21, status: "confirmed", totalPrice: 50, classId: null, courtName: "Court 1", venueName: "Arena PJ", venueTimeZone: "Asia/Kuala_Lumpur", sport: "badminton" },
          { code: "MS-GONE", date: day, startHour: 9, endHour: 10, status: "cancelled", totalPrice: 20, classId: null, courtName: "Court 1", venueName: "Arena PJ", sport: "badminton" },
          { code: "MS-CLASS", date: day, startHour: 9, endHour: 10, status: "confirmed", totalPrice: 20, classId: 4, courtName: "Hall", venueName: "Arena PJ", sport: "badminton" },
          { code: "MS-PAST", date: addDays(todayISO(), -2), startHour: 9, endHour: 10, status: "confirmed", totalPrice: 20, classId: null, courtName: "Court 1", venueName: "Arena PJ", sport: "badminton" },
        ],
      },
    };
    routes["POST /api/games"] = { body: { ok: true } };
    render(<GamesPage />);
    await settle();
    const booking = screen.getByLabelText("Booking") as HTMLSelectElement;
    expect([...booking.options].map((o) => o.value)).toEqual(["MS-OPEN1"]);
    fireEvent.change(screen.getByLabelText("Players wanted"), { target: { value: "3" } });
    // RM50 among four players, to the 50 sen: RM12.50 each.
    expect((screen.getByLabelText("Each player pays (RM)") as HTMLInputElement).placeholder).toBe("12.5");
    fireEvent.click(screen.getByLabelText("Adults only (18+, as players say)"));
    fireEvent.change(screen.getByLabelText("Who can find it"), { target: { value: "private" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Find players" }));
    });
    expect(posts("/api/games")[0].body).toEqual({
      bookingCode: "MS-OPEN1",
      spots: 3,
      level: null,
      share: 12.5,
      autoAccept: false,
      note: "",
      who: "anyone",
      visibility: "private",
      waitlist: true,
      intensity: "any",
      adultsOnly: true,
    });
    expect(screen.getByText("Your game is open. Players can find it now.")).toBeTruthy();
  });
});

function group(over: Partial<Group> = {}): Group {
  return {
    id: 7,
    name: "Tuesday Smashers",
    sport: "badminton",
    area: "Subang",
    description: "Doubles every Tuesday night",
    privacy: "public",
    capacity: 12,
    members: 4,
    organiserId: 5,
    organiserName: "Aina",
    status: "active",
    ...over,
  } as Group;
}

describe("the groups list", () => {
  it("lists groups with their members, and offers starting one only when signed in", async () => {
    routes["/api/groups"] = { body: { groups: [group(), group({ id: 8, name: "Secret Club", privacy: "private", mine: { memberId: 3, role: "organiser", status: "member" } })], signedIn: false } };
    render(<GroupsPage />);
    await settle();
    expect(screen.getByRole("link", { name: /Tuesday Smashers/ }).getAttribute("href")).toBe("/games/groups/7");
    const rows = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(rows[0]).toContain("Badminton · Subang · 4 members");
    expect(rows[0]).not.toContain("Private");
    expect(rows[1]).toContain("Badminton · Subang · 4 members · Private · Organiser");
    expect(screen.queryByRole("button", { name: "Start a group" })).toBeNull();
  });

  it("starts a group, private when asked, with the first activity offered unless another is chosen; a refusal is shown", async () => {
    routes["GET /api/groups"] = { body: { groups: [], signedIn: true } };
    routes["POST /api/groups"] = { status: 400, body: { error: "A group holds 2 to 60 people." } };
    render(<GroupsPage />);
    await settle();
    expect(screen.getByText("No groups yet.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Pickle Pals" } });
    fireEvent.change(screen.getByLabelText("Up to how many people"), { target: { value: "8" } });
    fireEvent.click(screen.getByLabelText("Invite only (not listed)"));
    await act(async () => {
      fireEvent.submit(screen.getByRole("button", { name: "Start a group" }).closest("form")!);
    });
    expect(posts("/api/groups")[0].body).toEqual({ name: "Pickle Pals", sport: "badminton", area: "", description: "", capacity: 8, privacy: "private" });
    expect(screen.getByText("A group holds 2 to 60 people.")).toBeTruthy();
  });
});

describe("one group", () => {
  const open = async (g: Group | null, signedIn = true) => {
    routes["GET /api/groups/7"] = g ? { body: { group: g, signedIn } } : { status: 404, body: {} };
    render(<GroupPage params={resolved({ id: "7" })} />);
    await settle();
    await settle();
  };

  it("asks a visitor to sign in, coming back to the group", async () => {
    await open(group(), false);
    expect(screen.getByText(/Organiser: Aina/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in to join" }).getAttribute("href")).toBe("/login?next=/games/groups/7");
  });

  it("lets a player ask to join, and then shows they are waiting for the organiser", async () => {
    let asked = false;
    routes["GET /api/groups/7"] = () => ({ body: { group: group(asked ? { mine: { memberId: 30, role: "member", status: "requested" } } : {}), signedIn: true } });
    routes["POST /api/groups/7"] = () => {
      asked = true;
      return { body: { ok: true } };
    };
    render(<GroupPage params={resolved({ id: "7" })} />);
    await settle();
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ask to join" }));
    });
    expect(posts("/api/groups/7")[0].body).toEqual({ action: "join" });
    expect(screen.getByText("Asked: waiting for the organiser")).toBeTruthy();
  });

  it("lets somebody invited say yes or no", async () => {
    routes["POST /api/groups/7"] = { body: { ok: true } };
    await open(group({ mine: { memberId: 30, role: "member", status: "invited" } }));
    expect(screen.getByText(/You are invited/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "No thanks" }));
    });
    expect(posts("/api/groups/7")[0].body).toEqual({ action: "leave" });
  });

  it("shows the organiser who asks and who is in, to accept, decline or remove; invites by email; closes the group", async () => {
    routes["POST /api/groups/7/members/31"] = { body: { ok: true } };
    routes["POST /api/groups/7/members/32"] = { body: { ok: true } };
    routes["POST /api/groups/7"] = { body: { ok: true } };
    await open(
      group({
        mine: { memberId: 30, role: "organiser", status: "member" },
        roster: [
          { memberId: 30, userId: 5, name: "Aina", role: "organiser", status: "member" },
          { memberId: 31, userId: 6, name: "Bala", role: "member", status: "requested" },
          { memberId: 32, userId: 7, name: "Chen", role: "member", status: "member" },
        ],
        emailInvites: [{ id: 9, expiresAt: "2026-12-01 10:00:00" }],
      })
    );
    const roster = screen.getByTestId("roster");
    expect(within(roster).getByTestId("email-invite").textContent).toBe("Invited by email, not yet acceptedWithdraw invitation");
    const row = (name: string) => within(roster).getByText(new RegExp(`^${name} ·`)).closest("li")!;
    expect(within(row("Aina")).queryAllByRole("button")).toHaveLength(0);
    expect(within(row("Bala")).getByText(/Wants to join/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(row("Bala")).getByRole("button", { name: "Accept" }));
    });
    await act(async () => {
      fireEvent.click(within(row("Chen")).getByRole("button", { name: "Remove" }));
    });
    expect(posts("/api/groups/7/members/31")[0].body).toEqual({ action: "accept" });
    expect(posts("/api/groups/7/members/32")[0].body).toEqual({ action: "remove" });
    fireEvent.change(screen.getByPlaceholderText("Invite by email"), { target: { value: "dina@example.my" } });
    await act(async () => {
      fireEvent.submit(screen.getByPlaceholderText("Invite by email").closest("form")!);
    });
    expect(posts("/api/groups/7")[0].body).toEqual({ action: "invite", email: "dina@example.my" });
    // One answer for every address: whether they could be invited is not given away.
    expect(screen.getByText("Invitation sent, if they can be invited.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close the group" }));
    });
    expect(posts("/api/groups/7")[1].body).toEqual({ action: "close" });
  });

  it("a member who is not the organiser sees no one's requests and can only leave", async () => {
    await open(
      group({
        mine: { memberId: 32, role: "member", status: "member" },
        roster: [
          { memberId: 30, userId: 5, name: "Aina", role: "organiser", status: "member" },
          { memberId: 32, userId: 7, name: "Chen", role: "member", status: "member" },
        ],
      })
    );
    expect(screen.getByRole("button", { name: "Leave" })).toBeTruthy();
    for (const name of ["Accept", "Remove", "Close the group"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByPlaceholderText("Invite by email")).toBeNull();
  });

  it("says nothing more of a group that is not there or not to be seen", async () => {
    await open(null);
    expect(screen.getByText("No groups yet.")).toBeTruthy();
  });
});

describe("the playing preferences", () => {
  const PROFILE: PlayerProfile = {
    area: "Subang",
    near: null,
    maxKm: 10,
    days: [2],
    times: ["evening"],
    intensity: "casual",
    maxShare: 15,
    adult: true,
    discoverable: true,
    invitable: true,
    notifyMatches: "digest",
  } as unknown as PlayerProfile;

  beforeEach(() => {
    routes["GET /api/my/profile"] = { body: { profile: PROFILE } };
    routes["GET /api/players/blocks"] = { body: { blocks: [{ userId: 44, name: "Rude Player" }] } };
  });

  it("sends a signed-out visitor to sign in, coming back here", async () => {
    routes["GET /api/my/profile"] = { status: 401, body: {} };
    render(<PreferencesPage />);
    await settle();
    expect(screen.getByRole("link", { name: "Sign in to join" }).getAttribute("href")).toBe("/login?next=/games/preferences");
  });

  it("saves the days, times and limits chosen", async () => {
    routes["PUT /api/my/profile"] = (init) => ({ body: { profile: JSON.parse(String(init!.body)) } });
    render(<PreferencesPage />);
    await settle();
    expect((screen.getByLabelText("Area") as HTMLInputElement).value).toBe("Subang");
    fireEvent.click(screen.getByRole("button", { name: "Morning" }));
    fireEvent.click(screen.getByRole("button", { name: "Evening" }));
    expect(screen.getByRole("button", { name: "Morning" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByLabelText("Most you would pay as a share"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Email me suggested games"), { target: { value: "none" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    const sent = posts("/api/my/profile")[0].body as PlayerProfile;
    expect(sent).toMatchObject({ times: ["morning"], maxShare: null, notifyMatches: "none", days: [2], adult: true });
    expect(screen.getByText("Saved.")).toBeTruthy();
  });

  it("offers being found and invited to declared adults only: saying under 18, or not saying, turns both off", async () => {
    routes["PUT /api/my/profile"] = (init) => ({ body: { profile: JSON.parse(String(init!.body)) } });
    render(<PreferencesPage />);
    await settle();
    const found = () => screen.getByLabelText(/Let hosts find me/) as HTMLInputElement;
    const invited = () => screen.getByLabelText("Let any host invite me") as HTMLInputElement;
    expect([found().checked, found().disabled, invited().checked]).toEqual([true, false, true]);
    fireEvent.click(screen.getByLabelText("Under 18"));
    expect([found().checked, found().disabled, invited().checked, invited().disabled]).toEqual([false, true, false, true]);
    expect(screen.getByText(/Your word, not checked\. Players under 18 are never suggested/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(posts("/api/my/profile")[0].body).toMatchObject({ adult: false, discoverable: false, invitable: false });
    fireEvent.click(screen.getByLabelText("Prefer not to say"));
    expect([found().disabled, invited().disabled]).toEqual([true, true]);
  });

  it("says why the server refused, and lists who is blocked, to unblock", async () => {
    routes["PUT /api/my/profile"] = { status: 400, body: { error: "That is not an amount." } };
    routes["DELETE /api/players/blocks"] = { body: { blocks: [] } };
    render(<PreferencesPage />);
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(screen.getByText("That is not an amount.")).toBeTruthy();
    expect(screen.getByText(/Rude Player/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unblock" }));
    });
    expect(posts("/api/players/blocks")[0]).toMatchObject({ method: "DELETE", body: { userId: 44 } });
    expect(screen.getByText("Nobody.")).toBeTruthy();
  });
});
