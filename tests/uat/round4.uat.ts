import fs from "fs";
import net from "net";
import { describe, expect, inject } from "vitest";
import type { Page } from "playwright-core";
import { freeSlot, gone, scenario, signInOwner, signUp, url, type Actor } from "./harness";
import { applyFor, archeryRange, confirmedCode, decideApi, family, laneLink, STAFF_PASSWORD, staffApi, staffSignIn, type Child, type Range } from "./families";

/**
 * Who may act for a child, supporting documents a scanner could not pass,
 * and what the platform owner records about how long applications are
 * kept, as the people involved meet them:
 *
 * - **Guardians G, H** (ADR 0023, amended 27 October 2026: another guardian
 *   only by verified consent; lib/guardian-requests.ts). The front desk starts
 *   a request for an adult who asks at the counter; a single-use code for
 *   their own account; nothing granted until the existing guardian agrees
 *   online; the existing guardian told by email, never who asked; a refusal
 *   that grants nothing; a change reported as a mistake and paused by a
 *   manager. Then a second guardian books for a child on the approval the
 *   first guardian applied for, and still cannot open that application.
 * - **Documents I** (ADR 0024, amended 27 October 2026: fail closed, owner
 *   retry). A document sent while the scanner is away waits in quarantine;
 *   one a working scanner cannot scan fails; the platform owner has it
 *   scanned again with a reason; once it passes the reviewer opens it.
 * - **Places K, L** (ADR 0025: benefits by scope, one person taken off). A
 *   guardian takes one child off a pool session sold by the place: the other
 *   stays booked, the place goes to the waiting list, and only that place's
 *   price comes off; a session sold whole refuses, saying why. One child's own
 *   concession on a booking for two: on her place alone, once, with no code
 *   on top (one discount), on the receipt; her proof checked and remembered.
 * - **Recovery J** (ADR 0024: review provenance). The retention review form
 *   asks for who reviewed what, on what written advice, and says it is the
 *   platform owner's record, not verified by MySenam; changing a period lapses
 *   it. The erasure ledger and the restore gate have nothing to drive in a
 *   browser: tests/erasure-ledger-restore.test.ts runs the real scripts.
 *
 * **The malware scanner here is the acceptance stand-in, not ClamAV**
 * (tests/uat/scanner.ts): it speaks clamd's protocol, and the scenarios set
 * how it behaves (`UAT-MODE up|down|error`). It proves nothing about the
 * engine (tests/document-scanning-engine.test.ts does). Against a deployment
 * there is no stand-in, and Documents I is skipped rather than passed.
 *
 * Emails: the acceptance server sends with MYSENAM_SEND=log, and its output is
 * kept beside the evidence (tests/uat/setup.ts), so a scenario reads there
 * what an email said. Against a deployment only the queued message is checked.
 */

const scanner = inject("uatScanner");
const serverLog = inject("uatServerLog");

/** A command to the scanner stand-in (its own, not clamd's): its answer. */
async function standIn(command: string): Promise<string> {
  const [host, port] = scanner!.split(":");
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port: Number(port) }, () => socket.write(`z${command}\0`));
    let reply = "";
    socket.on("data", (d) => (reply += d.toString()));
    socket.on("end", () => resolve(reply.replace(/\0/g, "")));
    socket.on("error", reject);
  });
}

/**
 * The emails the app sent to one address, from its output (MYSENAM_SEND=log
 * writes `[outbox] email → <to>`, the subject, then the text).
 */
function emailsTo(address: string): { subject: string; text: string }[] {
  if (!serverLog || !fs.existsSync(serverLog)) return [];
  return fs
    .readFileSync(serverLog, "utf8")
    .split("[outbox] ")
    .filter((chunk) => chunk.startsWith(`email → ${address}\n`))
    .map((chunk) => {
      const lines = chunk.split("\n").slice(1);
      const end = lines.findIndex((l, i) => i > 0 && l.startsWith("["));
      const body = (end < 0 ? lines : lines.slice(0, end)).join("\n").trim();
      return { subject: lines[0], text: body.slice(lines[0].length).trim() };
    });
}

/** A one-page PDF that passes the structural checks (lib/approval-documents.ts), with a comment of our own after its header. */
function pdf(comment: string): Buffer {
  const body =
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
  return Buffer.from(`%PDF-1.7\n% ${comment}\n${body}`, "latin1");
}

