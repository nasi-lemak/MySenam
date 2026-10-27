import { describe, expect } from "vitest";
import { bookCourt, freeSlot, gone, scenario, signUp, url, type Actor, type Scenario } from "./harness";

/**
 * Matchmaking, through the games page, with several people at once:
 * A finding a game that suits you and why, B a host's approval, C a full game,
 * its waiting list and a replacement, D invitations and links (withdrawn
 * ones stop working), E a weekly game, F privacy and permissions, G what
 * players pay and to whom, H moving a game with players in it, only once
 * each has answered.
 *
 * Not here, because a deployed app's clock cannot be moved from a browser:
 * an invitation or a held place running out by itself. Those are tested in
 * tests/matchmaking.test.ts on both databases.
 */

const LEVEL = { sport: "badminton", level: "intermediate" };

/** A host with a court booked, and a game opened on it through the API. */
async function hostWithGame(s: Scenario, name: string, game: Record<string, unknown>) {
  const host = await signUp(await s.actor(name), { profile: { adult: true }, level: LEVEL });
  const when = await freeSlot();
  const booking = await bookCourt(host, when.courtId, when.date, when.hour);
  const opened = await host.api("POST", "/api/games", { bookingCode: booking.code, spots: 2, level: null, share: 5, autoAccept: false, ...game });
  if (opened.status !== 201) throw new Error(`open game: ${JSON.stringify(opened.body)}`);
  return { host, gameId: (opened.body.game as { id: number }).id, booking };
}

async function games(a: Actor) {
  await a.page.goto(`${url}/games`);
  await a.page.getByRole("heading", { name: "Find a game" }).waitFor();
  await a.page.waitForLoadState("networkidle");
}

