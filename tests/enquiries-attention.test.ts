import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { ENQUIRY_NUDGE_DAYS, enquiriesAttention, setEnquiryStatus, submitEnquiry } from "../src/lib/enquiries";
import { setBookingAlerts } from "../src/lib/notify";
import { createVenue } from "../src/lib/store";
import { GET as attentionGet } from "../src/app/api/admin/attention/route";
import { staffTranslator } from "../src/lib/staff-i18n";

/**
 * Hardening round E17: a private hire enquiry nobody has answered is on the staff needs-attention list, whether or not the venue
 * set an alert email, with a gentle nudge once it has waited ENQUIRY_NUDGE_DAYS; it leaves when staff answer it; each venue's
 * staff see only their own venue's.
 */
let venueA: number;
let venueB: number;
let managerA: string;
let deskA: string;
let managerB: string;
let ownerCookie: string;
let n = 0;
const enquire = (venueId: number, name: string, extra: Record<string, unknown> = {}) =>
  submitEnquiry(venueId, {
    name,
    phone: `019333${String(4000 + n++)}`,
    kind: "party",
    message: "A birthday party for twenty children, Saturday afternoon, two courts.",
    ...extra,
  }).then((r) => {
    if (!r.ok) throw new Error(r.error);
    return r.enquiry;
  });
