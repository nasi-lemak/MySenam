import fs from "fs";
import net from "net";
import { describe, expect, inject } from "vitest";
import type { Page } from "playwright-core";
import { gone, scenario, signInOwner, url } from "./harness";
import { archeryRange, family, staffSignIn } from "./families";

/**
 * A supporting document on its way from a parent to the venue's reviewer
 * (ADR 0024; docs/architecture/security.md#malware-scanning): sent with an
 * application, held in quarantine while it is scanned, opened by the
 * reviewer only once the scan released it, and never opened, by the reviewer
 * or the parent, while it waits or after the scan refused it; an
 * application whose document has not passed cannot be approved.
 *
 * **The scanner here is a stand-in, not ClamAV** (tests/uat/scanner.ts): it
 * speaks clamd's protocol on the loopback, so the app reaches it through
 * its real scanner client exactly as it reaches clamd, but what it answers
 * is decided by the scenario: a document marked to be held waits, as behind
 * a slow scanner, until the scenario releases it; one carrying the EICAR
 * test string is refused. The real engine is tested in
 * tests/document-scanning-engine.test.ts. Against a deployment (E2E_URL)
 * there is no stand-in, and the scenario is skipped rather than passed.
 */

const scanner = inject("uatScanner");

/** A one-page PDF that passes the structural checks (lib/approval-documents.ts), with a comment line of our own after its header. */
function pdf(comment: string): Buffer {
  const body =
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
  return Buffer.from(`%PDF-1.7\n% ${comment}\n${body}`, "latin1");
}
/** Held by the stand-in until released: a document behind a slow scanner. */
const HELD = pdf("UAT-HOLD-SCAN club certificate");
/** The EICAR anti-virus test string: no malware, but every scanner reports it as if it were. */
const EICAR = pdf("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");

/** The stand-in answers every scan it is holding back (its own command, not clamd's). */
async function releaseHeldScans(): Promise<string> {
  const [host, port] = scanner!.split(":");
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port: Number(port) }, () => socket.write("zUAT-RELEASE\0"));
    let reply = "";
    socket.on("data", (d) => (reply += d.toString()));
    socket.on("end", () => resolve(reply.replace(/\0/g, "")));
    socket.on("error", reject);
  });
}