/** An application for a child, with a certificate where the range asks for one, on the venue's form. */
async function applyOnPage(page: Page, venueId: number, child: string, file?: { name: string; buffer: Buffer }) {
  await page.goto(`${url}/account/approvals?venueId=${venueId}&sport=archery`);
  await page.getByLabel("Who is this application for?").selectOption({ label: child });
  if (file) await page.locator('input[type="file"]').setInputFiles({ name: file.name, mimeType: "application/pdf", buffer: file.buffer });
  await page.getByLabel(/range officer's calls/).check();
  await page.getByLabel(/have the authority to apply for them/).check();
  await page.getByRole("button", { name: "Send application" }).click();
  // A scan that does not answer keeps the parent waiting no longer than 20 seconds (lib/document-scanning.ts).
  await page.getByText("Sent. The venue reviews it and you hear by email.").waitFor({ timeout: 40_000 });
}

/** The reviewer's row for one child's application, among those waiting. */
const waitingRow = (page: Page, child: string) =>
  page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Applications waiting for review" }) })
    .locator("li")
    .filter({ hasText: new RegExp(`for ${child}\\b`) });

/** The "People you manage" section of the account page. */
const peopleOf = (page: Page) => page.locator("section#people");

/**
 * At the counter, an adult in front of the desk (typed as the number holder)
 * asks to become a guardian of a child the venue knows: found by a recorded
 * guardian's number, and a single-use code made for the adult's own account.
 * Returns the code, shown this once.
 */
async function inviteAtCounter(page: Page, range: Range, at: { courtId: number; date: string; hour: number }, adult: Actor, guardianPhone: string, child: string): Promise<string> {
  const adultName = `${adult.name} Tester`;
  await page.goto(laneLink(range.venueId, at.courtId, at.date, at.hour));
  await page.getByRole("button", { name: /^Book · RM/ }).waitFor();
  await page.getByLabel("Name", { exact: true }).fill(adultName);
  await page.getByLabel("Phone", { exact: true }).fill(adult.phone);
  await page.getByRole("button", { name: "For somebody on this number (a child)?" }).click();
  await page.getByText("Nobody this venue knows on this number.").waitFor();
  await page.getByRole("button", { name: "An adult not on record asks to become a guardian of a child we know?" }).click();
  const box = page.getByTestId("add-guardian");
  await box.getByText(/They act for the child only once an existing guardian agrees online, or a manager records an exception/).waitFor();
  await box.getByLabel("A recorded guardian's number").fill(guardianPhone);
  await box.getByRole("button", { name: "Find", exact: true }).click();
  await box.getByRole("radio", { name: new RegExp(`^${child}\\b`) }).check();
  await box.getByLabel(`Email of ${adultName}'s MySenam account (optional: then only that account can accept)`).fill(adult.email);
  await box.getByRole("button", { name: `Make an invitation code for ${adultName}` }).click();
  const shown = box.getByRole("status");
  await shown.getByText(`Until it is accepted and agreed, ${adultName} cannot book for ${child} or see anything about them.`, { exact: false }).waitFor();
  return (await shown.textContent())!.match(/[A-Z2-9]{5}-[A-Z2-9]{5}/)![0];
}

/** A code accepted on the adult's own people page, with their own declaration. */
async function acceptCode(page: Page, code: string) {
  await page.goto(`${url}/account`);
  const form = peopleOf(page).locator("form").filter({ hasText: "Have a code?" });
  await form.getByLabel("Code", { exact: true }).fill(code);
  await form.getByLabel("If you are becoming their guardian, you are their").selectOption("parent");
  await form.getByLabel(/^If you are becoming their guardian: I am their parent/).check();
  await form.getByRole("button", { name: "Accept", exact: true }).click();
}

/**
 * Everything an adult who does not act for a child might try, refused: the
 * child is not among their people, nor in the booking form, nor in search's
 * picker; a booking for them, an application for them, and their
 * applications, by the API too.
 */
async function nothingAbout(a: Actor, range: Range, child: Child, at: { courtId: number; date: string; hour: number }) {
  const page = a.page;
  await page.goto(`${url}/account`);
  await peopleOf(page).getByText("Nobody yet.").waitFor();
  const mine = (await a.api("GET", "/api/my/people?archived=1")).body as { people: { id: number }[] };
  expect(mine.people.map((p) => p.id)).not.toContain(child.id);
  await page.goto(laneLink(range.venueId, at.courtId, at.date, at.hour));
  await page.getByRole("button", { name: /^Book · RM/ }).waitFor();
  expect(await page.getByLabel(`${child.name} (booked by you)`).count()).toBe(0);
  await page.goto(`${url}/search?sport=archery&date=${at.date}`);
  await page.getByTestId("taking-picker").waitFor();
  expect(await page.getByTestId("taking-picker").getByRole("button", { name: child.name, exact: true }).count()).toBe(0);
  const booked = await a.api("POST", "/api/bookings", {
    courtId: at.courtId,
    sport: "archery",
    date: at.date,
    start: at.hour * 60,
    end: at.hour * 60 + 60,
    name: `${a.name} Tester`,
    phone: a.phone,
    participantIds: [child.id],
    customerTakesPart: false,
  });
  expect([booked.status, booked.body.code]).toEqual([404, "GUARD_NOT_FOUND"]);
  const applied = await a.api("POST", "/api/my/approvals", { venueId: range.venueId, sport: "archery", declaration: true, forPerson: child.id, authority: true });
  expect(applied.status).toBe(404);
  const theirs = (await a.api("GET", "/api/my/approvals")).body.requests as { forPerson: { name: string } | null }[];
  expect(theirs.filter((r) => r.forPerson?.name === child.name)).toEqual([]);
}

describe("guardians by verified consent", () => {
  scenario("Guardians G: a father asks the front desk to become his daughter's guardian too; nothing is his until her mother agrees online, she is told by email without his name, a stranger she refuses gets nothing, and a change she reports is paused by a manager", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const range = await archeryRange(owner, "Panahan Kepong");
    const mgrApi = await staffApi(await s.actor("Manager API"), range.manager.email);
    const {
      parent: mother,
      kids: [aisyah],
    } = await family(s, "Mother", ["Aisyah"]);
    // The venue knows Aisyah: her mother applied for her there, and the venue approved (setup).
    await decideApi(mgrApi, range.venueId, await applyFor(mother, range.venueId, aisyah), "approve");
    const father = await signUp(await s.actor("Father"));
    const stranger = await signUp(await s.actor("Stranger"));
    const slot = await freeSlot({ sport: "archery", venueId: range.venueId, hours: [14, 15, 16, 17] });
    const desk = await s.actor("Desk");

    const fatherCode = await s.step(desk, "at the counter, finds Aisyah by her mother's number and makes a single-use code for her father's own account, shown once; nothing granted yet", async () => {
      await staffSignIn(desk, range.desk.email);
      return inviteAtCounter(desk.page, range, slot, father, mother.phone, "Aisyah");
    });

    await s.step(father, "before accepting: Aisyah is nowhere on his account, and booking or applying for her is refused", async () => {
      await nothingAbout(father, range, aisyah, slot);
    });

    await s.step(father, "accepts the code signed in, with his own declaration: pending, and still nothing about Aisyah is his", async () => {
      await acceptCode(father.page, fatherCode);
      const people = peopleOf(father.page);
      await people.getByText("Accepted. You can act for Aisyah once one of their guardians agrees, or the venue records an exception. Until then nothing about them is shown to you.").waitFor();
      await people.getByText("Your request to act for Aisyah is waiting for one of their guardians to agree, or for the venue.").waitFor();
      await nothingAbout(father, range, aisyah, slot);
    });

    await s.step(mother, "is told by email that another adult asked: Aisyah named, what, when, where to answer or report a mistake, the venue to call; never who", async () => {
      const subject = "Aisyah: another adult asked to become their guardian";
      // The venue's messages (opening them sends what is due): one to the mother, about Aisyah.
      await expect
        .poll(async () => {
          const list = (await mgrApi.api("GET", `/api/admin/messages?venueId=${range.venueId}`)).body.messages as { recipient: string; subject: string | null; status: string }[];
          return list.filter((m) => m.recipient === mother.email && m.subject === subject).map((m) => m.status);
        })
        .toEqual(["sent"]);
      for (const other of [father, stranger]) {
        const list = (await mgrApi.api("GET", `/api/admin/messages?venueId=${range.venueId}`)).body.messages as { recipient: string }[];
        expect(list.filter((m) => m.recipient === other.email)).toEqual([]);
      }
      if (serverLog) {
        const mails = emailsTo(mother.email).filter((m) => m.subject === subject);
        expect(mails).toHaveLength(1);
        const text = mails[0].text;
        expect(text).toMatch(/^Hi Mother,/);
        expect(text).toMatch(/On \d{4}-\d{2}-\d{2} \d{1,2}:\d{2} [AP]M, another adult asked to become Aisyah's guardian\. Nothing changes unless you agree, or the venue's manager records an exception\./);
        expect(text).toContain(`If this is not right, report it as a mistake on your people page: ${url}/account?lang=en#people`);
        expect(text).toContain(`You can also contact ${range.name} on 03-7877 3000.`);
        for (const never of ["Father", father.email, father.phone, range.desk.name]) expect(text).not.toContain(never);
      }
      await mother.page.goto(`${url}/account`);
    });

    await s.step(mother, "finds the request on her people page, started by the desk at the venue, and agrees", async () => {
      const people = peopleOf(mother.page);
      const waiting = people.locator("div").filter({ has: mother.page.getByText("Waiting for your answer", { exact: true }) });
      await waiting.getByText(`Father Tester asked to become Aisyah's guardian, as their parent. Started by ${range.desk.name} at ${range.name}.`).waitFor();
      await waiting.getByText("They act for Aisyah only if you agree. Refuse if you do not know them or it is not right.").waitFor();
      await waiting.getByRole("button", { name: "Agree", exact: true }).click();
      await people.getByText("Agreed: they now act for Aisyah too.").waitFor();
      await gone(people.getByText("Waiting for your answer", { exact: true }));
    });

    await s.step(father, "now manages Aisyah alongside her mother", async () => {
      await father.page.goto(`${url}/account`);
      const row = peopleOf(father.page).locator("li").filter({ hasText: "Aisyah" });
      await row.getByText(/parent · 1 other guardian\(s\)/).waitFor();
      await gone(peopleOf(father.page).getByText(/Your request to act for Aisyah is waiting/));
    });

    const strangerCode = await s.step(desk, "makes a code for another adult who asks at the counter, as before", async () =>
      inviteAtCounter(desk.page, range, slot, stranger, mother.phone, "Aisyah")
    );
    await acceptCode(stranger.page, strangerCode);
    await peopleOf(stranger.page).getByText(/^Accepted\. You can act for Aisyah once/).waitFor();

    await s.step(mother, "refuses the stranger's request, saying why: nothing changes", async () => {
      await mother.page.goto(`${url}/account`);
      const people = peopleOf(mother.page);
      const waiting = people.locator("div").filter({ has: mother.page.getByText("Waiting for your answer", { exact: true }) });
      await waiting.getByText(/^Stranger Tester asked to become Aisyah's guardian/).waitFor();
      mother.page.once("dialog", (d) => void d.accept("I do not know this person."));
      await waiting.getByRole("button", { name: "Refuse", exact: true }).click();
      await people.getByText("Refused. Nothing changed.").waitFor();
    });

    await s.step(stranger, "after the refusal: nothing about Aisyah, nothing pending, and booking or applying for her is refused", async () => {
      await nothingAbout(stranger, range, aisyah, slot);
      await stranger.page.goto(`${url}/account`);
      await peopleOf(stranger.page).getByText("Nobody yet.").waitFor();
      expect(await peopleOf(stranger.page).getByText(/Aisyah/).count()).toBe(0);
    });

    await s.step(mother, "reports the father's addition as a mistake from her people page: flagged for the venue, nothing else changes yet", async () => {
      await mother.page.goto(`${url}/account`);
      const row = peopleOf(mother.page).locator("li").filter({ hasText: "Aisyah" });
      await row.getByText(/^Another guardian was added on /).waitFor();
      mother.page.once("dialog", (d) => void d.accept("He is not her guardian at the moment; the court is deciding."));
      await row.getByRole("button", { name: "Report a mistake" }).click();
      await peopleOf(mother.page).getByText("Reported. A manager will look at it; nothing changes until they do.").waitFor();
      await row.getByText("Reported: the venue will look at it.").waitFor();
    });

    const manager = await s.actor("Manager");
    await s.step(manager, "finds Aisyah among what needs review, the father's relationship reported by another guardian, and pauses it with a reason", async () => {
      const page = manager.page;
      await staffSignIn(manager, range.manager.email);
      await page.getByRole("button", { name: "Venue details", exact: true }).first().click();
      const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Participants: guardians and own logins" }) });
      await panel.getByRole("button", { name: "Show what needs review" }).click();
      const child = panel.locator("ul > li").filter({ hasText: "Aisyah" });
      const fatherRow = child.locator("li").filter({ hasText: "Father Tester: parent, declared online" });
      await fatherRow.getByText("reported as a mistake by another guardian").waitFor();
      await fatherRow.getByText(/Reported as a mistake by Mother Tester: He is not her guardian/).waitFor();
      page.once("dialog", (d) => void d.accept("Reported by the mother; paused until the custody question is settled."));
      await fatherRow.getByRole("button", { name: "Pause", exact: true }).click();
      await fatherRow.getByText("paused", { exact: true }).waitFor();
    });

    await s.step(father, "is told on his people page that acting for Aisyah is paused, and booking for her is refused meanwhile", async () => {
      await father.page.goto(`${url}/account`);
      await peopleOf(father.page).getByText("Acting for Aisyah is paused while the venue looks at it. Ask the venue if you have questions.").waitFor();
      const booked = await father.api("POST", "/api/bookings", {
        courtId: slot.courtId,
        sport: "archery",
        date: slot.date,
        start: slot.hour * 60,
        end: slot.hour * 60 + 60,
        name: "Father Tester",
        phone: father.phone,
        participantIds: [aisyah.id],
        customerTakesPart: false,
      });
      expect([booked.status, booked.body.code]).toEqual([404, "GUARD_NOT_FOUND"]);
    });
  });

  scenario("Guardians H: a second guardian books for a child on the approval her mother applied for; the mother's application and certificate stay hers alone", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const withDocument = scanner !== null;
    const range = await archeryRange(owner, "Panahan Ampang", { documents: withDocument });
    const certificate = pdf("Aisyah's club safety certificate");
    const {
      parent: mother,
      kids: [aisyah],
    } = await family(s, "Mother", ["Aisyah"]);
    const father = await signUp(await s.actor("Father"));
    const slot = await freeSlot({ sport: "archery", venueId: range.venueId, hours: [14, 15, 16, 17] });

    await s.step(mother, "applies for Aisyah on the venue's form, with her certificate", async () => {
      await applyOnPage(mother.page, range.venueId, "Aisyah", withDocument ? { name: "aisyah-certificate.pdf", buffer: certificate } : undefined);
      await mother.page.locator("li").filter({ hasText: "For Aisyah" }).getByText("Waiting for review").waitFor();
    });
    const mothers = (await mother.api("GET", "/api/my/approvals")).body.requests as { id: number; forPerson: { name: string } | null; documents: { id: number; scan: string }[] }[];
    const application = mothers.find((r) => r.forPerson?.name === "Aisyah")!;
    if (withDocument) await expect.poll(async () => ((await mother.api("GET", "/api/my/approvals")).body.requests as typeof mothers)[0].documents[0].scan).toBe("clean");

    const manager = await s.actor("Manager");
    await s.step(manager, "approves Aisyah's application", async () => {
      await staffSignIn(manager, range.manager.email);
      const row = waitingRow(manager.page, "Aisyah");
      await row.getByText(`Applied by Mother Tester (declared parent) for Aisyah`).waitFor();
      await row.getByRole("button", { name: "Approve", exact: true }).click();
      await gone(row);
    });

    // The father becomes her guardian by the same steps as Guardians G, through the API (setup here).
    const deskApi = await staffApi(await s.actor("Desk API"), range.desk.email);
    const made = await deskApi.api("POST", `/api/admin/participants/${aisyah.id}/guardians`, { venueId: range.venueId, proposedName: "Father Tester", email: father.email });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const accepted = await father.api("POST", "/api/my/people/accept", { code: (made.body.request as { code: string }).code, relationship: "parent", authority: true });
    expect(accepted.body.as).toBe("pending");
    const toAnswer = ((await mother.api("GET", "/api/my/people")).body.requests as { toAnswer: { id: number }[] }).toAnswer;
    expect((await mother.api("POST", "/api/my/people/requests", { id: toAnswer[0].id, agree: true })).status).toBe(200);

    await s.step(father, "chooses Aisyah on search: approved, on her mother's application", async () => {
      await father.page.goto(`${url}/search?sport=archery&date=${slot.date}`);
      await father.page.getByTestId("taking-picker").getByRole("button", { name: "Aisyah", exact: true }).click();
      const badge = father.page.locator("li").filter({ hasText: range.name }).first().locator("[data-needs]");
      await expect.poll(() => badge.textContent()).toBe("Aisyah: approved");
      expect(await badge.getAttribute("data-eligibility")).toBe("eligible");
    });

    const code = await s.step(father, "books a lane for Aisyah, not himself, on the booking form", async () => {
      const page = father.page;
      await page.goto(laneLink(range.venueId, slot.courtId, slot.date, slot.hour));
      await page.getByRole("button", { name: /^Book · RM/ }).waitFor();
      const me = page.getByLabel("Me", { exact: true });
      if (await me.isChecked()) await me.click();
      await page.getByLabel("Aisyah (booked by you)").check();
      await page.getByRole("button", { name: /^Book · RM/ }).click();
      const booked = await confirmedCode(page);
      await page.goto(`${url}/account`);
      await page.locator("div.rounded-xl").filter({ hasText: booked }).getByText("For Aisyah").waitFor();
      return booked;
    });

    await s.step(father, "cannot open the mother's application, its answers or its certificate: not on his approvals page, not by its address", async () => {
      const page = father.page;
      await page.goto(`${url}/account/approvals`);
      await page.getByRole("heading").first().waitFor();
      expect(await page.locator("li").filter({ hasText: "For Aisyah" }).count()).toBe(0);
      expect(await page.getByText("aisyah-certificate.pdf").count()).toBe(0);
      const his = (await father.api("GET", "/api/my/approvals")).body.requests as { id: number }[];
      expect(his.map((r) => r.id)).not.toContain(application.id);
      if (withDocument) {
        const doc = await father.api("GET", `/api/my/approvals/document?id=${application.documents[0].id}`);
        expect(doc.status).toBe(404);
      }
    });

    await s.step(manager, "sees the booking on its day under Aisyah, booked by her father", async () => {
      const mp = manager.page;
      await mp.goto(`${url}/admin`);
      await mp.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
      await mp.getByLabel("Day to show").fill(slot.date);
      await mp.locator("tr").filter({ hasText: code }).getByText("Aisyah · booked by Father Tester").first().waitFor();
    });

    await s.step(mother, "still has her own application, approved, and her certificate, exactly as sent", async () => {
      await mother.page.goto(`${url}/account/approvals`);
      const card = mother.page.locator("li").filter({ hasText: "For Aisyah" });
      await card.getByText("Approved", { exact: true }).waitFor();
      if (withDocument) {
        const link = card.getByRole("link", { name: /aisyah-certificate\.pdf/ });
        const [download] = await Promise.all([mother.page.waitForEvent("download"), link.click()]);
        expect(fs.readFileSync((await download.path())!).equals(certificate)).toBe(true);
      }
    });
  });
});

