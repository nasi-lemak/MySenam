// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { PlaybookDocument } from "../../src/components/admin/guide/PlaybookDocument";
import { PlaybookView } from "../../src/components/admin/guide/PlaybookView";
import { GuideTab } from "../../src/components/admin/guide/GuideTab";
import { buildPlaybook } from "../../src/lib/guide/playbook";
import type { GuideLink } from "../../src/lib/guide/playbook/types";
import { emptyProfile, type VenueProfile } from "../../src/lib/guide/profile-types";

/**
 * The playbook as a document: its table of contents, its search, its
 * collapsible sections, the links that open a dashboard screen, the role
 * preview, and the print view (docs/features/venue-guide.md, "The operating
 * playbook").
 */

function venue(): VenueProfile {
  const p = emptyProfile(3);
  p.today = "2026-10-31";
  p.identity.live = true;
  p.identity.draft = false;
  p.resources.total = 4;
  p.activities = [{ key: "badminton", support: "full", own: false }];
  p.rates.lowest = 18;
  p.rates.highest = 28;
  p.rates.peakPricing = true;
  p.payments.counterMethods = ["cash"];
  p.history.bookings = 20;
  p.people.coaches = 2;
  p.people.coachesWithHours = 2;
  return p;
}

const manager = buildPlaybook(venue(), "manager", { venueName: "Court House" });
const desk = buildPlaybook(venue(), "desk", { venueName: "Court House" });
const coach = buildPlaybook(venue(), "coach", { venueName: "Court House", coach: { lessonsAhead: 2, hoursSet: true, timeOff: 0 } });

const sectionButton = (name: RegExp | string) => screen.getByRole("button", { name });

