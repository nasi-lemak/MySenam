import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

// The language the page is in, as its cookie says: none unless a test sets one.
const page = vi.hoisted(() => ({ locale: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: (name: string) => (name === "ms_lang" && page.locale ? { value: page.locale } : undefined) }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { listEnquiries, setEnquiryStatus, submitEnquiry } from "../src/lib/enquiries";
import { setBookingAlerts } from "../src/lib/notify";
import { exportPhoneData, retentionDue } from "../src/lib/privacy";
import { listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as ask } from "../src/app/api/venues/[id]/enquiry/route";
import { GET as list, POST as answer } from "../src/app/api/admin/enquiries/route";
import { replySubject } from "../src/components/admin/EnquiriesPanel";

/** Private hire enquiries: asked from the venue's page, answered by its staff. */

let venueId: number;
let otherId: number;
const good = {
  name: "Encik Hakim",
  phone: "0193334444",
  email: "hakim@syarikat.my",
  kind: "corporate",
  wantedOn: addDays(todayISO(), 30),
  people: 60,
  message: "Company sports day: badminton and futsal for 60 staff, Saturday morning.",
};
const post = (id: number, body: Record<string, unknown>) =>
  ask(
    new NextRequest(`http://localhost/api/venues/${id}/enquiry`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: String(id) }) }
  );

beforeAll(async () => {
  const venues = await listVenues();
  venueId = venues[0].id;
  otherId = venues[1].id;
  await setBookingAlerts(venueId, { email: "desk@arena.my" });
});

describe("asking about private hire", () => {
  it("is passed to the venue, by email where it gave an address", async () => {
    const res = await post(venueId, good);
    expect(res.status).toBe(201);
    const mail = (await getDb().prepare("SELECT recipient, subject, body FROM messages WHERE kind = 'hire_enquiry'").all()) as {
      recipient: string;
      subject: string;
      body: string;
    }[];
    expect(mail).toHaveLength(1);
    expect(mail[0].recipient).toBe("desk@arena.my");
    expect(mail[0].subject).toContain("Encik Hakim");
    expect(mail[0].body).toContain("60 staff");
  });

  it("asks for enough to answer, and not more than a person would send", async () => {
    expect((await post(venueId, { ...good, message: "hi" })).status).toBe(400);
    expect((await post(venueId, { ...good, kind: "rave" })).status).toBe(400);
    expect((await post(venueId, { ...good, wantedOn: addDays(todayISO(), -1) })).status).toBe(400);
    expect((await post(venueId, { ...good, people: 0 })).status).toBe(400);
    // A script fills in the field nobody sees: thanked, and nothing kept.
    expect((await post(venueId, { ...good, website: "http://spam" })).status).toBe(201);
    expect(await submitEnquiry(venueId, { ...good, phone: "0197778888" })).toMatchObject({ ok: true });
    expect(await submitEnquiry(venueId, { ...good, phone: "0197778888" })).toMatchObject({ ok: true });
    expect(await submitEnquiry(venueId, { ...good, phone: "019-777 8888" })).toMatchObject({ ok: true });
    expect(await submitEnquiry(venueId, { ...good, phone: "0197778888" })).toMatchObject({ ok: false, code: "ENQUIRY_LIMIT" });
    expect((await post(999999, good)).status).toBe(404);
  });
});