describe.skipIf(scanner === null)("supporting documents a scanner could not pass", () => {
  scenario("Documents I: a certificate sent while the scanner is away waits unopened; one a working scanner cannot scan fails; the platform owner has it scanned again with a reason, and once it passes the reviewer opens it", async (s) => {
    try {
      const owner = await signInOwner(await s.actor("Owner"));
      const range = await archeryRange(owner, "Panahan Rawang", { documents: true });
      const { parent } = await family(s, "Parent", ["Alya", "Bilal"]);
      const reviewer = await s.actor("Reviewer");
      await staffSignIn(reviewer, range.manager.email);
      const page = parent.page;
      const alyaFile = pdf("Alya's club certificate");
      const bilalFile = pdf("Bilal's club certificate");
      const docOf = async (child: string) => {
        const requests = (await parent.api("GET", "/api/my/approvals")).body.requests as { id: number; forPerson: { name: string } | null; documents: { id: number; scan: string }[] }[];
        const r = requests.find((x) => x.forPerson?.name === child)!;
        return { requestId: r.id, ...r.documents[0] };
      };
      const panel = (p: Page) => p.locator("section").filter({ has: p.getByRole("heading", { name: "Supporting documents: malware scanning" }) });
      const openPanel = async () => {
        await owner.page.goto(`${url}/admin`);
        await owner.page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
        await owner.page.getByRole("button", { name: "Venues & staff", exact: true }).click();
        await panel(owner.page).getByText(/^Scanner: clamd/).waitFor();
      };

      expect(await standIn("UAT-MODE down")).toBe("MODE down");
      await s.step(parent, "applies for Alya with her certificate while the scanner is away: sent, and the page says it is being checked", async () => {
        await applyOnPage(page, range.venueId, "Alya", { name: "alya-certificate.pdf", buffer: alyaFile });
        const card = page.locator("li").filter({ hasText: "For Alya" });
        await card.getByText("Being checked for malware").waitFor();
        expect(await card.getByRole("link", { name: /alya-certificate\.pdf/ }).count()).toBe(0);
      });
      const alyaDoc = await docOf("Alya");
      expect(alyaDoc.scan).toBe("pending");

      await s.step(reviewer, "sees Alya's certificate waiting in quarantine, cannot open it by any path, and cannot approve", async () => {
        await reviewer.page.reload();
        const r = waitingRow(reviewer.page, "Alya");
        await r.getByText("Being checked for malware: it can be opened once it passes").waitFor();
        expect(await r.getByRole("link", { name: /alya-certificate\.pdf/ }).count()).toBe(0);
        await r.getByRole("button", { name: "Approve", exact: true }).click();
        await reviewer.page.getByText(/has not passed its malware scan, so this cannot be approved yet/).waitFor();
        const asReviewer = await reviewer.api("GET", `/api/admin/approvals/document?venueId=${range.venueId}&id=${alyaDoc.id}`);
        expect([asReviewer.status, asReviewer.body.code]).toEqual([409, "SCAN_NOT_RELEASED"]);
      });

      await s.step(owner, "sees on the Supporting documents panel that the scanner does not answer and a document is waiting for a scan", async () => {
        await openPanel();
        const p = panel(owner.page);
        await p.getByText("Not answering", { exact: true }).waitFor();
        await p.getByText("The scanner does not answer: documents wait in quarantine and are tried again.").waitFor();
        await p.getByText(/^Waiting for a scan: [1-9]\d* /).waitFor();
      });

      // The scanner answers again, but cannot scan what it is sent (its own size-limit error).
      expect(await standIn("UAT-MODE error")).toBe("MODE error");
      await s.step(parent, "applies for Bilal with his certificate; the scanner cannot scan it, and the page says so", async () => {
        await applyOnPage(page, range.venueId, "Bilal", { name: "bilal-certificate.pdf", buffer: bilalFile });
        const card = page.locator("li").filter({ hasText: "For Bilal" });
        await card.getByText("Could not be checked for malware: send it again if the venue asks").waitFor();
        expect(await card.getByRole("link", { name: /bilal-certificate\.pdf/ }).count()).toBe(0);
      });
      const bilalDoc = await docOf("Bilal");
      expect(bilalDoc.scan).toBe("failed");

      await s.step(reviewer, "sees Bilal's certificate could not be checked, cannot open it, and finds it in the application's history", async () => {
        await reviewer.page.reload();
        const r = waitingRow(reviewer.page, "Bilal");
        await r.getByText("Could not be checked for malware: it cannot be opened").waitFor();
        expect(await r.getByRole("link", { name: /bilal-certificate\.pdf/ }).count()).toBe(0);
        await r.getByText("History").click();
        await r.getByText("a document could not be checked for malware").waitFor();
        const asReviewer = await reviewer.api("GET", `/api/admin/approvals/document?venueId=${range.venueId}&id=${bilalDoc.id}`);
        expect([asReviewer.status, asReviewer.body.code]).toEqual([409, "SCAN_NOT_RELEASED"]);
      });

      const failedRow = () => panel(owner.page).locator("li").filter({ hasText: `Document ${bilalDoc.id} · application ${bilalDoc.requestId} · ${range.name} · archery · PDF` });
      await s.step(owner, "finds Bilal's certificate among documents that could not be scanned (no name, no contents) and has it scanned again with a reason; the scanner still cannot, and the retry is on record", async () => {
        await openPanel();
        const row = failedRow();
        await row.getByText("A working scanner could not scan it: removed after the quarantine period unless scanned again").waitFor();
        await row.getByText("Scanned again by the owner 0 of 3 times").waitFor();
        expect(await row.getByText(/bilal|Bilal|Parent Tester/).count()).toBe(0);
        const retry = row.getByRole("button", { name: "Scan again" });
        expect(await retry.isDisabled()).toBe(true);
        await row.getByLabel("Why scan it again").fill("Scanner restarted after an update");
        await retry.click();
        await panel(owner.page).getByText("Scanned again: it still could not be scanned.").waitFor();
        await row.getByText("Scanned again by the owner 1 of 3 times").waitFor();
        await row.getByText("Retries", { exact: true }).click();
        await row.getByText(/ · .+ \(platform owner\) · Scanner restarted after an update → could not be scanned$/).waitFor();
      });

      expect(await standIn("UAT-MODE up")).toBe("MODE up");
      await s.step(owner, "has it scanned again once the scanner is fixed: it passes, and leaves the list of documents that could not be scanned", async () => {
        const row = failedRow();
        await row.getByLabel("Why scan it again").fill("Scanner fixed: its size limit was set too low");
        await row.getByRole("button", { name: "Scan again" }).click();
        await panel(owner.page).getByText("Scanned again: it passed, and can now be opened.").waitFor();
        await gone(failedRow());
      });
      expect((await docOf("Bilal")).scan).toBe("clean");

      await s.step(reviewer, "opens Bilal's certificate, exactly as sent; the history shows it failed twice and was put back to be scanned twice; approves him", async () => {
        await reviewer.page.reload();
        const r = waitingRow(reviewer.page, "Bilal");
        const link = r.getByRole("link", { name: /bilal-certificate\.pdf/ });
        await link.waitFor();
        const [download] = await Promise.all([reviewer.page.waitForEvent("download"), link.click()]);
        expect(fs.readFileSync((await download.path())!).equals(bilalFile)).toBe(true);
        await r.getByText("History").click();
        // Failed when sent, and again on the first retry; put back in quarantine by each retry.
        await r.getByText("a document could not be checked for malware").nth(1).waitFor();
        expect(await r.getByText("a document could not be checked for malware").count()).toBe(2);
        expect(await r.getByText("a document was put back in quarantine to be scanned again").count()).toBe(2);
        await r.getByRole("button", { name: "Approve", exact: true }).click();
        await gone(r);
      });

      await s.step(owner, "finds both retries in the staff activity log, each with its reason", async () => {
        await owner.page.getByRole("button", { name: "Reports", exact: true }).click();
        // Reports are per venue: the range's.
        await owner.page.locator("select").filter({ has: owner.page.locator("option", { hasText: range.name }) }).first().selectOption({ label: range.name });
        const log = owner.page.locator("section").filter({ has: owner.page.getByRole("heading", { name: "Staff activity" }) });
        const rows = log.locator("tbody tr").filter({ hasText: `supporting document ${bilalDoc.id} to be scanned again` });
        await rows.filter({ hasText: "Scanner restarted after an update" }).getByText("Asked for a supporting document to be scanned for malware again").waitFor();
        await rows.filter({ hasText: "Scanner fixed: its size limit was set too low" }).waitFor();
      });

      await s.step(parent, "sees Bilal's certificate passed and Alya's still being checked: a document sent while the scanner was away waits for the scheduler's next try", async () => {
        await page.goto(`${url}/account/approvals`);
        await page.locator("li").filter({ hasText: "For Bilal" }).getByRole("link", { name: /bilal-certificate\.pdf/ }).waitFor();
        await page.locator("li").filter({ hasText: "For Alya" }).getByText("Being checked for malware").waitFor();
        expect((await docOf("Alya")).scan).toBe("pending");
      });
    } finally {
      if (scanner) await standIn("UAT-MODE up");
    }
  });
});

