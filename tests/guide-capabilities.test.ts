import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { BUILTIN_ACTIVITIES } from "../src/lib/activity-catalogue";
import { DICTIONARIES, LOCALES } from "../src/lib/i18n";
import { STAFF_ACTIONS } from "../src/lib/roles";
import {
  CAPABILITIES,
  CAPABILITY_GROUPS,
  INTEGRATIONS,
  REQUIREMENTS,
  availabilityOf,
  availableCapabilities,
  capability,
  requireCapability,
  unsupportedCapabilities,
} from "../src/lib/guide/capabilities";
import { DASHBOARD_TABS } from "../src/lib/guide/shell";

/**
 * The capability registry is tied to the repository's own account of itself
 * (docs/features/venue-guide.md#the-capability-registry): an available
 * capability rests on a row of docs/product/feature-status.md that says it is
 * implemented and tested (or tested against fakes, naming its integration);
 * an unsupported one on a row that says it is not built, a known-limitations
 * anchor or an activity's `supportNote`. The guide cannot say MySenam does
 * something its own matrix does not.
 */

const ROOT = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

// The matrix: | Capability | Status | Behaviour | Code | Tests | Gaps |
const rows = new Map<string, { status: string; gaps: string }>();
for (const line of read("docs/product/feature-status.md").split("\n")) {
  if (!/^\|\s*[^-|\s]/.test(line) || line.split("|").length < 8 || /^\|\s*Capability\s*\|/.test(line)) continue;
  const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
  rows.set(cells[1], { status: cells[2], gaps: cells[6] });
}

/** GitHub's anchors for the register's headings. */
function anchors(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .filter((l) => /^#{1,6}\s/.test(l))
      .map((l) =>
        l
          .replace(/^#{1,6}\s+/, "")
          .trim()
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s_-]/gu, "")
          .replace(/\s/g, "-")
      )
  );
}
const limitationAnchors = anchors(read("docs/roadmap/known-limitations.md"));

