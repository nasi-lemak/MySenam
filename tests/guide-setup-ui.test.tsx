// @vitest-environment jsdom
/// <reference types="vite/client" />
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_MARKETPLACE = "on";
process.env.MYSENAM_GEOCODER = "off";
for (const name of ["SMTP_URL", "MAIL_FROM", "SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "SES_REGION", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]) delete process.env[name];

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { SetupPlanView } from "../src/components/admin/guide/SetupPlanView";
import { buildSetupPlan } from "../src/lib/guide/plan";
import { emptyProfile } from "../src/lib/guide/profile-types";
import { emptyAnswers, type GuideAnswers } from "../src/lib/guide/answer-schema";
import { launchReadiness } from "../src/lib/guide/readiness";
import { discover } from "../src/lib/guide/discover";
import type { SetupView } from "../src/lib/guide/http";
import type { JourneyView } from "../src/lib/guide/setup-journey";

/**
 * The setup journey on screen: the questions one at a time (conditional,
 * saved with the revision, a stale save keeping the entry, backtracking losing
 * nothing), the plan (counts not a percentage, a card for each step saying why
 * it is shown and what it proposes, the consequence before a financial
 * choice), a phone-width structure with a collapsing step list and focus that
 * moves with the step, and, over the real routes and a real database, the
 * actions the cards run changing real state or being refused in the
 * application's own words.
 */

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) });

