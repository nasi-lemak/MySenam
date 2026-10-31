import { describe, expect } from "vitest";
import { dayAhead, fitsScreen, scenario, signInOwner, url } from "./harness";
import { addCoach, answerDiscovery, doItHere, expectNoPrivate, freeHourAt, marketplace, openGuide, planSteps, playbookApi, playbookText, sectionTitles, signUpVenue, stamp, stepCard } from "./guide-support";

/**
 * The venue guide (docs/features/venue-guide.md) as the people who use it meet
 * it, in browsers of their own, through the real pages: the setup journey that
 * configures the real application, the operating playbook written from what was
 * saved, the contextual "?" and the print view. Setup that is not what a
 * scenario is about goes through the app's API from that person's browser.
 *
 * The scenarios of the owner's list (Part G, 32):
 * - **Guide A** a small badminton venue is set up from nothing and gets its own guide.
 *
 * Only a marketplace takes sign-ups (the UAT server runs as one); against a
 * deployment that is not, the scenarios that sign a venue up are skipped.
 */

describe.skipIf(!marketplace)("the venue guide: setup, playbook, help and discovery", () => {
  scenario("Guide A: a small badminton venue is set up from nothing, makes a test booking and reads a playbook that is its own", async (s) => {
    const operator = await s.actor("Operator");
    const page = operator.page;
    const venueName = `Dewan Badminton Guide ${stamp()}`;

    const venueId = await s.step(operator, "signs the venue up as a new operator, and signs in to its draft", async () => signUpVenue(operator, venueName));

    await s.step(operator, "opens Guide → Set up and is asked the first question; nothing is set up, so nothing is yet known from settings", async () => {
      await openGuide(page, "Set up");
      await page.locator("#guide-setup-heading").waitFor();
      await page.getByRole("heading", { name: "What kind of venue do you run?" }).waitFor();
      expect(page.url()).toContain("tab=guide");
      expect(page.url()).toContain("view=setup");
    });

    const asked = await s.step(operator, "chooses a badminton and pickleball centre with badminton, reserving courts, 2–6 of them, one location, staffed, booked online and at the counter, no discounts, no children, no tournaments, open to anyone", async () => {
      return answerDiscovery(page, {
        types: ["Badminton and pickleball centre"],
        activities: ["Badminton"],
        customersDo: ["Reserve courts or rooms"],
        resources: "Two to six",
        branches: "One location",
        staffing: "Somebody is always at the desk",
        channels: ["Online, on our page", "At the counter"],
        discounts: "No",
        children: "No",
        competitions: "No",
        audience: "Anyone",
      });
    });

    await s.step(operator, "is not asked about coaching, and the plan has the small venue's steps without a coach, a branch, a guardian or a tournament", async () => {
      expect(asked).not.toContain("coaching");
      await page.getByRole("heading", { name: "Check your details and opening hours" }).first().waitFor();
      const steps = await planSteps(page);
      for (const wanted of ["details", "activities", "courts", "prices", "peak-hours", "booking-rules", "cancellation-terms", "staff", "test-booking", "launch"]) expect(steps).toContain(wanted);
      for (const unwanted of ["coaches", "coach-hours", "classes", "tournaments", "branches", "copied-branch", "guardians", "participant-requirements", "equipment", "shared-resources", "memberships", "discounts", "unattended", "einvoicing"])
        expect(steps, `the plan shows ${unwanted}`).not.toContain(unwanted);
      // Counted from saved state: nothing is done, and three steps are needed before going live.
      await page.getByText("0 of 3 required steps done").waitFor();
    });

    await s.step(operator, "saves closing an hour earlier from the opening-hours step; the real venue hours change, and it is the checklist's own step", async () => {
      const card = await doItHere(page, "details");
      await card.getByLabel("Closes", { exact: true }).fill("22:00");
      await card.getByRole("button", { name: "Save", exact: true }).first().click();
      await card.getByText("Opening hours saved.").waitFor();
      await page.locator('li[data-step="details"][data-state="done"]').waitFor();
      // What the venue really has now, read from the saved venue (the dashboard's own journey route), not from the card.
      const saved = (await operator.api("GET", `/api/admin/guide/setup/journey?venueId=${venueId}`)).body as { extras?: { venue: { closeMin: number; openMin: number } } };
      expect(saved.extras?.venue.closeMin).toBe(22 * 60);
      expect(saved.extras?.venue.openMin).toBe(8 * 60);
    });

    await s.step(operator, "adds two badminton courts at RM18 off-peak and RM25 peak from the courts step; two real courts exist and the step is done", async () => {
      const card = await doItHere(page, "courts");
      await card.getByRole("combobox", { name: /^Activity/ }).selectOption("badminton");
      await card.getByLabel("How many").fill("2");
      await card.getByLabel(/^Off-peak \(/).fill("18");
      await card.getByLabel(/^Peak \(/).fill("25");
      await card.getByRole("button", { name: "Add", exact: true }).click();
      await card.getByText("Added Court 1, Court 2.").waitFor();
      await page.locator('li[data-step="courts"][data-state="done"]').waitFor();
      await page.getByText("2 of 3 required steps done").waitFor();
      await card.getByText("You have 2 courts or other facilities set up.").waitFor();
    });

    await s.step(operator, "sets Court 1's peak rate to RM28 in the prices step; the example price, worked out from the saved rates, follows", async () => {
      const card = await doItHere(page, "prices");
      await card.locator("[data-price-example]").getByText(/Court 1: one hour at 8:00 PM on .* costs RM25 \(peak rate\)\./).waitFor();
      await card.getByLabel("Peak rate for Court 1", { exact: true }).fill("28");
      await card.locator("[data-court]").filter({ hasText: "Court 1" }).getByRole("button", { name: "Save" }).click();
      await card.getByText("Rate saved. It applies from now to new bookings.").waitFor();
      await card.locator("[data-price-example]").getByText(/Court 1: one hour at 8:00 PM on .* costs RM28 \(peak rate\)\./).waitFor();
    });

    await s.step(operator, "reviews the cancellation terms: told what a change does first, sets the cutoff to 6 hours and marks the review done, by name and date", async () => {
      const card = await doItHere(page, "cancellation-terms");
      await card.getByText(/^Before you save: If customers cancel within the cutoff, your configured cancellation policy decides whether a refund or a charge applies\./).waitFor();
      await card.getByLabel("Cancel cutoff (hrs)").fill("6");
      await card.getByRole("button", { name: "Save", exact: true }).first().click();
      await card.getByText("Cancellation cutoff saved.").waitFor();
      await card.getByRole("button", { name: "I have reviewed this" }).click();
      await page.locator('li[data-step="cancellation-terms"][data-state="done"]').waitFor();
      await card.getByText(/^Reviewed on .+ by Operator Tester$/).waitFor();
      // The words the card shows never carry a placeholder the code forgot to fill.
      expect(await card.innerText()).not.toMatch(/\{[a-z]+\}/i);
    });

    const slot = await freeHourAt(venueId, "badminton", operator, 2);
    const code = await s.step(operator, "makes a test booking on the venue's own page, as the Try it step says; the page says it is a preview and the booking a test", async () => {
      const pub = await operator.context.newPage();
      await pub.goto(`${url}/venue/${venueId}?date=${slot.date}&sport=badminton&court=${slot.courtId}&hour=${slot.hour}&duration=1`);
      await pub.getByText("Bookings you make here are test bookings.").waitFor();
      await pub.getByLabel("Name").fill("Operator Tester");
      await pub.getByLabel("Phone").fill(operator.phone);
      await pub.getByRole("button", { name: /^Book · RM/ }).click();
      await pub.getByText("Booking confirmed!").waitFor({ timeout: 15_000 });
      const made = (await pub.getByText(/MS-[A-Z0-9]{4,}/).first().textContent())!.match(/MS-[A-Z0-9]{4,}/)![0];
      await pub.close();
      return made;
    });

    await s.step(operator, "comes back to the journey: the test-booking step is done from the saved booking, and three of three required steps are done", async () => {
      await page.reload();
      await page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
      await page.getByText("3 of 3 required steps done").waitFor();
      const card = stepCard(page, "test-booking");
      await card.locator('li[data-state], [data-try="customer"]').first().waitFor();
      await card.locator('[data-try="customer"][data-mark="done"]').waitFor();
      await card.locator('[data-try="schedule"][data-mark="done"]').waitFor();
      // Not claimed: what MySenam cannot see.
      await card.locator('[data-try="price"][data-mark="unchecked"]').getByText("Not checked by MySenam").waitFor();
      await card.locator('[data-try="messages"][data-mark="unchecked"]').waitFor();
      // The test booking is on the staff's list, marked as one.
      await page.getByRole("button", { name: "Bookings", exact: true }).click();
      await page.getByLabel("Day to show").fill(slot.date);
      const row = page.locator("tr").filter({ hasText: code });
      await row.getByText("Court", { exact: false }).first().waitFor();
      await row.getByText(/test/i).first().waitFor();
      await openGuide(page, "Set up");
    });

    await s.step(operator, "reads the launch readiness: nothing required is missing, the unverified items are said as such, and no online payment provider is asked for", async () => {
      const card = stepCard(page, "launch");
      await card.scrollIntoViewIfNeeded();
      await card.locator('[data-ready-group="requiredMissing"]').getByText("Nothing here.").waitFor();
      const unverified = card.locator('[data-ready-group="unverifiedExternal"]');
      await unverified.getByText(/no email service set up/).waitFor();
      const readiness = await card.locator("[data-readiness]").innerText();
      expect(readiness).not.toMatch(/online payment account|Billplz|Stripe/i);
      expect(readiness).toContain("no single score");
    });

    await s.step(operator, "opens How to run it: the manager's playbook names badminton, today's hours and the prices just saved, and explains the test booking", async () => {
      await openGuide(page, "How to run it");
      const text = await playbookText(page);
      expect(text).toContain("Guide for: Manager");
      expect(text).toContain(venueName);
      expect(text).toContain("offering Badminton");
      expect(text).toContain("Your venue has 2 bookable resources");
      expect(text).toContain("It opens from 8:00 AM to 10:00 PM today.");
      expect(text).toContain("Today's rates run from RM18 to RM28 an hour");
      expect(text).toContain("cancel");
      // The test-booking explanation, from the venue's saved state: a draft, and a test standing.
      expect(text).toContain("a booking made now is a test booking");
      expect(text).toContain("1 test bookings still stand at your venue.");
      expect(text).toContain("Marking a booking a test never takes money out of the records.");
      // The cutoff the journey saved is the policy the playbook states.
      expect(text).toContain("6 hours");
      // Written for this venue, not a manual with every feature on.
      expect(text).not.toMatch(/coaching|tournaments?|leagues?|equipment hire|hire equipment|open games?|family membership/i);
      expectNoPrivate(text, operator.email, operator.password, operator.phone);
      const titles = await sectionTitles(page);
      expect(titles).toEqual(["Getting started", "Before opening", "Handling a customer booking", "During operations", "Cancellations and refunds", "End of day", "Manager responsibilities", "Quick reference cards"]);
      expect(titles).not.toContain("Specialised workflows");
      // The same guide, as the server answers it: no specialised module, no coach's, no tournament's.
      const api = (await playbookApi(operator, venueId)).body as { playbook: { modules: string[] } };
      expect(api.playbook.modules.filter((m) => m.startsWith("spec."))).toEqual([]);
      expect(api.playbook.modules).not.toContain("during.coaching");
      expect(api.playbook.modules).not.toContain("during.hire");
      expect(api.playbook.modules).toContain("manager.testBookings");
    });

    // The change reached the app: asked to go live, approved by the platform's owner, the venue is public with what the journey saved.
    await s.step(operator, "asks the platform to take the venue live from the dashboard's own button", async () => {
      await page.getByRole("button", { name: "Ask to go live" }).click();
      await page.getByText("Your venue is waiting to go live").waitFor();
    });
    const owner = await signInOwner(await s.actor("Owner"));
    await s.step(owner, "approves the venue (every check the owner makes), through the owner's API", async () => {
      const list = (await owner.api("GET", "/api/admin/venue-applications")).body as { applications: { id: number; venueId: number | null; status: string }[] };
      const mine = list.applications.find((a) => a.venueId === venueId && a.status === "pending");
      expect(mine, "the venue's application").toBeTruthy();
      const done = await owner.api("POST", "/api/admin/venue-applications", { id: mine!.id, decision: "approve", checks: ["location", "phone", "business", "photos"] });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
    });
    const customer = await s.actor("Customer");
    await s.step(customer, "sees the live venue's public page and availability with the journey's hours and prices: 8 AM to 10 PM, RM18 off-peak, RM28 and RM25 at peak", async () => {
      const date = dayAhead(4);
      const res = await customer.page.goto(`${url}/venue/${venueId}?date=${date}&sport=badminton`);
      expect(res?.status()).toBe(200);
      await customer.page.getByText("Open daily 8:00 AM – 10:00 PM").waitFor();
      await customer.page.getByText("free cancellation until 6 hours before your slot").waitFor();
      const public_ = await customer.api("GET", `/api/availability?venueId=${venueId}&date=${date}&sport=badminton`);
      expect(public_.status).toBe(200);
      const avail = (public_.body as { availability: { court: { name: string; offPeakRate: number; peakRate: number }; starts: { minute: number }[] }[] }).availability;
      expect(avail.map((a) => [a.court.name, a.court.offPeakRate, a.court.peakRate])).toEqual([
        ["Court 1", 18, 28],
        ["Court 2", 18, 25],
      ]);
      // Nothing starts after the closing hour the journey saved: the last hour is 9 PM.
      const lastStart = Math.max(...avail.flatMap((a) => a.starts.map((st) => st.minute)));
      expect(lastStart).toBeLessThanOrEqual(21 * 60);
    });

    // On a phone, the same journey where it was left (answers and steps are saved in the venue, not in a browser).
    const phone = await s.actor("Operator on phone", "phone");
    await s.step(phone, "continues on a phone: signed in, the plan is as it was left and the page fits the screen", async () => {
      const login = await phone.api("POST", "/api/admin/auth/login", { email: operator.email, password: operator.password });
      expect(login.status).toBe(200);
      await phone.page.goto(`${url}/admin?tab=guide&view=setup&venue=${venueId}`);
      await phone.page.locator("#guide-setup-heading").waitFor();
      await phone.page.getByText("3 of 3 required steps done").waitFor();
      expect(await fitsScreen(phone.page)).toBeLessThanOrEqual(0);
      // The list of steps folds into one button on a phone, and opens.
      await phone.page.getByRole("button", { name: /^Steps \(\d+\)$/ }).click();
      await phone.page.getByRole("button", { name: /^Check your details and opening hours/ }).click();
      expect(await fitsScreen(phone.page)).toBeLessThanOrEqual(0);
    });

    await s.step(phone, "reads How to run it on the phone: it fits, and Review my business still shows the answers given on the laptop", async () => {
      await phone.page.getByRole("button", { name: "Review my business" }).click();
      await phone.page.getByRole("heading", { name: "About your business" }).waitFor();
      expect(await phone.page.getByLabel("Badminton and pickleball centre", { exact: true }).isChecked()).toBe(true);
      expect(await fitsScreen(phone.page)).toBeLessThanOrEqual(0);
      await phone.page.getByRole("navigation", { name: "Guide sections" }).getByRole("button", { name: "How to run it", exact: true }).click();
      await phone.page.getByRole("heading", { name: "How to run your venue" }).waitFor();
      expect(await fitsScreen(phone.page)).toBeLessThanOrEqual(0);
      await playbookText(phone.page);
      expect(await fitsScreen(phone.page)).toBeLessThanOrEqual(0);
    });

    await s.step(operator, "prints the playbook: only the guide is on the paper, the dashboard's chrome and the controls are not", async () => {
      await page.reload();
      await page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
      await openGuide(page, "How to run it");
      await playbookText(page);
      await page.emulateMedia({ media: "print" });
      // On paper: the guide's own title, the venue's name and the date; not the tab bar, the views, the search box or the buttons.
      await page.getByRole("heading", { name: "How to run your venue", level: 1 }).waitFor({ state: "visible" });
      expect(await page.getByText("Printed on").first().isVisible()).toBe(true);
      expect(await page.getByRole("button", { name: "Bookings", exact: true }).isVisible()).toBe(false);
      expect(await page.getByRole("button", { name: /sign out/i }).isVisible()).toBe(false);
      expect(await page.getByRole("navigation", { name: "Guide sections" }).isVisible()).toBe(false);
      expect(await page.getByLabel("Search this guide").isVisible()).toBe(false);
      expect(await page.getByRole("button", { name: "Print this guide" }).isVisible()).toBe(false);
      expect(await page.getByRole("navigation", { name: "Contents" }).isVisible()).toBe(false);
      // Every section is open on paper whatever was folded on screen.
      expect(await page.locator("[data-section-body]").evaluateAll((els) => els.every((e) => getComputedStyle(e).display !== "none"))).toBe(true);
      await page.emulateMedia({ media: "screen" });
    });

    await s.step(operator, "opens the \"?\" beside the booking rules from the keyboard: a dialog named for its question, Escape closes it and focus is back on the \"?\"", async () => {
      await page.getByRole("button", { name: "Courts & rates", exact: true }).click();
      const tip = page.getByRole("button", { name: "Help: How do booking buffers work?" });
      await tip.scrollIntoViewIfNeeded();
      await tip.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "How do booking buffers work?" });
      await dialog.waitFor();
      // Written from this venue's saved settings, as the playbook says it.
      await dialog.getByText("Written from this venue's saved settings.").waitFor();
      expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      expect(await tip.evaluate((el) => el === document.activeElement)).toBe(true);
    });
  });

  scenario("Guide B: a multi-sport centre with a pitch and the courts that share its floor, and prices of different kinds, is not asked what it does not use and is given the shared-facility guide", async (s) => {
    const operator = await s.actor("Operator");
    const page = operator.page;
    const venueName = `Pusat Sukan Guide ${stamp()}`;
    const venueId = await s.step(operator, "signs the multi-sport centre up", async () => signUpVenue(operator, venueName));

    const asked = await s.step(operator, "answers for a multi-sport centre: futsal, badminton and a gym floor, seven to twenty facilities, one location, staffed, counter bookings only", async () => {
      await openGuide(page, "Set up");
      return answerDiscovery(page, {
        types: ["Multi-sport centre"],
        activities: ["Futsal", "Badminton", "Gym"],
        customersDo: ["Reserve courts or rooms"],
        resources: "Seven to twenty",
        branches: "One location",
        staffing: "Somebody is always at the desk",
        channels: ["At the counter"],
        coaching: "No",
        discounts: "No",
        children: "No",
        competitions: "No",
        audience: "Anyone",
      });
    });

    await s.step(operator, "sees the plan of a venue with several kinds of facility: a step for shared and linked resources and one for the activities, each once, and nothing for coaches, branches or children", async () => {
      await page.locator('li[data-step="shared-resources"]').waitFor();
      const steps = await planSteps(page);
      expect(new Set(steps).size, `a step is shown twice: ${steps.join(", ")}`).toBe(steps.length);
      for (const wanted of ["activities", "courts", "shared-resources", "prices", "peak-hours", "booking-rules", "cancellation-terms", "test-booking", "launch"]) expect(steps).toContain(wanted);
      for (const unwanted of ["coaches", "coach-hours", "classes", "branches", "copied-branch", "guardians", "participant-requirements", "equipment", "memberships", "discounts", "tournaments", "online-payment"])
        expect(steps, `the plan shows ${unwanted}`).not.toContain(unwanted);
      // Why it is shown is said, from what was answered or what is saved.
      await stepCard(page, "shared-resources").getByText(/^Why you see this: /).waitFor();
      expect(asked).toContain("resources");
    });

    await s.step(operator, "adds the badminton courts from the courts step, as a small venue does", async () => {
      const card = await doItHere(page, "courts");
      await card.getByRole("combobox", { name: /^Activity/ }).selectOption("badminton");
      await card.getByLabel("How many").fill("2");
      await card.getByLabel(/^Off-peak \(/).fill("18");
      await card.getByLabel(/^Peak \(/).fill("25");
      await card.getByRole("button", { name: "Add", exact: true }).click();
      await card.getByText("Added Court 1, Court 2.").waitFor();
    });

    // Not the subject: a full pitch and the two halves it is made of, priced by the hour, and a gym floor with places priced per person (the courts' own API, as the screens send it).
    const ids = await s.step(operator, "has the pitch, its two halves, a gym floor with places and a court sold per person added through the courts' own routes, and the pitch linked to its halves", async () => {
      const made = async (body: Record<string, unknown>) => {
        const r = await operator.api("POST", "/api/admin/courts", { venueId, deposit: 0, ...body });
        expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
        return ((r.body.courts as { id: number }[] | undefined)?.[0] ?? (r.body.court as { id: number })).id;
      };
      const full = await made({ sport: "futsal", name: "Full pitch", offPeakRate: 120, peakRate: 180, capacity: 1 });
      const halfA = await made({ sport: "futsal", name: "Half pitch A", offPeakRate: 70, peakRate: 100, capacity: 1 });
      const halfB = await made({ sport: "futsal", name: "Half pitch B", offPeakRate: 70, peakRate: 100, capacity: 1 });
      const gym = await made({ sport: "gym", name: "Gym floor", offPeakRate: 8, peakRate: 10, capacity: 20 });
      // A court sold per person: each player pays the rate, rather than one price for the court.
      const social = await made({ sport: "padel", name: "Social padel court", offPeakRate: 15, peakRate: 20, capacity: 1, perPlayer: true, maxPlayers: 4 });
      const link = await operator.api("POST", "/api/admin/court-links", { courtId: full, parts: [halfA, halfB] });
      expect(link.status, JSON.stringify(link.body)).toBe(200);
      return { full, halfA, halfB, gym, social };
    });

    await s.step(operator, "comes back to the plan: it lists every priced resource, the places of the gym floor and the per-person court beside the hourly courts, each with its own rates", async () => {
      await page.reload();
      await page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
      const card = await doItHere(page, "prices");
      for (const [name, off, peak] of [["Full pitch", 120, 180], ["Half pitch A", 70, 100], ["Gym floor", 8, 10], ["Social padel court", 15, 20], ["Court 1", 18, 25]] as const) {
        expect(await card.getByLabel(`Off-peak rate for ${name}`, { exact: true }).inputValue()).toBe(String(off));
        expect(await card.getByLabel(`Peak rate for ${name}`, { exact: true }).inputValue()).toBe(String(peak));
      }
      // The venue says which of its resources take places rather than a price per hour.
      const profile = (await operator.api("GET", `/api/admin/guide/setup?venueId=${venueId}`)).body as { profile: { resources: { total: number; linked: number; shared: number; perPlayer: number } } };
      expect(profile.profile.resources).toMatchObject({ total: 7, perPlayer: 1 });
      expect(profile.profile.resources.linked).toBeGreaterThan(0);
      expect(profile.profile.resources.shared).toBeGreaterThan(0);
      expect(ids.gym).toBeGreaterThan(0);
      expect(ids.social).toBeGreaterThan(0);
    });

    await s.step(operator, "reads How to run it: the shared and linked facilities topic is there, with this venue's own counts, and nothing about coaches or classes", async () => {
      await openGuide(page, "How to run it");
      const text = await playbookText(page);
      expect(await page.locator("#topic-shared-linked").count()).toBe(1);
      expect(text).toContain("Shared and linked facilities");
      expect(text).toContain("Courts that share a floor are linked: booking the large court takes all the small courts under it, and booking any small court takes the large one.");
      expect(text).toContain("A shared facility (a gym floor, a lap pool, a studio) takes as many people at the same moment as it has places.");
      expect(text).toMatch(/\d+ of your resources take more than one booking at a time\./);
      expect(text).toMatch(/\d+ of your resources take, or are taken by, another when booked\./);
      expect(text).toMatch(/offering (Badminton|Futsal|Gym|Padel)(, (Badminton|Futsal|Gym|Padel)){3}\./);
      expect(text).toContain("Your venue has 7 bookable resources");
      expect(text).not.toMatch(/Lessons and coaches|Specialised workflows/);
      expectNoPrivate(text, operator.email, operator.password, operator.phone);
      const api = (await playbookApi(operator, venueId)).body as { playbook: { modules: string[] } };
      expect(api.playbook.modules).toContain("booking.availability");
      expect(api.playbook.modules.filter((m) => m.startsWith("spec.") || m === "during.coaching" || m === "during.classes")).toEqual([]);
    });

    await s.step(operator, "finds the same explanation from the \"?\" beside the courts that share a floor on Courts & rates, and Open this in the guide takes it to the same section", async () => {
      await page.getByRole("button", { name: "Courts & rates", exact: true }).click();
      const tip = page.getByRole("button", { name: "Help: How do shared and linked facilities work?" });
      await tip.scrollIntoViewIfNeeded();
      await tip.click();
      const dialog = page.getByRole("dialog", { name: "How do shared and linked facilities work?" });
      await dialog.getByText("Courts that share a floor are linked: booking the large court takes all the small courts under it").waitFor();
      await dialog.getByRole("link", { name: "Open this in the guide" }).click();
      await page.locator("#topic-shared-linked").waitFor();
      expect(page.url()).toContain("view=playbook");
    });
  });

  scenario("Guide C: a coaching academy is guided through coaches and their hours, gets coaching workflows and a coach's own guide, and none of the equipment-hire procedure", async (s) => {
    const operator = await s.actor("Operator");
    const page = operator.page;
    const venueName = `Akademi Badminton Guide ${stamp()}`;
    const venueId = await s.step(operator, "signs the academy up", async () => signUpVenue(operator, venueName));

    await s.step(operator, "answers as an academy: coaching and classes for children, badminton, a few courts, two ways to book, no memberships", async () => {
      await openGuide(page, "Set up");
      const asked = await answerDiscovery(page, {
        types: ["Coaching academy"],
        activities: ["Badminton"],
        customersDo: ["Join classes"],
        resources: "Two to six",
        branches: "One location",
        staffing: "Somebody is always at the desk",
        channels: ["Online, on our page", "At the counter"],
        memberships: [],
        discounts: "No",
        coaching: "Yes",
        children: "Yes",
        competitions: "No",
        audience: "Anyone",
      });
      expect(asked).toContain("coaching");
      expect(asked).toContain("children");
    });

    await s.step(operator, "sees the academy's plan: coaches and their weekly hours, classes and the guardian and participant rules; the hours wait for a coach; no equipment, shared-floor, branch or tournament steps", async () => {
      const steps = await planSteps(page);
      for (const wanted of ["coaches", "coach-hours", "classes", "guardians", "participant-requirements", "courts", "test-booking"]) expect(steps, `the plan lacks ${wanted}`).toContain(wanted);
      for (const unwanted of ["equipment", "shared-resources", "branches", "copied-branch", "tournaments", "memberships", "unattended"]) expect(steps, `the plan shows ${unwanted}`).not.toContain(unwanted);
      const hours = stepCard(page, "coach-hours");
      expect(await hours.getAttribute("data-state")).toBe("blocked");
      await hours.getByText(/^Do first: /).waitFor();
      // The guardian step says guardians are declared, never verified.
      expect(await stepCard(page, "guardians").innerText()).toMatch(/declared, not verified/i);
    });

    const coach = await s.step(operator, "adds two badminton courts, and a coach with weekly hours and a private link (the coach's own routes), and the hours step is no longer waiting", async () => {
      const card = await doItHere(page, "courts");
      await card.getByRole("combobox", { name: /^Activity/ }).selectOption("badminton");
      await card.getByLabel("How many").fill("2");
      await card.getByLabel(/^Off-peak \(/).fill("20");
      await card.getByLabel(/^Peak \(/).fill("30");
      await card.getByRole("button", { name: "Add", exact: true }).click();
      await card.getByText("Added Court 1, Court 2.").waitFor();
      const made = await addCoach(operator, venueId, "Coach Aini Marker", "badminton");
      await page.reload();
      await page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
      expect(await stepCard(page, "coaches").getAttribute("data-state")).toBe("done");
      expect(await stepCard(page, "coach-hours").getAttribute("data-state")).toBe("done");
      return made;
    });

    await s.step(operator, "reads How to run it: coaching, coaching is there, written for this academy, classes and guardians wait for the first class or child, and there is no equipment collection and return", async () => {
      await openGuide(page, "How to run it");
      const text = await playbookText(page);
      const titles = await sectionTitles(page);
      expect(titles).toContain("Specialised workflows");
      expect(text).toContain("Lessons and coaches");
      expect(text).toContain("A lesson is a booking: the house rules, strikes, holds, credit, receipts, cancelling, refunds and reports all apply to it");
      expect(text).toContain("The coach's fee is added to the lesson's price and is its own line on the receipt.");
      const api = (await playbookApi(operator, venueId)).body as { playbook: { modules: string[] } };
      // The playbook is written from what is saved, not from the questionnaire: no class is scheduled and no child or approval is set up yet, so those workflows are not in it (they come with the first one).
      expect(api.playbook.modules).not.toContain("spec.classes");
      expect(api.playbook.modules).not.toContain("spec.guardians");
      // Hire is not this venue's: no collection-and-return procedure, no hire deposit module.
      expect(text).not.toContain("Equipment collection and return");
      expect(text).not.toMatch(/deposit held against that booking|record its condition \(fine, damaged, not returned\)/i);
      expectNoPrivate(text, operator.email, operator.password, operator.phone, "Coach Aini Marker");
      for (const m of ["spec.coaching", "during.coaching"]) expect(api.playbook.modules, m).toContain(m);
      expect(api.playbook.modules).not.toContain("during.hire");
      expect(api.playbook.modules).not.toContain("spec.tournaments");
    });

    const guest = await s.actor("Coach", "phone");
    await s.step(guest, "opens the coach's own guide from the private link on a phone: their lessons and hours, nothing about money or the venue's people, and it fits the screen", async () => {
      await guest.page.goto(`${url}/coach/${coach.token}`);
      await guest.page.getByRole("link", { name: "How to use this page, and what you can see" }).click();
      await guest.page.getByRole("heading", { name: "Your guide as a coach" }).waitFor();
      expect(guest.page.url()).toBe(`${url}/coach/${coach.token}/guide`);
      const text = await playbookText(guest.page);
      expect(text).toContain("Your private page");
      expect(text).toContain("You have set the hours you take lessons.");
      expect(text).toContain("Your hours and days off");
      expect(text).not.toMatch(/Cash-up|Reports|refund|Manager responsibilities|Equipment collection/i);
      expectNoPrivate(text, operator.email, operator.phone, "Coach Aini Marker");
      // A coach has no dashboard: the guide has no screen links.
      expect(await guest.page.locator("[data-link-tab]").count()).toBe(0);
      expect(await fitsScreen(guest.page)).toBeLessThanOrEqual(0);
    });

    await s.step(guest, "is told nothing by a wrong link: the guide of a made-up token is the same not-found as any other page", async () => {
      const res = await guest.page.goto(`${url}/coach/${"x".repeat(43)}/guide`);
      expect(res?.status()).toBe(404);
    });
  });
});
