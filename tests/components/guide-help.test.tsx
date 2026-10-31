// @vitest-environment jsdom
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { HelpTip } from "../../src/components/admin/guide/HelpTip";
import { GuideTab } from "../../src/components/admin/guide/GuideTab";
import { DiscoverView } from "../../src/components/admin/guide/DiscoverView";
import { PlaybookDocument } from "../../src/components/admin/guide/PlaybookDocument";
import { CAPABILITIES } from "../../src/lib/guide/capabilities";
import { emptyAnswers } from "../../src/lib/guide/answer-schema";
import { discover } from "../../src/lib/guide/discover";
import { buildPlaybook } from "../../src/lib/guide/playbook";
import { buildTopic } from "../../src/lib/guide/playbook/topics";
import { linkFor } from "../../src/lib/guide/playbook/dsl";
import { buildSetupPlan } from "../../src/lib/guide/plan";
import { emptyProfile, type VenueProfile } from "../../src/lib/guide/profile-types";
import { launchReadiness } from "../../src/lib/guide/readiness";
import { guideAddress, type TopicId } from "../../src/lib/guide/help";
import type { SetupView } from "../../src/lib/guide/http";

/**
 * Contextual help on screen: the "?" (a named, keyboard-reachable button that
 * opens a dialog and reads its topic only when first opened), and the guide's
 * discover view (suggestions with their reasons, and everything MySenam can do
 * marked as in use, available or not currently supported). Placement on the
 * real screens is in guide-help-screens.test.tsx.
 */

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) });

function profile(): VenueProfile {
  const p = emptyProfile(3);
  p.today = "2026-10-31";
  p.identity.live = true;
  p.identity.draft = false;
  p.resources.total = 4;
  p.resources.withBuffers = 1;
  p.activities = [{ key: "badminton", support: "full", own: false }];
  p.rates.lowest = 18;
  p.rates.highest = 28;
  p.rates.peakPricing = true;
  p.history.bookings = 40;
  p.channels.onlinePage = true;
  return p;
}