function viewOf(over: { answers?: GuideAnswers; rev?: number; mutate?: (p: ReturnType<typeof emptyProfile>) => void; role?: "manager" | "desk"; focus?: string } = {}): JourneyView {
  const profile = emptyProfile(3);
  over.mutate?.(profile);
  const answers = over.answers ?? emptyAnswers();
  const plan = buildSetupPlan({ profile, answers, acknowledged: {}, role: over.role ?? "manager", ...(over.focus ? { focus: over.focus } : {}) });
  return {
    venueId: 3,
    role: over.role ?? "manager",
    profile,
    answers,
    rev: over.rev ?? 0,
    acknowledged: {},
    dismissed: {},
    plan,
    readiness: launchReadiness(profile, plan),
    discoveries: discover(profile, answers),
    extras: {
      focus: over.focus ?? null,
      venue: { openMin: 480, closeMin: 1380, weekHours: null, cancelCutoffHours: 24, timeZone: "Asia/Kuala_Lumpur" },
      courts: [],
      prices: [],
      tryIt: { live: false, made: 0, standing: 0, cancelled: 0, counterPaid: 0, emailService: false, publicPath: "/venue/3" },
    },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
let served: JourneyView;
beforeEach(() => {
  window.history.replaceState(null, "", "/admin?tab=guide&view=setup");
  window.sessionStorage.clear();
  served = viewOf();
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return json(served);
    return json(served);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const renderJourney = (view: JourneyView = served, onGo = vi.fn()) => {
  served = view;
  const { extras: _extras, ...data } = view;
  return { onGo, ...render(<SetupPlanView data={data as SetupView} onGo={onGo} />) };
};

const step = async (id: string): Promise<HTMLElement> => {
  await waitFor(() => expect(document.querySelector(`[data-step="${id}"]`)).not.toBeNull());
  return document.querySelector(`[data-step="${id}"]`) as HTMLElement;
};

describe("the questions", () => {
  it("open a first visit to an empty venue, one at a time, and count only what will be asked", async () => {
    renderJourney(viewOf({ rev: 0 }));
    expect(document.querySelector("[data-stage='questions']")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "What kind of venue do you run?" })).toBeTruthy();
    expect(screen.getByText(/^Question 1 of \d+$/)).toBeTruthy();
    // The question has a group of named choices, not a bare list of boxes.
    const group = screen.getAllByRole("group")[0];
    expect(within(group).getAllByRole("checkbox").length).toBeGreaterThan(10);
    expect(within(group).getByLabelText("Badminton and pickleball centre")).toBeTruthy();
  });

  it("save each answer on the revision it was given on, move on, and keep the answer when going back", async () => {
    renderJourney(viewOf({ rev: 0 }));
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return json(served);
      const body = JSON.parse(init.body as string);
      served = viewOf({ rev: body.rev + 1, answers: { v: 1, ...body.answers } });
      return json(served);
    });
    fireEvent.click(screen.getByLabelText("Badminton and pickleball centre"));
    await act(async () => screen.getByRole("button", { name: "Save and continue" }).click());
    const post = fetchMock.mock.calls.find((c) => c[1]?.method === "POST")!;
    expect(JSON.parse(post[1].body as string)).toMatchObject({ venueId: 3, action: "answers", rev: 0, answers: { types: ["badminton-and-pickleball"] } });
    expect(await screen.findByRole("heading", { name: "Which activities will you offer?" })).toBeTruthy();
    // Back: the first question is as it was left.
    await act(async () => screen.getByRole("button", { name: "Back" }).click());
    expect(await screen.findByRole("heading", { name: "What kind of venue do you run?" })).toBeTruthy();
    expect((screen.getByLabelText("Badminton and pickleball centre") as HTMLInputElement).checked).toBe(true);
  });

  it("move focus to the new question's heading, so a screen reader says where it is", async () => {
    renderJourney(viewOf({ rev: 0 }));
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return json(served);
      const body = JSON.parse(init.body as string);
      served = viewOf({ rev: body.rev + 1, answers: { v: 1, ...body.answers } });
      return json(served);
    });
    await act(async () => screen.getByRole("button", { name: "Not sure: skip" }).click());
    const heading = await screen.findByRole("heading", { name: "Which activities will you offer?" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("refuse a stale save, show the answers now saved, and keep what was entered so it can be saved again", async () => {
    // The first question not answered yet is how many facilities there are: a single choice.
    window.history.replaceState(null, "", "/admin?tab=guide&view=setup&stage=questions");
    renderJourney(viewOf({ rev: 2, answers: { v: 1, types: ["swimming"], activities: ["swimming"], customersDo: ["reserve"] } }));
    const newer = viewOf({ rev: 3, answers: { v: 1, types: ["swimming"], activities: ["swimming"], customersDo: ["reserve"], coaching: true } });
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === "POST" ? json({ error: "Somebody saved the guide's answers since you opened them.", stale: true, ...newer }, 409) : json(served)));
    expect(await screen.findByRole("heading", { name: "How many courts, rooms or other facilities do you have?" })).toBeTruthy();
    const first = screen.getByLabelText("Two to six") as HTMLInputElement;
    fireEvent.click(first);
    expect(first.checked).toBe(true);
    await act(async () => screen.getByRole("button", { name: /Save and (continue|finish)/ }).click());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Somebody saved answers since you opened this");
    // What was ticked is still ticked, and the next save goes on the newer revision.
    expect((screen.getByLabelText("Two to six") as HTMLInputElement).checked).toBe(true);
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return json(newer);
      served = newer;
      return json(newer);
    });
    await act(async () => screen.getByRole("button", { name: /Save and (continue|finish)/ }).click());
    const retry = fetchMock.mock.calls.filter((c) => c[1]?.method === "POST").at(-1)!;
    expect(JSON.parse(retry[1].body as string).rev).toBe(3);
  });

  it("do not ask what the saved settings already show, and say so as a fact from the settings", async () => {
    renderJourney(
      viewOf({
        rev: 1,
        mutate: (p) => {
          p.resources.total = 6;
          p.activities = [{ key: "badminton", support: "full", own: false }];
          p.people.coaches = 2;
        },
        answers: { v: 1, types: ["coaching-academy"] },
      })
    );
    window.history.replaceState(null, "", "/admin?tab=guide&view=setup&stage=questions");
    // Re-render at the questions stage.
    document.body.innerHTML = "";
    renderJourney(
      viewOf({
        rev: 1,
        mutate: (p) => {
          p.resources.total = 6;
          p.activities = [{ key: "badminton", support: "full", own: false }];
          p.people.coaches = 2;
        },
        answers: { v: 1, types: ["coaching-academy"] },
      })
    );
    const known = await screen.findByText(/things we already know from your settings/);
    fireEvent.click(known);
    expect(document.querySelector("[data-fact='resources']")!.textContent).toContain("You already have 6 courts or other facilities.");
    expect(document.querySelector("[data-fact='coaching']")!.textContent).toContain("from your settings");
    expect(document.querySelector("[data-question='resources']")).toBeNull();
    expect(document.querySelector("[data-question='coaching']")).toBeNull();
  });

  it("show an activity's limitation as the catalogue says it, and an archery range none: its rostered range officer is built", async () => {
    renderJourney(viewOf({ rev: 1, answers: { v: 1, types: ["archery-and-supervised"] } }));
    window.history.replaceState(null, "", "/admin?tab=guide&view=setup&stage=questions");
    document.body.innerHTML = "";
    renderJourney(viewOf({ rev: 1, answers: { v: 1, types: ["archery-and-supervised"] } }));
    expect(await screen.findByRole("heading", { name: "Which activities will you offer?" })).toBeTruthy();
    const kayak = screen.getByLabelText(/Kayak/).closest("label")!;
    expect(kayak.textContent).toContain("Limitation");
    expect(kayak.textContent).toContain("Not built: choosing a kind within one fleet");
    const archery = screen.getByLabelText(/Archery/).closest("label")!;
    expect(archery.textContent).not.toContain("Limitation");
    expect(archery.textContent).not.toContain("range officer");
  });
});