describe("the playbook document", () => {
  it("has a table of contents with a link to every section, and opening one shows it", async () => {
    render(<PlaybookDocument playbook={manager} onGo={() => undefined} />);
    const toc = screen.getByRole("navigation", { name: "Contents" });
    const links = within(toc).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(expect.arrayContaining(manager.sections.map((s) => `#gp-${s.id}`)));
    // Only the first section is open to begin with.
    expect(document.querySelector("#gp-body-start")!.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector("#gp-body-cancel")!.hasAttribute("hidden")).toBe(true);
    expect(sectionButton(/^Cancellations and refunds/).getAttribute("aria-expanded")).toBe("false");
    await act(async () => within(toc).getByRole("link", { name: "Cancellations and refunds" }).click());
    expect(sectionButton(/^Cancellations and refunds/).getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("#gp-body-cancel")!.hasAttribute("hidden")).toBe(false);
    // The quick-reference cards are listed under their section, each a link to its card.
    const cards = within(toc).getByRole("link", { name: "Create a booking" });
    expect(cards.getAttribute("href")).toBe("#card-create");
    await act(async () => cards.click());
    expect(sectionButton(/^Quick reference cards/).getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("card-create")).not.toBeNull();
  });

  it("folds and unfolds a section from its own heading, by keyboard as well as the mouse, and all at once", async () => {
    render(<PlaybookDocument playbook={manager} onGo={() => undefined} />);
    const header = sectionButton(/^Before opening/);
    expect(header.tagName).toBe("BUTTON");
    expect(header.getAttribute("aria-controls")).toBe("gp-body-before");
    header.focus();
    fireEvent.keyDown(header, { key: "Enter" });
    await act(async () => header.click());
    expect(header.getAttribute("aria-expanded")).toBe("true");
    await act(async () => header.click());
    expect(header.getAttribute("aria-expanded")).toBe("false");
    await act(async () => screen.getByRole("button", { name: "Open every section" }).click());
    for (const s of manager.sections) expect(document.querySelector(`#gp-body-${s.id}`)!.hasAttribute("hidden"), s.id).toBe(false);
    await act(async () => screen.getByRole("button", { name: "Close every section" }).click());
    expect(document.querySelector("#gp-body-start")!.hasAttribute("hidden")).toBe(true);
  });

  it("searches the text already loaded: it shows only what matches, opens it, says how many, and says when nothing does", async () => {
    render(<PlaybookDocument playbook={manager} onGo={() => undefined} />);
    const box = screen.getByRole("searchbox", { name: "Search this guide" });
    await act(async () => fireEvent.change(box, { target: { value: "cash-up" } }));
    const status = screen.getByRole("status");
    expect(status.textContent).toMatch(/^\d+ matching topics$/);
    const eod = document.querySelector("#gp-body-eod")!;
    expect(eod.hasAttribute("hidden")).toBe(false);
    expect(within(eod as HTMLElement).getByText("Cash-up", { selector: "h3" })).toBeTruthy();
    // A section with no match is not shown at all.
    expect(document.querySelector("#gp-before")).toBeNull();
    await act(async () => fireEvent.change(box, { target: { value: "quantum" } }));
    expect(screen.getByRole("status").textContent).toBe("Nothing in this guide matches that.");
    expect(document.querySelectorAll("[data-section]").length).toBe(0);
    await act(async () => screen.getByRole("button", { name: "Clear search" }).click());
    expect(document.querySelectorAll("[data-section]").length).toBe(manager.sections.length);
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    // Several words must all be there.
    await act(async () => fireEvent.change(box, { target: { value: "cutoff refund" } }));
    expect(Number(/^(\d+)/.exec(screen.getByRole("status").textContent!)![1])).toBeGreaterThan(0);
  });

  it("draws steps as a numbered list, a callout with a word as well as a colour, and a table with column headings", async () => {
    render(<PlaybookDocument playbook={manager} onGo={() => undefined} />);
    await act(async () => screen.getByRole("button", { name: "Open every section" }).click());
    const steps = document.querySelector("#gp-body-before ol")!;
    expect(steps.tagName).toBe("OL");
    expect(steps.querySelectorAll("li").length).toBeGreaterThan(3);
    const policy = document.querySelector('[data-callout="policy"]') as HTMLElement;
    expect(policy.getAttribute("role")).toBe("note");
    expect(policy.textContent).toMatch(/^Your venue's policy/);
    const table = document.querySelector("#gp-body-booking table")!;
    expect(within(table as HTMLElement).getAllByRole("columnheader").length).toBe(2);
  });

  it("shows the venue's name and what it is, and a 'Coming later' callout labelled with words", async () => {
    const p = venue();
    p.hours.scheduled = [{ from: "2026-12-01", openMin: 435, closeMin: 1320 }];
    const book = buildPlaybook(p, "manager", { venueName: "Court House" });
    render(<PlaybookDocument playbook={book} onGo={() => undefined} />);
    expect(screen.getAllByText("Court House").length).toBeGreaterThan(0);
    expect(document.querySelector("[data-summary]")!.textContent).toContain("Your venue has 4 bookable resources, offering Badminton.");
    const callout = document.querySelector('[data-callout="scheduled"]') as HTMLElement;
    expect(callout.textContent).toMatch(/^Coming later: Coming on /);
    expect(callout.textContent).toContain("7:15 AM");
  });
});

describe("links to the dashboard's screens", () => {
  it("open the screen they name, as buttons with a name, for a manager", async () => {
    const onGo = vi.fn<(link: GuideLink) => void>();
    render(<PlaybookDocument playbook={manager} onGo={onGo} />);
    const first = document.querySelector('[data-link-tab="bookings"]') as HTMLElement;
    expect(first.tagName).toBe("BUTTON");
    expect(first.textContent).toBe("Open Bookings");
    await act(async () => first.click());
    expect(onGo).toHaveBeenCalledWith(expect.objectContaining({ tab: "bookings" }));
    for (const tab of ["reports", "courts", "venues"]) expect(document.querySelector(`[data-link-tab="${tab}"]`), tab).not.toBeNull();
  });

  it("are never drawn for the desk where it may not use them, and never where there is no dashboard", async () => {
    const { unmount } = render(<PlaybookDocument playbook={desk} onGo={() => undefined} />);
    for (const tab of ["reports", "courts", "venues"]) expect(document.querySelector(`[data-link-tab="${tab}"]`), tab).toBeNull();
    expect(document.querySelector('[data-link-tab="bookings"]')).not.toBeNull();
    unmount();
    render(<PlaybookDocument playbook={manager} />);
    expect(document.querySelectorAll("[data-link-tab]").length).toBe(0);
  });
});

describe("the role preview", () => {
  it("is offered where a role may see another's, says which guide it is looking at, and hands the choice back", async () => {
    const onViewAs = vi.fn();
    const { rerender } = render(<PlaybookDocument playbook={manager} ownRole="manager" roles={["manager", "desk", "coach"]} onViewAs={onViewAs} onGo={() => undefined} />);
    const select = screen.getByRole("combobox", { name: "View as" }) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["Manager", "Front desk", "Coach"]);
    expect(document.querySelector("[data-preview]")).toBeNull();
    await act(async () => fireEvent.change(select, { target: { value: "desk" } }));
    expect(onViewAs).toHaveBeenCalledWith("desk");
    rerender(<PlaybookDocument playbook={desk} ownRole="manager" roles={["manager", "desk", "coach"]} onViewAs={onViewAs} onGo={() => undefined} />);
    const note = document.querySelector("[data-preview]") as HTMLElement;
    expect(note.textContent).toContain("Guide for: Front desk.");
    expect(note.textContent).toContain("Use it to train them, and print it.");
    // A desk with nothing below but the coach's preview; a coach with no preview at all.
    rerender(<PlaybookDocument playbook={coach} ownRole="coach" />);
    expect(screen.queryByRole("combobox", { name: "View as" })).toBeNull();
  });
});