const cookie = (c: string) => ({ headers: { cookie: c } });
const attention = async (c: string) => (await (await attentionGet(new NextRequest("http://localhost/api/admin/attention", cookie(c)))).json()).enquiries as Awaited<ReturnType<typeof enquiriesAttention>>;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const a = await createVenue({ name: "Hire Arena A", area: "PJ", address: "1", phone: "0388880000" });
  const b = await createVenue({ name: "Hire Arena B", area: "PJ", address: "2", phone: "0388880001" });
  if (!a.ok || !b.ok) throw new Error("venue");
  venueA = a.venue.id;
  venueB = b.venue.id;
  const ma = await createAdmin({ name: "Mina A", email: "enq-ma@hire.test", password: "a long enough password", venueId: venueA, role: "manager" });
  const da = await createAdmin({ name: "Dev A", email: "enq-da@hire.test", password: "a long enough password", venueId: venueA, role: "desk" });
  const mb = await createAdmin({ name: "Mo B", email: "enq-mb@hire.test", password: "a long enough password", venueId: venueB, role: "manager" });
  if (!ma.ok || !da.ok || !mb.ok) throw new Error("admins");
  managerA = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(ma.admin.id)).token}`;
  deskA = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(da.admin.id)).token}`;
  managerB = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(mb.admin.id)).token}`;
  const owner = (await listAdmins()).find((x) => x.venueId === null)!;
  ownerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
});

describe("an unanswered private hire enquiry on the needs-attention list", () => {
  it("is there when the venue set no alert email at all, and nobody else sees it", async () => {
    // Venue A has no alert address or number: nothing was emailed, the list is all it has.
    const e = await enquire(venueA, "Puan Aminah");
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE kind = 'hire_enquiry'").get()) as { n: number }).n).toBe(0);
    for (const who of [managerA, deskA]) {
      const mine = await attention(who);
      expect(mine.total).toBe(1);
      expect(mine.items[0]).toMatchObject({ id: e.id, venueId: venueA, venueName: "Hire Arena A", kind: "party", name: "Puan Aminah", ageDays: 0, nudge: false });
    }
    // Another venue's staff see nothing of it; the platform owner sees every venue's.
    expect((await attention(managerB)).total).toBe(0);
    expect((await attention(ownerCookie)).items.map((i) => i.id)).toContain(e.id);
    // Only who and what, never the message or the number.
    const raw = JSON.stringify(await attention(managerA));
    expect(raw).not.toContain("birthday party");
    expect(raw).not.toContain("019333");
  });

  it("is there with an alert email too (the email is a courtesy, the list is the record), oldest first, scoped per venue", async () => {
    await setBookingAlerts(venueB, { email: "desk@b.my" });
    const first = await enquire(venueB, "Encik Bakar");
    const second = await enquire(venueB, "Cik Chong", { kind: "school" });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE kind = 'hire_enquiry'").get()) as { n: number }).n).toBe(2);
    const b = await attention(managerB);
    expect(b.total).toBe(2);
    expect(b.items.map((i) => i.id)).toEqual([first.id, second.id]);
    expect((await attention(managerA)).items.every((i) => i.venueId === venueA)).toBe(true);
  });

  it("is nudged after the days set, by its age, not before", async () => {
    const e = await enquire(venueA, "Encik Daud");
    const at = (days: number) => new Date(Date.now() + days * 86_400_000 + 60_000);
    const day = async (days: number) => (await enquiriesAttention([venueA], at(days))).items.find((i) => i.id === e.id)!;
    expect(await day(0)).toMatchObject({ ageDays: 0, nudge: false });
    expect(await day(1)).toMatchObject({ ageDays: 1, nudge: false });
    expect(ENQUIRY_NUDGE_DAYS).toBe(2);
    expect(await day(ENQUIRY_NUDGE_DAYS)).toMatchObject({ ageDays: 2, nudge: true });
    expect(await day(9)).toMatchObject({ ageDays: 9, nudge: true });
  });

  it("leaves the list when staff answer it, however it is answered, and twice at once is the same", async () => {
    const a = await enquire(venueA, "Puan Eliza");
    const b = await enquire(venueA, "Puan Farah");
    const before = (await attention(managerA)).total;
    await Promise.all([setEnquiryStatus(venueA, a.id, "replied", null), setEnquiryStatus(venueA, a.id, "replied", null)]);
    expect((await attention(managerA)).total).toBe(before - 1);
    await setEnquiryStatus(venueA, b.id, "declined", null);
    expect((await attention(managerA)).total).toBe(before - 2);
    // Put back to new, it is there again (the same rule as the Bookings tab's "new").
    await setEnquiryStatus(venueA, b.id, "new", null);
    expect((await attention(managerA)).items.map((i) => i.id)).toContain(b.id);
    // Another venue's staff answering it by id changes nothing.
    expect(await setEnquiryStatus(venueB, b.id, "booked", null)).toBeNull();
    expect((await attention(managerA)).items.map((i) => i.id)).toContain(b.id);
  });

  it("carries at most twenty and says how many there are; a venue with none costs nothing", async () => {
    const c = await createVenue({ name: "Hire Arena C", area: "PJ", address: "3", phone: "0388880002" });
    if (!c.ok) throw new Error("venue");
    for (let i = 0; i < 25; i++)
      await getDb()
        .prepare("INSERT INTO hire_enquiries (venue_id, name, phone, kind, message) VALUES (?, ?, '0193330000', 'event', 'Something for the whole club, a Sunday in March.')")
        .run(c.venue.id, `Club ${i}`);
    const out = await enquiriesAttention([c.venue.id]);
    expect(out.total).toBe(25);
    expect(out.items).toHaveLength(20);
    expect(out.items[0].name).toBe("Club 0");
    expect(await enquiriesAttention([])).toEqual({ total: 0, items: [] });
  });
});

describe("what staff read", () => {
  it("is in English, Malay and Chinese, the nudge gentle, with no key left over", () => {
    for (const locale of ["en", "ms", "zh"] as const) {
      const t = staffTranslator(locale);
      const line = t("enq.att.line", { name: "Puan Aminah", kind: t("enq.kind.party"), age: t("enq.att.daysAgo", { n: 3 }) });
      expect(line).toContain("Puan Aminah");
      expect(line).not.toMatch(/enq\.att|\{/);
      expect(t.plural("enq.att.title", 1)).not.toMatch(/enq\.att|\{/);
      expect(t.plural("enq.att.title", 4)).toContain("4");
      expect(t("enq.att.nudge")).not.toMatch(/enq\.att/);
      expect(t("enq.att.help", { place: t("sh.tab.bookings") })).toContain(t("sh.tab.bookings"));
    }
    expect(staffTranslator("en")("enq.att.nudge")).toMatch(/kind/);
  });
});