describe("the plan", () => {
  it("says how many required steps are done as a count, never a percentage", async () => {
    renderJourney(viewOf({ rev: 3, mutate: (p) => (p.setup.courts = 2) }));
    await step("courts");
    const progress = document.querySelector("[data-progress]")!;
    expect(progress.textContent).toContain("1 of 3 required steps done");
    expect(progress.textContent).not.toContain("%");
  });

  it("gives each step a card: why it is shown, its state in words, what it proposes, and the consequence before a financial choice", async () => {
    renderJourney(viewOf({ rev: 3, answers: { v: 1, resources: "few", activities: ["badminton"] } }));
    const courts = await step("courts");
    expect(within(courts).getByRole("heading", { name: "Add your courts or other resources" })).toBeTruthy();
    expect(within(courts).getByText("To do")).toBeTruthy();
    expect(within(courts).getByText("Needed before going live")).toBeTruthy();
    expect(within(courts).getByText(/Why you see this/)).toBeTruthy();
    // A recommendation is typed, and says it is not saved.
    expect(within(courts).getByText("Recommendation")).toBeTruthy();
    expect(courts.querySelector("[data-recommendation]")!.textContent).toContain("nothing changes until you save it yourself");
    expect(courts.querySelector("[data-platform-rule]")!.textContent).toContain("never lets two bookings take the same court at the same time");
    // The longer explanation is folded away, and there.
    const more = courts.querySelector("details")!;
    expect(more.open).toBe(false);
    expect(more.textContent).toContain("Pick an activity");
    // Financial choices say what saving will do, as the application does it.
    const prices = await step("prices");
    expect(prices.querySelector("[data-consequence]")!.textContent).toContain("Bookings already made keep the price they were sold at");
    const cancel = await step("cancellation-terms");
    expect(cancel.querySelector("[data-consequence]")!.textContent).toContain("If customers cancel within the cutoff");
  });

  it("says a done step is a saved setting, a blocked one what it waits for, and a reviewed one when and by whom", async () => {
    renderJourney(viewOf({ rev: 3, mutate: (p) => (p.setup.courts = 2) }));
    const courts = await step("courts");
    expect(within(courts).getByText("Done")).toBeTruthy();
    expect(within(courts).getByText("Saved setting")).toBeTruthy();
    const empty = viewOf({ rev: 3 });
    served = empty;
    document.body.innerHTML = "";
    renderJourney(empty);
    const prices = await step("prices");
    expect(within(prices).getByText("Waiting on another step")).toBeTruthy();
    expect(prices.textContent).toContain("Add your courts or other resources");
  });

  it("marks the step the journey is on, moves focus to its heading when it is chosen from the list, and keeps it in the address", async () => {
    renderJourney(viewOf({ rev: 3 }));
    await step("courts");
    const nav = screen.getByRole("navigation", { name: "Setup steps" });
    const item = within(nav).getByRole("button", { name: /Add your courts or other resources/ });
    await act(async () => item.click());
    const card = document.querySelector('[data-step="courts"]')!;
    expect(card.getAttribute("aria-current")).toBe("step");
    expect(item.getAttribute("aria-current")).toBe("step");
    await waitFor(() => expect(document.activeElement).toBe(card.querySelector("h5")));
    expect(window.location.search).toContain("step=courts");
  });

  it("collapses its step list on a phone, behind a button that says whether it is open", async () => {
    window.innerWidth = 360;
    renderJourney(viewOf({ rev: 3 }));
    await step("courts");
    const nav = screen.getByRole("navigation", { name: "Setup steps" });
    const toggle = within(nav).getByRole("button", { name: /^Steps \(\d+\)$/ });
    expect(toggle.className).toContain("md:hidden");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const list = nav.querySelector("ol")!;
    expect(list.className).toContain("hidden");
    expect(list.className).toContain("md:block");
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(list.className).not.toMatch(/(^| )hidden( |$)/);
  });

  it("gives every control of its own a target of at least 24 px and a name, and puts nothing wider than the page in one column", async () => {
    renderJourney(viewOf({ rev: 3 }));
    await step("courts");
    for (const button of Array.from(document.querySelectorAll("[data-guide-setup] button"))) {
      expect(button.className, button.textContent ?? "").toMatch(/min-h-(8|9|10|11|12)\b/);
      expect((button.textContent ?? "").trim() || button.getAttribute("aria-label"), "a button with no name").toBeTruthy();
    }
    expect(document.querySelector("[data-guide-setup]")!.className).toContain("space-y-4");
  });

  it("never shows a link to a screen the role may not use, and says a manager changes it", async () => {
    renderJourney(viewOf({ rev: 3, role: "desk" }));
    const courts = await step("courts");
    expect(within(courts).queryByRole("button", { name: /Open/ })).toBeNull();
    expect(within(courts).queryByRole("button", { name: "Do it here" })).toBeNull();
    expect(within(courts).getByText("A manager changes this.")).toBeTruthy();
  });

  it("leaves a launch step that holds the readiness summary: six kinds of thing, each item with why and where to fix it", async () => {
    renderJourney(viewOf({ rev: 3 }));
    const launch = await step("launch");
    const groups = Array.from(launch.querySelectorAll("[data-ready-group]")).map((g) => g.getAttribute("data-ready-group"));
    expect(groups).toEqual(["requiredMissing", "unverifiedExternal", "legalPrerequisite", "featureSpecific", "optionalEnhancements", "configurationComplete"]);
    const missing = launch.querySelector("[data-ready-group='requiredMissing']")!;
    expect(missing.querySelectorAll("[data-ready-item]").length).toBeGreaterThan(0);
    // Without a score of any kind.
    expect(launch.textContent).not.toMatch(/\d+ ?%/);
  });

  it("tells a live venue it is live and never encourages a pretend booking there", async () => {
    const live = viewOf({ rev: 3, mutate: (p) => ((p.identity.live = true), (p.identity.draft = false), (p.history.bookings = 12), (p.setup.courts = 3)) });
    live.extras.tryIt.live = true;
    renderJourney(live);
    const test = await step("test-booking");
    expect(test.querySelector("[data-tryit]")!.textContent).toContain("Your venue is live");
    expect(test.querySelector("[data-tryit]")!.textContent).toContain("do not make pretend bookings");
    expect(within(test.querySelector("[data-tryit]") as HTMLElement).queryByText("Make a test booking as a customer")).toBeNull();
  });

  it("ticks Try it only from saved state and says plainly what MySenam cannot check", async () => {
    const view = viewOf({ rev: 3, mutate: (p) => ((p.setup.courts = 2), (p.setup.testBooking = true), (p.install.emailTransport = true), (p.payments.online.accountExists = true), (p.payments.online.accountEnabled = true)) });
    view.extras.tryIt = { live: false, made: 1, standing: 1, cancelled: 0, counterPaid: 0, emailService: true, publicPath: "/venue/3" };
    view.extras.prices = [{ courtId: 1, court: "Court 1", sport: "badminton", date: "2026-11-07", startMin: 1200, minutes: 60, total: 28, peak: true }];
    renderJourney(view);
    const test = await step("test-booking");
    const mark = (id: string) => test.querySelector(`[data-try='${id}']`)!.getAttribute("data-mark");
    expect(mark("customer")).toBe("done");
    expect(mark("schedule")).toBe("done");
    expect(mark("cancel")).toBe("todo");
    expect(mark("counter")).toBe("todo");
    for (const id of ["price", "change", "messages"]) expect(mark(id), id).toBe("unchecked");
    expect(test.querySelector("[data-try='price']")!.textContent).toContain("costs RM");
    expect(test.querySelector("[data-try='price']")!.textContent).toContain("(peak rate)");
    expect(within(test.querySelector("[data-try='messages']") as HTMLElement).getByText("Not checked by MySenam")).toBeTruthy();
    // A connected provider with no real payment is not called verified, and the stand-in is named.
    expect(test.querySelector("[data-try='online']")!.textContent).toContain("stand-in payment service");
    expect(mark("online")).toBe("unchecked");
  });
});

