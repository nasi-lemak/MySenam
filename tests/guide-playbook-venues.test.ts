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

import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdmin, createAdminSession, ensureBootstrapAdmin, type Admin } from "../src/lib/admin-auth";
import { submitApplication } from "../src/lib/applications";
import { attachCoach, coachById, saveCoach } from "../src/lib/coaching";
import { setCoachLink, setCoachLocale } from "../src/lib/coach-schedule";
import { setCourtRates, setHoursChange } from "../src/lib/dated-changes";
import { getDb } from "../src/lib/db";
import { savePaymentSettings } from "../src/lib/payments";
import { createBooking, createCourt, getCourt } from "../src/lib/store";
import { staffTranslator, type StaffLocale } from "../src/lib/staff-i18n";
import { addDays, todayISO } from "../src/lib/time";
import { minuteClock } from "../src/lib/region";
import { playbookText, playbookLinks } from "../src/lib/guide/playbook/render";
import type { Playbook } from "../src/lib/guide/playbook/types";
import { linkAllowed } from "../src/lib/guide/playbook/dsl";
import { staffMay } from "../src/lib/roles";
import { GET as playbookGet } from "../src/app/api/admin/guide/playbook/route";
import { POST as branchesPost } from "../src/app/api/admin/branches/route";
import CoachGuidePage from "../src/app/coach/[token]/guide/page";
import CoachSchedulePage from "../src/app/coach/[token]/page";

/**
 * The playbook over real, saved venues: the route's contract and its role
 * rules, one venue's guide never carrying another's, a change to the
 * venue's configuration showing on the very next request, a branch getting
 * its own guide, and the coach's page and link. Run on PGlite and on
 * Postgres (docs/features/venue-guide.md, "The operating playbook").
 */

const ZONE = "Asia/Kuala_Lumpur";
const today = todayISO(ZONE);
const later = addDays(today, 20);
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
const get = (path: string, cookie?: string) => playbookGet(new NextRequest(`http://localhost${path}`, cookie ? { headers: { cookie } } : undefined));
const book = async (venueId: number, role = "", cookie = "") => {
  const res = await get(`/api/admin/guide/playbook?venueId=${venueId}${role ? `&as=${role}` : ""}`, cookie);
  return { res, body: res.status === 200 ? await res.clone().json() : await res.clone().json().catch(() => null) };
};
const textOf = (playbook: Playbook, locale: StaffLocale = "en") => playbookText({ t: staffTranslator(locale, "MySenam"), locale }, playbook).join("\n");

let alpha: number;
let beta: number;
let alphaCourt: number;
let asAlphaManager: string;
let asAlphaBranch: string;
let asAlphaDesk: string;
let asBetaManager: string;
let asOwner: string;
let coachToken: string;
let coachId: number;
let otherCoachToken: string;
let hours: { weekday: number; from: number; until: number }[];