describe("answering them", () => {
  it("is for the venue's own staff, who mark where each stands", async () => {
    const desk = await createAdmin({ name: "Desk", email: "desk-enq@arena.my", password: "desk-password-1", venueId, role: "desk" });
    const away = await createAdmin({ name: "Away", email: "away-enq@arena.my", password: "away-password-1", venueId: otherId });
    if (!desk.ok || !away.ok) throw new Error("admin");
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    const awayCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(away.admin.id)).token}`;
    const seen = await (await list(new NextRequest("http://localhost/api/admin/enquiries", { headers: { cookie } }))).json();
    expect(seen.enquiries.length).toBe(4);
    expect(seen.enquiries[0]).toMatchObject({ status: "new", venueId });
    const theirs = await (await list(new NextRequest("http://localhost/api/admin/enquiries", { headers: { cookie: awayCookie } }))).json();
    expect(theirs.enquiries).toEqual([]);
    const id = seen.enquiries.find((e: { name: string; phone: string }) => e.phone === "0193334444").id;
    const mark = (body: unknown, as = cookie) =>
      answer(new NextRequest("http://localhost/api/admin/enquiries", { method: "POST", headers: { cookie: as }, body: JSON.stringify(body) }));
    expect((await mark({ venueId: otherId, id, status: "booked" }, cookie)).status).toBe(403);
    expect((await mark({ venueId, id, status: "maybe" })).status).toBe(400);
    const res = await mark({ venueId, id, status: "booked" });
    expect((await res.json()).enquiry).toMatchObject({ status: "booked", handledBy: "Desk" });
    expect(await setEnquiryStatus(otherId, id, "declined", null)).toBeNull();
  });

  it("go out with what the venue holds against the number, and go after a year", async () => {
    const held = await exportPhoneData([venueId], "0193334444");
    expect(held.enquiries).toEqual([expect.objectContaining({ kind: "corporate", status: "booked" })]);
    await getDb().prepare("UPDATE hire_enquiries SET created_at = '2020-01-01 00:00:00' WHERE phone = '0193334444'").run();
    const due = (await retentionDue()).find((l) => l.what === "Private hire enquiries");
    expect(due?.affected).toBe(1);
    expect((await listEnquiries([venueId])).every((e) => e.venueId === venueId)).toBe(true);
  });
});

describe("the subject of a reply", () => {
  let from = 0;
  const enquire = async (phone: string, email: string, locale: string | undefined) => {
    page.locale = locale;
    try {
      // Each from an address of its own, past the limit the tests above used up.
      const res = await ask(
        new NextRequest(`http://localhost/api/venues/${venueId}/enquiry`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${++from}` },
          body: JSON.stringify({ ...good, phone, email }),
        }),
        { params: Promise.resolve({ id: String(venueId) }) }
      );
      expect(res.status).toBe(201);
    } finally {
      page.locale = undefined;
    }
    return (await listEnquiries([venueId])).find((e) => e.phone === phone)!;
  };

  it("is in the language the enquiry was made in", async () => {
    const e = await enquire("0197770001", "aminah@example.my", "ms");
    expect(e.replyLocale).toBe("ms");
    expect(replySubject(e, "Your private hire enquiry")).toBe(`Pertanyaan sewaan persendirian anda — ${e.venueName}`);
  });

  it("is in the language of the customer's account where the platform knows it", async () => {
    await getDb().prepare("INSERT INTO users (name, email, phone, password_hash, locale) VALUES (?, ?, ?, '', 'zh')").run("Tan Wei", "Wei@Example.my", "0197770002");
    const e = await enquire("0197770002", "wei@example.my", "en");
    expect(e.replyLocale).toBe("zh");
    expect(replySubject(e, "x")).toBe(`您的包场询问 — ${e.venueName}`);
  });

  it("is in the staff member's language where neither is known", async () => {
    const e = await enquire("0197770003", "old@example.my", "ms");
    // Made before the language was kept.
    await getDb().prepare("UPDATE hire_enquiries SET locale = NULL WHERE id = ?").run(e.id);
    const old = (await listEnquiries([venueId])).find((x) => x.id === e.id)!;
    expect(old.replyLocale).toBeNull();
    expect(replySubject(old, "Pertanyaan sewaan persendirian anda")).toBe("Pertanyaan sewaan persendirian anda");
    // A language the install does not offer is not one to answer in.
    await getDb().prepare("UPDATE hire_enquiries SET locale = 'xx' WHERE id = ?").run(e.id);
    expect((await listEnquiries([venueId])).find((x) => x.id === e.id)!.replyLocale).toBeNull();
  });
});