describe("a venue with bookings", () => {
  it("is told the guide reviews and adds and changes nothing unless it saves in the screen itself, and starts a targeted journey from one thing", async () => {
    const established = viewOf({ rev: 3, mutate: (p) => ((p.history.bookings = 40), (p.history.paidBookings = 30), (p.setup.courts = 5), (p.setup.detailsChecked = true), (p.setup.testBooking = true)) });
    renderJourney(established);
    await step("courts");
    expect(document.querySelector("[data-history-banner]")!.textContent).toBe("Your venue already has bookings: this guide reviews and adds, and never changes a saved setting unless you save one in its own screen.");
    expect((await step("courts")).getAttribute("data-state")).toBe("done");
    const entry = screen.getByRole("button", { name: "Invite staff" });
    served = viewOf({ rev: 3, focus: "staff-invitations", mutate: (p) => ((p.history.bookings = 40), (p.history.paidBookings = 30), (p.setup.courts = 5)) });
    await act(async () => entry.click());
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("focus=staff-invitations"))).toBe(true));
    expect(window.location.search).toContain("focus=staff-invitations");
    expect(await screen.findByText(/You are looking at one part of the setup/)).toBeTruthy();
    expect(document.querySelectorAll("[data-step]").length).toBe(1);
    // Back to the whole plan.
    served = established;
    await act(async () => screen.getByRole("button", { name: "Show the whole plan" }).click());
    await waitFor(() => expect(document.querySelector("[data-focus]")).toBeNull());
    expect(window.location.search).not.toContain("focus=");
  });

  it("offers a review of the business to a venue that has already answered, with its answers in place", async () => {
    renderJourney(viewOf({ rev: 5, answers: { v: 1, types: ["swimming"], coaching: true } }));
    await step("courts");
    await act(async () => screen.getByRole("button", { name: "Review my business" }).click());
    expect(document.querySelector("[data-stage='questions']")).not.toBeNull();
    expect(window.location.search).toContain("stage=questions");
  });
});

