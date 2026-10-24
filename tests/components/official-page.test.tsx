// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useParams: () => ({ token: "tok-ref" }) }));

import OfficialPage from "../../src/app/officials/[token]/page";
import { DEFAULT_RULES } from "../../src/lib/tournament-rules";

/** An official's page: the matches waiting for a result, each entered under the official's name. */

const tournament = {
  id: 9,
  name: "Open Cup",
  venueName: "Arena Damansara",
  rules: DEFAULT_RULES,
  entries: [
    { id: 1, name: "Aina", status: "entered" },
    { id: 2, name: "Bala", status: "entered" },
  ],
  matches: [
    { id: 50, stage: "knockout", a: 1, b: 2, courtName: "Court 1", date: "2026-12-05", minute: 540, status: "scheduled" },
    { id: 51, stage: "knockout", a: null, b: null, courtName: "Court 1", date: "2026-12-05", minute: 600, status: "scheduled" },
  ],
};

const posts: { url: string; body: Record<string, unknown> }[] = [];
let alive = true;
beforeEach(() => {
  posts.length = 0;
  alive = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (!alive) return { ok: false, json: async () => ({ error: "gone" }) };
      if (init?.method === "POST") posts.push({ url, body: JSON.parse(init.body ?? "{}") });
      return { ok: true, json: async () => ({ official: { id: 3, name: "Referee Rahim" }, tournament }) };
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("an official's page", () => {
  it("lists the matches waiting for a result and sends one under the link", async () => {
    render(<OfficialPage />);
    await act(async () => {});
    expect(screen.getByText(/Entering results as Referee Rahim/)).toBeTruthy();
    // Only the match with both sides known.
    expect(screen.getAllByRole("button", { name: "Send the result" })).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Who won"), { target: { value: "2" } });
    fireEvent.click(screen.getByLabelText("Walkover"));
    fireEvent.click(screen.getByRole("button", { name: "Send the result" }));
    await act(async () => {});
    expect(posts.at(-1)).toEqual({ url: "/api/officials/tok-ref", body: { matchId: 50, winner: 2, score: "", walkover: true } });
    expect(screen.getByText("Saved.")).toBeTruthy();
  });

  it("says so when the link has been withdrawn", async () => {
    alive = false;
    render(<OfficialPage />);
    await act(async () => {});
    expect(screen.getByText(/This link no longer works/)).toBeTruthy();
  });
});