/** An application for a child with a document, on the venue's form. */
async function applyWithDocument(page: Page, venueId: number, child: string, file: { name: string; buffer: Buffer }) {
  await page.goto(`${url}/account/approvals?venueId=${venueId}&sport=archery`);
  await page.getByLabel("Who is this application for?").selectOption({ label: child });
  await page.locator('input[type="file"]').setInputFiles({ name: file.name, mimeType: "application/pdf", buffer: file.buffer });
  await page.getByLabel(/range officer's calls/).check();
  await page.getByLabel(/have the authority to apply for them/).check();
  await page.getByRole("button", { name: "Send application" }).click();
  // A scan that does not answer keeps the parent waiting no longer than 20 seconds (lib/document-scanning.ts).
  await page.getByText("Sent. The venue reviews it and you hear by email.").waitFor({ timeout: 40_000 });
}

/** The reviewer's row for one child's application, among those waiting. */
const row = (page: Page, child: string) =>
  page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Applications waiting for review" }) })
    .locator("li")
    .filter({ hasText: new RegExp(`for ${child}\\b`) });

describe.skipIf(scanner === null)("supporting documents: quarantined, scanned, released only when clean", () => {
  scenario("Documents E: a parent's certificate is opened by the reviewer only once its scan passed; one waiting or refused cannot be opened or approved", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const range = await archeryRange(owner, "Panahan Cheras", { documents: true });
    const { parent } = await family(s, "Parent", ["Alya", "Bilal"]);
    const reviewer = await s.actor("Reviewer");
    await staffSignIn(reviewer, range.manager.email);
    const page = parent.page;

    await s.step(parent, "applies for Alya with her club certificate; the scanner is slow, and the page says it is being checked", async () => {
      await applyWithDocument(page, range.venueId, "Alya", { name: "alya-certificate.pdf", buffer: HELD });
      const card = page.locator("li").filter({ hasText: "For Alya" });
      await card.getByText("alya-certificate.pdf").waitFor();
      await card.getByText("Being checked for malware").waitFor();
      expect(await card.getByRole("link", { name: /alya-certificate\.pdf/ }).count()).toBe(0);
    });

    const docOf = async (child: string) => {
      const requests = (await parent.api("GET", "/api/my/approvals")).body.requests as { id: number; forPerson: { name: string } | null; documents: { id: number; scan: string }[] }[];
      const r = requests.find((x) => x.forPerson?.name === child)!;
      return { requestId: r.id, ...r.documents[0] };
    };
    const alyaDoc = await docOf("Alya");
    expect(alyaDoc.scan).toBe("pending");

    await s.step(reviewer, "sees Alya's certificate waiting for its scan, with no way to open it, and cannot approve yet", async () => {
      await reviewer.page.reload();
      const r = row(reviewer.page, "Alya");
      await r.getByText("Being checked for malware: it can be opened once it passes").waitFor();
      expect(await r.getByRole("link", { name: /alya-certificate\.pdf/ }).count()).toBe(0);
      await r.getByRole("button", { name: "Approve", exact: true }).click();
      await reviewer.page.getByText(/has not passed its malware scan, so this cannot be approved yet/).waitFor();
      // Nor by its address: the reviewer's download and the parent's own both refuse it.
      const asReviewer = await reviewer.api("GET", `/api/admin/approvals/document?venueId=${range.venueId}&id=${alyaDoc.id}`);
      expect([asReviewer.status, asReviewer.body.code]).toEqual([409, "SCAN_NOT_RELEASED"]);
      const asParent = await parent.api("GET", `/api/my/approvals/document?id=${alyaDoc.id}`);
      expect([asParent.status, asParent.body.code]).toEqual([409, "SCAN_NOT_RELEASED"]);
    });

    // The stand-in answers the scan it held: the document passes and is released.
    expect(await releaseHeldScans()).toBe("RELEASED 1");
    await expect.poll(async () => (await docOf("Alya")).scan, { timeout: 15_000 }).toBe("clean");

    await s.step(reviewer, "once it passed, opens the certificate, exactly as sent, and approves Alya", async () => {
      await reviewer.page.reload();
      const r = row(reviewer.page, "Alya");
      const link = r.getByRole("link", { name: /alya-certificate\.pdf/ });
      await link.waitFor();
      const [download] = await Promise.all([reviewer.page.waitForEvent("download"), link.click()]);
      expect(download.suggestedFilename()).toBe("alya-certificate.pdf");
      expect(fs.readFileSync((await download.path())!).equals(HELD)).toBe(true);
      await r.getByRole("button", { name: "Approve", exact: true }).click();
      await gone(r);
    });

    await s.step(parent, "applies for Bilal with a file the scanner refuses; the page says so, and the file cannot be opened", async () => {
      await applyWithDocument(page, range.venueId, "Bilal", { name: "bilal-certificate.pdf", buffer: EICAR });
      const card = page.locator("li").filter({ hasText: "For Bilal" });
      await card.getByText("Refused by the malware check: send another file").waitFor();
      expect(await card.getByRole("link", { name: /bilal-certificate\.pdf/ }).count()).toBe(0);
      await page.locator("li").filter({ hasText: "For Alya" }).getByText("Approved", { exact: true }).waitFor();
    });

    const bilalDoc = await docOf("Bilal");
    expect(bilalDoc.scan).toBe("rejected");

    await s.step(reviewer, "sees Bilal's file refused by the scan, cannot open it by any path, and cannot approve him on it", async () => {
      await reviewer.page.reload();
      const r = row(reviewer.page, "Bilal");
      await r.getByText("Refused by the malware check: it cannot be opened").waitFor();
      expect(await r.getByRole("link", { name: /bilal-certificate\.pdf/ }).count()).toBe(0);
      await r.getByText("History").click();
      await r.getByText("a document was refused by the malware check").waitFor();
      await r.getByRole("button", { name: "Approve", exact: true }).click();
      await reviewer.page.getByText(/has not passed its malware scan, so this cannot be approved yet/).waitFor();
      const asReviewer = await reviewer.api("GET", `/api/admin/approvals/document?venueId=${range.venueId}&id=${bilalDoc.id}`);
      expect([asReviewer.status, asReviewer.body.code]).toEqual([409, "SCAN_NOT_RELEASED"]);
      const asParent = await parent.api("GET", `/api/my/approvals/document?id=${bilalDoc.id}`);
      expect([asParent.status, asParent.body.code]).toEqual([409, "SCAN_NOT_RELEASED"]);
    });
  });
});