function topicAnswer(id: TopicId, role: "manager" | "desk" = "manager", guide = true) {
  return { venueId: 3, role, topic: buildTopic(id, profile(), role), guide: guide ? linkFor(role, "guide", undefined, "playbook") ?? null : null };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  window.history.replaceState(null, "", "/admin?tab=courts");
  fetchMock = vi.fn(async () => json(topicAnswer("buffers")));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const tip = () => screen.getByRole("button", { name: /^Help: / });

describe("the ? beside a control", () => {
  it("is a button with a visible ? and a name that is the question it answers, big enough to press, and reads nothing until it is opened", () => {
    render(<HelpTip place="courts.buffers" venueId={3} />);
    const button = tip();
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.textContent).toBe("?");
    expect(button.getAttribute("aria-label")).toBe("Help: How do booking buffers work?");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    // 28 px: above the 24 px a finger or a pointer needs.
    expect(button.className).toMatch(/\bh-7\b/);
    expect(button.className).toMatch(/\bw-7\b/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens a dialog named by its question, loads the topic once, and says what the playbook says of it for this venue", async () => {
    render(<HelpTip place="courts.buffers" venueId={3} />);
    await act(async () => tip().click());
    const dialog = await screen.findByRole("dialog", { name: "How do booking buffers work?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(tip().getAttribute("aria-expanded")).toBe("true");
    expect(await within(dialog).findByText("1 of your 4 resources have buffers set.")).toBeTruthy();
    expect(within(dialog).getByText("Written from this venue's saved settings.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/guide/topic?venueId=3&id=buffers");
    // On a phone it fits the width and scrolls inside itself.
    expect(dialog.className).toContain("w-full");
    expect(dialog.className).toContain("max-w-lg");
    expect(dialog.className).toContain("overflow-y-auto");
    expect(dialog.className).toContain("max-h-[85vh]");
  });

  it("closes with Escape and gives the focus back to the ? it came from, and opening it again reads nothing more", async () => {
    render(<HelpTip place="courts.buffers" venueId={3} />);
    const button = tip();
    button.focus();
    await act(async () => button.click());
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
    await act(async () => {
      fireEvent.keyDown(dialog, { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await act(async () => button.click());
    expect(await screen.findByText("1 of your 4 resources have buffers set.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The Close button closes it too.
    await act(async () => within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }).click());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the focus inside the dialog: Tab from the last control goes to the first, Shift+Tab the other way", async () => {
    render(<HelpTip place="courts.buffers" venueId={3} />);
    await act(async () => tip().click());
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Written from this venue's saved settings.");
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"));
    expect(focusable.length).toBeGreaterThanOrEqual(3);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    expect(first.textContent).toBe("Close");
    expect(last.textContent).toBe("Open this in the guide");
    last.focus();
    await act(async () => {
      fireEvent.keyDown(last, { key: "Tab" });
    });
    expect(document.activeElement).toBe(first);
    await act(async () => {
      fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    });
    expect(document.activeElement).toBe(last);
  });

  it("draws the topic with the playbook's own renderer: its callouts carry a word, its tables are tables, its links open the screen", async () => {
    fetchMock.mockImplementation(async () => json(topicAnswer("cannot-reserve")));
    render(<HelpTip place="counter.refusal" venueId={3} />);
    await act(async () => tip().click());
    const dialog = await screen.findByRole("dialog", { name: "Why can't this customer reserve this?" });
    await within(dialog).findByRole("table");
    expect(dialog.querySelector("aside[data-callout='policy']")!.textContent).toContain("Your venue's policy");
    expect(within(dialog).getAllByRole("columnheader").length).toBe(2);
    // There is one renderer: the tip's file imports the playbook's, and draws no tables or callouts of its own.
    const source = fs.readFileSync("src/components/admin/guide/HelpTip.tsx", "utf8");
    expect(source).toContain('import { BlockView } from "./PlaybookDocument"');
    expect(source).not.toMatch(/<table|<aside|<ol|<dl/);

    fetchMock.mockImplementation(async () => json(topicAnswer("buffers")));
    await act(async () => within(dialog).getByRole("button", { name: "Close" }).click());
    render(<HelpTip place="courts.buffers" venueId={3} />);
    await act(async () => screen.getByRole("button", { name: /booking buffers/ }).click());
    const buffers = await screen.findByRole("dialog", { name: /booking buffers/ });
    await act(async () => within(buffers).getByRole("button", { name: /Open Courts & rates/ }).click());
    // The screen it names is opened (the address is where the dashboard reads it), and the dialog is gone.
    expect(window.location.search).toContain("tab=courts");
    expect(screen.queryByRole("dialog", { name: /booking buffers/ })).toBeNull();
  });

  it("offers Open this in the guide only where the role may open it, and takes the dashboard there at the topic, on the same venue", async () => {
    window.history.replaceState(null, "", "/admin?tab=courts&venue=3");
    let popped = 0;
    const onPop = () => popped++;
    window.addEventListener("popstate", onPop);
    render(<HelpTip place="courts.buffers" venueId={3} />);
    await act(async () => tip().click());
    const link = await screen.findByRole("link", { name: "Open this in the guide" });
    expect(link.getAttribute("href")).toBe(guideAddress(3, "buffers"));
    await act(async () => link.click());
    const search = new URLSearchParams(window.location.search);
    expect(Object.fromEntries(search)).toMatchObject({ tab: "guide", view: "playbook", venue: "3", topic: "buffers" });
    expect(popped).toBeGreaterThan(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    window.removeEventListener("popstate", onPop);
  });

  it("does not show the link where the server did not give one", async () => {
    fetchMock.mockImplementation(async () => json(topicAnswer("buffers", "manager", false)));
    render(<HelpTip place="courts.buffers" venueId={3} />);
    await act(async () => tip().click());
    await screen.findByText("Written from this venue's saved settings.");
    expect(screen.queryByRole("link", { name: "Open this in the guide" })).toBeNull();
  });

  it("shows the desk the desk's version: it is told a manager changes it, and has no link to a screen it cannot use", async () => {
    fetchMock.mockImplementation(async () => json(topicAnswer("buffers", "desk")));
    render(<HelpTip place="courts.buffers" venueId={3} />);
    await act(async () => tip().click());
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Written from this venue's saved settings.");
    expect(dialog.textContent).toMatch(/A manager/);
    expect(within(dialog).queryByRole("button", { name: /Open Courts & rates/ })).toBeNull();
  });

  it("renders nothing, and asks nothing, for a role the topic is not written for, or with no venue to explain", () => {
    const { container, rerender } = render(<HelpTip place="courts.buffers" venueId={3} role="coach" />);
    expect(container.innerHTML).toBe("");
    rerender(<HelpTip place="courts.buffers" venueId={null} />);
    expect(container.innerHTML).toBe("");
    rerender(<HelpTip place="courts.buffers" venueId={undefined} role="manager" />);
    expect(container.innerHTML).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
    rerender(<HelpTip place="courts.buffers" venueId={3} role="desk" />);
    expect(screen.getByRole("button", { name: /^Help: / })).toBeTruthy();
  });

  it("goes away when the server says there is none for this role, and says so plainly when it cannot be read, with a way to try again", async () => {
    fetchMock.mockImplementation(async () => json({ error: "There is no help for that." }, 404));
    const gone = render(<HelpTip place="courts.buffers" venueId={3} />);
    await act(async () => tip().click());
    await waitFor(() => expect(gone.container.innerHTML).toBe(""));
    expect(screen.queryByRole("dialog")).toBeNull();
    gone.unmount();

    let calls = 0;
    fetchMock.mockImplementation(async () => (++calls === 1 ? json({ error: "x" }, 500) : json(topicAnswer("buffers"))));
    render(<HelpTip place="courts.buffers" venueId={3} />);
    await act(async () => tip().click());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The help could not be loaded.");
    await act(async () => within(alert).getByRole("button", { name: "Try again" }).click());
    expect(await screen.findByText("1 of your 4 resources have buffers set.")).toBeTruthy();
    expect(calls).toBe(2);
  });
});

describe("opening the guide at a topic", () => {
  it("opens the section that explains the topic, brings it into view, and forgets the address's topic so a later visit starts where it always does", async () => {
    const p = profile();
    p.resources.withBuffers = 2;
    const book = buildPlaybook(p, "manager", { venueName: "Court House" });
    const section = book.sections.find((s) => s.blocks.some((b) => b.type === "heading" && b.id === "topic-buffers"))!;
    expect(section).toBeTruthy();
    expect(section.id).not.toBe(book.sections[0].id);
    window.history.replaceState(null, "", "/admin?tab=guide&view=playbook&venue=3&topic=buffers");
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    render(<PlaybookDocument playbook={book} onGo={() => undefined} />);
    await waitFor(() => expect(document.querySelector(`#gp-body-${section.id}`)!.hasAttribute("hidden")).toBe(false));
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    expect(new URLSearchParams(window.location.search).has("topic")).toBe(false);
    expect(new URLSearchParams(window.location.search).get("view")).toBe("playbook");
  });

  it("just opens the guide where the venue's guide has no section for the topic (it is there only where the venue uses what it explains)", async () => {
    const book = buildPlaybook(profile(), "manager", { venueName: "Court House" });
    expect(book.sections.some((s) => s.blocks.some((b) => b.type === "heading" && b.id === "topic-unattended"))).toBe(false);
    window.history.replaceState(null, "", "/admin?tab=guide&view=playbook&topic=unattended");
    render(<PlaybookDocument playbook={book} onGo={() => undefined} />);
    expect(document.querySelector("#gp-body-start")!.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector("#gp-body-cancel")!.hasAttribute("hidden")).toBe(true);
  });
});

// ------------------------------------------------------------------------ discover

function setupView(p: VenueProfile, dismissed: Record<string, unknown> = {}, answers = emptyAnswers()): SetupView {
  const plan = buildSetupPlan({ profile: p, answers, acknowledged: {}, role: "manager" });
  return {
    venueId: 3,
    role: "manager",
    profile: p,
    answers,
    rev: 2,
    acknowledged: {},
    dismissed,
    plan,
    readiness: launchReadiness(p, plan),
    discoveries: discover(p, answers, dismissed),
  } as SetupView;
}

function coachingVenue(): VenueProfile {
  const p = profile();
  p.people.classes = 3;
  p.people.upcomingClasses = 2;
  return p;
}

describe("the discover view", () => {
  const show = (view: SetupView, post = vi.fn(async () => undefined), onSetUp = vi.fn(), onGo = vi.fn()) => {
    render(<DiscoverView data={view} post={post} onGo={onGo} onSetUp={onSetUp} />);
    return { post, onSetUp, onGo };
  };

  it("offers at most three suggestions with the reason, what each needs, a way to set it up, set it aside and read how it works: and calls them suggestions", async () => {
    const view = setupView(coachingVenue());
    expect(view.discoveries.length).toBeGreaterThan(0);
    expect(view.discoveries.length).toBeLessThanOrEqual(3);
    const { post, onSetUp } = show(view);
    const section = document.querySelector("[data-suggestions]") as HTMLElement;
    expect(within(section).getByRole("heading", { name: `Suggestions (${view.discoveries.length})` })).toBeTruthy();
    const coaching = section.querySelector('[data-suggestion="coaching"]') as HTMLElement;
    expect(within(coaching).getByText("One-to-one coaching")).toBeTruthy();
    expect(within(coaching).getByText(/You run classes\. MySenam also supports one-to-one coaching/)).toBeTruthy();
    expect(within(coaching).getByText("Available with configuration")).toBeTruthy();
    // Set this up: a targeted journey, not the whole of setup.
    const setUp = within(coaching).getByRole("link", { name: "Set this up" });
    expect(setUp.getAttribute("href")).toBe("/admin?tab=guide&view=setup&venue=3&focus=coaching");
    await act(async () => setUp.click());
    expect(onSetUp).toHaveBeenCalledWith("coaching");
    // Not for us: the existing dismiss action, by id.
    await act(async () => within(coaching).getByRole("button", { name: "Not for us" }).click());
    expect(post).toHaveBeenCalledWith({ action: "dismiss", id: "coaching" });
    // How it works: the capability's own sentence, read when asked.
    const how = within(coaching).getByRole("button", { name: "How it works" });
    expect(how.getAttribute("aria-expanded")).toBe("false");
    await act(async () => how.click());
    expect(how.getAttribute("aria-expanded")).toBe("true");
    const blurb = within(coaching).getByText(/Coaches with their own hours and rates take lesson bookings/);
    expect(blurb.closest("[hidden]")).toBeNull();
    // Never "recommended for you by AI": the words around the suggestions say what they are.
    const said = `${document.querySelector("#guide-discover-heading")!.parentElement!.textContent} ${section.textContent}`.replace(/How it works[\s\S]*$/, "");
    expect(said).not.toMatch(/recommended for you|\bAI\b|artificial|machine|learned/i);
    expect(said).toContain("suggestions from simple rules");
    expect(said).toContain("Suggestions (");
  });

  it("says when there is nothing to suggest, and then shows only the catalogue", () => {
    const p = profile();
    // Everything it would suggest has been set aside.
    const view = setupView(p, Object.fromEntries(setupView(p).discoveries.map((d) => [d.id, { at: "x" }])));
    expect(view.discoveries).toEqual([]);
    show(view);
    expect(screen.getByText("Suggestions (0)")).toBeTruthy();
    expect(screen.getByText("Nothing to suggest right now.")).toBeTruthy();
    expect(document.querySelector("[data-catalogue]")).toBeTruthy();
  });

  it("never suggests what is set aside or what the venue already uses", () => {
    const p = coachingVenue();
    expect(discover(p, emptyAnswers(), {}).map((d) => d.id)).toContain("coaching");
    expect(discover(p, emptyAnswers(), { coaching: { at: "x" } }).map((d) => d.id)).not.toContain("coaching");
    const using = coachingVenue();
    using.people.coaches = 2;
    expect(discover(using, emptyAnswers(), {}).map((d) => d.id)).not.toContain("coaching");
    // And in the view: a dismissed suggestion is not among the suggestions, a used capability is marked in use and offered no setup.
    show(setupView(using, {}));
    expect(document.querySelector('[data-suggestion="coaching"]')).toBeNull();
    const row = document.querySelector('[data-capability="coaching"]') as HTMLElement;
    expect(row.getAttribute("data-state")).toBe("in-use");
    expect(within(row).getByText("In use")).toBeTruthy();
    expect(row.querySelector("[data-setup]")).toBeNull();
  });

  it("lists everything MySenam can do, every capability of the registry exactly once, by area", () => {
    show(setupView(coachingVenue()));
    const rows = Array.from(document.querySelectorAll("[data-capability]")).map((el) => el.getAttribute("data-capability"));
    expect(rows.length).toBe(CAPABILITIES.length);
    expect([...rows].sort()).toEqual(CAPABILITIES.map((c) => c.id).sort());
    expect(new Set(rows).size).toBe(rows.length);
    const groups = Array.from(document.querySelectorAll("[data-group]"));
    expect(groups.length).toBeGreaterThanOrEqual(12);
    for (const g of groups) expect(g.querySelector("summary")!.textContent).toMatch(/in use, \d+ available, \d+ not currently supported/);
  });

  it("marks each item in use, available or not currently supported, in words as well as colour, and gives the unsupported one its alternative and never a way to set it up", () => {
    show(setupView(coachingVenue()));
    const states = new Map(Array.from(document.querySelectorAll("[data-capability]")).map((el) => [el.getAttribute("data-capability")!, el as HTMLElement]));
    for (const c of CAPABILITIES) {
      const row = states.get(c.id)!;
      const state = row.getAttribute("data-state");
      if (c.status === "unsupported") {
        expect(state, c.id).toBe("unsupported");
        expect(within(row).getByText("Not currently supported"), c.id).toBeTruthy();
        expect(row.textContent, c.id).toContain("Instead:");
        expect(row.querySelector("[data-setup]"), c.id).toBeNull();
        // Nothing to press but how it works.
        expect(within(row).queryAllByRole("button").map((b) => b.textContent), c.id).toEqual(["How it works"]);
        expect(within(row).queryByRole("link"), c.id).toBeNull();
      } else {
        expect(["in-use", "available"], c.id).toContain(state);
        expect(within(row).getByText(state === "in-use" ? "In use" : "Available"), c.id).toBeTruthy();
      }
    }
    expect(states.get("classes")!.getAttribute("data-state")).toBe("in-use");
    expect(states.get("coaching")!.getAttribute("data-state")).toBe("available");
    // An unsupported way of selling says what the catalogue says of it.
    expect(states.get("gym-walk-in")!.textContent).toMatch(/Limitation:/);
  });

  it("offers each available, unused capability a way to set it up only where setup has steps for it, else the screen that has it", async () => {
    const { onGo } = show(setupView(coachingVenue()));
    const hire = document.querySelector('[data-capability="equipment-hire"]') as HTMLElement;
    expect(hire.querySelector("[data-setup]")?.getAttribute("href")).toContain("focus=equipment-hire");
    // Company accounts have no setup step: the screen is opened instead.
    const company = document.querySelector('[data-capability="company-accounts"]') as HTMLElement;
    expect(company.querySelector("[data-setup]")).toBeNull();
    await act(async () => within(company).getByRole("button", { name: "Open Credit & passes" }).click());
    expect(onGo).toHaveBeenCalledWith("credit");
  });

  it("shows a capability that is suggested above only once with a way to act on it, and says where", () => {
    show(setupView(coachingVenue()));
    const above = document.querySelector('[data-suggestion="coaching"]') as HTMLElement;
    expect(above.querySelector("[data-setup]")).toBeTruthy();
    const row = document.querySelector('[data-capability="coaching"]') as HTMLElement;
    expect(within(row).getByText("Suggested above")).toBeTruthy();
    expect(row.querySelector("[data-setup]")).toBeNull();
    expect(document.querySelectorAll('[data-setup="coaching"]').length).toBe(1);
  });

  it("names the outside service a capability needs, and never calls it verified", () => {
    show(setupView(coachingVenue()));
    const billplz = document.querySelector('[data-capability="pay-online-billplz"]') as HTMLElement;
    expect(within(billplz).getByText("Requires an external integration")).toBeTruthy();
    const needs = billplz.querySelector("[data-availability]")!.textContent!;
    expect(needs).toContain("Needs Billplz.");
    expect(needs).not.toMatch(/verified|checked against/i);
  });

  it("shows the topic for a capability the playbook explains, read when it is first opened", async () => {
    fetchMock.mockImplementation(async () => json({ venueId: 3, role: "manager", topic: buildTopic("peak-dated", profile(), "manager"), guide: null }));
    show(setupView(coachingVenue()));
    const row = document.querySelector('[data-capability="peak-pricing"]') as HTMLElement;
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => within(row).getByRole("button", { name: "How it works" }).click());
    expect(await within(row).findByText(/Rates in force today run from RM18 to RM28 an hour/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/guide/topic?venueId=3&id=peak-dated");
  });
});

describe("the discover view in the guide's tab", () => {
  const venues = [{ id: 3, name: "Court House", courts: [] }] as never;

  it("is shown a manager, starts a targeted setup journey from a suggestion, and dismisses one through the existing route", async () => {
    window.history.replaceState(null, "", "/admin?tab=guide&view=discover");
    const view = setupView(coachingVenue());
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({ venueId: 3, action: "dismiss", id: "coaching" });
        return json(setupView(coachingVenue(), { coaching: { at: "x" } }));
      }
      if (String(url).includes("/guide/setup/journey")) return json({ error: "Not for this test." }, 500);
      return json(view);
    });
    render(<GuideTab venues={venues} role="manager" onGo={() => undefined} />);
    expect(await screen.findByText("Discover what else MySenam can do")).toBeTruthy();
    const suggestion = await waitFor(() => {
      const el = document.querySelector('[data-suggestion="coaching"]') as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    });
    // Dismissing: the answer is the venue's view without it.
    await act(async () => within(suggestion).getByRole("button", { name: "Not for us" }).click());
    await waitFor(() => expect(document.querySelector('[data-suggestion="coaching"]')).toBeNull());
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true);
  });

  it("goes to the setup view narrowed to the capability, in the address, when Set this up is used", async () => {
    window.history.replaceState(null, "", "/admin?tab=guide&view=discover");
    const view = setupView(coachingVenue());
    fetchMock.mockImplementation(async (url: string) => (String(url).includes("/guide/setup/journey") ? json({ error: "Not for this test." }, 500) : json(view)));
    render(<GuideTab venues={venues} role="manager" onGo={() => undefined} />);
    const suggestion = await waitFor(() => {
      const el = document.querySelector('[data-suggestion="coaching"]') as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    });
    await act(async () => within(suggestion).getByRole("link", { name: "Set this up" }).click());
    const search = new URLSearchParams(window.location.search);
    expect(search.get("view")).toBe("setup");
    expect(search.get("focus")).toBe("coaching");
    await waitFor(() => expect(document.querySelector("[data-guide-view='setup']")).toBeTruthy());
    expect(document.querySelector("[data-discover]")).toBeNull();
  });

  it("is not the front desk's: no discover view, no request for the venue's setup", async () => {
    window.history.replaceState(null, "", "/admin?tab=guide&view=discover");
    fetchMock.mockImplementation(async (url: string) => (String(url).includes("/guide/playbook") ? json({ venueId: 3, role: "desk", ownRole: "desk", roles: ["desk"], playbook: buildPlaybook(profile(), "desk", { venueName: "Court House" }) }) : json({ error: "no" }, 403)));
    render(<GuideTab venues={venues} role="desk" onGo={() => undefined} />);
    await waitFor(() => expect(document.querySelector("[data-playbook-print]")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Discover" })).toBeNull();
    expect(document.querySelector("[data-discover]")).toBeNull();
    expect(fetchMock.mock.calls.every((c) => !String(c[0]).includes("/guide/setup"))).toBe(true);
  });
});
