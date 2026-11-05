import { describe, expect } from "vitest";
import { dayAhead, scenario, signInOwner, url } from "./harness";
import { staffSignIn } from "./families";
import { BILLPLZ_STAND_IN } from "./gateway";
import { answerDiscovery, doItHere, expectNoPrivate, freeHourAt, madeVenue, marketplace, openGuide, planSteps, playbookApi, playbookText, sectionTitles, signUpVenue, stamp, stepCard } from "./guide-support";

/**
 * The venue guide when the business changes, and when MySenam cannot do
 * something (docs/features/venue-guide.md): a price and the hours set from a
 * later date, which the playbook keeps apart from today's (Guide G); an
 * unsupported capability, which neither the public guide nor the dashboard's
 * discover view pretends is there, in English and in Malay (Guide H); and a
 * venue that takes counter payments only, whose set-up and guide never ask for
 * an online provider until online payment is switched on (Guide I).
 */

describe.skipIf(!marketplace)("the venue guide when things change", () => {
  scenario("Guide G: a price and the hours set from a later date are in the playbook beside today's, labelled by their date, never as in force; withdrawn, they leave the next request", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const venue = await madeVenue(owner, "Gelanggang Perubahan", [
      { sport: "badminton", name: "Court 1", offPeakRate: 18, peakRate: 25 },
      { sport: "badminton", name: "Court 2", offPeakRate: 18, peakRate: 25 },
    ]);
    const manager = await s.actor("Manager");
    await staffSignIn(manager, venue.manager.email);
    const page = manager.page;
    const ratesFrom = dayAhead(10);
    const hoursFrom = dayAhead(12);

    await s.step(manager, "reads the playbook before any change: today's hours and rates, and nothing coming", async () => {
      await openGuide(page, "How to run it");
      const text = await playbookText(page);
      expect(text).toContain("It opens from 8:00 AM to 11:00 PM today.");
      expect(text).toContain("Today's rates run from RM18 to RM25 an hour");
      expect(text).not.toContain("Coming changes");
      expect(await page.locator('[data-callout="scheduled"]').count()).toBe(0);
    });

    await s.step(manager, `sets Court 1's rates from ${ratesFrom} on Courts & rates: RM22 off-peak, RM30 peak`, async () => {
      await page.getByRole("button", { name: "Courts & rates", exact: true }).click();
      const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "Rates and a court's own hours from a date" }) });
      await section.scrollIntoViewIfNeeded();
      await section.getByRole("combobox", { name: /^Court/ }).first().selectOption({ label: "Court 1" });
      await section.getByLabel("From", { exact: true }).fill(ratesFrom);
      await section.getByLabel(/^Off-peak \(/).fill("22");
      await section.getByLabel(/^Peak \(/).fill("30");
      await section.getByRole("button", { name: "Set from this date" }).click();
      await section.getByText(`Saved: from ${ratesFrom}.`).waitFor();
      await section.getByText(`From ${ratesFrom}`, { exact: true }).waitFor();
    });

    await s.step(manager, `sets the usual hours from ${hoursFrom} on Venue details: closing at 9 PM instead of 11 PM`, async () => {
      await page.goto(`${url}/admin?tab=venues`);
      await page.getByRole("button", { name: /sign out/i }).waitFor();
      const summary = page.getByText("Change the hours from a date", { exact: true });
      await summary.scrollIntoViewIfNeeded();
      await summary.click();
      const form = page.locator("details").filter({ has: summary });
      await form.getByLabel("From", { exact: true }).fill(hoursFrom);
      await form.getByLabel("Closes from that date").fill("21:00");
      await form.getByRole("button", { name: "Set from this date" }).click();
      await form.getByText(`Saved: from ${hoursFrom}.`).waitFor();
    });

    await s.step(manager, "reads the playbook again: today's hours and rates are as they were; the changes are in a section of their own, each labelled Coming later with its date", async () => {
      await openGuide(page, "How to run it");
      const text = await playbookText(page);
      // In force today: the old.
      expect(text).toContain("It opens from 8:00 AM to 11:00 PM today.");
      expect(text).toContain("Opening hours today8:00 AM to 11:00 PM");
      expect(text).toContain("Today's rates run from RM18 to RM25 an hour");
      expect(text).toContain("Rates in force todayRM18 to RM25 an hour");
      // Coming: the new, apart, with the date and never as today's.
      const coming = page.locator('[data-callout="scheduled"]');
      expect(await coming.count()).toBe(2);
      const callouts = await coming.allInnerTexts();
      for (const c of callouts) {
        expect(c).toContain("Coming later");
        expect(c).toMatch(/Coming on /);
      }
      const hours = callouts.find((c) => c.includes("opening hours"))!;
      const rates = callouts.find((c) => c.includes("The rates change"))!;
      expect(hours).toContain("The usual opening hours change to 8:00 AM to 9:00 PM. Until then today's hours stand, and bookings already made stay as they are.");
      expect(rates).toContain("The rates change on 1 of your resources. Until then today's rates stand, and a booking already made keeps the price it was sold at.");
      // The dates are the ones set, written as the dashboard writes a day.
      const dateWord = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-MY", { day: "numeric", month: "short", timeZone: "UTC" });
      expect(hours.replace(/\s+/g, " ")).toContain(dateWord(hoursFrom));
      expect(rates.replace(/\s+/g, " ")).toContain(dateWord(ratesFrom));
      // The new figures are not in today's statements: the closing hour is 9 PM only inside the coming one.
      expect(text).not.toContain("8:00 AM to 9:00 PM today");
      expect(text).not.toMatch(/RM22 to RM30/);
      expect(text).toContain("Coming changes");
      expect(text).toContain("Until then today's hours stand");
    });

    await s.step(manager, "finds what the app does for the dates: a customer is quoted today's price today and the new one from its day", async () => {
      const today = await manager.api("GET", `/api/availability?venueId=${venue.venueId}&date=${dayAhead(3)}&sport=badminton`);
      const later = await manager.api("GET", `/api/availability?venueId=${venue.venueId}&date=${dayAhead(11)}&sport=badminton`);
      const rate = (r: { body: Record<string, unknown> }, name: string) => {
        const a = (r.body.availability as { court: { name: string; offPeakRate: number; peakRate: number } }[]).find((x) => x.court.name === name)!;
        return [a.court.offPeakRate, a.court.peakRate];
      };
      expect(rate(today, "Court 1")).toEqual([18, 25]);
      expect(rate(today, "Court 2")).toEqual([18, 25]);
      // From its date Court 1 is priced at the new rates (and Court 2, which was not changed, at the old).
      expect(rate(later, "Court 1")).toEqual([22, 30]);
      expect(rate(later, "Court 2")).toEqual([18, 25]);
      // The hours change is also the app's own: after its date the day closes at 9 PM, and not before.
      const closing = (r: { body: Record<string, unknown> }) => Math.max(...(r.body.availability as { starts: { minute: number }[] }[]).flatMap((a) => a.starts.map((st) => st.minute)));
      const afterHours = await manager.api("GET", `/api/availability?venueId=${venue.venueId}&date=${dayAhead(13)}&sport=badminton`);
      expect(closing(today)).toBe(22 * 60);
      expect(closing(afterHours)).toBe(20 * 60);
    });

    await s.step(manager, "withdraws the rates change on Courts & rates (after the confirmation): the next playbook has only the hours coming", async () => {
      await page.goto(`${url}/admin?tab=courts`);
      await page.getByRole("button", { name: /sign out/i }).waitFor();
      const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "Rates and a court's own hours from a date" }) });
      await section.scrollIntoViewIfNeeded();
      page.once("dialog", (d) => void d.accept());
      await section.getByRole("button", { name: "Withdraw" }).click();
      await section.getByText("Withdrawn.", { exact: false }).waitFor();
      await openGuide(page, "How to run it");
      const text = await playbookText(page);
      expect(text).not.toContain("The rates change on");
      expect(text).toContain("The usual opening hours change to 8:00 AM to 9:00 PM.");
      expect(await page.locator('[data-callout="scheduled"]').count()).toBe(1);
      // A fresh read, not a kept one: the same address answers the same from the server.
      const api = (await playbookApi(manager, venue.venueId)).body as { playbook: { scheduled: unknown[] } };
      expect(JSON.stringify(api.playbook.scheduled)).toContain(hoursFrom);
      expect(JSON.stringify(api.playbook.scheduled)).not.toContain(ratesFrom);
    });

    await s.step(manager, "finds the setup journey's price step listing the waiting change too, from the same saved state", async () => {
      await page.goto(`${url}/admin?tab=guide&view=setup&stage=plan&venue=${venue.venueId}`);
      const card = await doItHere(page, "price-dates");
      await card.getByText("Change hours from a later date", { exact: true }).click();
      await card.getByText(`From ${hoursFrom}`, { exact: true }).first().waitFor();
    });
  });

  scenario("Guide H: an archery range is told, in English and Malay, that rostered range officers are available; what is not supported is still said plainly; gym entry and day passes are not among it; setup never offers what is not built", async (s) => {
    const visitor = await s.actor("Visitor");
    const page = visitor.page;

    await s.step(visitor, "chooses an archery range and a gym, refining by archery, on the public guide", async () => {
      await page.goto(`${url}/for-venues`);
      await page.getByRole("heading", { name: "How MySenam fits your business", level: 1 }).waitFor();
      await page.getByLabel("Archery or other supervised sport").check();
      await page.getByLabel("Gym or fitness centre").check();
      await page.getByText("Refine by activity (optional)").click();
      await page.getByLabel("Archery", { exact: true }).check();
      await page.getByRole("button", { name: "Show how it fits" }).click();
      await page.getByRole("heading", { name: "What MySenam does not do", exact: true }).waitFor();
      expect(page.url()).toContain("types=");
    });

    await s.step(visitor, "reads what MySenam can do for a range: the rostered range officer is among what is available and not among what it does not do; gym entry and day passes are not under what it does not do either", async () => {
      const not = page.locator("#not");
      expect(await not.innerText()).not.toMatch(/rostered supervisor|Scheduling a range officer|Gym entry without booking a session|Open-ended day passes/);
      // What is not supported for any venue is still said plainly.
      await not.getByText("Not supported for any venue").waitFor();
      // The groups of what is available: the range officer is in one that is not the unsupported group.
      const groups = await page.locator("#available > div > div").evaluateAll((divs) => divs.map((d) => ({ heading: d.querySelector("h3")?.textContent ?? "", items: [...d.querySelectorAll("li")].map((li) => li.textContent ?? "") })));
      const listed = groups.filter((x) => !x.heading.includes("Not currently supported")).flatMap((g) => g.items);
      expect(listed.some((i) => i.includes("A rostered supervisor for each session"))).toBe(true);
      for (const g of groups.filter((x) => x.heading.includes("Not currently supported")))
        for (const item of g.items) expect(item, `${g.heading} lists ${item}`).not.toMatch(/rostered supervisor|Gym entry without booking a session|Open-ended day passes/);
      // Archery is fully supported: the catalogue's note has nothing not built to say of it.
      expect(await page.locator("#know").innerText()).not.toMatch(/range officer/);
    });

    await s.step(visitor, "switches the page to Bahasa Malaysia: the heading and the rostered range officer are in Malay, and nothing says it is not supported", async () => {
      await page.getByTitle("Bahasa Malaysia", { exact: true }).first().click();
      await page.getByRole("heading", { name: "Bagaimana MySenam sesuai dengan perniagaan anda", level: 1 }).waitFor();
      await page.locator("#available").getByText("Penyelia dalam jadual bagi setiap sesi").waitFor();
      expect(await page.locator("#not h3").count()).toBeGreaterThan(0);
      const text = (await page.locator("#available").innerText()).replace(/\s+/g, " ");
      expect(text).not.toMatch(/Not currently supported/);
      expect(await page.locator("#not").innerText()).not.toContain("Penyelia dalam jadual bagi setiap sesi");
      await page.getByTitle("English", { exact: true }).first().click();
      await page.getByRole("heading", { name: "How MySenam fits your business", level: 1 }).waitFor();
    });

    await s.step(visitor, "goes on to list the venue with the same choices: the form says what was chosen, and exploring the guide wrote nothing", async () => {
      await page.getByRole("link", { name: "List your venue with these choices" }).click();
      await page.getByText(/You told us you run:/).waitFor();
      const href = new URL(page.url());
      expect(href.pathname).toBe("/list-your-venue");
      expect(href.searchParams.get("fit")).toContain("archery-and-supervised");
      // Nothing was stored by looking: the guide is public and the choice travels in the address (the only cookie is the language's).
      expect((await page.context().cookies()).filter((c) => c.name !== "ms_lang")).toEqual([]);
    });

    const operator = visitor;
    const venueId = await s.step(operator, "signs up with that choice carried into the form", async () => signUpVenue(operator, `Pusat Memanah Guide ${stamp()}`, { here: true }));

    await s.step(operator, "opens Guide → Set up: not asked again what kind of venue it is or what it offers; archery is shown with no limitation, since its rostered range officer is built", async () => {
      await openGuide(page, "Set up");
      const p = page;
      await p.locator("#guide-setup-heading").waitFor();
      // The kinds and the activities came with the application, so the guide does not begin by asking them: it opens on the plan and says how many questions are still open.
      await p.locator('[data-guide-setup][data-stage="plan"]').waitFor();
      await p.getByText(/^\d+ questions about your business are still open\./).waitFor();
      await p.getByRole("button", { name: "Answer them" }).click();
      await p.locator("[data-question]").first().waitFor();
      expect(await p.locator("[data-question]").first().getAttribute("data-question")).toBe("customersDo");
      // Going back shows what was said, ticked.
      await p.getByRole("button", { name: "Back", exact: true }).click();
      await p.locator('[data-question="activities"]').waitFor();
      expect(await p.getByRole("checkbox", { name: /(^|\s)Archery(\s|$)/ }).first().isChecked()).toBe(true);
      expect(await p.locator('[data-question="activities"]').innerText()).not.toMatch(/Not built: scheduling a range officer/);
      await p.getByRole("button", { name: "Back", exact: true }).click();
      await p.locator('[data-question="types"]').waitFor();
      expect(await p.getByLabel("Archery or other supervised sport", { exact: true }).isChecked()).toBe(true);
      expect(await p.getByLabel("Gym or fitness centre", { exact: true }).isChecked()).toBe(true);
      await p.getByRole("button", { name: "Go to my plan" }).click();
      // No step sets up what MySenam cannot do.
      const html = await p.locator("[data-guide-setup]").innerHTML();
      expect(html).not.toMatch(/web-push|native-app|surge-pricing|Scheduling a range officer/);
    });

    await s.step(operator, "opens Discover: every unsupported thing says so, what to do instead, and has no way to set it up; gym entry and day passes are available", async () => {
      const p = page;
      await openGuide(p, "Discover");
      await p.getByRole("heading", { name: "Everything MySenam can do" }).waitFor();
      // The catalogue is in groups, each folded: open every one, as a person does.
      for (const summary of await p.locator("details[data-group] > summary").all()) await summary.click();
      const unsupported = p.locator('li[data-capability][data-state="unsupported"]');
      expect(await unsupported.count()).toBe(9);
      for (const li of await unsupported.all()) {
        const id = await li.getAttribute("data-capability");
        await li.getByText("Not currently supported", { exact: true }).waitFor();
        expect(await li.innerText(), `${id} has no alternative`).toMatch(/Instead: /);
        expect(await li.locator("[data-setup], a[href*='focus=']").count(), `${id} offers a setup`).toBe(0);
        // Its only control is to read how it works: no Set this up, no Open screen.
        expect(await li.getByRole("button").allTextContents(), `${id} has controls`).toEqual(["How it works"]);
        expect(await li.getByRole("link").count(), `${id} has links`).toBe(0);
      }
      // The rostered range officer is built now: available, not among the unsupported.
      const officer = p.locator('li[data-capability="range-officer"]').first();
      await officer.getByText("A rostered supervisor for each session").waitFor();
      expect(await officer.getAttribute("data-state")).not.toBe("unsupported");
      // Built now: gym entry and day passes are not unsupported.
      for (const id of ["gym-walk-in", "open-day-pass", "bowling-by-game", "range-officer"])
        expect(await p.locator(`li[data-capability="${id}"]`).first().getAttribute("data-state"), id).not.toBe("unsupported");
      // Nothing unsupported is among the suggestions.
      const suggestions = await p.locator('li[data-capability][data-state="available"]:has-text("Suggested above")').evaluateAll((els) => els.map((e) => e.getAttribute("data-capability")));
      for (const id of await unsupported.evaluateAll((els) => els.map((e) => e.getAttribute("data-capability")))) expect(suggestions, id ?? "").not.toContain(id);
      expect(venueId).toBeGreaterThan(0);
    });
  });

  scenario("Guide I: a venue that takes counter payments only completes its setup and gets its playbook without an online provider being asked for; switching online payment on (a sandbox stand-in, not Billplz) makes the provider's verification appear", async (s) => {
    const operator = await s.actor("Operator");
    const page = operator.page;
    const venueName = `Dewan Kaunter Guide ${stamp()}`;
    const venueId = await s.step(operator, "signs the venue up", async () => signUpVenue(operator, venueName));

    await s.step(operator, "says customers book at the counter only: no online payment step is in the plan, and no online account is asked for", async () => {
      await openGuide(page, "Set up");
      const asked = await answerDiscovery(page, {
        types: ["Badminton and pickleball centre"],
        activities: ["Badminton"],
        customersDo: ["Reserve courts or rooms"],
        resources: "Two to six",
        branches: "One location",
        staffing: "Somebody is always at the desk",
        channels: ["At the counter"],
        discounts: "No",
        children: "No",
        competitions: "No",
        audience: "Anyone",
      });
      expect(asked).toContain("channels");
      const steps = await planSteps(page);
      expect(steps).toContain("counter-payments");
      expect(steps).not.toContain("online-payment");
    });

    await s.step(operator, "completes the required steps: confirms the hours, adds two courts, makes a test booking", async () => {
      const hours = await doItHere(page, "details");
      await hours.getByRole("button", { name: "They are right as they are" }).click();
      await hours.getByText("Noted: your hours are right as they are.").waitFor();
      const card = await doItHere(page, "courts");
      await card.getByRole("combobox", { name: /^Activity/ }).selectOption("badminton");
      await card.getByLabel("How many").fill("2");
      await card.getByLabel(/^Off-peak \(/).fill("18");
      await card.getByLabel(/^Peak \(/).fill("25");
      await card.getByRole("button", { name: "Add", exact: true }).click();
      await card.getByText("Added Court 1, Court 2.").waitFor();
      const slot = await freeHourAt(venueId, "badminton", operator, 2);
      const pub = await operator.context.newPage();
      await pub.goto(`${url}/venue/${venueId}?date=${slot.date}&sport=badminton&court=${slot.courtId}&hour=${slot.hour}&duration=1`);
      await pub.getByLabel("Name").fill("Operator Tester");
      await pub.getByLabel("Phone").fill(operator.phone);
      await pub.getByRole("button", { name: /^Book · RM/ }).click();
      await pub.getByText("Booking confirmed!").waitFor({ timeout: 15_000 });
      await pub.close();
      await page.reload();
      await page.getByText("3 of 3 required steps done").waitFor();
    });

    await s.step(operator, "reads the readiness: nothing required is missing and no online provider is mentioned, neither as missing nor as unverified", async () => {
      const launch = stepCard(page, "launch");
      await launch.scrollIntoViewIfNeeded();
      await launch.locator('[data-ready-group="requiredMissing"]').getByText("Nothing here.").waitFor();
      const readiness = await launch.locator("[data-readiness]").innerText();
      expect(readiness).not.toMatch(/online payment|payment account|Billplz|Stripe|gateway/i);
      expect(await stepCard(page, "test-booking").locator('[data-try="online"]').count()).toBe(0);
    });

    await s.step(operator, "reads the playbook: payment is at the counter, and there is no online-payment verification, gateway or online refund procedure in it", async () => {
      await openGuide(page, "How to run it");
      const text = await playbookText(page);
      expect(text).toContain("Online payment is off: customers pay at the counter.");
      expect(text).toContain("Customers pay at the counter, so no money goes back through a gateway.");
      expect(text).not.toMatch(/Billplz|Stripe|test mode|has not been checked|not yet proven/i);
      const api = (await playbookApi(operator, venueId)).body as { playbook: { modules: string[] } };
      expect(api.playbook.modules).not.toContain("eod.owedOnline");
      expect(api.playbook.modules).not.toContain("cancel.manual");
      expectNoPrivate(text, operator.email, operator.password, operator.phone);
    });

    await s.step(operator, "switches online payment on from Venue details with the sandbox stand-in's keys (Billplz-sandbox-like, not Billplz): saved, in test mode", async () => {
      await page.getByRole("button", { name: "Branches & staff", exact: true }).click();
      const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Online payment", level: 2 }) });
      await panel.scrollIntoViewIfNeeded();
      await panel.getByLabel("API secret key").fill(BILLPLZ_STAND_IN.apiKey);
      await panel.getByLabel("Collection ID").fill(BILLPLZ_STAND_IN.collectionId);
      await panel.getByLabel("X Signature key").fill(BILLPLZ_STAND_IN.xSignatureKey);
      await panel.getByLabel("Customers can pay online").check();
      await panel.getByLabel("Sandbox (test payments, no real money)").check();
      await panel.getByRole("button", { name: "Save", exact: true }).click();
      await panel.getByText("Checked with the gateway and saved. Customers can pay online.").waitFor();
    });

    await s.step(operator, "finds the plan changed: the online payment step is there and says connected, not yet proven; the readiness now lists the provider as unverified, in test mode", async () => {
      await openGuide(page, "Set up");
      const online = stepCard(page, "online-payment");
      await online.waitFor();
      await online.getByText(/Connected, and the connection was checked when it was saved; no payment has been taken yet, so it is not proven until one is\./).waitFor();
      const launch = stepCard(page, "launch");
      await launch.scrollIntoViewIfNeeded();
      const unverified = launch.locator('[data-ready-group="unverifiedExternal"]');
      await unverified.getByText("Your online payment account is in test mode: no real money moves until it is switched to live.").waitFor();
      // Why it is on the list: a sandbox account, or a stand-in, proves nothing about the real provider.
      await unverified.getByText("Only a real payment taken through it shows that it works.").waitFor();
      // Taking money online makes the cancellation and refund terms a step needed before going live (as the setup says it does); the provider itself is not one, and nothing is called verified.
      const missing = await launch.locator('[data-ready-group="requiredMissing"]').innerText();
      expect(missing).toContain("Review your cancellation and refund terms");
      expect(missing).not.toMatch(/online payment account/i);
      expect(await launch.locator("[data-readiness]").innerText()).not.toMatch(/\bverified\b(?!.*not)/i);
      // The Try it step now has a line for online payment, not checked by MySenam.
      const tryIt = stepCard(page, "test-booking").locator('[data-try="online"]');
      await tryIt.waitFor();
      expect(await tryIt.getAttribute("data-mark")).toBe("unchecked");
      await tryIt.getByText("Not checked by MySenam").waitFor();
      await stepCard(page, "test-booking").getByText(/MySenam's own tests of payments use stand-in services\. Only a real payment through your own account proves the provider/).first().waitFor();
    });

    await s.step(operator, "reads the playbook again: online payment is on in test mode with Billplz, never called verified, with what Billplz cannot do; the keys are nowhere in it", async () => {
      await openGuide(page, "How to run it");
      const text = await playbookText(page);
      expect(text).toContain("Online payment is on in test mode with Billplz");
      expect(text).toContain("Billplz has no refund API");
      expect(text).not.toMatch(/Online payment is off/);
      expectNoPrivate(text, BILLPLZ_STAND_IN.apiKey, BILLPLZ_STAND_IN.collectionId, BILLPLZ_STAND_IN.xSignatureKey, operator.email, operator.password);
      const titles = await sectionTitles(page);
      expect(titles).toContain("Cancellations and refunds");
      const wire = JSON.stringify((await playbookApi(operator, venueId)).body) + JSON.stringify((await operator.api("GET", `/api/admin/guide/setup?venueId=${venueId}`)).body);
      for (const secret of [BILLPLZ_STAND_IN.apiKey, BILLPLZ_STAND_IN.xSignatureKey, BILLPLZ_STAND_IN.collectionId]) expect(wire).not.toContain(secret);
    });
  });
});