describe("recovery: what the platform owner records", () => {
  scenario("Recovery J: the platform owner records a review of how long applications are kept only with who reviewed it, on what written advice, as their own record not verified by MySenam; the privacy notice says so, and changing a period lapses it", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const visitor = await s.actor("Visitor");
    const page = owner.page;
    const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Supporting documents: malware scanning" }) });
    const retention = panel.locator("div").filter({ has: page.getByRole("heading", { name: "How long applications are kept on this install" }) }).last();
    const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);

    await s.step(visitor, "reads on the privacy notice that the periods for applications are provisional, and that a restored backup is erased again before the site reopens", async () => {
      await visitor.page.goto(`${url}/privacy`);
      await visitor.page.getByText("These periods are provisional: they have not yet been reviewed by a lawyer.").waitFor();
      await visitor.page.getByText(/If a backup is ever restored, whatever was erased since it was taken is erased again, and the retention periods applied again, before the site reopens\./).waitFor();
    });

    const original = await s.step(owner, "opens the retention periods: provisional for Malaysia, and a recorded review is the owner's record, not verified by MySenam", async () => {
      await page.goto(`${url}/admin`);
      await page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
      await page.getByRole("button", { name: "Venues & staff", exact: true }).click();
      await retention.getByText(/^Provisional: these periods are the product owner's defaults or this install's own, not legal requirements, and no review is recorded for every period in Malaysia\./).waitFor();
      await retention.getByText("A recorded review is the platform owner's record of what a reviewer advised. MySenam does not verify it, and it does not make these periods legally approved.").waitFor();
      return retention.getByLabel("Documents after the decision (days)").inputValue();
    });

    await s.step(owner, "records a review for two periods in Malaysia: refused until the reviewer's role, firm and written advice are given", async () => {
      await retention.getByText("Record a review of these periods").click();
      await retention.getByText(/^Record only what the reviewer's written advice says\./).waitFor();
      await retention.getByLabel("Malaysia", { exact: true }).check();
      await retention.getByLabel("documents after the decision", { exact: true }).check();
      await retention.getByLabel("the review window", { exact: true }).check();
      await retention.getByLabel("Day of the review").fill(today);
      await retention.getByLabel("Reviewer's name").fill("Puan Aminah Yusof");
      await retention.getByLabel("What the review was based on").fill("Written advice on keeping safety certificates after an approval decision.");
      const record = retention.getByRole("button", { name: "Record the review" });
      for (const [missing, field, value] of [
        ["Give the reviewer's role or qualification, as they state it.", "Role or qualification, as they state it", "Advocate and solicitor"],
        ["Give the reviewer's firm or organisation.", "Firm or organisation", "Tetuan Contoh dan Rakan"],
        ["Give a reference to the written advice, kept outside MySenam.", "Reference to the written advice (kept outside MySenam)", "ADV-UAT-117"],
      ]) {
        await record.click();
        await panel.getByText(missing).waitFor();
        await retention.getByLabel(field).fill(value);
      }
      await record.click();
      await panel.getByText("Review recorded.").waitFor();
    });

    await s.step(owner, "sees the review as recorded by the platform owner, not verified by MySenam, and the periods it left out still provisional", async () => {
      await retention
        .getByText(
          new RegExp(
            `^Malaysia: Puan Aminah Yusof \\(Advocate and solicitor\\), Tetuan Contoh dan Rakan, reviewed documents after the decision, the review window on ${today}\\. Written advice: ADV-UAT-117\\. Recorded by .+, not verified by MySenam\\.`
          )
        )
        .waitFor();
      await retention.getByText("Malaysia: provisional for closed applications, refused or unscannable documents.").waitFor();
      await retention.getByText(/^Provisional: .*no review is recorded for every period in Malaysia\./).waitFor();
    });

    await s.step(visitor, "reads on the privacy notice who the owner recorded as reviewing which periods, that MySenam has not verified it and it is no legal approval, and what is still provisional", async () => {
      await visitor.page.reload();
      await visitor.page
        .getByText(/The platform owner has recorded a review of the periods for .+ in Malaysia by Puan Aminah Yusof \(Advocate and solicitor, Tetuan Contoh dan Rakan\) on .+\. MySenam has not verified it, and it is not a legal approval\. Still provisional: /)
        .waitFor();
      expect(await visitor.page.getByText("These periods are provisional: they have not yet been reviewed by a lawyer.").count()).toBe(0);
    });

    await s.step(owner, "changes a period and puts it back: the review lapses, the periods are as they were, and both changes and the review stay in the history", async () => {
      const days = retention.getByLabel("Documents after the decision (days)");
      for (const value of [String(Number(original) + 30), original]) {
        await days.fill(value);
        await retention.getByRole("button", { name: "Save periods" }).click();
        await panel.getByText("Saved. The periods are provisional until a review is recorded.").waitFor();
        await expect.poll(() => days.inputValue()).toBe(value);
      }
      await gone(retention.getByText(/^Malaysia: Puan Aminah Yusof/));
      await retention.getByText("Changes and reviews").click();
      await retention.getByText(/Review recorded \(not verified by MySenam\) for MY: Puan Aminah Yusof/).waitFor();
    });

    await s.step(visitor, "reads the periods as provisional again", async () => {
      await visitor.page.reload();
      await visitor.page.getByText("These periods are provisional: they have not yet been reviewed by a lawyer.").waitFor();
    });
  });
});

