// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { ChangeTime } from "../../src/components/ChangeTime";
import type { Booking } from "../../src/lib/types";
import { addDays, todayISO } from "../../src/lib/time";

/** Tomorrow, so the booking is never in the past whenever the test runs (the screen moves a past date to today). */
const DAY = addDays(todayISO(), 1);

/**
 * Changing a booking's time with a preview first (lib/game-moves.ts): what a
 * move would do is shown before anything changes, and a venue's change of a
 * game with players asks for the reason its players are told.
 */

const booking = { code: "MS-GAME01", date: DAY, startMin: 1080, endMin: 1140, courtId: 3, paymentStatus: "unpaid" } as unknown as Booking;
const option = { startMin: 1200, startHour: 20, courtId: 3, courtName: "Court 3", price: 25, difference: 0 };

function preview(outcome: "move" | "proposal" | "venue") {
  return {
    from: { date: DAY, startMin: 1080, endMin: 1140, courtId: 3, courtName: "Court 3" },
    to: { date: DAY, startMin: 1200, endMin: 1260, courtId: 3, courtName: "Court 3" },
    priceChange: 0,
    unchargedDifference: 0,
    outcome,
    gameId: outcome === "move" ? null : 7,
    players: outcome === "move" ? [] : [{ name: "Aina", paid: true }, { name: "Wei", paid: false }],
    pending: { invited: 1, requested: 0, waitlisted: 0, offered: 0 },
    clashes: outcome === "move" ? 0 : 1,
    sharesPaid: outcome === "move" ? 0 : 6,
    ...(outcome === "proposal" ? { expiresAt: "2026-11-01T10:00:00.000Z" } : {}),
  };
}

let submit: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ options: [option] }) }))
  );
  submit = vi.fn(async () => ({ ok: true, json: async () => ({ booking }) }));
});
afterEach(() => vi.unstubAllGlobals());

async function choose(outcome: "move" | "proposal" | "venue") {
  const previewCall = vi.fn(async () => ({ ok: true, json: async () => ({ preview: preview(outcome) }) }));
  render(
    <ChangeTime
      booking={booking}
      staff={outcome === "venue"}
      optionsUrl={(d) => `/options?date=${d}`}
      preview={previewCall as never}
      submit={submit as never}
      onDone={() => {}}
      onClose={() => {}}
    />
  );
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /8:00 PM–9:00 PM/ }));
  });
  expect(previewCall).toHaveBeenCalledTimes(1);
  return screen.getByTestId("move-preview");
}

describe("changing the time with a preview", () => {
  it("shows a game's players, who else hears, the clashes and the shares before anything changes", async () => {
    const panel = await choose("proposal");
    expect(panel.textContent).toContain("In the game: Aina, Wei");
    expect(panel.textContent).toContain("1 more who asked, were invited or are waiting will hear the new time.");
    expect(panel.textContent).toContain("1 of the players have something else at that time.");
    expect(panel.textContent).toMatch(/RM\s?6\.00 in shares was paid online/);
    expect(panel.textContent).toContain("Nothing moves until every player has kept their place or left.");
    expect(submit).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("asks for the venue's reason before a manager moves a game with players", async () => {
    await choose("venue");
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("move-reason"), { target: { value: "Court 3 is flooded" } });
    expect(confirm.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(submit).toHaveBeenCalledWith(option, DAY, "Court 3 is flooded");
  });

  it("goes back without changing anything", async () => {
    await choose("move");
    expect(screen.getByTestId("move-preview").textContent).toContain("It moves now.");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByTestId("move-preview")).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });
});