describe("printing", () => {
  it("prints the guide alone, on A4, open, with the venue's name and the date, and hides the controls and links", async () => {
    render(<PlaybookDocument playbook={manager} onGo={() => undefined} />);
    const root = document.querySelector("[data-playbook-print]") as HTMLElement;
    expect(root).not.toBeNull();
    const css = root.querySelector("style")!.textContent!;
    expect(css).toContain("@media print");
    expect(css).toContain("size: A4");
    expect(css).toContain("body * { visibility: hidden; }");
    expect(css).toContain("[data-section-body][hidden]");
    expect(css).toContain("break-inside: avoid");
    // The controls, the contents and every link are hidden on paper; the printed heading is only on paper.
    expect(screen.getByRole("button", { name: "Print this guide" }).className).toContain("print:hidden");
    expect(root.querySelector(".playbook-controls")).not.toBeNull();
    expect(root.querySelector("nav")!.className).toContain("print:hidden");
    expect((document.querySelector("[data-link-tab]") as HTMLElement).className).toContain("print:hidden");
    const paper = root.querySelector(".print\\:block") as HTMLElement;
    expect(paper.textContent).toContain("Court House");
    expect(paper.textContent).toContain("Printed on 2026-10-31 from the current settings.");
    expect(paper.textContent).toContain("Guide for: Manager");
    // Printing asks the browser, and stores nothing.
    const print = vi.fn();
    vi.stubGlobal("print", print);
    await act(async () => screen.getByRole("button", { name: "Print this guide" }).click());
    expect(print).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("the dashboard's view of it", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const json = (body: unknown, ok = true, status = 200) => ({ ok, status, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) });

  beforeEach(() => {
    window.history.replaceState(null, "", "/admin?tab=guide&view=playbook");
    fetchMock = vi.fn(async (url: string) => {
      const as = /as=(\w+)/.exec(url)?.[1] ?? "manager";
      const playbook = as === "desk" ? desk : manager;
      return json({ venueId: 3, role: as, ownRole: "manager", roles: ["manager", "desk", "coach"], playbook });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reads the playbook from its route, draws it, and reads it again for the role chosen", async () => {
    render(<PlaybookView venueId={3} onGo={() => undefined} />);
    expect(await screen.findByRole("navigation", { name: "Contents" })).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/guide/playbook?venueId=3");
    await act(async () => fireEvent.change(screen.getByRole("combobox", { name: "View as" }), { target: { value: "desk" } }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("&as=desk"))).toBe(true));
    await waitFor(() => expect(document.querySelector("[data-preview]")).not.toBeNull());
    expect(document.querySelector('[data-link-tab="reports"]')).toBeNull();
  });

  it("opens a screen when its link is chosen, and the guide's own views by their view", async () => {
    const onGo = vi.fn();
    const onView = vi.fn();
    const p = venue();
    p.identity.draft = true;
    p.identity.live = false;
    const draftBook = buildPlaybook(p, "manager", { venueName: "Court House" });
    fetchMock.mockImplementation(async () => json({ venueId: 3, role: "manager", ownRole: "manager", roles: ["manager"], playbook: draftBook }));
    render(<PlaybookView venueId={3} onGo={onGo} onView={onView} />);
    await screen.findByRole("navigation", { name: "Contents" });
    await act(async () => (document.querySelector('[data-link-tab="bookings"]') as HTMLElement).click());
    expect(onGo).toHaveBeenCalledWith("bookings");
    await act(async () => (document.querySelector('[data-link-tab="guide"]') as HTMLElement).click());
    expect(onView).toHaveBeenCalledWith("setup");
  });

  it("says when the guide cannot be read", async () => {
    fetchMock.mockImplementation(async () => json({ error: "You can see the guide only for your own role or one below it." }, false, 403));
    render(<PlaybookView venueId={3} onGo={() => undefined} />);
    expect((await screen.findByRole("alert")).textContent).toContain("only for your own role");
  });
});

describe("in the guide tab", () => {
  it("is the desk's only view, and shows what the route sent, with no placeholder", async () => {
    window.history.replaceState(null, "", "/admin?tab=guide");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ venueId: 3, role: "desk", ownRole: "desk", roles: ["desk", "coach"], playbook: desk }), text: async () => "" }))
    );
    render(<GuideTab venues={[{ id: 3, name: "Court House", courts: [] }] as never} role="desk" onGo={() => undefined} />);
    expect(await screen.findByRole("navigation", { name: "Contents" })).toBeTruthy();
    expect(document.querySelector("[data-placeholder]")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Guide sections" }).querySelectorAll("button").length).toBe(1);
    vi.unstubAllGlobals();
  });
});
