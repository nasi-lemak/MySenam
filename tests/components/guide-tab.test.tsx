// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";

import { GuideTab } from "../../src/components/admin/guide/GuideTab";
import { buildSetupPlan } from "../../src/lib/guide/plan";
import { emptyProfile } from "../../src/lib/guide/profile-types";
import { launchReadiness } from "../../src/lib/guide/readiness";
import { discover } from "../../src/lib/guide/discover";
import { emptyAnswers } from "../../src/lib/guide/answer-schema";
import { buildPlaybook } from "../../src/lib/guide/playbook";

/**
 * The guide's tab in the dashboard: every account has it; a manager is
 * shown the three views, the front desk only the playbook (the server refuses
 * it the setup regardless); each view reads its own route; and a link is
 * shown only where the role may use what it opens.
 */

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 403, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) });

function setupAnswer(role: "manager" | "desk" = "manager") {
  const profile = emptyProfile(3);
  profile.setup.courts = 2;
  profile.identity.live = true;
  profile.history.bookings = 30;
  profile.resources.total = 2;
  const answers = emptyAnswers();
  const plan = buildSetupPlan({ profile, answers, acknowledged: {}, role });
  return { venueId: 3, role, profile, answers, rev: 4, acknowledged: {}, dismissed: {}, plan, readiness: launchReadiness(profile, plan), discoveries: discover(profile, answers) };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/admin?tab=guide");
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/guide/playbook")) return json({ venueId: 3, role: "desk", ownRole: "desk", roles: ["desk", "coach"], playbook: buildPlaybook(setupAnswer("desk").profile, "desk", { venueName: "Court House" }) });
    return json(setupAnswer());
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const venues = [{ id: 3, name: "Court House", courts: [] }] as never;

/** A plan step's row, once the plan has been read (a step's name also appears in the readiness lists below it). */
async function step(id: string): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector(`[data-step="${id}"]`)).not.toBeNull());
  return document.querySelector(`[data-step="${id}"]`) as HTMLElement;
}

describe("the guide tab", () => {
  it("shows a manager the setup, the playbook and the discoveries, and reads the plan from the setup route", async () => {
    const onGo = vi.fn();
    render(<GuideTab venues={venues} role="manager" onGo={onGo} />);
    const nav = screen.getByRole("navigation", { name: "Guide sections" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["Set up", "How to run it", "Discover"]);
    await step("courts");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/guide/setup?venueId=3");
    // The placeholder says what it is, and what is already known is listed.
    expect(document.querySelector("[data-placeholder]")).not.toBeNull();
    // The step's state is a word, not only a colour; the requirement is said.
    const courts = document.querySelector('[data-step="courts"]')!;
    expect(within(courts as HTMLElement).getByText("Done")).toBeTruthy();
    expect(within(courts as HTMLElement).getByText("Needed before going live")).toBeTruthy();
    // Opening a screen goes to the tab the step names.
    await act(async () => within(courts as HTMLElement).getByRole("button", { name: /Open Courts & rates/ }).click());
    expect(onGo).toHaveBeenCalledWith("courts");
  });

  it("goes to the discoveries and the playbook, and keeps the view in the address", async () => {
    render(<GuideTab venues={venues} role="manager" onGo={() => undefined} />);
    await step("courts");
    await act(async () => screen.getByRole("button", { name: "How to run it" }).click());
    expect(window.location.search).toContain("view=playbook");
    expect(await screen.findByText("Your venue has 2 bookable resources.")).toBeTruthy();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith("/api/admin/guide/playbook?venueId=3"))).toBe(true);
    await act(async () => screen.getByRole("button", { name: "Discover" }).click());
    expect(await screen.findByText("Discover what else MySenam can do")).toBeTruthy();
    expect(window.location.search).toContain("view=discover");
  });

  it("gives the front desk the playbook only, and never asks the server for the setup", async () => {
    window.history.replaceState(null, "", "/admin?tab=guide&view=setup");
    render(<GuideTab venues={venues} role="desk" onGo={() => undefined} />);
    const nav = screen.getByRole("navigation", { name: "Guide sections" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["How to run it"]);
    expect(await screen.findByText("Your venue has 2 bookable resources.")).toBeTruthy();
    expect(fetchMock.mock.calls.every((c) => !String(c[0]).includes("/guide/setup"))).toBe(true);
    expect(screen.queryByText("Set up your venue")).toBeNull();
  });

  it("shows no link a role may not use, and says a manager changes it", async () => {
    const answer = setupAnswer("desk");
    fetchMock.mockImplementation(async () => json(answer));
    render(<GuideTab venues={venues} role="manager" onGo={() => undefined} />);
    await step("courts");
    const courts = document.querySelector('[data-step="courts"]') as HTMLElement;
    expect(within(courts).queryByRole("button", { name: /Open/ })).toBeNull();
    expect(within(courts).getByText("A manager changes this.")).toBeTruthy();
  });

  it("lets a manager say a review step was reviewed, and shows the answer it is sent back", async () => {
    let call = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      call++;
      const view = setupAnswer();
      if (init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({ venueId: 3, action: "acknowledge", step: "cancellation-terms" });
        const reviewed = buildSetupPlan({ profile: view.profile, answers: view.answers, acknowledged: { "cancellation-terms": { at: "2026-10-31 10:00:00", byAdminId: 1, byName: "Musa" } }, role: "manager" });
        return json({ ...view, plan: reviewed });
      }
      return json(view);
    });
    render(<GuideTab venues={venues} role="manager" onGo={() => undefined} />);
    await step("cancellation-terms");
    const row = document.querySelector('[data-step="cancellation-terms"]') as HTMLElement;
    expect(within(row).getByText("To review")).toBeTruthy();
    expect(within(row).getByText(/If customers cancel within the cutoff/)).toBeTruthy();
    await act(async () => within(row).getByRole("button", { name: "I have reviewed this" }).click());
    expect(call).toBeGreaterThan(1);
    expect(await screen.findByText("Reviewed on 2026-10-31 10:00:00 by Musa")).toBeTruthy();
  });

  it("says the guide could not be read, with a way to try again", async () => {
    fetchMock.mockImplementation(async () => json({ error: "Which venue?" }, false));
    render(<GuideTab venues={venues} role="manager" onGo={() => undefined} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