/**
 * A swimming centre of a scenario's own: a pool sold by the place (RM10 a
 * place, `poolPlaces` of them) and a gym floor whose places the venue sells
 * together (the booking rule `separatePlaces` off), with a manager and a front
 * desk. Made by the platform's owner.
 */
async function swimCentre(owner: Actor, label: string, poolPlaces: number) {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const name = `${label} ${stamp}`;
  const made = await owner.api("POST", "/api/admin/venues", { name, area: "Wangsa Maju", address: "8 Jalan 4/27A, Wangsa Maju", phone: "03-4142 8800" });
  if (made.status !== 201) throw new Error(`venue: ${JSON.stringify(made.body)}`);
  const venueId = (made.body.venue as { id: number }).id;
  const court = async (sport: string, courtName: string, capacity: number, rate: number) => {
    const c = await owner.api("POST", "/api/admin/courts", { venueId, sport, name: courtName, offPeakRate: rate, peakRate: rate, capacity, maxPlayers: capacity, deposit: 0 });
    if (c.status >= 300) throw new Error(`${courtName}: ${JSON.stringify(c.body)}`);
    return ((c.body.courts as { id: number }[] | undefined)?.[0] ?? (c.body.court as { id: number })).id;
  };
  const pool = await court("swimming", "Pool", poolPlaces, 10);
  const gym = await court("gym", "Gym Floor", 4, 8);
  const whole = await owner.api("POST", "/api/admin/booking-policies", { venueId, level: "sport", sport: "gym", settings: { separatePlaces: false } });
  if (whole.status !== 200) throw new Error(`rules: ${JSON.stringify(whole.body)}`);
  const staff = {
    manager: { email: `swim-manager-${stamp}@uat.mysenam.test`, name: `${label} Manager` },
    desk: { email: `swim-desk-${stamp}@uat.mysenam.test`, name: `${label} Desk` },
  };
  for (const role of ["manager", "desk"] as const) {
    const r = await owner.api("POST", "/api/admin/admins", { name: staff[role].name, email: staff[role].email, password: STAFF_PASSWORD, venueId, role });
    if (r.status >= 300) throw new Error(`${role}: ${JSON.stringify(r.body)}`);
  }
  return { venueId, name, pool, gym, ...staff };
}

