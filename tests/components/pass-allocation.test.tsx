// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";

import PassAllocation, { passCodesOf, type AllocPass, type AllocationWords } from "../../src/components/PassAllocation";
import { BookingsTab } from "../../src/components/admin/BookingsTab";
import { errorText, translator } from "../../src/lib/i18n";

/**
 * Which pass pays for whom (components/PassAllocation.tsx), as the booking
 * form and the counter show it: one pass for the whole booking, or each
 * person's own pass for their place, with what each spends of what it has
 * left, and why the choice cannot pay where it cannot, in the engine's words.
 */

const en = translator("en");
const words: AllocationWords = {
  title: "Which pass pays for whom",
  whole: "Using a pass?",
  each: "A pass for each person",
  none: "No pass",
  option: (p) => `${p.name} · ${p.remaining} left`,
  uses: (p, units) => `Uses ${units} of ${p.remaining}`,
  short: "Not enough left on this pass.",
  ready: "Each place is paid by its own pass.",
  explain: (plan) => (plan.code === "PASS_TOO_LONG" ? "too long" : errorText(en, plan.code, plan.vars)),
};

const pass = (id: number, over: Partial<AllocPass>): AllocPass => ({
  id,
  code: `PS-${id}`,
  name: `Pass ${id}`,
  kind: "session",
  entryMinutes: 60,
  maxMinutes: null,
  holderName: "Mum",
  remaining: 5,
  scope: "participant",
  holderParticipantId: null,
  ...over,
});

const places = [
  { placeId: null, customer: false, participantId: 1, name: "Aina" },
  { placeId: null, customer: false, participantId: 2, name: "Badrul" },
];
const passes = [
  pass(1, { name: "Aina's swim", holderParticipantId: 1, holderParticipantName: "Aina" }),
  pass(2, { name: "Badrul's swim", holderParticipantId: 2, holderParticipantName: "Badrul", remaining: 1 }),
  pass(3, { name: "Family 10", scope: "booking" }),
  // Another child's: offered to nobody here.
  pass(4, { name: "Cik's swim", holderParticipantId: 3, holderParticipantName: "Cik" }),
];

function Harness({ onCodes, minutes = 60 }: { onCodes: (codes: string[]) => void; minutes?: number }) {
  const [codes, setCodes] = useState<string[]>([]);
  return (
    <PassAllocation
      places={places}
      passes={passes}
      players={2}
      minutes={minutes}
      soldByPlace
      bookerName="Mum"
      codes={codes}
      onChange={(c) => {
        setCodes(c);
        onCodes(passCodesOf(c));
      }}
      words={words}
    />
  );
}