describe("the capability registry", () => {
  it("is not empty, and names each capability once, in words and hyphens", () => {
    expect(CAPABILITIES.length).toBeGreaterThan(60);
    const ids = CAPABILITIES.map((c) => c.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    for (const id of ids) expect(id, id).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    expect(requireCapability("memberships").id).toBe("memberships");
    expect(capability("no-such-thing")).toBeUndefined();
    expect(() => requireCapability("no-such-thing")).toThrow();
  });

  it("covers everything the owner's list names, and the things that are not supported", () => {
    const has = (id: string) => expect(capability(id), id).toBeDefined();
    // Courts and resources, shared facilities and linked courts, buffers, prices from a date, concessions, promo codes.
    ["resources", "shared-facilities", "linked-courts", "buffers", "peak-pricing", "rates-from-date", "concessions", "promo-codes"].forEach(has);
    // Memberships, family and guardian rules, passes, classes and coaching, tournaments, leagues, open games, hire.
    ["memberships", "family-memberships", "guardians", "passes", "classes", "coaching", "tournaments", "leagues", "open-games", "equipment-hire"].forEach(has);
    // Staff, the counter and cash-up, payments three ways, refunds and credit notes, check-in and unstaffed access, sign-offs.
    ["staff-invitations", "staff-roles", "counter-payments", "cash-up", "pay-online-billplz", "pay-online-stripe", "stored-credit", "refunds", "receipts-tax", "check-in", "unstaffed-access", "sign-offs", "activity-approvals"].forEach(has);
    // Test bookings, branches and copying, e-invoicing, messages, company accounts, reports and exports, venue cancellations, languages.
    ["test-bookings", "branches", "branch-copy", "e-invoicing", "whatsapp-messages", "email-messages", "company-accounts", "reports", "exports", "venue-cancellations", "languages"].forEach(has);
    // Not supported: sessionless gym admission, per-venue WhatsApp numbers, web push, a native app.
    for (const id of ["gym-walk-in", "venue-whatsapp-number", "web-push", "native-app"]) expect(capability(id)?.status, id).toBe("unsupported");
    expect(unsupportedCapabilities().length + availableCapabilities().length).toBe(CAPABILITIES.length);
  });

  it("rests each available capability on a feature-status row that says it is implemented", () => {
    const bad: string[] = [];
    for (const c of availableCapabilities()) {
      const row = c.featureRow === null ? undefined : rows.get(c.featureRow);
      if (!row) {
        bad.push(`${c.id}: no row called ${JSON.stringify(c.featureRow)}`);
        continue;
      }
      if (row.status !== "IMPLEMENTED_AND_TESTED" && row.status !== "INTEGRATION_VERIFICATION_REQUIRED") bad.push(`${c.id}: its row is ${row.status}`);
      if (row.status === "INTEGRATION_VERIFICATION_REQUIRED" && !c.requires.includes("integration")) bad.push(`${c.id}: its row needs a live check, and requires does not list "integration"`);
    }
    expect(bad).toEqual([]);
  });

  it("lists its integrations exactly when it requires one, and names a row's live-check dependency in its gaps", () => {
    for (const c of CAPABILITIES) {
      const needs = c.requires.includes("integration");
      expect(needs, c.id).toBe((c.integrations ?? []).length > 0);
      for (const i of c.integrations ?? []) expect(INTEGRATIONS, c.id).toContain(i);
      for (const r of c.requires) expect(REQUIREMENTS).toContain(r);
      // A row that pays or messages through a service names that integration in its gaps (AGENTS.md rule 7).
      if (needs && c.status === "available") {
        const row = rows.get(c.featureRow!)!;
        if (row.status === "IMPLEMENTED_AND_TESTED") expect(row.gaps, `${c.id}: ${row.gaps}`).toMatch(/integration|gateway|live|Meta|provider/i);
      }
    }
  });

  it("says what an unsupported one is and what to do instead, and shows where that comes from", () => {
    const catalogue = new Map(BUILTIN_ACTIVITIES.map((a) => [a.key, a]));
    for (const c of unsupportedCapabilities()) {
      expect(c.alternativeKey, c.id).toBeTruthy();
      expect(c.requires, c.id).toEqual([]);
      // Its source: a row of the matrix, a known-limitations anchor, or an activity's own support note.
      const sources = [c.featureRow !== null, c.limitation !== undefined, c.activityNote !== undefined].filter(Boolean);
      expect(sources.length, `${c.id} has no source`).toBeGreaterThan(0);
      if (c.featureRow !== null) expect(rows.has(c.featureRow), `${c.id}: no row ${c.featureRow}`).toBe(true);
      if (c.limitation !== undefined) expect(limitationAnchors.has(c.limitation), `${c.id}: no heading ${c.limitation}`).toBe(true);
      if (c.activityNote !== undefined) {
        const a = catalogue.get(c.activityNote);
        expect(a, `${c.id}: no activity ${c.activityNote}`).toBeDefined();
        expect(a!.support, c.id).not.toBe("full");
        expect(a!.supportNote, c.id).toBeTruthy();
      }
    }
    // Where the register says a capability is not built, it is not offered as available: those rows are not any available one's.
    const available = new Set(availableCapabilities().map((c) => c.featureRow));
    for (const [name, row] of rows) if (["UNSUPPORTED", "BLOCKED"].includes(row.status)) expect(available.has(name), name).toBe(false);
  });

  it("has a title and a blurb in every language, and what to do instead where it is not supported", () => {
    for (const c of CAPABILITIES) {
      const keys = [c.titleKey, c.blurbKey, ...(c.alternativeKey ? [c.alternativeKey] : [])];
      for (const locale of LOCALES)
        for (const key of keys) expect((DICTIONARIES[locale] as Record<string, string>)[key]?.trim(), `${c.id}: ${key} in ${locale}`).toBeTruthy();
    }
  });

  it("names a real staff action, where it says who may use the screen, and a real tab", () => {
    for (const c of CAPABILITIES) {
      if (c.staffAction) expect(Object.keys(STAFF_ACTIONS), c.id).toContain(c.staffAction);
      if (c.configure) {
        expect(DASHBOARD_TABS, c.id).toContain(c.configure.tab);
        // Who may use a screen is always said: a staff action, or null for one the front desk uses too.
        expect(c.staffAction !== undefined, `${c.id} has a screen and does not say who may use it`).toBe(true);
      }
      expect(CAPABILITY_GROUPS, c.id).toContain(c.group);
    }
  });

  it("labels what it needs in the guide's five words", () => {
    expect(availabilityOf(requireCapability("check-in"))).toBe("now");
    expect(availabilityOf(requireCapability("memberships"))).toBe("configuration");
    expect(availabilityOf(requireCapability("go-live"))).toBe("approval");
    expect(availabilityOf(requireCapability("pay-online-billplz"))).toBe("integration");
    expect(availabilityOf(requireCapability("web-push"))).toBe("unsupported");
  });

  it("says nothing about a gym that its catalogue note does not", () => {
    const gym = BUILTIN_ACTIVITIES.find((a) => a.key === "gym")!;
    expect(gym.supportNote).toContain("without booking a session");
    expect(requireCapability("gym-walk-in").activityNote).toBe("gym");
  });
});