/** The venue's grid at one resource and hour, for an activity. */
const slotLink = (venueId: number, sport: string, courtId: number, date: string, hour: number) =>
  `${url}/venue/${venueId}?date=${date}&sport=${sport}&court=${courtId}&start=${hour * 60}&minutes=60`;

/** On the booking form: the guardian not taking part, these children ticked. */
async function forChildren(page: Page, ticked: string[], all: string[]) {
  const me = page.getByLabel("Me", { exact: true });
  if (await me.isChecked()) await me.click();
  for (const name of all) {
    const box = page.getByLabel(`${name} (booked by you)`);
    if ((await box.isChecked()) !== ticked.includes(name)) await box.click();
  }
}

/** One booking's card on the account page. */
const bookingCard = (page: Page, code: string) => page.locator("div.rounded-xl").filter({ hasText: code });

describe("places: one person's place on a booking of several", () => {
  scenario("Places K: a guardian takes one child off a pool session sold by the place; the other stays booked, only that place's price comes off, the freed place goes to the waiting list; a session sold whole refuses, saying why", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const centre = await swimCentre(owner, "Kolam Wangsa", 2);
    const {
      parent: mother,
      kids: [amani, bella],
    } = await family(s, "Mother", ["Amani", "Bella"]);
    const swimmer = await signUp(await s.actor("Swimmer"));
    const slot = await freeSlot({ sport: "swimming", venueId: centre.venueId, hours: [14, 15, 16, 17] });
    const page = mother.page;

    const code = await s.step(mother, "books both children on the pool's two places, not herself: RM20", async () => {
      await page.goto(slotLink(centre.venueId, "swimming", centre.pool, slot.date, slot.hour));
      await page.getByRole("button", { name: /^Book · RM/ }).waitFor();
      await forChildren(page, ["Amani", "Bella"], ["Amani", "Bella"]);
      await page.getByRole("button", { name: "Book · RM20" }).waitFor();
      await page.getByRole("button", { name: /^Book · RM/ }).click();
      return confirmedCode(page);
    });

    // Somebody else wants a place at that hour, and waits for one (setup).
    const waits = await swimmer.api("POST", "/api/waitlist", {
      courtId: centre.pool,
      date: slot.date,
      start: slot.hour * 60,
      end: slot.hour * 60 + 60,
      name: "Swimmer Tester",
      phone: swimmer.phone,
      email: swimmer.email,
    });
    expect(waits.status, JSON.stringify(waits.body)).toBeLessThan(300);

    await s.step(mother, "on her account page, sees who is on the booking and what taking each off would do: RM10 less to pay for either", async () => {
      await page.goto(`${url}/account`);
      const card = bookingCard(page, code);
      await card.getByRole("button", { name: "Take somebody off" }).click();
      const who = card.getByRole("region", { name: "Who is taking part" });
      for (const name of ["Amani", "Bella"]) await who.locator("li").filter({ hasText: name }).getByText("RM10 less to pay.").waitFor();
    });

    await s.step(mother, "takes Bella off: Amani stays booked, and RM10 less is owed", async () => {
      const card = bookingCard(page, code);
      let asked = "";
      page.once("dialog", (d) => {
        asked = d.message();
        void d.accept();
      });
      await card.getByRole("region", { name: "Who is taking part" }).locator("li").filter({ hasText: "Bella" }).getByRole("button", { name: "Take off" }).click();
      await page.getByText("Bella is off the booking. RM10 less to pay.").waitFor();
      expect(asked).toBe("Take Bella off this booking? Everybody else stays booked. RM10 less to pay.");
      const mine = (await mother.api("GET", "/api/my/bookings")).body.bookings as { code: string; totalPrice: number; participantName: string | null; status: string }[];
      const booked = mine.find((b) => b.code === code)!;
      expect([booked.status, booked.totalPrice, booked.participantName]).toEqual(["confirmed", 10, "Amani"]);
      await page.goto(`${url}/account`);
      await bookingCard(page, code).getByText("For Amani").waitFor();
      expect(await bookingCard(page, code).getByText(/Bella/).count()).toBe(0);
    });

    await s.step(mother, "may not take Amani off too: the last one on a booking is cancelled instead, and the page says so", async () => {
      const card = bookingCard(page, code);
      await card.getByRole("button", { name: "Take somebody off" }).click();
      await card.getByText("Cannot be taken off: Amani is the only one left on this booking. Cancel the booking instead.").waitFor();
      expect(await card.getByRole("button", { name: "Take off" }).count()).toBe(0);
    });

    await s.step(swimmer, "is offered the place Bella left, and claims it", async () => {
      await swimmer.page.goto(`${url}/account`);
      const list = swimmer.page.locator("section").filter({ has: swimmer.page.getByRole("heading", { name: "Waitlist" }) });
      const entry = list.locator("li").first();
      await entry.getByText(/A place is being held for you/).waitFor();
      await entry.getByRole("link", { name: "Claim place" }).click();
      await swimmer.page.getByRole("button", { name: "Claim my place" }).click();
      await swimmer.page.getByText("The place is yours").waitFor();
    });

    await s.step(mother, "is told by email who is off, that everybody else stays booked, and what happened to the money", async () => {
      const subject = `Bella is off booking ${code}`;
      const mgr = await staffApi(await s.actor("Manager API"), centre.manager.email);
      await expect
        .poll(async () => {
          const list = (await mgr.api("GET", `/api/admin/messages?venueId=${centre.venueId}`)).body.messages as { recipient: string; subject: string | null; status: string }[];
          return list.filter((m) => m.subject === subject).map((m) => [m.recipient, m.status]);
        })
        .toEqual([[mother.email, "sent"]]);
      if (serverLog) {
        const [mail] = emailsTo(mother.email).filter((m) => m.subject === subject);
        expect(mail.text).toMatch(new RegExp(`^Hi Mother, Bella is no longer on your booking ${code}: .+\\. Everybody else on it stays booked\\. RM10 less to pay\\.`));
      }
    });

    const desk = await s.actor("Desk");
    await s.step(desk, "sees the pool's hour on the day: Amani on the guardian's booking, the swimmer on the place Bella left", async () => {
      await staffSignIn(desk, centre.desk.email);
      await desk.page.getByLabel("Day to show").fill(slot.date);
      const row = desk.page.locator("tr").filter({ hasText: code });
      await row.getByText(/Amani/).first().waitFor();
      expect(await row.getByText(/Bella/).count()).toBe(0);
      await desk.page.locator("tr").filter({ hasText: "Swimmer Tester" }).first().waitFor();
    });

    // The gym floor is sold whole (setup): both children on one booking.
    const gymSlot = await freeSlot({ sport: "gym", venueId: centre.venueId, hours: [14, 15, 16, 17] });
    const gym = await mother.api("POST", "/api/bookings", {
      courtId: centre.gym,
      sport: "gym",
      date: gymSlot.date,
      start: gymSlot.hour * 60,
      end: gymSlot.hour * 60 + 60,
      name: "Mother Tester",
      phone: mother.phone,
      participantIds: [amani.id, bella.id],
      customerTakesPart: false,
    });
    expect(gym.status, JSON.stringify(gym.body)).toBe(201);
    const gymCode = (gym.body.booking as { code: string }).code;

    await s.step(mother, "on a gym session the venue sells whole, nobody can be taken off, and each says why", async () => {
      await page.goto(`${url}/account`);
      const card = bookingCard(page, gymCode);
      await card.getByRole("button", { name: "Take somebody off" }).click();
      const why = "Cannot be taken off: The venue sells these places together, so one person cannot be taken off. Cancel the booking, or ask the venue.";
      for (const name of ["Amani", "Bella"]) await card.locator("li").filter({ hasText: name }).getByText(why).waitFor();
      expect(await card.getByRole("button", { name: "Take off" }).count()).toBe(0);
    });
  });

  scenario("Places L: one child's own concession on a booking for two: it comes off her place alone, the form offers no code on top (one discount), the receipt adds up; her proof is checked at the counter and remembered, and her concession is not taken twice", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const centre = await swimCentre(owner, "Kolam Setapak", 8);
    const mgr = await staffApi(await s.actor("Manager API"), centre.manager.email);
    const concession = await mgr.api("POST", "/api/admin/concessions", {
      venueId: centre.venueId,
      name: "Junior swimmer",
      percent: 50,
      proof: "their MyKid card",
      sport: "swimming",
      scope: "participant",
    });
    expect(concession.status, JSON.stringify(concession.body)).toBe(200);
    const concessionId = (concession.body.concession as { id: number }).id;
    // A code for the whole booking, as the venue advertises it.
    const promo = await mgr.api("POST", "/api/admin/promos", {
      venueId: centre.venueId,
      code: "SPLASH10",
      description: "Ten percent off a swim",
      kind: "percent",
      value: 10,
      validFrom: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
      validTo: new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10),
    });
    expect(promo.status, JSON.stringify(promo.body)).toBeLessThan(300);
    const {
      parent: mother,
      kids: [amani, bella],
    } = await family(s, "Mother", ["Amani", "Bella"]);
    const slot = await freeSlot({ sport: "swimming", venueId: centre.venueId, fromDay: 3, toDay: 4, hours: [14, 15, 16, 17] });
    const page = mother.page;

    const code = await s.step(mother, "books both children with Amani on the junior price, her place only: RM20 less RM5 off Amani's place, RM15; with a concession chosen the form offers no code on top", async () => {
      await page.goto(slotLink(centre.venueId, "swimming", centre.pool, slot.date, slot.hour));
      await page.getByRole("button", { name: /^Book · RM/ }).waitFor();
      await forChildren(page, ["Amani", "Bella"], ["Amani", "Bella"]);
      await page.getByLabel("Promo code?").waitFor();
      await page.getByLabel("Price").selectOption({ label: "Junior swimmer, 50% off" });
      await page.getByText("This price is for one person's place.").waitFor();
      await page.getByLabel("Whose price is it?").selectOption({ label: "Amani" });
      await page.getByText("Bring their MyKid card to show at the counter. Without it, the full price is charged there.").waitFor();
      // One discount at a time (docs/features/pricing.md#concession-prices): the code's field goes.
      await gone(page.getByLabel("Promo code?"));
      await page.getByRole("button", { name: "Book · RM15" }).waitFor();
      await page.getByRole("button", { name: /^Book · RM/ }).click();
      const booked = await confirmedCode(page);
      await page.locator("dl").locator("div").filter({ hasText: /^Total/ }).getByText(/RM15 \(pay at counter\)/).waitFor();
      expect(await page.getByText("Promo discount").count()).toBe(0);
      return booked;
    });

    const desk = await s.actor("Desk");
    await s.step(desk, "at the counter, is asked for Amani's proof only, sees it, remembers it for 12 months, and takes the RM15 in cash", async () => {
      await staffSignIn(desk, centre.desk.email);
      await desk.page.getByLabel("Day to show").fill(slot.date);
      const row = desk.page.locator("tr").filter({ hasText: code });
      await row.getByText(/Junior swimmer for Amani \(RM5 off\): check their proof/).waitFor();
      expect(await row.getByText(/Junior swimmer for Bella/).count()).toBe(0);
      await row.getByRole("button", { name: "Proof seen" }).click();
      await row.getByRole("button", { name: "12 months" }).click();
      await row.getByText(/Junior swimmer for Amani: proof seen/).waitFor();
      await row.getByRole("button", { name: "unpaid" }).click();
      await row.getByTitle("Cash", { exact: true }).click();
      await row.getByRole("button", { name: /^✓ / }).waitFor();
    });

    await s.step(mother, "reads the receipt: both places, Amani's junior price once and on her place alone, RM15", async () => {
      await page.goto(`${url}/my-booking`);
      await page.getByLabel("Booking code").fill(code);
      await page.getByLabel("Phone number").fill(mother.phone);
      await page.getByRole("button", { name: "Find my booking" }).click();
      const href = await page.getByRole("link", { name: "Receipt ↗" }).getAttribute("href");
      await page.goto(new URL(href!, url).toString());
      const body = page.locator("article");
      await body.getByText("Junior swimmer price, Amani").waitFor();
      expect(await body.getByText("Junior swimmer price, Amani").count()).toBe(1);
      expect(await body.getByText(/price, Bella/).count()).toBe(0);
      expect(await body.getByText(/Promo/).count()).toBe(0);
      const text = (await body.textContent())!;
      for (const shown of [/2 players, for Amani, BellaRM20/, /Junior swimmer price, Amani−RM5/, /TotalRM15Paid: Cash/]) expect(text).toMatch(shown);
    });

    // The next week, both again, Amani on her junior price (setup through the API, as the venue's app would).
    const next = await freeSlot({ sport: "swimming", venueId: centre.venueId, fromDay: 9, toDay: 13, hours: [14, 15, 16, 17] });
    const booking = (extra: Record<string, unknown>) =>
      mother.api("POST", "/api/bookings", {
        courtId: centre.pool,
        sport: "swimming",
        date: next.date,
        start: next.hour * 60,
        end: next.hour * 60 + 60,
        name: "Mother Tester",
        phone: mother.phone,
        participantIds: [amani.id, bella.id],
        customerTakesPart: false,
        ...extra,
      });
    // Amani's concession asked for twice on one booking: refused before anything is booked.
    const twice = await booking({ placeConcessions: [{ participantId: amani.id, concessionId }, { participantId: amani.id, concessionId }] });
    expect(twice.status).toBe(400);
    const again = await booking({ placeConcessions: [{ participantId: amani.id, concessionId }] });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    const againBooking = again.body.booking as { code: string; totalPrice: number };
    expect(againBooking.totalPrice).toBe(15);

    await s.step(desk, "next time, Amani's proof is already on file: nobody asks again, and her place alone is at the junior price", async () => {
      await desk.page.getByLabel("Day to show").fill(next.date);
      const row = desk.page.locator("tr").filter({ hasText: againBooking.code });
      await row.getByText(/Junior swimmer for Amani: proof seen/).waitFor();
      expect(await row.getByRole("button", { name: "Proof seen" }).count()).toBe(0);
      expect(await row.getByText(/Junior swimmer for Bella/).count()).toBe(0);
    });
  });
});