describe("going to another screen and coming back", () => {
  it("opens the screen a step names, keeping the step in the address so the guide tab returns to it", async () => {
    const view = viewOf({ rev: 3, answers: { v: 1, coaching: true } });
    const { onGo } = renderJourney(view);
    const coaches = await step("coaches");
    await act(async () => within(coaches).getByRole("button", { name: /Open Classes/ }).click());
    expect(onGo).toHaveBeenCalledWith("classes");
    expect(window.location.search).toContain("step=coaches");
  });
});

// ---------------------------------------------------------------------------------------------------
// The actions, over the real routes and a real database.

describe("the actions a card runs, against the real routes", () => {
  const files = import.meta.glob("../src/app/api/**/route.ts");
  const table = Object.entries(files).map(([file, load]) => {
    const names: string[] = [];
    const path = file.replace("../src/app", "").replace("/route.ts", "");
    const re = new RegExp(`^${path.replace(/\[([^\]]+)\]/g, (_m, n: string) => (names.push(n), "([^/]+)"))}$`);
    return { re, names, load };
  });

  let venueId: number;
  let cookie: string;
  let loadView: () => Promise<JourneyView>;
  let db: typeof import("../src/lib/db");
  let store: typeof import("../src/lib/store");

  /** `fetch`, answered by the application's own route handlers with this manager's session. */
  const bridge = async (input: unknown, init?: RequestInit) => {
    const { NextRequest } = await import("next/server");
    const url = new URL(String(input), "http://localhost");
    const route = table.find((r) => r.re.test(url.pathname));
    if (!route) return json({ error: "no such route" }, 404);
    const params = Object.fromEntries(route.names.map((n, i) => [n, url.pathname.match(route.re)![i + 1]]));
    const method = init?.method ?? "GET";
    const mod = (await route.load()) as Record<string, (req: unknown, ctx: unknown) => Promise<Response>>;
    const request = new NextRequest(url, { method, headers: { cookie, "content-type": "application/json" }, ...(init?.body ? { body: init.body as string } : {}) });
    return mod[method](request, { params: Promise.resolve(params) });
  };

  beforeAll(async () => {
    const admin = await import("../src/lib/admin-auth");
    const apps = await import("../src/lib/applications");
    store = await import("../src/lib/store");
    db = await import("../src/lib/db");
    await admin.ensureBootstrapAdmin();
    const applied = await apps.submitApplication({ businessName: "UI Courts", area: "Ampang", address: "1 Jalan Satu, Ampang", venuePhone: "0342220000", contactName: "UI Owner", email: "ui@setup.my", password: "a long enough password", lat: 3.15, lng: 101.6 });
    if (!applied.ok) throw new Error(applied.error);
    venueId = applied.application.venueId!;
    const manager = (await admin.authenticateAdmin("ui@setup.my", "a long enough password"))!;
    cookie = `${admin.ADMIN_SESSION_COOKIE}=${(await admin.createAdminSession(manager.id)).token}`;
    const journey = await import("../src/lib/guide/setup-journey");
    loadView = () => journey.journeyView(venueId, "manager", null);
  });

  beforeEach(() => {
    fetchMock.mockImplementation(bridge as never);
  });

  async function open(id: string): Promise<HTMLElement> {
    const view = await loadView();
    const { extras: _extras, ...data } = view;
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/admin?tab=guide&view=setup&stage=plan");
    render(<SetupPlanView data={data as SetupView} onGo={() => undefined} />);
    const card = await step(id);
    // Wait for the real journey to be read, not the first paint.
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/guide/setup/journey"))).toBe(true));
    return card;
  }

  it("adds courts from an activity's template through the journey and they exist on the venue, and the step reads done", async () => {
    const card = await open("courts");
    expect(card.getAttribute("data-state")).toBe("todo");
    await act(async () => within(card).getByRole("button", { name: "Do it here" }).click());
    // The existing form, with its template for the activity chosen.
    const form = await waitFor(() => {
      const f = card.querySelector("form");
      expect(f).not.toBeNull();
      return f as HTMLFormElement;
    });
    fireEvent.change(within(form).getByLabelText("How many"), { target: { value: "3" } });
    fireEvent.change(within(form).getByLabelText(/^Off-peak/), { target: { value: "12" } });
    fireEvent.change(within(form).getByLabelText(/^Peak \(/), { target: { value: "20" } });
    await act(async () => fireEvent.submit(form));
    await waitFor(async () => expect((await store.getVenue(venueId))!.courts.length).toBe(3));
    const courts = (await store.getVenue(venueId))!.courts;
    expect(courts.map((c) => [c.offPeakRate, c.peakRate])).toEqual([
      [12, 20],
      [12, 20],
      [12, 20],
    ]);
    await waitFor(() => expect(document.querySelector('[data-step="courts"]')!.getAttribute("data-state")).toBe("done"));
  });

  it("saves the venue's hours through the venue route, which ticks the checklist, and shows the application's own refusal when a booking is in the way", async () => {
    const court = (await store.getVenue(venueId))!.courts[0];
    const date = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const held = await store.createBooking({ courtId: court.id, date, hours: [20], name: "Late Lee", phone: "0123450002" });
    if (!held.ok) throw new Error(held.error);
    const card = await open("details");
    expect(card.getAttribute("data-state")).toBe("todo");
    await act(async () => within(card).getByRole("button", { name: "Do it here" }).click());
    const closes = within(card).getAllByLabelText("Closes")[0] as HTMLInputElement;
    // Narrowing under the booking: refused, in the application's words, naming it; nothing saved.
    fireEvent.change(closes, { target: { value: "19:00" } });
    await act(async () => within(card).getByRole("button", { name: "Save" }).click());
    const refusal = await within(card).findByRole("alert");
    expect(refusal.textContent).toContain(held.booking.code);
    expect((await store.getVenue(venueId))!.closeMin).toBe(23 * 60);
    expect((await (await import("../src/lib/setup")).venueSetup(venueId)).detailsChecked).toBe(false);
    // Widening: saved, and the checklist's own step is ticked by the venue route.
    fireEvent.change(closes, { target: { value: "23:30" } });
    await act(async () => within(card).getByRole("button", { name: "Save" }).click());
    await waitFor(async () => expect((await store.getVenue(venueId))!.closeMin).toBe(23 * 60 + 30));
    expect((await (await import("../src/lib/setup")).venueSetup(venueId)).detailsChecked).toBe(true);
    await waitFor(() => expect(document.querySelector('[data-step="details"]')!.getAttribute("data-state")).toBe("done"));
  });

  it("changes a court's rate through the courts route and the example price follows it", async () => {
    const card = await open("prices");
    await act(async () => within(card).getByRole("button", { name: "Do it here" }).click());
    const court = (await store.getVenue(venueId))!.courts[0];
    // The courts arrive with the journey's own read, a moment after the first paint.
    const peak = (await within(card).findAllByLabelText(`Peak rate for ${court.name}`))[0] as HTMLInputElement;
    fireEvent.change(peak, { target: { value: "41" } });
    await act(async () => within(card).getAllByRole("button", { name: "Save" })[0].click());
    await waitFor(async () => expect((await store.getVenue(venueId))!.courts[0].peakRate).toBe(41));
    await waitFor(() => expect(card.querySelector("[data-price-example]")!.textContent).toContain("RM41"));
    // The application's own refusal for a rate it will not take.
    fireEvent.change(within(card).getAllByLabelText(`Peak rate for ${court.name}`)[0], { target: { value: "5000" } });
    await act(async () => within(card).getAllByRole("button", { name: "Save" })[0].click());
    expect((await within(card).findByRole("alert")).textContent).toMatch(/1000/);
    expect((await store.getVenue(venueId))!.courts[0].peakRate).toBe(41);
  });

  it("saves the cancellation cutoff through the venue route, shows the terms, and a review is the manager's own recorded act", async () => {
    const card = await open("cancellation-terms");
    expect(card.getAttribute("data-state")).toBe("review-needed");
    await act(async () => within(card).getByRole("button", { name: "Do it here" }).click());
    const cutoff = within(card).getAllByLabelText("Cancel cutoff (hrs)")[0] as HTMLInputElement;
    fireEvent.change(cutoff, { target: { value: "12" } });
    await act(async () => within(card).getAllByRole("button", { name: "Save" })[0].click());
    await waitFor(async () => expect((await store.getVenue(venueId))!.cancelCutoffHours).toBe(12));
    await waitFor(() => expect(card.querySelector("[data-terms]")!.textContent).toContain("12 hours"));
    // The sentence is said whole: a value the phrase names and the card forgot to pass would show as a bare {name} (found by the acceptance run, Guide A).
    expect(card.querySelector("[data-terms]")!.textContent).not.toMatch(/\{[a-z]+\}/i);
    expect(card.querySelector("[data-terms]")!.textContent).toContain("After that they cannot cancel online");
    // Not done until the manager says so.
    expect(document.querySelector('[data-step="cancellation-terms"]')!.getAttribute("data-state")).toBe("review-needed");
    await act(async () => within(document.querySelector('[data-step="cancellation-terms"]') as HTMLElement).getByRole("button", { name: "I have reviewed this" }).click());
    await waitFor(() => expect(document.querySelector('[data-step="cancellation-terms"]')!.getAttribute("data-state")).toBe("done"));
    const row = (await db.getDb().prepare("SELECT acknowledged FROM venue_guide WHERE venue_id = ?").get(venueId)) as { acknowledged: Record<string, { byName: string }> | string };
    const acknowledged = typeof row.acknowledged === "string" ? JSON.parse(row.acknowledged) : row.acknowledged;
    expect(acknowledged["cancellation-terms"].byName).toBe("UI Owner");
  });

  it("invites staff through the staff route, and the step reads done with the invitation counted", async () => {
    const card = await open("staff");
    await act(async () => within(card).getByRole("button", { name: "Do it here" }).click());
    fireEvent.change(within(card).getAllByLabelText("Name")[0], { target: { value: "Nina Desk" } });
    fireEvent.change(within(card).getAllByLabelText("Email")[0], { target: { value: "nina-ui@setup.my" } });
    // This install may be unable to email: then the form asks for a password, once it has asked the route what it can do.
    await act(async () => new Promise((r) => setTimeout(r, 100)));
    const password = within(card).queryByLabelText(/Password/);
    if (password) fireEvent.change(password, { target: { value: "a long enough password" } });
    await act(async () => within(card).getByRole("button", { name: /Send invitation|Add the account/ }).click());
    await waitFor(async () => {
      const row = (await db.getDb().prepare("SELECT (SELECT COUNT(*) FROM admins WHERE venue_id = ? AND email = 'nina-ui@setup.my') + (SELECT COUNT(*) FROM staff_invitations WHERE venue_id = ? AND email = 'nina-ui@setup.my') AS n").get(venueId, venueId)) as { n: number | string };
      expect(Number(row.n)).toBe(1);
    });
    await waitFor(() => expect(document.querySelector('[data-step="staff"]')!.getAttribute("data-state")).toBe("done"));
    // The application's refusal for an address that is not one, in its words.
    fireEvent.change(within(card).getAllByLabelText("Email")[0], { target: { value: "nobody" } });
    fireEvent.change(within(card).getAllByLabelText("Name")[0], { target: { value: "Nobody" } });
    const form = card.querySelector("form") as HTMLFormElement;
    form.noValidate = true;
    await act(async () => fireEvent.submit(form));
    expect((await within(card).findByRole("alert")).textContent).toMatch(/email/i);
  });
});
