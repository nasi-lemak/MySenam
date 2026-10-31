import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_MARKETPLACE = "on";
process.env.MYSENAM_GEOCODER = "off";
process.env.MYSENAM_URL = "https://book.example.my";
for (const name of ["SMTP_URL", "MAIL_FROM", "SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "SES_REGION", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]) delete process.env[name];

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdmin, createAdminSession, ensureBootstrapAdmin, type Admin } from "../src/lib/admin-auth";
import { submitApplication } from "../src/lib/applications";
import { saveCoach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { createCourt } from "../src/lib/store";
import { CAPABILITIES, CAPABILITY_GROUPS, availabilityOf, capability } from "../src/lib/guide/capabilities";
import { emptyAnswers } from "../src/lib/guide/answer-schema";
import { DISCOVERY_RULES, MAX_DISCOVERIES, discover } from "../src/lib/guide/discover";
import { CAPABILITY_TOPIC, IN_USE_IDS, REGISTRY_IDS, capabilityInUse, catalogue, setupFocus } from "../src/lib/guide/help-catalogue";
import { TOPIC_IDS } from "../src/lib/guide/help";
import { focusIds } from "../src/lib/guide/plan";
import { emptyProfile } from "../src/lib/guide/profile-types";
import { isFocus } from "../src/lib/guide/setup-journey";
import { GET as journeyGet } from "../src/app/api/admin/guide/setup/journey/route";
import { GET as setupGet, POST as setupPost } from "../src/app/api/admin/guide/setup/route";

/**
 * The discover view's model and what it rests on: "everything MySenam can do"
 * is the registry, nothing unsupported is offered for setup, a venue is never
 * offered what it uses, a suggestion set aside stays set aside and is logged,
 * and a suggestion's "Set this up" is a targeted journey the route serves.
 * Run on PGlite and on Postgres.
 */

const pin = { lat: 3.15, lng: 101.6 };
const PASSWORD = "a long enough password";
const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};

async function signUp(name: string, email: string): Promise<{ venueId: number; manager: Admin }> {
  const applied = await submitApplication({ businessName: name, area: "Ampang", address: "1 Jalan Satu, Ampang", venuePhone: "0342220000", contactName: `Owner of ${name}`, email, password: PASSWORD, ...pin });
  if (!applied.ok) throw new Error(applied.error);
  return { venueId: applied.application.venueId!, manager: (await authenticateAdmin(email, PASSWORD))! };
}
const cookieOf = async (admin: Admin) => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(admin.id)).token}`;
const req = (path: string, cookie: string, init?: { method: string; body: unknown }) =>
  new NextRequest(`http://localhost${path}`, { headers: { cookie, "content-type": "application/json" }, ...(init ? { method: init.method, body: JSON.stringify(init.body) } : {}) });
const view = async (venueId: number, cookie: string) => (await setupGet(req(`/api/admin/guide/setup?venueId=${venueId}`, cookie))).json();
const post = (cookie: string, body: Record<string, unknown>) => setupPost(req("/api/admin/guide/setup", cookie, { method: "POST", body }));

let alpha: number;
let beta: number;
let asAlpha: string;
let asBeta: string;
let asAlphaDesk: string;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const a = await signUp("Discover Alpha", "alpha@discover.my");
  alpha = a.venueId;
  asAlpha = await cookieOf(a.manager);
  await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(alpha);
  ok(await createCourt({ venueId: alpha, name: "Discover 1", sport: "badminton", offPeakRate: 18, peakRate: 28 }));
  const desk = ok(await createAdmin({ name: "Alpha Disc Desk", email: "desk@discover.my", password: "desk-password-1", venueId: alpha, role: "desk" }));
  asAlphaDesk = await cookieOf(desk.admin);
  const b = await signUp("Discover Beta", "beta@discover.my");
  beta = b.venueId;
  asBeta = await cookieOf(b.manager);
  await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(beta);
  ok(await createCourt({ venueId: beta, name: "Discover B1", sport: "futsal", offPeakRate: 30, peakRate: 40 }));
});