describe("matchmaking", () => {
  scenario("A: a player finds a game that suits them, and sees why", async (s) => {
    const host = await signUp(await s.actor("Host"), { profile: { adult: true }, level: LEVEL });
    // An afternoon, on a day the player will say suits them, so the game ranks first among any others.
    const when = await freeSlot({ hours: [13, 14, 15, 16] });
    const weekday = new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "UTC" }).format(new Date(`${when.date}T00:00:00Z`));
    const booking = await bookCourt(host, when.courtId, when.date, when.hour);

    await s.step(host, "opens their booking to players: intermediate, casual, two places", async () => {
      await games(host);
      const form = host.page.locator("form").filter({ has: host.page.getByRole("button", { name: "Find players" }) });
      await form.locator("select").filter({ has: host.page.locator(`option[value="${booking.code}"]`) }).selectOption(booking.code);
      await form.getByLabel("Players wanted").fill("2");
      await form.getByLabel("Level").selectOption("intermediate");
      await form.getByLabel("Kind of game").selectOption("casual");
      await form.getByRole("button", { name: "Find players" }).click();
      await host.page.getByText("Your game is open. Players can find it now.").waitFor();
    });

    const player = await signUp(await s.actor("Player"), { level: LEVEL });
    await s.step(player, "says how they like to play on the preferences page", async () => {
      await player.page.goto(`${url}/games/preferences`);
      await player.page.getByLabel("18 or over").check();
      await player.page.getByLabel("Kind of game").selectOption("casual");
      await player.page.getByRole("button", { name: "Afternoon" }).click();
      await player.page.getByRole("button", { name: weekday, exact: true }).click();
      await player.page.getByRole("button", { name: "Save" }).click();
      await player.page.getByText("Saved.").waitFor();
    });

    const gameId = ((await host.api("GET", "/api/my/games")).body.hosting as { id: number }[])[0].id;
    await s.step(player, "sees the game suggested, with the reasons beside it", async () => {
      await games(player);
      const card = player.page.getByTestId(`suggested-${gameId}`);
      await card.waitFor();
      for (const reason of ["You play Badminton", "The level you gave", "The kind of game you like", "The host decides who joins"])
        await card.getByText(reason).waitFor();
    });

    await s.step(player, "asks to join from the suggestion", async () => {
      await player.page.getByTestId(`suggested-${gameId}`).getByRole("button", { name: "Ask to join" }).click();
      await player.page.getByTestId(`playing-${gameId}`).getByText(/Asked: waiting for Host/).waitFor();
    });
  });

  scenario("B: the host approves a request", async (s) => {
    const { host, gameId } = await hostWithGame(s, "Host", { autoAccept: false });
    const player = await signUp(await s.actor("Player"), { profile: { adult: true }, level: LEVEL });

    await s.step(player, "asks to join from the list", async () => {
      await games(player);
      await player.page.getByTestId(`game-${gameId}`).getByRole("button", { name: "Ask to join" }).click();
      await player.page.getByTestId(`game-${gameId}`).getByText(/Asked: waiting for/).waitFor();
    });
    await s.step(host, "sees the request in their games and accepts it", async () => {
      await games(host);
      const hosted = host.page.getByTestId(`hosted-${gameId}`);
      await hosted.getByText("wants to join").waitFor();
      await hosted.getByRole("button", { name: "Accept" }).click();
      await hosted.getByText(/1 of 2 joined/).waitFor();
    });
    await s.step(player, "is in the game", async () => {
      await games(player);
      await player.page.getByTestId(`playing-${gameId}`).getByText("You're in").waitFor();
    });
  });

  scenario("C: a full game, its waiting list, and a replacement taking the freed place", async (s) => {
    const { gameId } = await hostWithGame(s, "Host", { spots: 1, autoAccept: true, waitlist: true });
    const first = await signUp(await s.actor("First"), { profile: { adult: true } });
    const second = await signUp(await s.actor("Second"), { profile: { adult: true } });

    await s.step(first, "joins the one place", async () => {
      await games(first);
      await first.page.getByTestId(`game-${gameId}`).getByRole("button", { name: "Join" }).click();
      await first.page.getByTestId(`playing-${gameId}`).getByText("You're in").waitFor();
    });
    await s.step(second, "finds it full and joins the waiting list", async () => {
      await games(second);
      const card = second.page.getByTestId(`game-${gameId}`);
      await card.getByRole("button", { name: "Join the waiting list" }).click();
      await second.page.getByTestId(`playing-${gameId}`).getByText("On the waiting list").waitFor();
    });
    await s.step(first, "drops out", async () => {
      await games(first);
      await first.page.getByTestId(`playing-${gameId}`).getByRole("button", { name: "Leave" }).click();
      await gone(first.page.getByTestId(`playing-${gameId}`));
    });
    await s.step(second, "is offered the freed place, held for them, and takes it", async () => {
      await games(second);
      const row = second.page.getByTestId(`playing-${gameId}`);
      await row.getByText(/A place is held for you until/).waitFor();
      await row.getByRole("button", { name: "Take the place" }).click();
      await second.page.getByTestId(`playing-${gameId}`).getByText("You're in").waitFor();
    });
  });

  scenario("D: invitations and links; withdrawn ones stop working", async (s) => {
    const { host, gameId } = await hostWithGame(s, "Host", { visibility: "private", autoAccept: false, spots: 3 });
    const friend = await signUp(await s.actor("Friend"), { profile: { adult: true, invitable: true } });
    const other = await signUp(await s.actor("Other"), { profile: { adult: true, invitable: true } });
    const outsider = await signUp(await s.actor("Outsider"), { profile: { adult: true } });

    await s.step(host, "invites a friend by email, and sees an invitation by email, not who holds the address", async () => {
      await games(host);
      const tools = host.page.getByTestId(`host-tools-${gameId}`);
      await tools.getByPlaceholder("Invite by email").fill(friend.email);
      await tools.getByRole("button", { name: "Invite", exact: true }).click();
      await host.page.getByText("Invitation sent, if they can be invited.").waitFor();
      await games(host);
      const hosted = host.page.getByTestId(`hosted-${gameId}`);
      await hosted.getByText("Invited by email, not yet accepted").waitFor();
      expect(await hosted.getByText(/Friend/).count()).toBe(0);
    });
    // The emailed link is the friend's to accept (tests/player-invitations.test.ts); here the host also picks them by name.
    await s.step(host, "invites the friend by name too", async () => {
      expect((await host.api("POST", `/api/games/${gameId}`, { action: "invite", userId: friend.id })).status).toBe(200);
    });
    await s.step(friend, "sees the invitation and says yes: the host's invitation is the host's yes", async () => {
      await games(friend);
      const row = friend.page.getByTestId(`playing-${gameId}`);
      await row.getByText(/Host invited you/).waitFor();
      await row.getByRole("button", { name: "Say yes" }).click();
      await friend.page.getByTestId(`playing-${gameId}`).getByText("You're in").waitFor();
    });
    await s.step(host, "invites another player they know by name, then withdraws it", async () => {
      await host.api("POST", `/api/games/${gameId}`, { action: "invite", userId: other.id });
      await games(host);
      const invited = host.page.getByTestId(`hosted-${gameId}`).locator("li").filter({ hasText: "Other" });
      await invited.getByRole("button", { name: "Remove" }).click();
      await gone(host.page.getByTestId(`hosted-${gameId}`).locator("li").filter({ hasText: "Other" }));
    });
    await s.step(other, "finds the withdrawn invitation gone, and cannot use it", async () => {
      await games(other);
      await gone(other.page.getByTestId(`playing-${gameId}`));
      // A private game they are no longer invited to is, to them, no game at all.
      expect((await other.api("POST", `/api/games/${gameId}`, { action: "join" })).status).toBe(404);
    });
    const link = await s.step(host, "makes a link to share", async () => {
      await host.page.getByTestId(`host-tools-${gameId}`).getByRole("button", { name: "Make a link" }).click();
      const value = await host.page.getByTestId("game-link").inputValue();
      expect(value).toContain(`game=${gameId}&link=`);
      return value.replace(/^https?:\/\/[^/]+/, url);
    });
    await s.step(outsider, "opens the link and sees the private game, which is listed nowhere", async () => {
      await games(outsider);
      await gone(outsider.page.getByTestId(`game-${gameId}`));
      await outsider.page.goto(link);
      await outsider.page.getByTestId("shared-game").getByRole("button", { name: "Ask to join" }).waitFor();
    });
    await s.step(host, "withdraws every link", async () => {
      await host.page.getByTestId(`host-tools-${gameId}`).getByRole("button", { name: "Withdraw links" }).click();
      await host.page.waitForLoadState("networkidle");
    });
    await s.step(outsider, "finds the link no longer leads anywhere", async () => {
      await outsider.page.goto(link);
      await outsider.page.locator("h1").first().waitFor();
      await outsider.page.waitForLoadState("networkidle");
      await gone(outsider.page.getByTestId("shared-game"));
      expect((await outsider.api("GET", `/api/games/${gameId}?link=${new URL(link).searchParams.get("link")}`)).status).toBe(404);
    });
  });

  scenario("E: a weekly game on a weekly booking, with last week's players invited", async (s) => {
    const host = await signUp(await s.actor("Host"), { profile: { adult: true } });
    const regular = await signUp(await s.actor("Regular"), { profile: { adult: true } });
    // Two weeks running free at the same hour: tried slot by slot until one is.
    let booking: { code: string } | null = null;
    for (let i = 0; i < 15 && !booking; i++) {
      const when = await freeSlot({ fromDay: 2, toDay: 6 });
      booking = await bookCourt(host, when.courtId, when.date, when.hour, 2).catch(() => null);
    }
    if (!booking) throw new Error("No weekly slot free two weeks running.");

    await s.step(host, "makes the weekly booking a weekly game", async () => {
      await games(host);
      const form = host.page.locator("form").filter({ has: host.page.getByRole("button", { name: "Find players" }) });
      await form.locator("select").filter({ has: host.page.locator(`option[value="${booking!.code}"]`) }).selectOption(booking!.code);
      await form.getByLabel("Let anybody join without asking me").check();
      await form.getByLabel("Every week (this booking repeats weekly)").check();
      await form.getByRole("button", { name: "Find players" }).click();
      await host.page.getByText("Weekly game set up: a game on each date of the booking.").waitFor();
      await host.page.getByTestId("weekly-games").getByText("2 dates to come").waitFor();
    });
    const series = (await host.api("GET", "/api/games/series")).body.series as { games: { id: number }[] }[];
    const [week1, week2] = series[0].games.map((g) => g.id);
    await s.step(regular, "plays the first week", async () => {
      await games(regular);
      await regular.page.getByTestId(`game-${week1}`).getByRole("button", { name: "Join" }).click();
      await regular.page.getByTestId(`playing-${week1}`).getByText("You're in").waitFor();
    });
    await s.step(host, "invites last week's players to the second week", async () => {
      await games(host);
      await host.page.getByTestId(`host-tools-${week2}`).getByRole("button", { name: "Invite last week's players" }).click();
      await host.page.getByText("Invitation sent, if they can be invited.").waitFor();
    });
    await s.step(regular, "is invited, not enrolled, to the second week", async () => {
      await games(regular);
      await regular.page.getByTestId(`playing-${week2}`).getByRole("button", { name: "Say yes" }).waitFor();
    });
  });

  scenario("F: private games, opted-out players, blocks and other hosts' rosters", async (s) => {
    const priv = await hostWithGame(s, "Host", { visibility: "private", level: "intermediate", spots: 3 });
    const pub = await (async () => {
      const when = await freeSlot();
      const b = await bookCourt(priv.host, when.courtId, when.date, when.hour);
      return (await priv.host.api("POST", "/api/games", { bookingCode: b.code, spots: 3, level: "intermediate", share: 5, autoAccept: false })).body.game as { id: number };
    })();
    const stranger = await signUp(await s.actor("Stranger"), { profile: { adult: true }, level: LEVEL });
    const findable = await signUp(await s.actor("Findable"), { profile: { adult: true, discoverable: true }, level: LEVEL });
    const pest = await signUp(await s.actor("Pest"), { profile: { adult: true } });
    const otherHost = await hostWithGame(s, "OtherHost", {});

    await s.step(stranger, "cannot see the private game, in the list or by its number", async () => {
      await games(stranger);
      await stranger.page.getByTestId(`game-${pub.id}`).waitFor();
      await gone(stranger.page.getByTestId(`game-${priv.gameId}`));
      expect((await stranger.api("GET", `/api/games/${priv.gameId}`)).status).toBe(404);
    });
    await s.step(priv.host, "looks for players: only the one who opted in is suggested, by first name and distance band", async () => {
      await games(priv.host);
      await priv.host.page.getByTestId(`host-tools-${priv.gameId}`).getByRole("button", { name: "Players who might suit this game" }).click();
      const list = priv.host.page.getByTestId("candidates");
      await list.getByText(/Findable \(Intermediate\)/).waitFor();
      await gone(list.getByText(/Stranger/));
      void findable;
    });
    await s.step(pest, "asks to join the public game", async () => {
      await games(pest);
      await pest.page.getByTestId(`game-${pub.id}`).getByRole("button", { name: "Ask to join" }).click();
      await pest.page.getByTestId(`playing-${pub.id}`).waitFor();
    });
    await s.step(priv.host, "blocks them from the roster", async () => {
      await games(priv.host);
      const row = priv.host.page.getByTestId(`hosted-${pub.id}`).locator("li").filter({ hasText: "Pest" });
      await row.getByRole("button", { name: "Block" }).click();
      await priv.host.page.getByText("Blocked. Neither of you will see the other's games.").waitFor();
    });
    await s.step(pest, "is turned down, and cannot ask again", async () => {
      await games(pest);
      await gone(pest.page.getByTestId(`playing-${pub.id}`));
      expect(await pest.api("POST", `/api/games/${pub.id}`, { action: "join" })).toMatchObject({ status: 409 });
    });
    await s.step(otherHost.host, "cannot change another host's roster", async () => {
      const roster = (await priv.host.api("GET", `/api/games/${pub.id}`)).body.game as { players: { id: number }[] };
      const target = roster.players[0].id;
      expect((await otherHost.host.api("POST", `/api/games/${pub.id}/players/${target}`, { action: "remove" })).status).toBe(404);
      expect((await otherHost.host.api("POST", `/api/games/${pub.id}`, { action: "cancel" })).status).toBe(404);
      expect((await otherHost.host.api("GET", `/api/games/${pub.id}/candidates`)).status).toBe(404);
    });
  });

  scenario("G: a share is paid to the venue, never to the host or another player", async (s) => {
    const { host, gameId, booking } = await hostWithGame(s, "Host", { autoAccept: true, share: 6 });
    const player = await signUp(await s.actor("Player"), { profile: { adult: true } });

    await s.step(player, "sees what each player pays before joining", async () => {
      await games(player);
      await player.page.getByTestId(`game-${gameId}`).getByText(/RM\s?6\.00 each/).waitFor();
    });
    await s.step(player, "joins, and is told to pay the share at the venue, which takes no payment online here", async () => {
      await player.page.getByTestId(`game-${gameId}`).getByRole("button", { name: "Join" }).click();
      const row = player.page.getByTestId(`playing-${gameId}`);
      await row.getByText(/Pay your RM\s?6\.00 share at the venue/).waitFor();
      await gone(row.getByRole("button", { name: /Pay my/ }));
      // Nothing was charged: joining a game takes no money and books no court.
      expect((await player.api("GET", "/api/my/bookings")).body.bookings).toEqual([]);
    });
    await s.step(host, "calls the game off: the court stays booked, and the player is told", async () => {
      await games(host);
      await host.page.getByTestId(`host-tools-${gameId}`).getByRole("button", { name: "Call it off" }).click();
      await host.page.getByText("Game called off. Everybody in it has been told.").waitFor();
      const mine = (await host.api("GET", "/api/my/bookings")).body.bookings as { code: string; status: string }[];
      expect(mine.find((b) => b.code === booking.code)?.status).toBe("confirmed");
    });
  });

  scenario("H: the host moves a game; it moves once every player has kept their place or left", async (s) => {
    const { host, gameId } = await hostWithGame(s, "Host", { autoAccept: true });
    const stays = await signUp(await s.actor("Stays"), { profile: { adult: true } });
    const goes = await signUp(await s.actor("Goes"), { profile: { adult: true } });
    for (const p of [stays, goes]) {
      const joined = await p.api("POST", `/api/games/${gameId}`, { action: "join" });
      if (joined.status !== 200) throw new Error(`join: ${JSON.stringify(joined.body)}`);
    }
    const before = ((await host.api("GET", "/api/my/games")).body.hosting as { id: number; date: string; startHour: number }[]).find((g) => g.id === gameId)!;

    await s.step(host, "picks a new time, sees who is in the game, and proposes it", async () => {
      await games(host);
      await host.page.getByTestId(`move-game-${gameId}`).click();
      await host.page.getByText("Change to when?").waitFor();
      await host.page.locator("button", { hasText: /\d{1,2}:\d{2} [AP]M–/ }).first().click();
      const preview = host.page.getByTestId("move-preview");
      await preview.getByText(/In the game: .*Stays.*Goes|In the game: .*Goes.*Stays/).waitFor();
      await preview.getByText(/Nothing moves until every player has kept their place or left/).waitFor();
      await preview.getByRole("button", { name: "Confirm" }).click();
      await host.page.getByText("New time proposed: waiting for the players' answers.").waitFor();
      await host.page.getByTestId(`move-waiting-${gameId}`).waitFor();
    });
    const proposed = ((await host.api("GET", "/api/my/games")).body.hosting as { id: number; move: { to: { date: string; startMin: number } } }[]).find((g) => g.id === gameId)!.move.to;

    await s.step(stays, "is asked, and keeps their place at the new time", async () => {
      await games(stays);
      const asked = stays.page.getByTestId(`move-asked-${gameId}`);
      await asked.getByText(/wants to move this game/).waitFor();
      await asked.getByRole("button", { name: "Keep my place" }).click();
      await gone(stays.page.getByTestId(`move-asked-${gameId}`));
    });
    await s.step(host, "still sees the game where it was, waiting for one answer", async () => {
      const now = ((await host.api("GET", "/api/my/games")).body.hosting as { id: number; date: string; startHour: number }[]).find((g) => g.id === gameId)!;
      expect([now.date, now.startHour]).toEqual([before.date, before.startHour]);
    });
    await s.step(goes, "would rather not, and leaves the game", async () => {
      await games(goes);
      await goes.page.getByTestId(`move-asked-${gameId}`).getByRole("button", { name: "Leave the game" }).click();
      await gone(goes.page.getByTestId(`playing-${gameId}`));
    });
    await s.step(host, "sees the game at its new time, with the player who stayed", async () => {
      await games(host);
      await gone(host.page.getByTestId(`move-waiting-${gameId}`));
      const now = ((await host.api("GET", "/api/my/games")).body.hosting as { id: number; date: string; startHour: number; joined: number }[]).find((g) => g.id === gameId)!;
      expect([now.date, Math.round(now.startHour * 60)]).toEqual([proposed.date, proposed.startMin]);
      expect(now.joined).toBe(1);
    });
  });
});
