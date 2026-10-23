// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { AddResourcesForm } from "../../src/components/admin/ResourcesEditor";
import SearchClient from "../../src/app/search/SearchClient";
import { QuickSearch } from "../../src/app/QuickSearch";
import { allActivities } from "../../src/lib/activity-registry";

/**
 * The screens that make activities usable without the database: an operator
 * adds lanes from a template, and a customer finds an activity by the word
 * they know it by.
 */

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, ok = true) => ({ ok, json: async () => body });

beforeEach(() => {
  fetchMock = vi.fn(async () => json({}));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("adding resources from a template", () => {
  it("starts from the chosen activity's template and makes several at once", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/admin/activities")) return json({ activities: allActivities() });
      if (init?.method === "POST") return json({ courts: [{ name: "Lane 1" }, { name: "Lane 2" }] });
      return json({});
    });
    const added = vi.fn();
    render(<AddResourcesForm venueId={3} onAdded={added} />);
    await act(async () => {});
    fireEvent.change(screen.getByRole("combobox", { name: /Activity/ }), { target: { value: "swimming" } });
    // Swimming's template: lanes with places, priced per swimmer, indoor or outdoor left to say.
    expect((screen.getByRole("combobox", { name: /Each is a/ }) as HTMLSelectElement).value).toBe("lane");
    expect((screen.getByRole("spinbutton", { name: /Places/ }) as HTMLInputElement).value).toBe("4");
    expect(screen.getByText(/In the pool|Full support|full/i)).toBeTruthy();
    fireEvent.change(screen.getByRole("spinbutton", { name: /How many/ }), { target: { value: "2" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: /Off-peak/ }), { target: { value: "6" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: /^Peak/ }), { target: { value: "8" } });
    await act(async () => fireEvent.submit(screen.getByRole("button", { name: "Add" }).closest("form")!));
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toMatchObject({ venueId: 3, sport: "swimming", count: 2, noun: "lane", capacity: 4, offPeakRate: 6, peakRate: 8 });
    expect(added).toHaveBeenCalledWith("Added Lane 1, Lane 2.");
  });

  it("says when an activity asks for a sign-off, and what is not built", async () => {
    fetchMock.mockImplementation(async () => json({ activities: allActivities() }));
    render(<AddResourcesForm venueId={3} onAdded={() => {}} />);
    await act(async () => {});
    fireEvent.change(screen.getByRole("combobox", { name: /Activity/ }), { target: { value: "climbing" } });
    expect(screen.getByText(/staff sign-off before they book it/)).toBeTruthy();
    expect(screen.getByText(/Not built: open-ended day passes/)).toBeTruthy();
    expect((screen.getByRole("combobox", { name: /Indoor or outdoor/ }) as HTMLSelectElement).value).toBe("indoor");
  });
});

describe("finding an activity", () => {
  const offered = ["badminton", "futsal", "sepak_takraw", "swimming", "yoga", "kayak"];

  it("groups what is offered by kind, and finds one by the word people use", async () => {
    fetchMock.mockImplementation(async () => json({ results: [], areas: [], covers: {} }));
    render(<SearchClient sports={offered} />);
    await act(async () => {});
    expect(screen.getByRole("group", { name: "Racket sports" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Team sports" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "takraw" } });
    await act(async () => fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" }));
    const last = String(fetchMock.mock.calls.at(-1)![0]);
    expect(last).toContain("sport=sepak_takraw");
    // A word for something nobody here offers says so.
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "bowling" } });
    expect(screen.getByText("Nobody here offers that yet.")).toBeTruthy();
  });

  it("offers the court filters that mean something for the activity", async () => {
    fetchMock.mockImplementation(async () => json({ results: [], areas: [], covers: {} }));
    render(<SearchClient sports={offered} start={{ sport: "kayak" }} />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /Floodlit/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Showers/ })).toBeTruthy();
    await act(async () => screen.getByRole("button", { name: /Futsal/ }).click());
    expect(screen.getByRole("button", { name: /Floodlit/ })).toBeTruthy();
  });

  it("keeps the home page to eight buttons, with the rest one pick away", () => {
    const many = allActivities().map((a) => a.key);
    render(<QuickSearch sports={many} />);
    const chooser = screen.getByRole("group", { name: /sport|activity/i });
    expect(chooser.querySelectorAll("button")).toHaveLength(8);
    expect(screen.getByRole("combobox", { name: /More activities/ })).toBeTruthy();
  });
});