describe("which pass pays for whom", () => {
  it("offers one pass for the whole booking, or each person's own; each person is offered only their own", () => {
    const seen = vi.fn();
    render(<Harness onCodes={seen} />);
    const choice = screen.getByRole("combobox", { name: "Which pass pays for whom" }) as HTMLSelectElement;
    expect([...choice.options].map((o) => o.textContent)).toEqual(["No pass", "Family 10 · 5 left", "A pass for each person"]);
    fireEvent.change(choice, { target: { value: "PS-3" } });
    expect(seen).toHaveBeenLastCalledWith(["PS-3"]);
    expect(screen.getByText("Uses 1 of 5")).toBeTruthy();

    fireEvent.change(choice, { target: { value: "__each" } });
    expect(seen).toHaveBeenLastCalledWith([]);
    const aina = screen.getByRole("combobox", { name: "Aina" }) as HTMLSelectElement;
    const badrul = screen.getByRole("combobox", { name: "Badrul" }) as HTMLSelectElement;
    expect([...aina.options].map((o) => o.textContent)).toEqual(["No pass", "Aina's swim · 5 left"]);
    expect([...badrul.options].map((o) => o.textContent)).toEqual(["No pass", "Badrul's swim · 1 left"]);

    // Aina's alone: Badrul's place is still to pay, said as the server says it.
    fireEvent.change(aina, { target: { value: "PS-1" } });
    expect(seen).toHaveBeenLastCalledWith(["PS-1"]);
    expect(screen.getByText(/Still to pay for: Badrul/)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Badrul" }), { target: { value: "PS-2" } });
    expect(seen).toHaveBeenLastCalledWith(["PS-1", "PS-2"]);
    expect(screen.getByText("Each place is paid by its own pass.")).toBeTruthy();
    expect(screen.getAllByText("Uses 1 of 5")).toHaveLength(1);
  });

  it("says when a pass has too little left for what it would spend", () => {
    // Ninety minutes on hour entries: two each; Badrul's has one.
    render(<Harness onCodes={() => {}} minutes={90} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Which pass pays for whom" }), { target: { value: "__each" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Aina" }), { target: { value: "PS-1" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Badrul" }), { target: { value: "PS-2" } });
    expect(screen.getByText("Uses 2 of 5")).toBeTruthy();
    expect(screen.getByText("Not enough left on this pass.")).toBeTruthy();
    expect(screen.queryByText("Each place is paid by its own pass.")).toBeNull();
  });

  it("shows nothing where no pass could pay", () => {
    const { container } = render(
      <PassAllocation places={places} passes={[]} players={2} minutes={60} soldByPlace bookerName="Mum" codes={[]} onChange={() => {}} words={words} />
    );
    expect(container.textContent).toBe("");
  });
});

describe("at the counter", () => {
  const booking = {
    id: 1,
    code: "MS-PASSES",
    seriesCode: null,
    venueId: 1,
    venueName: "Arena MySenam",
    courtName: "Pool",
    courtDeposit: 0,
    sport: "swimming",
    date: "2026-10-02",
    startHour: 9,
    endHour: 10,
    name: "Mum",
    phone: "0163211606",
    totalPrice: 20,
    status: "confirmed",
    paymentStatus: "unpaid",
    checkedInAt: null,
    checkedOutAt: null,
    noShow: false,
    priorNoShows: 0,
    hire: null,
    classId: null,
    people: [],
  };
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/admin/bookings/passes") && init?.method === "POST")
        return { ok: false, json: async () => ({ error: errorText(en, "ENT_PASS_UNCOVERED", { names: "Badrul" }), code: "ENT_PASS_UNCOVERED", vars: { names: "Badrul" } }) };
      if (String(url).startsWith("/api/admin/bookings/passes"))
        return {
          ok: true,
          json: async () => ({ booking: { name: "Mum", players: 2 }, places, passes, soldByPlace: true, minutes: 60 }),
        };
      return { ok: true, json: async () => ({ bookings: [booking], revenue: 20, collected: 0, outstanding: 20 }) };
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("staff choose each child's pass for an unpaid booking and pay with them; a refusal is said", async () => {
    render(<BookingsTab />);
    await act(async () => {});
    const row = screen.getByRole("table").querySelector("tbody tr")! as HTMLElement;
    await act(async () => within(row).getByText("unpaid").click());
    await act(async () => within(row).getByText("Passes…").click());
    const panel = within(row).getByTestId("counter-pass-pay");
    fireEvent.change(within(panel).getByRole("combobox", { name: "Which pass pays for whom" }), { target: { value: "__each" } });
    fireEvent.change(within(panel).getByRole("combobox", { name: "Aina" }), { target: { value: "PS-1" } });
    fireEvent.change(within(panel).getByRole("combobox", { name: "Badrul" }), { target: { value: "PS-2" } });
    expect(within(panel).getByText("Each place is paid by its own pass.")).toBeTruthy();
    await act(async () => within(panel).getByText("Pay with these passes").click());
    const post = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/admin/bookings/passes" && (init as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ code: "MS-PASSES", passCodes: ["PS-1", "PS-2"] });
    // Refused by the server (here, as if a place were uncovered): said in the staff language, nothing marked paid.
    expect(within(panel).getByText(/Still to pay for: Badrul/)).toBeTruthy();
  });
});
