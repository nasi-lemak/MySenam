// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { ActivityGlyph, ActivityTile, Glyph, GlyphTile } from "../../src/components/Glyph";
import { AddResourcesForm } from "../../src/components/admin/ResourcesEditor";
import { SetupPlanView } from "../../src/components/admin/guide/SetupPlanView";
import FitPicker from "../../src/components/fit/FitPicker";
import { allActivities, setActivities, type Activity } from "../../src/lib/activity-registry";
import { BUSINESS_TYPE_IDS } from "../../src/lib/guide/business-types";
import { buildSetupPlan } from "../../src/lib/guide/plan";
import { emptyProfile } from "../../src/lib/guide/profile-types";
import { emptyAnswers, type GuideAnswers } from "../../src/lib/guide/answer-schema";
import { launchReadiness } from "../../src/lib/guide/readiness";
import { discover } from "../../src/lib/guide/discover";
import type { SetupView } from "../../src/lib/guide/http";
import { translator } from "../../src/lib/i18n";

/**
 * Pictures on screen (docs/development/images.md): a glyph is decorative
 * beside its name and named where it stands alone; an operator's own activity
 * chooses its picture from a list of radio buttons, and one holding an emoji
 * from before glyphs shows and keeps it; the setup journey's and the public
 * guide's choices carry a tile beside each name and still save what they did.
 */

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, headers: new Headers({ "content-type": "application/json" }), json: async () => body });
let fetchMock: ReturnType<typeof vi.fn>;
const builtins = allActivities();
beforeEach(() => {
  fetchMock = vi.fn(async () => json({}));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setActivities(builtins);
});