beforeAll(async () => {
  await ensureBootstrapAdmin();
  asOwner = await cookieOf((await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!);

  // Alpha: configured, and everything about it carries the word Alpha.
  const a = await signUp("Marker Alpha Courts", "alpha@playbook.my");
  alpha = a.venueId;
  asAlphaManager = await cookieOf(a.manager);
  await getDb().prepare("UPDATE venues SET published_at = datetime('now'), cancel_cutoff_hours = 37 WHERE id = ?").run(alpha);
  const c1 = ok(await createCourt({ venueId: alpha, name: "Alpha Court 1", sport: "badminton", offPeakRate: 18, peakRate: 28 }));
  ok(await createCourt({ venueId: alpha, name: "Alpha Court 2", sport: "badminton", offPeakRate: 18, peakRate: 28 }));
  alphaCourt = c1.court.id;
  hours = [1, 2, 3, 4, 5, 6, 0].map((weekday) => ({ weekday, from: 9 * 60, until: 17 * 60 }));
  const coach = ok(await saveCoach(alpha, { name: "Coach Alphonse", sports: ["badminton"], rate: 61, hours }));
  coachId = coach.coach.id;
  ok(await saveCoach(alpha, { name: "Coach Alpha Two", sports: ["badminton"], rate: 62, hours }));
  const second = ok(await saveCoach(alpha, { name: "Coach Alpha Three", sports: ["badminton"], rate: 63, hours }));
  coachToken = (await setCoachLink(coachId, alpha, true))!.link!.pageUrl.split("/coach/")[1];
  otherCoachToken = (await setCoachLink(second.coach.id, alpha, true))!.link!.pageUrl.split("/coach/")[1];
  const lesson = ok(await createBooking({ courtId: alphaCourt, date: addDays(today, 2), hours: [10], name: "Student Alphard", phone: "0125550001" }));
  ok(await attachCoach(lesson.booking.id, (await coachById(coachId))!));
  const lesson2 = ok(await createBooking({ courtId: alphaCourt, date: addDays(today, 3), hours: [11], name: "Student Alphonsine", phone: "0125550002" }));
  ok(await attachCoach(lesson2.booking.id, (await coachById(second.coach.id))!));
  const desk = ok(await createAdmin({ name: "Alpha Desk", email: "desk@playbook.my", password: "desk-password-1", venueId: alpha, role: "desk" }));
  const branch = ok(await createAdmin({ name: "Alpha Branch", email: "branch@playbook.my", password: "branch-password-1", venueId: alpha }));
  asAlphaDesk = await cookieOf(desk.admin);
  asAlphaBranch = await cookieOf(branch.admin);

  // Beta: somebody else's, every name and number carrying its own marker.
  const b = await signUp("Marker Beta Hall", "beta@playbook.my");
  beta = b.venueId;
  asBetaManager = await cookieOf(b.manager);
  await getDb().prepare("UPDATE venues SET published_at = datetime('now'), cancel_cutoff_hours = 41 WHERE id = ?").run(beta);
  ok(await createCourt({ venueId: beta, name: "Beta Court", sport: "futsal", offPeakRate: 77, peakRate: 99 }));
  ok(await saveCoach(beta, { name: "Coach Betamax", sports: ["futsal"], rate: 55, hours }));
});

describe("the playbook route", () => {
  it("answers { venueId, role, ownRole, roles, playbook } for a manager, and no longer the placeholder facts", async () => {
    const { res, body } = await book(alpha, "", asAlphaManager);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(Object.keys(body).sort()).toEqual(["ownRole", "playbook", "role", "roles", "venueId"]);
    expect(body).toMatchObject({ venueId: alpha, role: "manager", ownRole: "manager", roles: ["manager", "desk", "coach"] });
    expect(body.playbook).toMatchObject({ role: "manager", venue: { id: alpha, name: "Marker Alpha Courts", draft: false, live: true } });
    expect(body.playbook.sections.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining(["start", "booking", "cancel", "eod", "manager", "quick"]));
    expect(body.playbook.toc.length).toBe(body.playbook.sections.length);
    // The venue's own number is the text's.
    expect(textOf(body.playbook)).toContain("up to 37 hours before the booking starts");
    // Its own venue by default, for a manager of one.
    const own = await get("/api/admin/guide/playbook", asAlphaBranch);
    expect((await own.json()).venueId).toBe(alpha);
  });

  it("gives the front desk its own guide, and a manager the desk's or a coach's to train them with", async () => {
    const desk = await book(alpha, "", asAlphaDesk);
    expect(desk.res.status).toBe(200);
    expect(desk.body).toMatchObject({ role: "desk", ownRole: "desk", roles: ["desk", "coach"] });
    expect(desk.body.playbook.role).toBe("desk");
    const preview = await book(alpha, "desk", asAlphaManager);
    expect(preview.body).toMatchObject({ role: "desk", ownRole: "manager" });
    expect(JSON.stringify(preview.body.playbook)).toBe(JSON.stringify(desk.body.playbook));
    const coach = await book(alpha, "coach", asAlphaManager);
    expect(coach.body.playbook.sections.map((s: { id: string }) => s.id)).toEqual(["coach"]);
    expect(playbookLinks(coach.body.playbook)).toEqual([]);
  });

  it("takes the role from the session: a desk asking for a manager's guide is refused, an unknown role is a bad request", async () => {
    expect((await get(`/api/admin/guide/playbook?venueId=${alpha}&as=manager`, asAlphaDesk)).status).toBe(403);
    expect((await get(`/api/admin/guide/playbook?venueId=${alpha}&as=owner`, asAlphaDesk)).status).toBe(400);
    expect((await get(`/api/admin/guide/playbook?venueId=${alpha}&as=desk`, asAlphaDesk)).status).toBe(200);
    expect((await get(`/api/admin/guide/playbook?venueId=${alpha}&as=coach`, asAlphaDesk)).status).toBe(200);
    expect((await get(`/api/admin/guide/playbook?venueId=${alpha}`)).status).toBe(401);
    expect((await get("/api/admin/guide/playbook", asOwner)).status).toBe(400);
    expect((await get("/api/admin/guide/playbook?venueId=abc", asOwner)).status).toBe(400);
    // The platform owner may read any venue's, as any role.
    expect((await get(`/api/admin/guide/playbook?venueId=${beta}`, asOwner)).status).toBe(200);
  });

  it("refuses a venue that is not yours to a branch manager, a business manager and the desk", async () => {
    for (const cookie of [asAlphaBranch, asAlphaManager, asAlphaDesk])
      for (const role of ["", "desk", "coach"]) expect((await get(`/api/admin/guide/playbook?venueId=${beta}${role ? `&as=${role}` : ""}`, cookie)).status, `${role} beta`).toBe(403);
    expect((await get(`/api/admin/guide/playbook?venueId=${alpha}`, asBetaManager)).status).toBe(403);
    expect((await get(`/api/admin/guide/playbook?venueId=999999`, asAlphaManager)).status).toBe(403);
  });

  it("puts in each role's guide only links that role may use, held to the real rules, as the route sends them", async () => {
    for (const [cookie, role] of [
      [asAlphaManager, "manager"],
      [asAlphaDesk, "desk"],
    ] as const) {
      const { body } = await book(alpha, "", cookie);
      const links = playbookLinks(body.playbook);
      expect(links.length, role).toBeGreaterThan(5);
      for (const link of links) {
        expect(linkAllowed(role, link.tab, link.staffAction), `${role} ${link.tab}`).toBe(true);
        if (link.staffAction) expect(staffMay(role)[link.staffAction], `${role} ${link.staffAction}`).toBe(true);
        if (role === "desk") expect(["reports", "courts", "venues"]).not.toContain(link.tab);
      }
    }
  });
});

describe("one venue's guide never carries another's", () => {
  const MARKERS_B = ["Marker Beta Hall", "Beta Court", "Coach Betamax", "41 hours", "RM77", "RM99", "beta@playbook.my"];
  const MARKERS_A = ["Marker Alpha Courts", "Alpha Court", "Coach Alphonse", "Student Alphard", "37 hours", "alpha@playbook.my"];

  it("holds across every role and language, in both directions", async () => {
    for (const [venue, cookie, theirs] of [
      [alpha, asAlphaManager, MARKERS_B],
      [beta, asBetaManager, MARKERS_A],
    ] as const)
      for (const role of ["manager", "desk", "coach"]) {
        const { body } = await book(venue, role, cookie);
        const json = JSON.stringify(body);
        for (const marker of theirs) {
          expect(json, `${venue} ${role}: ${marker}`).not.toContain(marker);
          for (const locale of ["en", "ms", "zh"] as const) expect(textOf(body.playbook, locale), `${venue} ${role} ${locale}: ${marker}`).not.toContain(marker);
        }
        // A manager's and a desk's own text says its own cutoff.
        if (role !== "coach") expect(textOf(body.playbook)).toContain(venue === alpha ? "up to 37 hours" : "up to 41 hours");
      }
  });

  it("names no customer, student, coach or staff member in any guide, but the venue's own name", async () => {
    const NAMES = ["Student Alphard", "Student Alphonsine", "Coach Alphonse", "Coach Alpha Two", "Coach Alpha Three", "Alpha Desk", "Alpha Branch", "Owner of Marker Alpha Courts", "0125550001", "0125550002"];
    for (const role of ["manager", "desk", "coach"]) {
      const { body } = await book(alpha, role, asAlphaManager);
      const json = JSON.stringify(body);
      for (const name of NAMES) expect(json, `${role}: ${name}`).not.toContain(name);
    }
  });
});

describe("a change to the configuration shows on the next request", () => {
  const manager = async (role = "manager") => textOf((await book(alpha, role, asAlphaManager)).body.playbook);

  it("changes the cutoff and what is owed, the way the venue is set, with nothing kept between two requests", async () => {
    expect(await manager()).toContain("up to 37 hours before the booking starts");
    await getDb().prepare("UPDATE venues SET cancel_cutoff_hours = 6 WHERE id = ?").run(alpha);
    const after = await manager();
    expect(after).toContain("up to 6 hours before the booking starts");
    expect(after).not.toContain("37 hours");
    // The late share, the strike limit and the online-refund setting are read from their own lookups.
    await getDb().prepare("UPDATE venues SET late_cancel_keep = 30, strike_limit = 4 WHERE id = ?").run(alpha);
    const late = await manager("desk");
    expect(late).toContain("keeps 30% of what was paid");
    expect(late).toContain("After 4 strikes");
    await getDb().prepare("UPDATE venues SET cancel_cutoff_hours = 37, late_cancel_keep = NULL, strike_limit = NULL WHERE id = ?").run(alpha);
    expect(await manager("desk")).toContain("customers cannot cancel online for a refund");
  });

  it("shows a scheduled change of hours and rates as 'coming', and today's apply until it starts", async () => {
    ok(await setHoursChange(alpha, { from: later, openMin: 7 * 60 + 15, closeMin: 22 * 60 }));
    ok(await setCourtRates((await getCourt(alphaCourt))!, { from: later, offPeakRate: 25, peakRate: 40 }));
    for (const role of ["manager", "desk"]) {
      const { body } = await book(alpha, role, asAlphaManager);
      const book_ = body.playbook as Playbook;
      expect(book_.scheduled.map((s) => s.kind)).toEqual(["hours", "rates"]);
      expect(book_.scheduled[0]).toMatchObject({ kind: "hours", from: later, openMin: 435, closeMin: 1320 });
      const callouts = book_.sections.flatMap((s) => s.blocks.filter((b) => b.type === "callout" && b.kind === "scheduled"));
      expect(callouts).toHaveLength(2);
      const text = textOf(book_);
      // The new times are only said in the callout; the summary still says today's.
      expect(text.split(minuteClock(435)).length - 1, role).toBe(1);
      expect(text).toContain("Coming on");
      expect(text).toContain("It opens from 8:00 AM to 11:00 PM today.");
      expect(text).toContain("Today's rates run from RM18 to RM28 an hour");
      expect(text).not.toContain("RM25");
      expect(text).not.toContain("RM40");
    }
  });

  it("shows a new activity, a new payment method and a new branch on the next request", async () => {
    expect(await manager()).not.toContain("Futsal");
    ok(await createCourt({ venueId: alpha, name: "Alpha Pitch", sport: "futsal", offPeakRate: 80, peakRate: 120 }));
    const withPitch = await manager();
    expect(withPitch).toContain("Badminton, Futsal");
    expect(withPitch).toContain("Your venue has 3 bookable resources");
    expect(withPitch).toContain("Online payment is off: customers pay at the counter.");
    expect(withPitch).not.toContain("Stripe");
    ok(await savePaymentSettings(alpha, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true }));
    const online = await manager();
    expect(online).toContain("Online payment is on in test mode with Billplz");
    expect(online).toContain("Billplz has no refund API");
    expect(online).not.toContain("api-key-1234");
    expect(online).not.toContain("col123");
    expect(online).not.toContain("S-key");
    expect(JSON.stringify((await book(alpha, "manager", asAlphaManager)).body)).not.toMatch(/api-key-1234|col123|S-key/);
    // A branch: the business's guide knows it has two, and the new branch gets a guide of its own.
    const res = await branchesPost(
      new NextRequest("http://localhost/api/admin/branches", {
        method: "POST",
        headers: { cookie: asAlphaManager, "content-type": "application/json" },
        body: JSON.stringify({ name: "Marker Alpha Two", area: "Cheras", address: "9 Jalan Salinan, Cheras", phone: "0391110000", ...pin, copyFrom: alpha }),
      })
    );
    expect(res.status).toBe(201);
    const branch = (await res.json()).venueId as number;
    expect(await manager()).toContain("Your business has 2 branches");
    const own = await book(branch, "manager", asAlphaManager);
    const text = textOf(own.body.playbook);
    expect(own.body.playbook.venue).toMatchObject({ id: branch, name: "Marker Alpha Two", draft: true });
    expect(text).toContain("Your business has 2 branches");
    expect(text).toContain("started from another branch's set-up");
    expect(text).toContain("Your venue is still a draft");
    // What is not copied is not in the new branch's guide: no payment account, no coach, no booking, no name of anything of the first.
    expect(text).not.toContain("Billplz");
    expect(text).not.toContain("coach's lessons");
    expect(JSON.stringify(own.body)).not.toMatch(/Marker Alpha Courts|Student Alphard|Coach Alphonse|api-key-1234/);
    expect(own.body.playbook.modules).not.toContain("spec.coaching");
  });
});

