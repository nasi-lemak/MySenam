import { describe, expect } from "vitest";
import { bookCourt, fitsScreen, scenario, signInOwner, signUp, url, type Actor } from "./harness";
import { staffApi, staffSignIn } from "./families";
import { BILLPLZ_STAND_IN } from "./gateway";
import { addCoach, answerDiscovery, expectNoPrivate, freeHourAt, madeVenue, marketplace, openGuide, planSteps, playbookApi, playbookText, sectionTitles, signUpVenue, stamp, stepCard } from "./guide-support";

/**
 * The venue guide for venues that already exist, and for who is using it
 * (docs/features/venue-guide.md): an established venue with bookings and money
 * records that is shown what it has and nothing is changed (Guide D); a business
 * adding a branch from another's set-up, whose new branch has a guide of its own
 * (Guide E); and the manager and the front desk of one venue, who are shown
 * different guides and cannot get more than their role's (Guide F).
 *
 * Venues made by the platform's owner (with a manager and a front desk) stand
 * for established ones; the business that adds a branch signs up as a new
 * operator does. Setup that is not a scenario's subject goes through the app's
 * API from that person's browser.
 */

describe("the venue guide for established venues, branches and roles", () => {
  scenario("Guide D: a venue that already has courts, bookings and money is shown what it has as done, is changed in nothing, and is pointed to what remains", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const venue = await madeVenue(owner, "Kelab Badminton Sedia Ada", [
      { sport: "badminton", name: "Court 1", offPeakRate: 18, peakRate: 25 },
      { sport: "badminton", name: "Court 2", offPeakRate: 18, peakRate: 25 },
      { sport: "tennis", name: "Tennis 1", offPeakRate: 20, peakRate: 30 },
    ]);
    const managerApi = await staffApi(await s.actor("Manager API"), venue.manager.email);
    const customer = await signUp(await s.actor("Customer"));

    // The venue's history: three bookings by a customer on different days, one of them paid in cash at the counter, with its receipt.
    const dates: string[] = [];
    const codes: string[] = [];
    await s.step(customer, "books three badminton courts on three days, and the manager records one paid in cash at the counter (setup: the venue's history)", async () => {
      for (const from of [3, 4, 5]) {
        const slot = await freeHourAt(venue.venueId, "badminton", null, from);
        const booked = await bookCourt(customer, slot.courtId, slot.date, slot.hour);
        dates.push(slot.date);
        codes.push(booked.code);
      }
      const paid = await managerApi.api("POST", "/api/admin/payments", { code: codes[0], paid: true, via: "cash" });
      expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    });

    /** What the venue holds, read through the routes the dashboard and the customers' pages use (not through the guide). */
    const held = async () => {
      const bookings: Record<string, string[]> = {};
      for (const d of [...new Set(dates)]) {
        const r = (await managerApi.api("GET", `/api/admin/bookings?date=${d}`)).body as { bookings: { code: string; status: string; paymentStatus: string; totalPrice: number }[] };
        bookings[d] = r.bookings.map((b) => `${b.code}:${b.status}:${b.paymentStatus}:${b.totalPrice}`).sort();
      }
      const { venues } = (await (await fetch(`${url}/api/venues`)).json()) as { venues: { id: number; courts: { id: number; name: string; sport: string; offPeakRate: number; peakRate: number }[] }[] };
      const courts = venues.find((v) => v.id === venue.venueId)!.courts.map((c) => `${c.id}:${c.name}:${c.sport}:${c.offPeakRate}/${c.peakRate}`).sort();
      const receipts = JSON.stringify((await managerApi.api("GET", `/api/admin/receipts?venueId=${venue.venueId}`)).body);
      const cashUp = JSON.stringify((await managerApi.api("GET", `/api/admin/cash-up?venueId=${venue.venueId}`)).body);
      const setup = (await managerApi.api("GET", `/api/admin/guide/setup?venueId=${venue.venueId}`)).body as {
        profile: { history: Record<string, number>; hours: { openMin: number; closeMin: number }; policies: { cancellation: Record<string, unknown> }; resources: { total: number } };
      };
      return { bookings, courts, receipts, cashUp, history: setup.profile.history, hours: setup.profile.hours, cancellation: setup.profile.policies.cancellation, resources: setup.profile.resources.total };
    };
    const before = await held();
    const logBefore = ((await managerApi.api("GET", `/api/admin/activity?venueId=${venue.venueId}&limit=500`)).body as { actions: unknown[] }).actions.length;
    expect(before.courts).toHaveLength(3);
    expect(Object.values(before.bookings).flat()).toHaveLength(3);
    expect(before.history.bookings).toBeGreaterThanOrEqual(3);
    // The money record: the cash taken at the counter is in the day's cash-up, and the booking is paid.
    expect(before.cashUp).toContain('"method":"cash"');
    expect(before.history.paidBookings).toBe(1);

    const manager = await s.actor("Manager");
    const page = manager.page;
    await s.step(manager, "signs in to the dashboard and opens Guide → Set up: told it reviews and adds and changes nothing unless a setting is saved in its own screen", async () => {
      await staffSignIn(manager, venue.manager.email);
      await openGuide(page, "Set up");
      await page.locator("#guide-setup-heading").waitFor();
      await page.locator("[data-history-banner]").getByText("Your venue already has bookings: this guide reviews and adds, and never changes a saved setting unless you save one in its own screen.").waitFor();
      // Not asked the questions of a new venue first: it goes straight to the plan.
      expect(await page.locator("[data-guide-setup]").getAttribute("data-stage")).toBe("plan");
      await page.getByRole("button", { name: "Review a policy" }).waitFor();
      for (const label of ["Add an activity", "Add a programme or class", "Add a branch", "Invite staff"]) await page.getByRole("button", { name: label }).waitFor();
    });

    await s.step(manager, "finds what it already has recognised as done, from saved settings: the courts and the prices", async () => {
      await page.locator('li[data-step="courts"][data-state="done"]').waitFor();
      await page.locator('li[data-step="prices"][data-state="done"]').waitFor();
      const courts = stepCard(page, "courts");
      await courts.getByText("Saved setting", { exact: true }).waitFor();
      await courts.getByRole("button", { name: "Do it here" }).click();
      await courts.getByText("You have 3 courts or other facilities set up.").waitFor();
      // Prices are read-only for a venue with bookings: the way to change them is from a later date.
      const prices = stepCard(page, "prices");
      await prices.getByRole("button", { name: "Do it here" }).click();
      expect(await prices.getByLabel("Peak rate for Court 1", { exact: true }).isDisabled()).toBe(true);
      expect(await prices.getByLabel("Off-peak rate for Tennis 1", { exact: true }).isDisabled()).toBe(true);
      await prices.getByRole("button", { name: "Prices from a date" }).waitFor();
      // And it is not offered a step that would write starting values over what it has.
      expect(await planSteps(page)).not.toContain("copied-branch");
    });

    await s.step(manager, "is guided to the remaining work only: the step the journey is on is one not yet done, and what is still to do is counted", async () => {
      const current = page.locator('li[data-step][aria-current="step"]');
      expect(await current.count()).toBe(1);
      expect(await current.getAttribute("data-state")).not.toBe("done");
      const todo = await page.locator('li[data-step]:not([data-state="done"])').evaluateAll((els) => els.map((e) => e.getAttribute("data-step")));
      expect(todo.length).toBeGreaterThan(0);
      // The cancellation terms exist (the venue has the defaults) but a manager has not yet said they were reviewed: asked, never assumed.
      expect(todo).toContain("cancellation-terms");
      await page.getByText(/^\d+ of \d+ required steps done/).waitFor();
    });

    await s.step(manager, "reviews the business: says it is a badminton and tennis club, saves the answers; the saved settings are what they were", async () => {
      await page.getByRole("button", { name: "Review my business" }).click();
      await page.getByRole("heading", { name: "About your business" }).waitFor();
      const asked = await answerDiscovery(page, { types: ["Badminton and pickleball centre", "Tennis and padel club"] });
      expect(asked.length).toBeGreaterThan(0);
      await page.locator("[data-guide-setup][data-stage=plan]").waitFor();
    });

    await s.step(manager, "marks the cancellation review done and dismisses one suggestion in Discover: these are the manager's own recorded acts", async () => {
      await openGuide(page, "Set up");
      const card = stepCard(page, "cancellation-terms");
      await card.getByRole("button", { name: "I have reviewed this" }).click();
      await page.locator('li[data-step="cancellation-terms"][data-state="done"]').waitFor();
      await card.getByText(/^Reviewed on .+ by .+$/).waitFor();
      await page.getByRole("navigation", { name: "Guide sections" }).getByRole("button", { name: "Discover", exact: true }).click();
      await page.getByRole("heading", { name: /^Suggestions \(\d+\)$/ }).waitFor();
      const notForUs = page.getByRole("button", { name: "Not for us" }).first();
      if (await notForUs.count()) {
        await notForUs.click();
        await page.getByText("Saving…").waitFor({ state: "hidden" }).catch(() => undefined);
      }
    });

    await s.step(manager, "finds nothing changed: the same bookings and payments, the same courts and prices, the same hours and terms; the activity log holds only the guide's own entries", async () => {
      const after = await held();
      expect(after).toEqual(before);
      // What the guide wrote is only intent, in the staff log: answers, a review, a dismissal. No setting, court, price, hour or booking entry came with it.
      const log = (await managerApi.api("GET", `/api/admin/activity?venueId=${venue.venueId}&limit=500`)).body as { actions: { action: string }[] };
      const added = log.actions.slice(0, log.actions.length - logBefore);
      expect(added.length).toBeGreaterThanOrEqual(2);
      expect(added.map((a) => a.action).filter((a) => !a.startsWith("guide."))).toEqual([]);
      expect(added.map((a) => a.action)).toEqual(expect.arrayContaining(["guide.answers", "guide.acknowledged"]));
    });

    await s.step(manager, "opens How to run it: it says what the venue really has (three courts, two activities, the prices in force) and nothing of a fresh set-up", async () => {
      await openGuide(page, "How to run it");
      const text = await playbookText(page);
      expect(text).toContain("Your venue has 3 bookable resources");
      expect(text).toContain("Badminton, Tennis");
      expect(text).toContain("Today's rates run from RM18 to RM30 an hour");
      expect(text).not.toContain("Your venue is still a draft");
      expectNoPrivate(text, customer.email, customer.phone, venue.manager.email, ...codes);
    });
  });

  describe.skipIf(!marketplace)("a business that signs itself up", () => {
  scenario("Guide E: a business adds a branch from the first one's set-up; the branch has a plan and a playbook of its own, and nothing of a customer, money, a secret or a person came across or is shown", async (s) => {
    const operator = await s.actor("Business manager");
    const page = operator.page;
    const venueName = `Dewan Induk Guide ${stamp()}`;
    const first = await s.step(operator, "signs the business up and sets its first venue up (courts, a coach, answers, a review, a dismissal, a payment account, a booking by a customer): the source of the copy", async () => {
      const id = await signUpVenue(operator, venueName);
      const court = await operator.api("POST", "/api/admin/courts", { venueId: id, sport: "badminton", count: 2, offPeakRate: 18, peakRate: 25, capacity: 1, deposit: 0 });
      expect(court.status, JSON.stringify(court.body)).toBeLessThan(300);
      await addCoach(operator, id, "Coach Hana Marker", "badminton");
      const said = await operator.api("POST", "/api/admin/guide/setup", {
        venueId: id,
        action: "answers",
        rev: 0,
        answers: { types: ["badminton-and-pickleball"], activities: ["badminton"], customersDo: ["reserve"], resources: "few", branches: "one", staffing: "staffed", channels: ["counter"], audience: "public" },
      });
      expect(said.status, JSON.stringify(said.body)).toBe(200);
      expect((await operator.api("POST", "/api/admin/guide/setup", { venueId: id, action: "acknowledge", step: "cancellation-terms" })).status).toBe(200);
      const view = (await operator.api("GET", `/api/admin/guide/setup?venueId=${id}`)).body as { discoveries: { id: string }[] };
      expect(view.discoveries.length).toBeGreaterThan(0);
      expect((await operator.api("POST", "/api/admin/guide/setup", { venueId: id, action: "dismiss", id: view.discoveries[0].id })).status).toBe(200);
      // A payment account of the sandbox stand-in (Billplz-sandbox-like, not Billplz) and a booking by a customer.
      const keys = await operator.api("PUT", `/api/admin/venues/${id}/payment-settings`, { provider: "billplz", credentials: { ...BILLPLZ_STAND_IN }, sandbox: true, enabled: true });
      expect(keys.status, JSON.stringify(keys.body)).toBe(200);
      const slot = await freeHourAt(id, "badminton", operator, 3);
      const booked = await operator.api("POST", "/api/bookings", { courtId: slot.courtId, date: slot.date, hours: [slot.hour], name: "Zainab Marker", phone: "0129998877" });
      expect(booked.status, JSON.stringify(booked.body)).toBeLessThan(300);
      return id;
    });
    // What the guide keeps for a venue is its manager's intent: answers, reviews, dismissals and their revision. (Its plan is read from the venue's real state and adapts: the first venue now has a sibling.)
    const sourceView = async () => {
      const v = (await operator.api("GET", `/api/admin/guide/setup?venueId=${first}`)).body as { rev: number; answers: unknown; acknowledged: unknown; dismissed: unknown };
      return { rev: v.rev, answers: v.answers, acknowledged: v.acknowledged, dismissed: v.dismissed };
    };
    const sourceBefore = await sourceView();
    expect(sourceBefore.rev).toBeGreaterThan(0);

    const branchName = `Dewan Cawangan Guide ${stamp()}`;
    await s.step(operator, "adds a branch from Branches & staff, starting from the first venue's set-up (the safe copy): told what was copied", async () => {
      await page.getByRole("button", { name: "Branches & staff", exact: true }).click();
      await page.getByRole("heading", { name: "Add a branch" }).waitFor();
      const form = page.locator("form").filter({ has: page.getByLabel("Branch name") });
      await form.getByLabel("Branch name").fill(branchName);
      await form.getByLabel("Area (e.g. Cheras)").fill("Cheras");
      await form.getByLabel("Address", { exact: true }).fill("9 Jalan Salinan, Cheras");
      await form.getByLabel("Phone", { exact: true }).fill("03-9111 0000");
      await form.getByRole("button", { name: "I'm there now: use my location" }).click();
      await form.getByText("Pinned. Drag the pin if it isn't quite right.").waitFor();
      await form.getByLabel("Start from").selectOption({ label: `${venueName}'s set-up` });
      await form.getByRole("button", { name: "Add this branch" }).click();
      await page.getByText(new RegExp(`^${branchName} is added as a draft, with 2 courts copied from ${venueName}\\.`)).waitFor();
    });

    const branch = await s.step(operator, "opens Guide → Set up for the branch from the venue picker: asked the questions of a new venue, with none of the first venue's answers", async () => {
      await page.reload();
      await page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
      await openGuide(page, "Set up");
      const picker = page.getByLabel("Venue", { exact: true });
      const id = Number(await picker.locator("option", { hasText: branchName }).getAttribute("value"));
      expect(id).not.toBe(first);
      await picker.selectOption(String(id));
      await page.getByRole("heading", { name: "What kind of venue do you run?" }).waitFor();
      expect(await page.getByLabel("Badminton and pickleball centre", { exact: true }).isChecked()).toBe(false);
      expect(await page.locator("[data-guide-setup]").getAttribute("data-stage")).toBe("questions");
      return id;
    });

    await s.step(operator, "goes to the branch's plan: its own review of what was copied is asked, and the cancellation review the first venue made is not carried over", async () => {
      await page.getByRole("button", { name: "Go to my plan" }).click();
      const copied = stepCard(page, "copied-branch");
      await copied.waitFor();
      expect(await copied.getAttribute("data-state")).toBe("review-needed");
      await copied.getByText("Prices, hours and rules came across; customers, money, staff and keys did not.", { exact: false }).waitFor();
      // Copied courts and prices are recognised from the branch's own saved settings.
      expect(await stepCard(page, "courts").getAttribute("data-state")).toBe("done");
      expect(await stepCard(page, "cancellation-terms").getAttribute("data-state")).toBe("review-needed");
      // The branch has no payment account, no coach and no test booking: those read as missing, not as the first venue's.
      expect(await planSteps(page)).not.toContain("coaches");
      expect(await stepCard(page, "test-booking").getAttribute("data-state")).not.toBe("done");
    });

    await s.step(operator, "reads the branch's own playbook: a draft, started from another branch's set-up, with nothing of the first venue's customer, coach, money or keys", async () => {
      await openGuide(page, "How to run it");
      const text = await playbookText(page);
      expect(text).toContain("Your business has 2 branches");
      expect(text).toContain("This branch was started from another branch's set-up. Its payment account, staff, coaches and test booking were not copied, and no customer, money or secret was.");
      expect(text).toContain("Your venue is still a draft");
      expect(text).toContain(branchName);
      expect(text).toContain("Online payment is off: customers pay at the counter.");
      expect(text).not.toContain(venueName);
      expectNoPrivate(text, "Zainab Marker", "0129998877", "Coach Hana Marker", venueName, operator.email, operator.password, operator.phone);
      const api = (await playbookApi(operator, branch)).body as { venueId: number; playbook: { venue: { id: number; name: string }; modules: string[] } };
      expect(api.venueId).toBe(branch);
      expect(api.playbook.modules).not.toContain("spec.coaching");
      expect(api.playbook.modules).toContain("spec.branches");
      // Everything the server sent for the branch, in one string: not a customer, a coach, a key, the first venue's name.
      const wire = JSON.stringify(api) + JSON.stringify((await operator.api("GET", `/api/admin/guide/setup?venueId=${branch}`)).body) + JSON.stringify((await operator.api("GET", `/api/admin/guide/setup/journey?venueId=${branch}`)).body);
      for (const forbidden of ["Zainab Marker", "0129998877", "Coach Hana Marker", venueName, BILLPLZ_STAND_IN.apiKey, BILLPLZ_STAND_IN.collectionId, BILLPLZ_STAND_IN.xSignatureKey]) expect(wire, `the branch's guide holds "${forbidden}"`).not.toContain(forbidden);
    });

    await s.step(operator, "finds the branch's own state in the database of the guide, and the first venue's untouched: its answers, review and dismissal as they were", async () => {
      const own = (await operator.api("GET", `/api/admin/guide/setup?venueId=${branch}`)).body as {
        rev: number;
        answers: Record<string, unknown>;
        acknowledged: Record<string, unknown>;
        dismissed: Record<string, unknown>;
        profile: { history: { bookings: number }; payments: { online: { accountExists: boolean } }; people: { coaches: number }; resources: { total: number } };
      };
      expect(own.answers).toEqual({ v: 1 });
      expect(own.acknowledged).toEqual({});
      expect(own.dismissed).toEqual({});
      expect(own.profile.history.bookings).toBe(0);
      expect(own.profile.payments.online.accountExists).toBe(false);
      expect(own.profile.people.coaches).toBe(0);
      expect(own.profile.resources.total).toBe(2);
      expect(await sourceView()).toEqual(sourceBefore);
    });
  });

  });

  scenario("Guide F: the manager of a venue is shown setup and administration, its front desk only the day's work; no address or route gives the desk more, and the desk's links open only screens it may use", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const venue = await madeVenue(owner, "Pusat Sukan Peranan", [
      { sport: "badminton", name: "Court 1", offPeakRate: 18, peakRate: 25 },
      { sport: "badminton", name: "Court 2", offPeakRate: 18, peakRate: 25 },
    ]);
    const manager = await s.actor("Manager");
    const desk = await s.actor("Front desk", "phone");
    await staffSignIn(manager, venue.manager.email);
    await staffSignIn(desk, venue.desk.email);
    const MANAGER_SCREENS = ["reports", "courts", "venues", "tournaments", "leagues"];
    const linkTabs = (a: Actor) => a.page.locator("[data-playbook-print] [data-link-tab]").evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-link-tab")!))]);

    const managerSections = await s.step(manager, "opens the Guide: three views (Set up, How to run it, Discover), and a playbook with the manager's sections and links to the administrative screens", async () => {
      await openGuide(manager.page);
      const views = manager.page.getByRole("navigation", { name: "Guide sections" }).getByRole("button");
      expect(await views.allTextContents()).toEqual(["Set up", "How to run it", "Discover"]);
      await views.filter({ hasText: "How to run it" }).click();
      await manager.page.getByRole("heading", { name: "How to run your venue" }).waitFor();
      const text = await playbookText(manager.page);
      expect(text).toContain("Guide for: Manager");
      const titles = await sectionTitles(manager.page);
      expect(titles).toContain("Manager responsibilities");
      expect(text).toContain("Prices and opening hours");
      const tabs = await linkTabs(manager);
      for (const wanted of ["courts", "venues", "reports"]) expect(tabs, `the manager's guide has no link to ${wanted}`).toContain(wanted);
      return titles;
    });

    await s.step(manager, "previews the front desk's guide to train them: told whose guide it is, with the desk's own sections", async () => {
      await manager.page.getByLabel("View as").selectOption({ label: "Front desk" });
      await manager.page.locator("[data-preview]").getByText("You are looking at the Front desk guide, as that role sees it.").waitFor();
      await manager.page.locator('[data-playbook-print][data-role="desk"]').waitFor();
      const previewTitles = await sectionTitles(manager.page);
      expect(previewTitles).not.toContain("Manager responsibilities");
      expect(previewTitles.length).toBeLessThan(managerSections.length);
      // A manager may also preview a coach's, and come back to their own.
      await manager.page.getByLabel("View as").selectOption({ label: "Coach" });
      await manager.page.locator('[data-playbook-print][data-role="coach"]').waitFor();
      await manager.page.getByLabel("View as").selectOption({ label: "Manager" });
      await manager.page.locator('[data-playbook-print][data-role="manager"]').waitFor();
    });

    const deskTitles = await s.step(desk, "opens the Guide on a phone: only How to run it, the front desk's guide, no Setup and no Discover, and the page fits the screen", async () => {
      await openGuide(desk.page);
      const views = desk.page.getByRole("navigation", { name: "Guide sections" }).getByRole("button");
      expect(await views.allTextContents()).toEqual(["How to run it"]);
      await desk.page.getByRole("heading", { name: "How to run your venue" }).waitFor();
      const text = await playbookText(desk.page);
      expect(text).toContain("Guide for: Front desk");
      const titles = await sectionTitles(desk.page);
      expect(titles).not.toContain("Manager responsibilities");
      expect(titles).toContain("Handling a customer booking");
      expect(text).toContain("What is yours, and what is not");
      expect(text).toContain("Anything that changes how the venue is set up or what something costs, and any refund you are not shown a button for, is a manager's: ask one.");
      expect(text).not.toContain("A manager also sets the venue up");
      expect(text).not.toContain("Prices and opening hours");
      // The desk may preview its own guide and a coach's, never a manager's: the choice does not offer one.
      expect(await desk.page.getByLabel("View as").locator("option").allTextContents()).toEqual(["Front desk", "Coach"]);
      expect(await fitsScreen(desk.page)).toBeLessThanOrEqual(0);
      return titles;
    });

    await s.step(desk, "is shown the same guide as the manager's preview of it: the desk's sections are what a manager is shown when previewing the desk", async () => {
      await manager.page.getByLabel("View as").selectOption({ label: "Front desk" });
      await manager.page.locator('[data-playbook-print][data-role="desk"]').waitFor();
      expect(await sectionTitles(manager.page)).toEqual(deskTitles);
      expect((await linkTabs(manager)).sort()).toEqual((await linkTabs(desk)).sort());
    });

    await s.step(desk, "has no link in its guide to a manager's screen, and every link it has opens a screen it uses, without a refusal", async () => {
      const tabs = await linkTabs(desk);
      expect(tabs.length).toBeGreaterThan(0);
      for (const forbidden of MANAGER_SCREENS) expect(tabs, `the desk's guide links to ${forbidden}`).not.toContain(forbidden);
      for (const tab of tabs.filter((t) => t !== "guide")) {
        await openGuide(desk.page);
        await playbookText(desk.page);
        await desk.page.locator(`[data-playbook-print] [data-link-tab="${tab}"]`).first().click();
        await desk.page.waitForURL((u) => new URL(u).searchParams.get("tab") === tab);
        await desk.page.getByRole("button", { name: /sign out/i }).waitFor();
        // (An empty alert is the framework's own route announcer; a refusal says something.)
        expect((await desk.page.getByRole("alert").allTextContents()).filter((t) => t.trim() !== ""), `${tab} opened with a refusal`).toEqual([]);
      }
    });

    await s.step(desk, "types the setup and the discover views into the address: it is shown its own guide, never the setup", async () => {
      for (const view of ["setup", "discover"]) {
        await desk.page.goto(`${url}/admin?tab=guide&view=${view}&venue=${venue.venueId}`);
        await desk.page.getByRole("heading", { name: "How to run your venue" }).waitFor();
        expect(await desk.page.locator("#guide-setup-heading").count()).toBe(0);
        expect(await desk.page.getByRole("heading", { name: "Everything MySenam can do" }).count()).toBe(0);
        expect(await desk.page.getByRole("button", { name: "Set up", exact: true }).count()).toBe(0);
      }
    });

    await s.step(desk, "is refused by the server what it is not shown: the setup, its journey and a save (manager-only), a manager's playbook (above its role) and another venue's guide", async () => {
      const refused = async (r: Promise<{ status: number; body: Record<string, unknown> }>, status: number) => {
        const got = await r;
        expect(got.status, JSON.stringify(got.body)).toBe(status);
        return got;
      };
      await refused(desk.api("GET", `/api/admin/guide/setup?venueId=${venue.venueId}`), 403);
      await refused(desk.api("GET", `/api/admin/guide/setup/journey?venueId=${venue.venueId}`), 403);
      await refused(desk.api("POST", "/api/admin/guide/setup", { venueId: venue.venueId, action: "answers", rev: 0, answers: { audience: "members" } }), 403);
      await refused(desk.api("POST", "/api/admin/guide/setup", { venueId: venue.venueId, action: "acknowledge", step: "cancellation-terms" }), 403);
      await refused(playbookApi(desk, venue.venueId, "manager"), 403);
      await refused(playbookApi(desk, venue.venueId, "owner"), 400);
      // At or below its role is allowed: its own, and a coach's.
      expect((await refused(playbookApi(desk, venue.venueId), 200)).body).toMatchObject({ role: "desk", ownRole: "desk", roles: ["desk", "coach"] });
      expect((await refused(playbookApi(desk, venue.venueId, "coach"), 200)).body.role).toBe("coach");
      // Another venue's guide is not the desk's to read.
      const { venues } = (await (await fetch(`${url}/api/venues`)).json()) as { venues: { id: number }[] };
      const other = venues.find((v) => v.id !== venue.venueId)!.id;
      await refused(playbookApi(desk, other), 403);
      await refused(desk.api("GET", `/api/admin/guide/topic?venueId=${other}&id=buffers`), 403);
      // The same routes are not closed to the manager.
      await refused(manager.api("GET", `/api/admin/guide/setup?venueId=${venue.venueId}`), 200);
      await refused(playbookApi(manager, venue.venueId, "desk"), 200);
    });

    await s.step(desk, "reads a topic as the desk: the same explanation with the desk's version, and no link to a screen only a manager has", async () => {
      const asDesk = (await desk.api("GET", `/api/admin/guide/topic?venueId=${venue.venueId}&id=buffers`)).body as { role: string; topic: unknown };
      const asManager = (await manager.api("GET", `/api/admin/guide/topic?venueId=${venue.venueId}&id=buffers`)).body as { role: string; topic: unknown };
      expect([asDesk.role, asManager.role]).toEqual(["desk", "manager"]);
      expect(JSON.stringify(asManager.topic)).toContain('"tab":"courts"');
      for (const forbidden of MANAGER_SCREENS) expect(JSON.stringify(asDesk.topic), `the desk's topic links to ${forbidden}`).not.toContain(`"tab":"${forbidden}"`);
      expect((await desk.api("GET", `/api/admin/guide/topic?venueId=${venue.venueId}&id=nonsense`)).status).toBe(404);
    });

    await s.step(desk, "opens the \"?\" beside passes on Credit & passes from the keyboard on the phone: the desk's version, Escape closes it and focus returns to the \"?\"", async () => {
      await desk.page.goto(`${url}/admin?tab=credit`);
      await desk.page.getByRole("button", { name: /sign out/i }).waitFor();
      const tip = desk.page.getByRole("button", { name: "Help: How do passes work?" });
      await tip.scrollIntoViewIfNeeded();
      await tip.focus();
      await desk.page.keyboard.press("Enter");
      const dialog = desk.page.getByRole("dialog", { name: "How do passes work?" });
      await dialog.waitFor();
      expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      // The desk is told a manager changes it, and has no button to a screen it cannot use.
      for (const forbidden of ["Open Courts & rates", "Open Reports", "Open Venue details"]) expect(await dialog.getByRole("button", { name: forbidden }).count(), forbidden).toBe(0);
      expect(await dialog.getByRole("link", { name: "Open this in the guide" }).count()).toBe(1);
      expect(await fitsScreen(desk.page)).toBeLessThanOrEqual(0);
      await desk.page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      expect(await tip.evaluate((el) => el === document.activeElement)).toBe(true);
    });
  });
});