describe("a glyph", () => {
  it("is hidden from screen readers beside a name, and an image with a name where it stands alone", () => {
    const { container } = render(
      <p>
        <Glyph name="activity/tennis" /> Tennis <Glyph name="generic/ball" label="Ball games" />
      </p>
    );
    const [decorative, named] = container.querySelectorAll("svg");
    expect(decorative.getAttribute("aria-hidden")).toBe("true");
    expect(decorative.getAttribute("role")).toBeNull();
    expect(decorative.getAttribute("focusable")).toBe("false");
    expect(decorative.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(decorative.getAttribute("stroke")).toBe("currentColor");
    expect(named.getAttribute("aria-hidden")).toBeNull();
    expect(screen.getByRole("img", { name: "Ball games" })).toBe(named);
    // Only the decorative one's neighbour is read: the name.
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("draws nothing for a name that is not a glyph", () => {
    const { container } = render(<Glyph name="activity/quidditch" />);
    expect(container.innerHTML).toBe("");
  });

  it("sits in a tile toned by its category, and a legacy emoji sits in the same tile as text", () => {
    const { container } = render(
      <>
        <GlyphTile name="category/aquatic" tone="aquatic" />
        <GlyphTile name="🏑" tone="team" />
        <GlyphTile name="generic/ball" tone="not-a-tone" />
      </>
    );
    const [pool, emoji, unknown] = Array.from(container.children) as HTMLElement[];
    expect(pool.className).toContain("bg-tile-aquatic");
    expect(pool.querySelector("svg")?.getAttribute("data-glyph")).toBe("category/aquatic");
    expect(emoji.className).toContain("bg-tile-team");
    expect(emoji.querySelector("svg")).toBeNull();
    expect(emoji.textContent).toBe("🏑");
    expect(unknown.className).toContain("bg-tile-neutral");
  });

  it("draws an activity with its catalogue glyph, or its emoji from before glyphs", () => {
    setActivities([...builtins, { ...builtins[0], key: "hockey_old", icon: "🏑", builtin: false, venueId: 3 } as Activity]);
    const { container } = render(
      <>
        <span data-x="a">
          <ActivityGlyph sport="badminton" />
        </span>
        <span data-x="b">
          <ActivityGlyph sport="hockey_old" />
        </span>
        <span data-x="c">
          <ActivityTile sport="swimming" />
        </span>
        <span data-x="d">
          <ActivityGlyph sport="somebody_elses_new_one" />
        </span>
      </>
    );
    const at = (x: string) => container.querySelector(`[data-x="${x}"]`)!;
    expect(at("a").querySelector("svg")?.getAttribute("data-glyph")).toBe("activity/badminton");
    expect(at("b").textContent).toBe("🏑");
    expect(at("c").firstElementChild?.className).toContain("bg-tile-aquatic");
    // Not heard of yet: the stand-in's court, never the key as text.
    expect(at("d").querySelector("svg")?.getAttribute("data-glyph")).toBe("generic/court");
  });
});

describe("choosing an own activity's picture", () => {
  const own = { ...builtins.find((a) => a.key === "football")!, key: "hockey_old", icon: "🏑", names: { en: "Old hockey" }, builtin: false, businessId: null, venueId: 3 } as Activity;

  it("is a group of radio buttons, each named, the category's chosen until another is, and saves the choice", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return json({ activity: { ...own, key: "tchoukball", icon: "generic/whistle" } }, 201);
      return json({ activities: builtins });
    });
    render(<AddResourcesForm venueId={3} onAdded={() => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Not in the list? Add an activity of your own" }));
    const picture = screen.getByRole("group", { name: "Picture" });
    const radios = within(picture).getAllByRole("radio") as HTMLInputElement[];
    // One group (one name), so the arrow keys move through it; none taken out of the tab order.
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    expect(radios.every((r) => r.tabIndex !== -1)).toBe(true);
    // The generic set and every built-in activity's, each under its name.
    expect(radios).toHaveLength(1 + 12 + builtins.filter((a) => a.builtin).length);
    expect((within(picture).getByRole("radio", { name: "Its category's" }) as HTMLInputElement).checked).toBe(true);
    expect(within(picture).getByRole("radio", { name: "Padel" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name (English)"), { target: { value: "Tchoukball" } });
    fireEvent.click(within(picture).getByRole("radio", { name: "Whistle" }));
    expect((within(picture).getByRole("radio", { name: "Whistle" }) as HTMLInputElement).checked).toBe(true);
    await act(async () => fireEvent.submit(picture.closest("form")!));
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toMatchObject({ venueId: 3, names: { en: "Tchoukball" }, icon: "generic/whistle" });
  });

  it("shows an emoji from before glyphs as the one to keep, and saves a glyph chosen instead", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return json({ activity: { ...own, icon: "generic/goal" } });
      return json({ activities: [...builtins, own] });
    });
    const said = vi.fn();
    render(<AddResourcesForm venueId={3} onAdded={said} />);
    await act(async () => {});
    fireEvent.change(screen.getByRole("combobox", { name: /Activity/ }), { target: { value: "hockey_old" } });
    // The chosen activity is named with its picture: the emoji, as text.
    expect(screen.getByText("🏑")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change the picture of Old hockey" }));
    const picture = screen.getByRole("group", { name: "Picture" });
    const keep = within(picture).getByRole("radio", { name: "Keep this one" }) as HTMLInputElement;
    expect(keep.checked).toBe(true);
    expect(keep.closest("label")!.textContent).toContain("🏑");
    fireEvent.click(within(picture).getByRole("radio", { name: "Goal" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")!;
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ key: "hockey_old", venueId: 3, icon: "generic/goal" });
    expect(said).toHaveBeenCalledWith("Picture of Old hockey saved.");
  });

  it("shows the route's refusal and keeps the picker open", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return json({ error: "Choose a picture from the list." }, 400);
      return json({ activities: [...builtins, own] });
    });
    render(<AddResourcesForm venueId={3} onAdded={() => {}} />);
    await act(async () => {});
    fireEvent.change(screen.getByRole("combobox", { name: /Activity/ }), { target: { value: "hockey_old" } });
    fireEvent.click(screen.getByRole("button", { name: "Change the picture of Old hockey" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(screen.getByText("Choose a picture from the list.")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Picture" })).toBeTruthy();
  });
});

function setupView(answers: GuideAnswers = emptyAnswers(), rev = 0): SetupView {
  const profile = emptyProfile(3);
  const plan = buildSetupPlan({ profile, answers, acknowledged: {}, role: "manager" });
  return {
    venueId: 3,
    role: "manager",
    profile,
    answers,
    rev,
    acknowledged: {},
    dismissed: {},
    plan,
    readiness: launchReadiness(profile, plan),
    discoveries: discover(profile, answers),
  } as unknown as SetupView;
}

describe("the setup journey's choices", () => {
  it("show each kind of business as a tile beside its name, still a checkbox, and save the same answer", async () => {
    let served = setupView();
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return json(served);
      const body = JSON.parse(init.body as string);
      served = setupView({ v: 1, ...body.answers } as GuideAnswers, body.rev + 1);
      return json(served);
    });
    render(<SetupPlanView data={served} onGo={vi.fn()} />);
    const box = screen.getByRole("checkbox", { name: "Swimming facility" }) as HTMLInputElement;
    const label = box.closest("label")!;
    expect(label.querySelector("svg[data-glyph='business/swimming']")?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelectorAll("svg[data-glyph^='business/']")).toHaveLength(BUSINESS_TYPE_IDS.length);
    fireEvent.click(box);
    await act(async () => screen.getByRole("button", { name: "Save and continue" }).click());
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toMatchObject({ action: "answers", rev: 0, answers: { types: ["swimming"] } });
    // The activities question: each with its own glyph beside its name.
    expect(await screen.findByRole("heading", { name: "Which activities will you offer?" })).toBeTruthy();
    const swim = screen.getByRole("checkbox", { name: /^Swimming/ });
    expect(swim.closest("label")!.querySelector("svg[data-glyph='activity/swimming']")).not.toBeNull();
  });
});

describe("the public guide's picker", () => {
  it("puts a tile beside each kind of business and a glyph beside each activity, inside the same labelled boxes", () => {
    const t = translator("en");
    render(<FitPicker selection={{ types: [], activities: [] }} t={t} showCards />);
    const box = screen.getByRole("checkbox", { name: "Climbing or bouldering centre" });
    expect(box.closest("label")!.querySelector("svg[data-glyph='business/climbing-and-bouldering']")).not.toBeNull();
    const padel = screen.getByRole("checkbox", { name: "Padel" });
    expect(padel.closest("label")!.querySelector("svg[data-glyph='activity/padel']")?.getAttribute("aria-hidden")).toBe("true");
    // The cards link by name; the tile adds nothing to it.
    expect(screen.getByRole("link", { name: "Climbing or bouldering centre" }).querySelector("svg")).not.toBeNull();
  });
});
