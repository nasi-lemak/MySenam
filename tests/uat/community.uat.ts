import { describe } from "vitest";
import { bookCourt, freeSlot, gone, scenario, signUp, url } from "./harness";

/** Social play: a community group formed through the pages, and invited to a game as one. */

describe("community", () => {
  scenario("Community: a group is formed, agreed both ways, and invited to a game", async (s) => {
    const organiser = await signUp(await s.actor("Organiser"), { profile: { adult: true } });
    const member = await signUp(await s.actor("Member"), { profile: { adult: true } });

    const groupUrl = await s.step(organiser, "starts a group on the groups page", async () => {
      await organiser.page.goto(`${url}/games/groups`);
      await organiser.page.locator('input[name="groupName"]').fill("Wednesday doubles");
      await organiser.page.getByRole("button", { name: "Start a group" }).click();
      await organiser.page.waitForURL(/\/games\/groups\/\d+$/);
      await organiser.page.getByRole("heading", { name: /Wednesday doubles/ }).waitFor();
      return organiser.page.url();
    });
    await s.step(member, "finds it and asks to join", async () => {
      await member.page.goto(`${url}/games/groups`);
      await member.page.getByRole("link", { name: /Wednesday doubles/ }).first().click();
      await member.page.getByRole("button", { name: "Ask to join" }).click();
      await member.page.getByText("Asked: waiting for the organiser").waitFor();
    });
    await s.step(organiser, "sees the request in the roster and lets them in", async () => {
      await organiser.page.goto(groupUrl);
      const row = organiser.page.getByTestId("roster").locator("li").filter({ hasText: "Wants to join" });
      await row.getByRole("button", { name: "Accept" }).click();
      await gone(organiser.page.getByTestId("roster").locator("li").filter({ hasText: "Wants to join" }));
      await organiser.page.getByText("2 members").first().waitFor();
    });

    const when = await freeSlot();
    const booking = await bookCourt(organiser, when.courtId, when.date, when.hour);
    const game = (await organiser.api("POST", "/api/games", { bookingCode: booking.code, spots: 3, level: null, share: 4, autoAccept: false, visibility: "private" })).body.game as { id: number };
    await s.step(organiser, "invites the group to a private game in one go", async () => {
      await organiser.page.goto(`${url}/games`);
      const tools = organiser.page.getByTestId(`host-tools-${game.id}`);
      await tools.getByRole("button", { name: "Invite a group" }).click();
      await organiser.page.getByTestId("my-groups").getByRole("button", { name: "Wednesday doubles" }).click();
      await organiser.page.getByText("Invitation sent, if they can be invited.").waitFor();
    });
    await s.step(member, "is invited, and says yes", async () => {
      await member.page.goto(`${url}/games`);
      await member.page.getByTestId(`playing-${game.id}`).getByRole("button", { name: "Say yes" }).click();
      await member.page.getByTestId(`playing-${game.id}`).getByText("You're in").waitFor();
    });
  });
});
