// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { ChangeTime } from "../../src/components/ChangeTime";
import type { MoveMoney } from "../../src/lib/move-money";
import type { Booking } from "../../src/lib/types";
import { addDays, todayISO } from "../../src/lib/time";

/**
 * What a change does to the price is shown before it is confirmed (ADR 0067): the price now, at the new time, the difference and where it
 * goes, for a customer's own booking (a quote first) and for staff (the preview, with the choice to keep a difference).
 */

const DAY = addDays(todayISO(), 1);
const booking = { code: "MS-PAID01", date: DAY, startMin: 1080, endMin: 1140, courtId: 3, paymentStatus: "paid" } as unknown as Booking;
const option = { startMin: 600, startHour: 10, courtId: 3, courtName: "Court 3", price: 25, difference: -35 };

const counterRefund: MoveMoney = { oldPrice: 60, newPrice: 25, difference: -35, settles: "refund", refund: { amount: 35, how: "counter" } };

let submit: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ options: [option] }) })));
  submit = vi.fn(async () => ({ ok: true, json: async () => ({ booking, money: counterRefund }) }));
});
afterEach(() => vi.unstubAllGlobals());

async function open(props: Record<string, unknown>) {
  const onDone = vi.fn();
  render(<ChangeTime booking={booking} optionsUrl={(d) => `/options?date=${d}`} submit={submit as never} onDone={onDone} onClose={() => {}} {...props} />);
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /10:00 AM–11:00 AM/ }));
  });
  return onDone;
}

describe("a customer's quote before confirming", () => {
  it("shows the price now, at the new time and where the difference goes, and changes nothing until confirmed", async () => {
    const quote = vi.fn(async () => ({ ok: true, json: async () => ({ preview: { money: counterRefund } }) }));
    const onDone = await open({ quote });
    expect(quote).toHaveBeenCalledTimes(1);
    const panel = screen.getByTestId("move-quote");
    expect(panel.textContent).toMatch(/Paid RM\s?60\.00; the new time costs RM\s?25\.00/);
    expect(panel.textContent).toMatch(/RM\s?35\.00 difference is owed back to you/);
    expect(submit).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm the change" }));
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][1]).toMatch(/The RM\s?35\.00 difference is going back the way you paid/);
  });

  it("going back changes nothing", async () => {
    const quote = vi.fn(async () => ({ ok: true, json: async () => ({ preview: { money: counterRefund } }) }));
    await open({ quote });
    fireEvent.click(screen.getByRole("button", { name: "Choose another time" }));
    expect(screen.queryByTestId("move-quote")).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it("says when a last-minute price goes with the old time, and what a pass changes (nothing)", async () => {
    const lost: MoveMoney = { oldPrice: 16, newPrice: 20, difference: 4, settles: "price", lastMinuteLost: true };
    await open({ quote: vi.fn(async () => ({ ok: true, json: async () => ({ preview: { money: lost } }) })) });
    expect(screen.getByTestId("move-quote").textContent).toContain("The last-minute price this booking was made at does not apply at the new time.");
    expect(screen.getByTestId("move-quote").textContent).toMatch(/RM\s?4\.00 more to pay/);
  });
});

describe("staff's preview of a paid booking moved cheaper", () => {
  const preview = (money: MoveMoney) => ({
    from: { date: DAY, startMin: 1080, endMin: 1140, courtId: 3, courtName: "Court 3" },
    to: { date: DAY, startMin: 600, endMin: 660, courtId: 3, courtName: "Court 3" },
    priceChange: 0,
    unchargedDifference: 0,
    money,
    outcome: "move",
    gameId: null,
    players: [],
    pending: { invited: 0, requested: 0, waitlisted: 0, offered: 0 },
    clashes: 0,
    sharesPaid: 0,
  });

  it("offers the difference back by default and keeping it as a choice, and sends the choice", async () => {
    const previewCall = vi.fn(async () => ({ ok: true, json: async () => ({ preview: preview({ ...counterRefund, canKeep: true }) }) }));
    await open({ staff: true, preview: previewCall });
    expect(screen.getByTestId("move-money").textContent).toMatch(/owed back to you/);
    const keep = screen.getByLabelText("Keep it: the price stays as paid") as HTMLInputElement;
    const back = screen.getByLabelText("Give it back the way it was paid") as HTMLInputElement;
    expect(back.checked).toBe(true);
    fireEvent.click(keep);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    });
    expect(submit).toHaveBeenCalledWith(option, DAY, undefined, { difference: "keep" });
  });

  it("starts at keeping it where the venue's default is to keep (past the customer's cutoff)", async () => {
    const kept: MoveMoney = { oldPrice: 60, newPrice: 25, difference: -35, settles: "kept", canKeep: true };
    await open({ staff: true, preview: vi.fn(async () => ({ ok: true, json: async () => ({ preview: preview(kept) }) })) });
    expect((screen.getByLabelText("Keep it: the price stays as paid") as HTMLInputElement).checked).toBe(true);
  });
});