describe("a coach's guide", () => {
  const page = async (token: string) => renderToStaticMarkup(await CoachGuidePage({ params: Promise.resolve({ token }) }));

  it("is at the coach's private link, with their own facts and nothing else of the venue", async () => {
    const html = await page(coachToken);
    expect(html).toContain("Marker Alpha Courts");
    expect(html).toContain("Your private page");
    expect(html).toContain("You have 1 lessons in the next 30 days.");
    expect(html).toContain(`href="/coach/${coachToken}"`);
    expect(html).toContain("data-playbook-print");
    expect(html).toContain("@media print");
    // The next coach has their own count, and neither sees the other's students, nor money, nor staff.
    const other = await page(otherCoachToken);
    expect(other).toContain("You have 1 lessons in the next 30 days.");
    for (const h of [html, other]) {
      for (const hidden of ["Student Alphard", "Student Alphonsine", "Coach Alphonse", "Coach Alpha Two", "Coach Alpha Three", "Marker Beta Hall", "Coach Betamax", "0125550001", "RM18", "RM28", "37 hours"]) expect(h, hidden).not.toContain(hidden);
      expect(h).not.toMatch(/refund|payment|cash-up|Cash-up|Reports/i);
    }
  });

  it("is not found for a wrong, lapsed or withdrawn link, as the schedule is", async () => {
    await expect(page("x".repeat(30))).rejects.toThrow();
    await expect(page("short")).rejects.toThrow();
    await expect(CoachSchedulePage({ params: Promise.resolve({ token: "x".repeat(30) }) })).rejects.toThrow();
    const lapsed = (await setCoachLink(coachId, alpha, true))!.link!.pageUrl.split("/coach/")[1];
    await expect(page(lapsed)).resolves.toContain("Your private page");
    await getDb().prepare("UPDATE coaches SET link_expires_at = now() - interval '1 day' WHERE id = ?").run(coachId);
    await expect(page(lapsed)).rejects.toThrow();
    await expect(CoachSchedulePage({ params: Promise.resolve({ token: lapsed }) })).rejects.toThrow();
    const again = (await setCoachLink(coachId, alpha, true))!.link!.pageUrl.split("/coach/")[1];
    await expect(page(again)).resolves.toContain("Your private page");
    await setCoachLink(coachId, alpha, false);
    await expect(page(again)).rejects.toThrow();
    // The old link no longer works either, and the other coach's still does.
    await expect(page(coachToken)).rejects.toThrow();
    await expect(page(otherCoachToken)).resolves.toContain("Your private page");
  });

  it("is linked from the coach's own page, and written in the coach's language", async () => {
    const token = (await setCoachLink(coachId, alpha, true))!.link!.pageUrl.split("/coach/")[1];
    const schedule = renderToStaticMarkup(await CoachSchedulePage({ params: Promise.resolve({ token }) }));
    expect(schedule).toContain(`href="/coach/${token}/guide"`);
    expect(schedule).toContain("How to use this page, and what you can see");
    ok(await setCoachLocale(coachId, alpha, "ms"));
    const ms = renderToStaticMarkup(await CoachGuidePage({ params: Promise.resolve({ token }) }));
    expect(ms).toContain("Halaman peribadi anda");
    expect(ms).not.toContain("Your private page");
    ok(await setCoachLocale(coachId, alpha, "zh"));
    const zh = renderToStaticMarkup(await CoachGuidePage({ params: Promise.resolve({ token }) }));
    expect(zh).toContain("您的私人页面");
    // Tamil has no staff dictionary: the install's first staff language, never a blank.
    ok(await setCoachLocale(coachId, alpha, "ta"));
    const ta = renderToStaticMarkup(await CoachGuidePage({ params: Promise.resolve({ token }) }));
    expect(ta).toContain("Your private page");
    ok(await setCoachLocale(coachId, alpha, null));
  });
});
