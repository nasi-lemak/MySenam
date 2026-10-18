// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useState } from "react";

import AddonPicker, { pickedList, pickedTotal, type OfferedAddon, type Picked } from "../../src/components/AddonPicker";
import { LanguageProvider, useT } from "../../src/components/Language";
import { forgetGuest, rememberedGuest, rememberGuest } from "../../src/lib/guest-memory";
import { DAY_PARTS, dayPartOf } from "../../src/lib/day-parts";

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, ok = true) => ({ ok, json: async () => body });

beforeEach(() => {
  fetchMock = vi.fn(async () => json({ addons: [] }));
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

const LIST: OfferedAddon[] = [
  { id: 1, name: "Racket", kind: "rental", price: 5, left: 2 },
  { id: 2, name: "Shuttle tube", kind: "sale", price: 18.5, left: null },
];

function Harness({ start = {}, query = "courtId=1" }: { start?: Picked; query?: string }) {
  const t = useT();
  const [picked, setPicked] = useState<Picked>(start);
  return (
    <>
      <AddonPicker t={t} query={query} picked={picked} onChange={setPicked} />
      <output data-testid="picked">{JSON.stringify(pickedList(picked))}</output>
    </>
  );
}

const show = (node: React.ReactNode) => render(<LanguageProvider locale="en">{node}</LanguageProvider>);

describe("the extras picker", () => {
  it("shows nothing when the venue offers nothing", async () => {
    show(<Harness />);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledWith("/api/addons?courtId=1", { cache: "no-store" });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is folded until asked, never preselected, and stops at what is left", async () => {
    fetchMock.mockImplementation(async () => json({ addons: LIST }));
    show(<Harness />);
    await act(async () => {});
    const toggle = screen.getByRole("button", { name: /Add extras/ });
    expect(screen.getByTestId("picked").textContent).toBe("[]");
    await act(async () => toggle.click());
    const more = screen.getByRole("button", { name: "One more Racket" });
    await act(async () => more.click());
    await act(async () => more.click());
    expect((more as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/2 left/)).toBeTruthy();
    await act(async () => screen.getByRole("button", { name: "One more Shuttle tube" }).click());
    expect(JSON.parse(screen.getByTestId("picked").textContent!)).toEqual([
      { addonId: 1, quantity: 2 },
      { addonId: 2, quantity: 1 },
    ]);
    expect(screen.getByRole("button", { name: /Extras: 3 · RM28.5/ })).toBeTruthy();
    await act(async () => screen.getByRole("button", { name: "One fewer Racket" }).click());
    expect(JSON.parse(screen.getByTestId("picked").textContent!)[0]).toEqual({ addonId: 1, quantity: 1 });
  });

  it("drops what is no longer offered and trims to what is left", async () => {
    fetchMock.mockImplementation(async () => json({ addons: [{ ...LIST[0], left: 1 }] }));
    show(<Harness start={{ 1: 3, 2: 1 }} />);
    await act(async () => {});
    expect(JSON.parse(screen.getByTestId("picked").textContent!)).toEqual([{ addonId: 1, quantity: 1 }]);
  });

  it("adds up", () => {
    expect(pickedTotal(LIST, { 1: 2, 2: 1 })).toBe(28.5);
    expect(pickedTotal(LIST, {})).toBe(0);
    expect(pickedList({ 1: 0, 2: 3 })).toEqual([{ addonId: 2, quantity: 3 }]);
  });
});

describe("a returning guest", () => {
  it("is remembered on this device and forgotten on request", () => {
    expect(rememberedGuest()).toBeNull();
    rememberGuest({ name: " Aisyah ", phone: "012-345 6789 ", email: "" });
    expect(rememberedGuest()).toEqual({ name: "Aisyah", phone: "012-345 6789", email: "" });
    forgetGuest();
    expect(rememberedGuest()).toBeNull();
  });

  it("ignores anything odd in storage, and storage that refuses", () => {
    window.localStorage.setItem("mysenam.guest", "{not json");
    expect(rememberedGuest()).toBeNull();
    window.localStorage.setItem("mysenam.guest", JSON.stringify({ name: 3 }));
    expect(rememberedGuest()).toBeNull();
    window.localStorage.setItem("mysenam.guest", JSON.stringify({ name: "Mei", phone: "0123", email: 5 }));
    expect(rememberedGuest()).toEqual({ name: "Mei", phone: "0123", email: "" });
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => rememberGuest({ name: "Raj", phone: "0199", email: "" })).not.toThrow();
    expect(() => forgetGuest()).not.toThrow();
    spy.mockRestore();
    remove.mockRestore();
  });
});

describe("parts of the day", () => {
  it("name a window, or none for one of your own", () => {
    expect(dayPartOf(...(DAY_PARTS.evening as unknown as [number, number]))).toBe("evening");
    expect(dayPartOf(DAY_PARTS.any[0], DAY_PARTS.any[1])).toBe("any");
    expect(dayPartOf(7, 9)).toBeNull();
  });
});

describe("the staff extras editor", () => {
  const venue = { id: 7, name: "Arena", courts: [{ sport: "badminton" }, { sport: "futsal" }] } as never;
  const racket = { id: 1, venueId: 7, name: "Racket", kind: "rental", price: 5, stock: 4, sport: "badminton", active: true };
  const towel = { id: 2, venueId: 7, name: "Towel", kind: "sale", price: 3, stock: null, sport: null, active: false };

  it("lists, adds, edits, retires and brings back", async () => {
    const { AddonsEditor } = await import("../../src/components/admin/AddonsEditor");
    const { fireEvent } = await import("@testing-library/react");
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return json({ addons: [racket, towel] });
      if (init.method === "POST" && JSON.parse(String(init.body)).name === "x") return json({ error: "Give it a name." }, false);
      return json({ addons: [racket, { ...towel, active: true }] });
    });
    render(<AddonsEditor venue={venue} />);
    await act(async () => screen.getByRole("button", { name: /Extras for sale or hire/ }).click());
    expect(screen.getByText(/4 in stock/)).toBeTruthy();
    expect(screen.getByText(/to hire, 4 in stock/).textContent).toContain("Badminton only");
    expect(screen.getByText(/retired/)).toBeTruthy();

    // A new one, refused, then put right.
    fireEvent.change(screen.getByPlaceholderText("Racket"), { target: { value: "x" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: /Price/ }), { target: { value: "2" } });
    await act(async () => fireEvent.submit(screen.getByRole("button", { name: "Add" }).closest("form")!));
    expect(screen.getByText("Give it a name.")).toBeTruthy();

    await act(async () => screen.getByRole("button", { name: "Bring back" }).click());
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/addons/2", expect.objectContaining({ method: "PATCH" }));

    await act(async () => screen.getAllByRole("button", { name: "Edit" })[0].click());
    expect((screen.getByPlaceholderText("Racket") as HTMLInputElement).value).toBe("Racket");
    fireEvent.change(screen.getByRole("combobox", { name: /Kind/ }), { target: { value: "sale" } });
    expect(screen.queryByRole("spinbutton", { name: /How many/ })).toBeNull();
    await act(async () => fireEvent.submit(screen.getByRole("button", { name: "Save changes" }).closest("form")!));
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/addons/1", expect.objectContaining({ method: "PATCH" }));
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();

    await act(async () => screen.getAllByRole("button", { name: "Edit" })[0].click());
    await act(async () => screen.getByRole("button", { name: "Cancel" }).click());
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
    await act(async () => screen.getAllByRole("button", { name: "Retire" })[0].click());
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/addons/1", expect.objectContaining({ method: "DELETE" }));
  });
});