describe("everything MySenam can do", () => {
  it("is the registry: every capability once, in the registry's groups and order, with nothing added", () => {
    const groups = catalogue(emptyProfile(1));
    const ids = groups.flatMap((g) => g.items.map((i) => i.capability.id));
    expect(ids.length).toBe(CAPABILITIES.length);
    expect([...ids].sort()).toEqual([...REGISTRY_IDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(groups.map((g) => g.group)).toEqual(CAPABILITY_GROUPS.filter((g) => CAPABILITIES.some((c) => c.group === g)));
    for (const g of groups) expect(g.items.map((i) => i.capability.id)).toEqual(CAPABILITIES.filter((c) => c.group === g.group).map((c) => c.id));
    for (const g of groups) expect(g.counts.inUse + g.counts.available + g.counts.unsupported).toBe(g.items.length);
  });

  it("marks an unsupported capability as such, never offers it for setup, and holds for any venue", () => {
    const busy = emptyProfile(1);
    busy.resources.total = 6;
    busy.history.bookings = 100;
    busy.identity.live = true;
    for (const profile of [emptyProfile(1), busy]) {
      for (const item of catalogue(profile, ["coaching"]).flatMap((g) => g.items)) {
        if (item.capability.status === "unsupported") {
          expect(item.state, item.capability.id).toBe("unsupported");
          expect(item.focus, item.capability.id).toBeNull();
          expect(setupFocus(item.capability, profile), item.capability.id).toBeNull();
          expect(item.availability).toBe("unsupported");
        } else {
          expect(["in-use", "available"], item.capability.id).toContain(item.state);
          expect(item.availability).toBe(availabilityOf(item.capability));
        }
      }
    }
  });

  it("marks only what the saved configuration shows as in use, and a venue is not offered a setup for what it uses", () => {
    const p = emptyProfile(1);
    expect(catalogue(p).flatMap((g) => g.items).filter((i) => i.state === "in-use").map((i) => i.capability.id)).toEqual([]);
    p.people.classes = 2;
    p.rates.peakPricing = true;
    p.commerce.passProducts = 1;
    p.resources.total = 3;
    const used = new Map(catalogue(p).flatMap((g) => g.items).map((i) => [i.capability.id, i]));
    for (const id of ["classes", "peak-pricing", "passes", "resources"]) {
      expect(used.get(id)!.state, id).toBe("in-use");
      expect(used.get(id)!.focus, id).toBeNull();
      expect(setupFocus(capability(id)!, p), id).toBeNull();
    }
    expect(used.get("coaching")!.state).toBe("available");
    expect(used.get("coaching")!.focus).toBe("coaching");
    // What the profile cannot tell is never shown as in use.
    for (const id of ["cash-up", "check-in", "reports", "outages"]) expect(capabilityInUse(id, p), id).toBeNull();
  });

  it("only checks capabilities that exist and are available, and explains only with topics that exist", () => {
    for (const id of IN_USE_IDS) {
      expect(capability(id), id).toBeTruthy();
      expect(capability(id)!.status, id).toBe("available");
    }
    for (const [id, topic] of Object.entries(CAPABILITY_TOPIC)) {
      expect(capability(id), id).toBeTruthy();
      expect(TOPIC_IDS, id).toContain(topic);
    }
    for (const c of CAPABILITIES.filter((c) => c.status === "unsupported")) expect(capabilityInUse(c.id, emptyProfile(1)), c.id).toBeNull();
  });

  it("starts a targeted setup only on a focus the setup plan has, and says which suggestions have none, so the screen opens instead", () => {
    const profile = emptyProfile(1);
    for (const item of catalogue(profile).flatMap((g) => g.items)) if (item.focus) expect(isFocus(item.focus), item.focus).toBe(true);
    const noFocus = DISCOVERY_RULES.map((r) => r.capability).filter((id) => !focusIds().includes(id));
    // Suggestions whose capability has no setup step open the screen that has it, and have one.
    for (const id of noFocus) expect(capability(id)!.configure, id).toBeTruthy();
    expect(noFocus.sort()).toEqual(["booking-alerts", "company-accounts"]);
  });
});

describe("the suggestions of a venue", () => {
  it("are at most three, never of an unsupported capability, with a reason each, for every rule at once", () => {
    const everything = emptyProfile(1);
    everything.identity.live = true;
    everything.history.bookings = 200;
    everything.channels.onlinePage = true;
    everything.resources.total = 8;
    everything.people.classes = 2;
    everything.activities = [{ key: "badminton", support: "full", own: false }];
    const answers = { ...emptyAnswers(), coaching: true, types: ["school-and-corporate"], branches: "several" } as never;
    const found = discover(everything, answers, {});
    expect(found.length).toBeLessThanOrEqual(MAX_DISCOVERIES);
    for (const d of found) {
      expect(capability(d.id)!.status, d.id).toBe("available");
      expect(d.reason.key).toMatch(/^gd\.disc\./);
    }
    for (const rule of DISCOVERY_RULES) expect(capability(rule.capability)!.status, rule.capability).toBe("available");
  });

  it("are offered once, set aside through the existing route, logged, kept aside for good, and for that venue only", async () => {
    const saved = await post(asAlpha, { venueId: alpha, action: "answers", answers: { coaching: true }, rev: (await view(alpha, asAlpha)).rev });
    expect(saved.status).toBe(200);
    const first = await view(alpha, asAlpha);
    expect(first.discoveries.map((d: { id: string }) => d.id)).toContain("coaching");
    expect(first.discoveries.filter((d: { id: string }) => d.id === "coaching").length).toBe(1);
    // Beta is its own venue: what Alpha said is not Beta's.
    expect((await view(beta, asBeta)).discoveries.map((d: { id: string }) => d.id)).not.toContain("coaching");

    const dismissed = await post(asAlpha, { venueId: alpha, action: "dismiss", id: "coaching" });
    expect(dismissed.status).toBe(200);
    expect((await dismissed.json()).discoveries.map((d: { id: string }) => d.id)).not.toContain("coaching");
    // It stays set aside: on a fresh read, after more answers, and after the same call twice.
    expect((await view(alpha, asAlpha)).discoveries.map((d: { id: string }) => d.id)).not.toContain("coaching");
    await post(asAlpha, { venueId: alpha, action: "answers", answers: { coaching: true, customersDo: ["classes"] }, rev: (await view(alpha, asAlpha)).rev });
    expect((await view(alpha, asAlpha)).discoveries.map((d: { id: string }) => d.id)).not.toContain("coaching");
    expect((await post(asAlpha, { venueId: alpha, action: "dismiss", id: "coaching" })).status).toBe(200);
    expect((await view(alpha, asAlpha)).dismissed).toHaveProperty("coaching");
    // Logged, naming the suggestion and nothing else.
    const log = (await listActivity([alpha])).filter((a) => a.action === "guide.dismissed" && a.detail === "Suggestion coaching");
    expect(log.length).toBeGreaterThanOrEqual(1);
    // The other venue's log has none of it.
    expect((await listActivity([beta])).some((a) => a.action === "guide.dismissed")).toBe(false);
    // Only a suggestion MySenam makes can be set aside, never an unsupported capability or an unknown word.
    for (const id of ["web-push", "surge-pricing", "nope", ""]) expect((await post(asAlpha, { venueId: alpha, action: "dismiss", id })).status, id).toBe(400);
  });

  it("are not offered for what the venue already uses", async () => {
    await getDb().prepare("DELETE FROM venue_guide WHERE venue_id = ?").run(beta);
    await post(asBeta, { venueId: beta, action: "answers", answers: { coaching: true }, rev: 0 });
    expect((await view(beta, asBeta)).discoveries.map((d: { id: string }) => d.id)).toContain("coaching");
    ok(await saveCoach(beta, { name: "Coach Disc", sports: ["futsal"], rate: 50, hours: [{ weekday: 1, from: 540, until: 1020 }] }));
    expect((await view(beta, asBeta)).discoveries.map((d: { id: string }) => d.id)).not.toContain("coaching");
  });

  it("are a manager's: the front desk is refused the view and the dismissal, and another venue's manager is refused", async () => {
    const getDesk = await setupGet(req(`/api/admin/guide/setup?venueId=${alpha}`, asAlphaDesk));
    expect(getDesk.status).toBe(403);
    expect((await getDesk.json()).code).toBe("MANAGER_ONLY");
    const dismissDesk = await post(asAlphaDesk, { venueId: alpha, action: "dismiss", id: "booking-alerts" });
    expect(dismissDesk.status).toBe(403);
    expect((await setupGet(req(`/api/admin/guide/setup?venueId=${alpha}`, asBeta))).status).toBe(403);
    expect((await post(asBeta, { venueId: alpha, action: "dismiss", id: "booking-alerts" })).status).toBe(403);
  });
});

describe("Set this up", () => {
  const journey = (venueId: number, focus: string, cookie: string) => journeyGet(req(`/api/admin/guide/setup/journey?venueId=${venueId}&focus=${focus}`, cookie));

  it("starts a targeted journey for a suggestion: the plan narrowed to that capability, not the whole of setup", async () => {
    const whole = await (await journeyGet(req(`/api/admin/guide/setup/journey?venueId=${alpha}`, asAlpha))).json();
    const targeted = await journey(alpha, "coaching", asAlpha);
    expect(targeted.status).toBe(200);
    const body = await targeted.json();
    expect(body.extras.focus).toBe("coaching");
    expect(body.plan.items.length).toBeGreaterThan(0);
    expect(body.plan.items.length).toBeLessThan(whole.plan.items.length);
  });

  it("refuses a focus the setup has no steps for, and the front desk, and another venue's manager", async () => {
    expect((await journey(alpha, "company-accounts", asAlpha)).status).toBe(400);
    expect((await journey(alpha, "gym-walk-in", asAlpha)).status).toBe(400);
    expect((await journey(alpha, "coaching", asAlphaDesk)).status).toBe(403);
    expect((await journey(alpha, "coaching", asBeta)).status).toBe(403);
  });
});
