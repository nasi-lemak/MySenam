import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { listActivity } from "../src/lib/activity";
import { createApiKey } from "../src/lib/api-keys";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { claimRelationship, confirmContactCode, guardianReviews, openNoticeTasks } from "../src/lib/contact-guardians";
import { getDb } from "../src/lib/db";
import { setHouseRules } from "../src/lib/house-rules";
import { listManaged } from "../src/lib/managed-people";
import { setTransport } from "../src/lib/outbox";
import { createAtVenue, createInvite, participantHistory, reviewQueue } from "../src/lib/participants";
import { phoneNumber } from "../src/lib/phone-check";
import { exportCustomerData } from "../src/lib/privacy";
import { resetRateLimits } from "../src/lib/rate-limit";
import { createResources } from "../src/lib/resources";
import { cancelBooking, createBookingSeries, createVenue, joinSlotWaitlist } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { createHash } from "crypto";
import * as attentionRoute from "../src/app/api/admin/attention/route";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as apiBookingsRoute from "../src/app/api/v1/bookings/route";
import * as contactRoute from "../src/app/api/admin/participants/[id]/contact-guardians/route";
import * as guardiansRoute from "../src/app/api/admin/participants/[id]/guardians/route";
import * as participantRoute from "../src/app/api/admin/participants/[id]/route";
import * as participantsRoute from "../src/app/api/admin/participants/route";
import * as acceptRoute from "../src/app/api/my/people/accept/route";
import * as invitesRoute from "../src/app/api/my/people/invites/route";

/**
 * Guardians a venue recorded by name and number only (lib/contact-guardians.ts;
 * ADR 0023, amended 27 October 2026; docs/features/venue-operations.md#guardians-without-an-account).
 *
 * A walk-in family's guardian has no account. A name and a number grant
 * nothing: through the venue's staff, a one-time code sent to the number
 * recorded for them (the code and the venue's name, nothing about the child)
 * and read back is their agreement, their withdrawal, or proof that the
 * number reaches them; without phone messaging a manager (never the desk)
 * records an in-person agreement, flagged for review. Registering later,
 * they take the same relationship over only with a proved number AND a code
 * from staff or another guardian. They are told of changes only at a number
 * proved to reach them, without the child's name; otherwise the venue is
 * given a task. A paused or ended guardian acts on no path.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0177${String(++n).padStart(6, "0")}`;

type Staff = { id: number; name: string; cookie: string };
type Adult = Awaited<ReturnType<typeof adult>>;

let venue: number;
let otherVenue: number;
let hall: number;
let hall2: number;
let kayak: number;
let manager: Staff;
let desk: Staff;
let otherManager: Staff;
let owner: Staff;

/** An account; its number proved (as lib/phone-check.ts records it) unless `proved` is false. */
async function adult(name: string, ph = phone(), proved = true) {
  const made = await registerUser({ name, email: `gc${++n}@gc.test`, phone: ph, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  if (proved) await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = ? WHERE id = ?").run(phoneNumber(ph), made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

async function staffMember(venueId: number | null, name: string, role: "manager" | "desk" = "manager"): Promise<Staff> {
  const made = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}${++n}@gc.test`, password: "a long enough password", venueId, role });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, name, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}

const req = (url: string, method: string, cookie: string | null, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.77.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const json = async (res: Response) => (await res.json()) as Record<string, unknown> & { code?: string };
const count = async (sql: string, ...args: unknown[]) => ((await getDb().prepare(sql).get(...args)) as { n: number }).n;

const contact = (who: Staff, participantId: number, body: Record<string, unknown>, venueId = venue) =>
  contactRoute.POST(req(`http://localhost/api/admin/participants/${participantId}/contact-guardians`, "POST", who.cookie, { venueId, ...body }), ctx(participantId));
const invite = (who: Staff, participantId: number, body: Record<string, unknown>) =>
  guardiansRoute.POST(req(`http://localhost/api/admin/participants/${participantId}/guardians`, "POST", who.cookie, { venueId: venue, ...body }), ctx(participantId));
const patch = (who: Staff, participantId: number, body: Record<string, unknown>) =>
  participantRoute.PATCH(req(`http://localhost/api/admin/participants/${participantId}`, "PATCH", who.cookie, body), ctx(participantId));
const accept = (who: Adult, body: Record<string, unknown>) => acceptRoute.POST(req("http://localhost/api/my/people/accept", "POST", who.cookie, body));
const attention = async (who: Staff) => json(await attentionRoute.GET(req("http://localhost/api/admin/attention", "GET", who.cookie)));
const bookOnline = (who: Adult, participantId: number, hour: number, date = day(7), extra: Record<string, unknown> = {}) =>
  bookingsRoute.POST(
    req("http://localhost/api/bookings", "POST", who.cookie, { courtId: hall, date, start: at(hour), end: at(hour + 1), name: who.name, phone: who.phone, participantIds: [participantId], ...extra })
  );
const bookAtCounter = (who: Staff, ph: string, participantId: number, hour: number, date = day(5)) =>
  bookingsRoute.POST(req("http://localhost/api/bookings", "POST", who.cookie, { courtId: hall, date, start: at(hour), end: at(hour + 1), name: "At the counter", phone: ph, participantIds: [participantId] }));

// ---------------------------------------------------------------------- what leaves the building

/** SMS through a stand-in HTTP gateway: every text sent, as the gateway received it. */
let texts: { to: string; text: string }[] = [];
function smsOn() {
  texts = [];
  vi.stubEnv("SMS_HTTP_URL", "https://sms.example.my/send?to={to}&msg={text}");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(String(url));
      texts.push({ to: u.searchParams.get("to") ?? "", text: u.searchParams.get("msg") ?? "" });
      return new Response("queued", { status: 200 });
    })
  );
}
const lastCode = () => /\b(\d{6})\b/.exec(texts.at(-1)!.text)![1];
/** WhatsApp set up (messages queue in the outbox; nothing leaves in a test). */
function whatsappOn() {
  vi.stubEnv("WHATSAPP_TOKEN", "test-token");
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "1");
}

/** A child the venue added at the counter, their mother on record by name and number only. */
async function walkIn(displayName: string, mumPhone = phone()) {
  const made = await createAtVenue({
    venueId: venue,
    admin: { id: desk.id, name: desk.name },
    displayName,
    birthYear: 2016,
    guardian: { name: "Puan Aminah", phone: mumPhone, relationship: "parent", authority: true },
  });
  if (!made.ok) throw new Error(made.error);
  return { id: made.participant.id, mumPhone, mumGuardian: made.guardianshipId };
}

/** Staff start a request for another adult; that adult accepts it on their own account (pending). */
async function requested(kid: number, dad: Adult, accept_ = true) {
  const res = await invite(desk, kid, { proposedName: dad.name });
  expect(res.status).toBe(201);
  const { request } = (await res.json()) as { request: { id: number; code: string; consentPossible: boolean; contactConsent: boolean } };
  if (accept_) expect(await json(await accept(dad, { code: request.code, relationship: "parent", authority: true }))).toMatchObject({ as: "pending" });
  return request;
}

beforeAll(async () => {
  const make = async (name: string, ph: string) => {
    const v = await createVenue({ name, area: "Bangsar", address: "x", phone: ph, openMin: at(7), closeMin: at(23) });
    if (!v.ok) throw new Error("venue");
    return v.venue.id;
  };
  venue = await make("Guardian Centre", "0312350601");
  otherVenue = await make("Elsewhere Centre", "0312350602");
  const court = async (sport: string, name: string, capacity = 1) => {
    const r = await createResources({ venueId: venue, sport, name, offPeakRate: 20, peakRate: 20, capacity, ...(capacity > 1 ? { maxPlayers: capacity } : {}) });
    if (!r.ok) throw new Error(r.error);
    return r.courts[0].id;
  };
  hall = await court("badminton", "Hall A");
  hall2 = await court("badminton", "Hall B");
  kayak = await court("kayak", "Kayaks", 2);
  expect((await setHouseRules(venue, { aheadDays: 45 })).ok).toBe(true);
  manager = await staffMember(venue, "Mona Manager");
  desk = await staffMember(venue, "Dewi Desk", "desk");
  otherManager = await staffMember(otherVenue, "Omar Other");
  owner = await staffMember(null, "Olive Owner");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setTransport(null);
  resetRateLimits();
});

// ---------------------------------------------------------------------- agreeing through staff

describe("a guardian recorded by name and number agrees through staff, by a code to their number", () => {
  it("makes the relationship once the code comes back; the text says the venue and the code, nothing about the child", async () => {
    smsOn();
    const kid = await walkIn("Alya");
    const dad = await adult("Encik Rahman");
    const participants = await count("SELECT COUNT(*)::int AS n FROM participants");
    const request = await requested(kid.id, dad);
    // Nobody on record has an account, but the mother recorded here can agree through staff.
    expect(request.consentPossible).toBe(false);
    expect(request.contactConsent).toBe(true);
    expect(await listManaged(dad.id)).toEqual([]);

    const sent = await contact(desk, kid.id, { action: "sendCode", guardianId: kid.mumGuardian, purpose: "agree", requestId: request.id });
    expect(sent.status).toBe(201);
    expect(await json(sent)).toMatchObject({ channel: "sms" });
    expect(texts).toHaveLength(1);
    expect(texts[0].to).toBe(phoneNumber(kid.mumPhone));
    expect(texts[0].text).toContain("Guardian Centre");
    expect(texts[0].text).toMatch(/\b\d{6}\b/);
    for (const secret of ["Alya", "Rahman", "guardian", "child", "2016"]) expect(texts[0].text.replace("Guardian Centre", "").toLowerCase()).not.toContain(secret.toLowerCase());
    // Only its keyed hash is kept.
    expect(await count("SELECT COUNT(*)::int AS n FROM guardian_contact_codes WHERE code_hash = ?", lastCode())).toBe(0);

    // A wrong code is refused and counted; nothing is made.
    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    expect((await json(await contact(desk, kid.id, { action: "confirmCode", guardianId: kid.mumGuardian, purpose: "agree", requestId: request.id, code: wrong }))).code).toBe("GW5_CODE_WRONG");
    expect(await listManaged(dad.id)).toEqual([]);

    const right = await contact(desk, kid.id, { action: "confirmCode", guardianId: kid.mumGuardian, purpose: "agree", requestId: request.id, code });
    expect(right.status).toBe(200);
    expect(await json(right)).toEqual({ ok: true, active: true });
    expect((await listManaged(dad.id)).map((p) => p.id)).toEqual([kid.id]);
    expect((await bookOnline(dad, kid.id, 9)).status).toBe(201);
    // Used once: the same code again is refused.
    expect((await json(await contact(desk, kid.id, { action: "confirmCode", guardianId: kid.mumGuardian, purpose: "agree", requestId: request.id, code }))).code).toBe("GW5_CODE_EXPIRED");

    // On record: how, who entered it; the relationship is the adult's online declaration, not flagged; no second child.
    expect(
      await getDb()
        .prepare("SELECT status, consent_method, consented_by_name, consent_staff_name, consent_guardianship_id, consented_by_user_id FROM guardian_requests WHERE id = ?")
        .get(request.id)
    ).toEqual({
      status: "active",
      consent_method: "staff_assisted_phone_code",
      consented_by_name: "Puan Aminah",
      consent_staff_name: "Dewi Desk",
      consent_guardianship_id: kid.mumGuardian,
      consented_by_user_id: null,
    });
    expect(await getDb().prepare("SELECT provenance, review_reason FROM participant_guardians WHERE participant_id = ? AND user_id = ?").get(kid.id, dad.id)).toEqual({
      provenance: "online",
      review_reason: null,
    });
    expect(await getDb().prepare("SELECT contact_verified_at IS NOT NULL AS verified, contact_verified_number FROM participant_guardians WHERE id = ?").get(kid.mumGuardian)).toEqual({
      verified: true,
      contact_verified_number: phoneNumber(kid.mumPhone),
    });
    expect(await count("SELECT COUNT(*)::int AS n FROM participants")).toBe(participants);
    const history = await participantHistory(kid.id);
    expect(history.map((e) => e.action)).toEqual(expect.arrayContaining(["guardian.code_sent", "guardian.request_agreed", "guardian.added"]));
    expect(history.find((e) => e.action === "guardian.added")!.detail).toContain("by a code sent to their number, entered by Dewi Desk");
    const log = await listActivity([venue], {});
    expect(log.map((e) => e.action)).toEqual(expect.arrayContaining(["participant.guardian_code_sent", "participant.guardian_agreed_by_code"]));
  });

  it("a code run out, tried five times wrong, or replaced by a newer one is refused", async () => {
    smsOn();
    const kid = await walkIn("Batrisya");
    const request = await requested(kid.id, await adult("Encik Bakar"));
    const send = () => contact(desk, kid.id, { action: "sendCode", guardianId: kid.mumGuardian, purpose: "agree", requestId: request.id });
    const enter = (code: string) => contact(desk, kid.id, { action: "confirmCode", guardianId: kid.mumGuardian, purpose: "agree", requestId: request.id, code });
    expect((await send()).status).toBe(201);
    const first = lastCode();
    await getDb().prepare("UPDATE guardian_contact_codes SET expires_at = now() - interval '1 minute' WHERE guardianship_id = ?").run(kid.mumGuardian);
    expect((await json(await enter(first))).code).toBe("GW5_CODE_EXPIRED");

    expect((await send()).status).toBe(201);
    const second = lastCode();
    for (let i = 0; i < 5; i++) expect((await json(await enter(second === "999999" ? "888888" : "999999"))).code).toBe("GW5_CODE_WRONG");
    expect((await json(await enter(second))).code).toBe("GW5_CODE_EXPIRED");

    expect((await send()).status).toBe(201);
    const third = lastCode();
    // A third send in the hour is the last; a fourth is refused.
    expect((await json(await send())).code).toBe("PHONE_CODE_LIMIT");
    expect((await json(await enter(third))).ok).toBe(true);
    expect(await getDb().prepare("SELECT status FROM guardian_requests WHERE id = ?").get(request.id)).toEqual({ status: "active" });
  });

  it("agreed before the adult accepts, it takes effect on acceptance, but only while that guardian still acts for the child", async () => {
    smsOn();
    const kid = await walkIn("Cempaka");
    const dad = await adult("Encik Chan");
    const request = await requested(kid.id, dad, false);
    expect((await contact(desk, kid.id, { action: "sendCode", guardianId: kid.mumGuardian, purpose: "agree", requestId: request.id })).status).toBe(201);
    expect(await json(await contact(desk, kid.id, { action: "confirmCode", guardianId: kid.mumGuardian, purpose: "agree", requestId: request.id, code: lastCode() }))).toEqual({
      ok: true,
      active: false,
    });
    // Staff see it agreed, waiting for the adult.
    const found = (await json(await participantsRoute.GET(req(`http://localhost/api/admin/participants?venueId=${venue}&phone=${kid.mumPhone}`, "GET", desk.cookie)))) as {
      participants: { id: number; requests: { id: number; agreed: unknown; contactConsent: boolean }[] }[];
    };
    expect(found.participants.find((p) => p.id === kid.id)!.requests).toEqual([expect.objectContaining({ id: request.id, agreed: { by: "Puan Aminah", how: "staff_assisted_phone_code" }, contactConsent: false })]);
    expect(await json(await accept(dad, { code: request.code, relationship: "parent", authority: true }))).toMatchObject({ as: "guardian" });
    expect((await listManaged(dad.id)).map((p) => p.id)).toEqual([kid.id]);

    // The same, but the mother ends her own relationship before the second adult accepts: her agreement lapses.
    const kid2 = await walkIn("Dahlia");
    const dad2 = await adult("Encik Daud");
    const request2 = await requested(kid2.id, dad2, false);
    await contact(desk, kid2.id, { action: "sendCode", guardianId: kid2.mumGuardian, purpose: "agree", requestId: request2.id });
    expect((await json(await contact(desk, kid2.id, { action: "confirmCode", guardianId: kid2.mumGuardian, purpose: "agree", requestId: request2.id, code: lastCode() }))).ok).toBe(true);
    await contact(desk, kid2.id, { action: "sendCode", guardianId: kid2.mumGuardian, purpose: "withdraw" });
    expect((await json(await contact(desk, kid2.id, { action: "confirmCode", guardianId: kid2.mumGuardian, purpose: "withdraw", code: lastCode() }))).ok).toBe(true);
    expect(await json(await accept(dad2, { code: request2.code, relationship: "parent", authority: true }))).toMatchObject({ as: "pending" });
    expect(await listManaged(dad2.id)).toEqual([]);
    expect((await participantHistory(kid2.id)).map((e) => e.action)).toContain("guardian.consent_lapsed");
  });

  it("without phone messaging, only a manager records an agreement given in person, flagged for review and never proof", async () => {
    const kid = await walkIn("Erina");
    const dad = await adult("Encik Erwin");
    const request = await requested(kid.id, dad);
    expect((await json(await contact(desk, kid.id, { action: "sendCode", guardianId: kid.mumGuardian, purpose: "agree", requestId: request.id }))).code).toBe("GW5_NO_PHONE_CODES");
    const inPerson = { action: "inPerson", guardianId: kid.mumGuardian, requestId: request.id, reason: "Mother present with her IC-free word; no SMS here" };
    const byDesk = await contact(desk, kid.id, inPerson);
    expect(byDesk.status).toBe(403);
    expect((await json(byDesk)).code).toBe("MANAGER_ONLY");
    expect((await json(await contact(manager, kid.id, { ...inPerson, reason: "" }))).code).toBe("PTC_REASON_NEEDED");
    expect(await json(await contact(manager, kid.id, inPerson))).toEqual({ ok: true, active: true });
    expect((await listManaged(dad.id)).map((p) => p.id)).toEqual([kid.id]);
    const rel = (await getDb().prepare("SELECT review_reason, review_note FROM participant_guardians WHERE participant_id = ? AND user_id = ?").get(kid.id, dad.id)) as {
      review_reason: string;
      review_note: string;
    };
    expect(rel.review_reason).toBe("in-person-agreement");
    expect(rel.review_note).toContain("not proof of authority");
    expect(await getDb().prepare("SELECT consent_method, consent_staff_name, consent_reason FROM guardian_requests WHERE id = ?").get(request.id)).toEqual({
      consent_method: "staff_in_person",
      consent_staff_name: "Mona Manager",
      consent_reason: inPerson.reason,
    });
    expect((await reviewQueue({ venueId: venue })).map((p) => p.id)).toContain(kid.id);

    // Where a code can be sent, the code is the way.
    smsOn();
    const kid2 = await walkIn("Farah");
    const request2 = await requested(kid2.id, await adult("Encik Fauzi"));
    expect((await json(await contact(manager, kid2.id, { ...inPerson, guardianId: kid2.mumGuardian, requestId: request2.id }))).code).toBe("GW5_USE_PHONE_CODE");
  });

  it("a paused guardian agrees to nothing; another venue's staff reach nothing", async () => {
    smsOn();
    const kid = await walkIn("Gemala");
    const request = await requested(kid.id, await adult("Encik Ghani"));
    expect((await patch(manager, kid.id, { venueId: venue, action: "suspendGuardian", guardianId: kid.mumGuardian, reason: "Reported as not the mother" })).status).toBe(200);
    expect((await json(await contact(desk, kid.id, { action: "sendCode", guardianId: kid.mumGuardian, purpose: "agree", requestId: request.id }))).code).toBe("GW5_GUARDIAN_PAUSED");
    expect(texts).toHaveLength(0);
    for (const body of [
      { action: "sendCode", guardianId: kid.mumGuardian, purpose: "verify" },
      { action: "claimCode", guardianId: kid.mumGuardian },
      { action: "report", reporterId: kid.mumGuardian, guardianId: kid.mumGuardian },
    ]) {
      const res = await contact(otherManager, kid.id, body, otherVenue);
      expect(res.status).toBe(404);
      expect((await json(res)).code).toBe("PTC_NOT_FOUND");
    }
    // Their own venue id, with another venue's session: refused before anything is looked at.
    expect((await contact(otherManager, kid.id, { action: "claimCode", guardianId: kid.mumGuardian })).status).toBe(403);
    expect(texts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------- registering later

describe("a guardian recorded by name and number registers later", () => {
  // Claiming needs the recorded number proved on the account, which only phone checks allow (lib/contact-guardians.ts).
  const before = process.env.MYSENAM_PHONE_CHECK;
  beforeEach(() => {
    process.env.MYSENAM_PHONE_CHECK = "on";
  });
  afterEach(() => {
    if (before === undefined) delete process.env.MYSENAM_PHONE_CHECK;
    else process.env.MYSENAM_PHONE_CHECK = before;
  });

  it("takes the same relationship over with a proved number and a code from staff; neither alone is enough", async () => {
    const kid = await walkIn("Hana");
    const rows = await count("SELECT COUNT(*)::int AS n FROM participant_guardians WHERE participant_id = ?", kid.id);
    const participants = await count("SELECT COUNT(*)::int AS n FROM participants");
    // She registers with the number the venue recorded, not yet proved: her number alone shows her nothing.
    const mum = await adult("Puan Aminah", kid.mumPhone, false);
    expect(await listManaged(mum.id)).toEqual([]);
    expect((await exportCustomerData(mum.id))!.managedPeople).toEqual([]);

    const issued = await contact(desk, kid.id, { action: "claimCode", guardianId: kid.mumGuardian });
    expect(issued.status).toBe(201);
    const { code } = (await issued.json()) as { code: string };
    expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    // The code alone is not enough: her number is not proved.
    expect((await json(await accept(mum, { code, authority: true }))).code).toBe("GW5_PHONE_UNPROVEN");
    // Somebody else's proved number with her code: refused.
    const stranger = await adult("Stranger");
    expect((await json(await accept(stranger, { code, authority: true }))).code).toBe("GW5_NOT_THEIR_NUMBER");
    // Her declaration again, signed in.
    await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = ? WHERE id = ?").run(phoneNumber(kid.mumPhone), mum.id);
    expect((await json(await accept(mum, { code }))).code).toBe("GUARD_AUTHORITY_NEEDED");
    const claimed = await accept(mum, { code, authority: true });
    expect(claimed.status).toBe(200);
    expect(await json(claimed)).toEqual({ as: "claimed", person: { id: kid.id, displayName: "Hana" } });

    // The same row, now hers; how it began kept; no new participant, no new relationship.
    expect(
      await getDb()
        .prepare("SELECT user_id, contact_name, contact_phone, provenance, claim_method, claim_code_by_name, claimed_at IS NOT NULL AS claimed FROM participant_guardians WHERE id = ?")
        .get(kid.mumGuardian)
    ).toEqual({ user_id: mum.id, contact_name: "Puan Aminah", contact_phone: kid.mumPhone.replace(/\D/g, ""), provenance: "counter", claim_method: "staff_code", claim_code_by_name: "Dewi Desk", claimed: true });
    expect(await count("SELECT COUNT(*)::int AS n FROM participant_guardians WHERE participant_id = ?", kid.id)).toBe(rows);
    expect(await count("SELECT COUNT(*)::int AS n FROM participants")).toBe(participants);
    expect((await listManaged(mum.id)).map((p) => p.id)).toEqual([kid.id]);
    expect((await bookOnline(mum, kid.id, 10, day(8))).status).toBe(201);
    expect((await participantHistory(kid.id)).map((e) => e.action)).toContain("guardian.claimed");
    // Used once.
    expect((await json(await accept(mum, { code, authority: true }))).code).toBe("PTC_INVITE_INVALID");
  });

  it("or with a code another guardian with an account gave; a child with no such guardian has nothing to give", async () => {
    const kid = await walkIn("Iman");
    const dad = await adult("Encik Ismail");
    const request = await requested(kid.id, dad);
    expect((await patch(manager, kid.id, { venueId: venue, action: "exception", requestId: request.id, category: "guardian_unavailable", reason: "Mother abroad", reviewOn: addDays(todayISO(), 30) })).status).toBe(200);
    const give = await invitesRoute.POST(req("http://localhost/api/my/people/invites", "POST", dad.cookie, { id: kid.id, purpose: "claim" }));
    expect(give.status).toBe(201);
    const { code } = (await give.json()) as { code: string };
    const mum = await adult("Puan Aminah", kid.mumPhone);
    expect(await json(await accept(mum, { code, authority: true }))).toMatchObject({ as: "claimed" });
    expect(await getDb().prepare("SELECT user_id, claim_method FROM participant_guardians WHERE id = ?").get(kid.mumGuardian)).toEqual({ user_id: mum.id, claim_method: "guardian_code" });

    // Nobody left on a name and number: no claim code to give.
    expect(await createInvite(dad, kid.id, "claim")).toMatchObject({ ok: false, code: "GW5_NO_RECORDED_GUARDIAN" });
    // A guardian who stops acting voids the code they gave.
    const kid2 = await walkIn("Jasmin");
    const dad2 = await adult("Encik Jamal");
    const req2 = await requested(kid2.id, dad2);
    await patch(manager, kid2.id, { venueId: venue, action: "exception", requestId: req2.id, category: "guardian_unavailable", reason: "Mother abroad", reviewOn: addDays(todayISO(), 30) });
    const given = (await createInvite(dad2, kid2.id, "claim")) as { code: string };
    const dadRel = (await getDb().prepare("SELECT id FROM participant_guardians WHERE participant_id = ? AND user_id = ?").get(kid2.id, dad2.id)) as { id: number };
    await patch(manager, kid2.id, { venueId: venue, action: "revokeGuardian", guardianId: dadRel.id, reason: "Not the father after all" });
    const mum2 = await adult("Puan Aminah", kid2.mumPhone);
    expect((await json(await accept(mum2, { code: given.code, authority: true }))).code).toBe("PTC_INVITE_INVALID");
    expect(await listManaged(mum2.id)).toEqual([]);
  });

  it("is not offered where the site cannot check phone numbers, since nobody could prove the number recorded", async () => {
    const kid = await walkIn("Kirana");
    process.env.MYSENAM_PHONE_CHECK = "off";
    {
      // Staff are told why, and no claim code is made by staff or by another guardian.
      const found = (await json(
        await participantsRoute.GET(req(`http://localhost/api/admin/participants?venueId=${venue}&phone=${kid.mumPhone}`, "GET", desk.cookie))
      )) as { claimsPossible: boolean };
      expect(found.claimsPossible).toBe(false);
      const issued = await contact(desk, kid.id, { action: "claimCode", guardianId: kid.mumGuardian });
      expect(issued.status).toBe(409);
      expect((await json(issued)).code).toBe("GW5_NO_PHONE_CHECKS");
      // A guardian with an account is refused the same way, before anything about the child is looked at.
      const dad = await adult("Encik Khalid");
      expect(await createInvite(dad, kid.id, "claim")).toMatchObject({ ok: false, code: "GW5_NO_PHONE_CHECKS" });
      expect(await count("SELECT COUNT(*)::int AS n FROM participant_invites WHERE participant_id = ? AND purpose = 'claim'", kid.id)).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------- telling them

describe("telling a guardian recorded by name and number", () => {
  it("never at a number not proved to reach them: the venue is given a task, which staff close", async () => {
    const kid = await walkIn("Kirana");
    const dad = await adult("Encik Khalid");
    const request = await requested(kid.id, dad);
    // The request waits: the mother recorded here is to be told, in person, that she can agree at the counter.
    let tasks = await openNoticeTasks([venue], [kid.id]);
    expect(tasks).toEqual([expect.objectContaining({ guardianName: "Puan Aminah", change: "request", why: "unverified_number" })]);
    await patch(manager, kid.id, { venueId: venue, action: "exception", requestId: request.id, category: "guardian_unavailable", reason: "Mother not reachable", reviewOn: addDays(todayISO(), 30) });
    tasks = await openNoticeTasks([venue], [kid.id]);
    expect(tasks.map((t) => t.change)).toEqual(["request", "added"]);
    expect(await count("SELECT COUNT(*)::int AS n FROM messages WHERE kind = 'guardian_notice' AND phone_key(recipient) = phone_key(?)", kid.mumPhone)).toBe(0);

    // Shown under Needs attention to the venue's staff, front desk included; never to another venue's.
    const forDesk = (await attention(desk)) as { guardianTasks: { id: number; displayName: string; phone: string }[] };
    expect(forDesk.guardianTasks.filter((t) => t.displayName === "Kirana")).toHaveLength(2);
    expect(((await attention(otherManager)) as { guardianTasks: unknown[] }).guardianTasks).toEqual([]);
    const otherTry = await attentionRoute.POST(req("http://localhost/api/admin/attention", "POST", otherManager.cookie, { action: "guardianTold", taskId: tasks[0].id, how: "told" }));
    expect(otherTry.status).toBe(404);
    const done = await attentionRoute.POST(req("http://localhost/api/admin/attention", "POST", desk.cookie, { action: "guardianTold", taskId: tasks[0].id, how: "told" }));
    expect(done.status).toBe(200);
    expect((await openNoticeTasks([venue], [kid.id])).map((t) => t.change)).toEqual(["added"]);
    expect(await getDb().prepare("SELECT done_by_name, done_how FROM guardian_notice_tasks WHERE id = ?").get(tasks[0].id)).toEqual({ done_by_name: "Dewi Desk", done_how: "told" });
    expect((await listActivity([venue], {})).map((e) => e.action)).toContain("participant.guardian_told");
  });

  it("at a number a code came back from, a WhatsApp notice with the venue's name and nothing about the child; without WhatsApp, a task", async () => {
    smsOn();
    const kid = await walkIn("Lestari");
    await contact(desk, kid.id, { action: "sendCode", guardianId: kid.mumGuardian, purpose: "verify" });
    expect(await json(await contact(desk, kid.id, { action: "confirmCode", guardianId: kid.mumGuardian, purpose: "verify", code: lastCode() }))).toEqual({ ok: true });
    whatsappOn();
    const dad = await adult("Encik Lokman");
    const request = await requested(kid.id, dad);
    const notices = (await getDb()
      .prepare("SELECT channel, kind, body, status FROM messages WHERE kind = 'guardian_notice' AND phone_key(recipient) = phone_key(?) ORDER BY id")
      .all(kid.mumPhone)) as { channel: string; kind: string; body: string; status: string }[];
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ channel: "whatsapp", status: "queued" });
    expect(notices[0].body).toContain("Guardian Centre");
    expect(notices[0].body).toContain("ask at the counter");
    for (const secret of ["Lestari", "Lokman", "Hall"]) expect(notices[0].body).not.toContain(secret);
    expect(await openNoticeTasks([venue], [kid.id])).toEqual([]);

    // WhatsApp gone: the next change is a task, why recorded.
    vi.unstubAllEnvs();
    await patch(manager, kid.id, { venueId: venue, action: "closeRequest", requestId: request.id, reason: "Father withdrew the request" });
    const dad2 = await adult("Encik Lutfi");
    await requested(kid.id, dad2);
    expect(await openNoticeTasks([venue], [kid.id])).toEqual([expect.objectContaining({ change: "request", why: "no_channel" })]);
  });
});

// ---------------------------------------------------------------------- disputes and withdrawal

describe("disputes and withdrawal through staff", () => {
  it("a guardian recorded by name and number reports another's relationship; a manager sees it", async () => {
    const kid = await walkIn("Melur");
    const dad = await adult("Encik Malik");
    const request = await requested(kid.id, dad);
    await patch(manager, kid.id, { venueId: venue, action: "exception", requestId: request.id, category: "custody_dispute", reason: "Court order seen", reviewOn: addDays(todayISO(), 30) });
    const dadRel = (await getDb().prepare("SELECT id FROM participant_guardians WHERE participant_id = ? AND user_id = ?").get(kid.id, dad.id)) as { id: number };
    await patch(manager, kid.id, { venueId: venue, action: "confirmGuardian", guardianId: dadRel.id, reason: "Order checked" });
    expect((await json(await contact(desk, kid.id, { action: "report", reporterId: kid.mumGuardian, guardianId: kid.mumGuardian }))).code).toBe("GV_CHANGE_NOT_FOUND");
    expect((await contact(desk, kid.id, { action: "report", reporterId: kid.mumGuardian, guardianId: dadRel.id, note: "He is not the father" })).status).toBe(200);
    expect(await getDb().prepare("SELECT review_reason, review_note FROM participant_guardians WHERE id = ?").get(dadRel.id)).toEqual({
      review_reason: "reported",
      review_note: "Reported as a mistake by Puan Aminah (recorded by name and number), told to Dewi Desk: He is not the father",
    });
    expect((await reviewQueue({ venueId: venue })).find((p) => p.id === kid.id)!.guardians.map((g) => g.id)).toContain(dadRel.id);
    // Nothing else changed until a manager decides.
    expect((await listManaged(dad.id)).map((p) => p.id)).toEqual([kid.id]);
  });

  it("a paused or ended guardian acts on no path: online, group bookings, the counter, the API key, waiting-list offers", async () => {
    smsOn();
    const kid = await walkIn("Nadia");
    const dad = await adult("Encik Nasir");
    const request = await requested(kid.id, dad);
    await contact(desk, kid.id, { action: "sendCode", guardianId: kid.mumGuardian, purpose: "agree", requestId: request.id });
    expect((await json(await contact(desk, kid.id, { action: "confirmCode", guardianId: kid.mumGuardian, purpose: "agree", requestId: request.id, code: lastCode() }))).active).toBe(true);
    const dadRel = (await getDb().prepare("SELECT id FROM participant_guardians WHERE participant_id = ? AND user_id = ?").get(kid.id, dad.id)) as { id: number };
    const made = await createApiKey(venue, { name: "Front desk system", scope: "write" }, manager.id);
    if (!made.ok) throw new Error(made.error);
    const api = (ph: string, hour: number) =>
      apiBookingsRoute.POST(
        req("http://localhost/api/v1/bookings", "POST", null, { courtId: hall2, date: day(12), start: at(hour), end: at(hour + 1), name: "API", phone: ph, participantIds: [kid.id] }, { authorization: `Bearer ${made.key}` })
      );
    // Before: the father queues the child for a full kayak slot.
    const date = day(13);
    const crowd = await adult("Crowd");
    const full = await createBookingSeries({ courtId: kayak, date, start: at(9), end: at(10), weeks: 1, name: crowd.name, phone: crowd.phone, userId: crowd.id, players: 2, by: "staff" });
    if (!full.ok) throw new Error(full.error);
    const queued = await joinSlotWaitlist({ courtId: kayak, date, start: at(9), end: at(10), name: dad.name, phone: dad.phone, userId: dad.id, people: { participants: [{ id: kid.id, name: "Nadia" }], customerTakesPart: false } });
    if (!queued.ok) throw new Error(queued.error);

    // Paused by a manager: nothing on any path.
    expect((await patch(manager, kid.id, { venueId: venue, action: "suspendGuardian", guardianId: dadRel.id, reason: "Mother disputes it" })).status).toBe(200);
    expect((await json(await bookOnline(dad, kid.id, 14, day(9)))).code).toBe("GUARD_NOT_FOUND");
    expect((await json(await bookOnline(dad, kid.id, 15, day(9), { participantIds: [], moreCourts: [{ courtId: hall2, participantIds: [kid.id] }] }))).code).toBe("GUARD_NOT_FOUND");
    expect((await json(await bookAtCounter(desk, dad.phone, kid.id, 14))).code).toBe("PBK_NOT_GUARDIAN");
    expect((await json(await api(dad.phone, 14))).code).toBe("PBK_NOT_GUARDIAN");
    expect((await cancelBooking(full.bookings[0].code, crowd.phone)).ok).toBe(true);
    expect(await getDb().prepare("SELECT status, offer_token FROM waitlist WHERE id = ?").get(queued.entry.id)).toEqual({ status: "cancelled", offer_token: null });
    expect(await listManaged(dad.id)).toEqual([]);
    expect((await exportCustomerData(dad.id))!.managedPeople).toEqual([]);

    // The mother, recorded by name and number, ends her own relationship by a code: her number books for nobody now.
    expect((await bookAtCounter(desk, kid.mumPhone, kid.id, 16)).status).toBe(201);
    expect((await contact(desk, kid.id, { action: "sendCode", guardianId: kid.mumGuardian, purpose: "withdraw" })).status).toBe(201);
    expect(texts.at(-1)!.text).not.toContain("Nadia");
    expect(await json(await contact(desk, kid.id, { action: "confirmCode", guardianId: kid.mumGuardian, purpose: "withdraw", code: lastCode() }))).toEqual({ ok: true });
    expect((await json(await bookAtCounter(desk, kid.mumPhone, kid.id, 17))).code).toBe("PBK_NOT_GUARDIAN");
    expect((await json(await api(kid.mumPhone, 15))).code).toBe("PBK_NOT_GUARDIAN");
    expect((await json(await contact(desk, kid.id, { action: "claimCode", guardianId: kid.mumGuardian }))).code).toBe("GW5_NOT_RECORDED_GUARDIAN");
    expect(await getDb().prepare("SELECT revoked_by_name, revoke_reason FROM participant_guardians WHERE id = ?").get(kid.mumGuardian)).toEqual({
      revoked_by_name: "Puan Aminah",
      revoke_reason: "Ended by Puan Aminah at the counter, by a code sent to their number, entered by Dewi Desk",
    });
    expect((await listActivity([venue], {})).map((e) => e.action)).toContain("participant.guardian_withdrawn");
  });
});

// ---------------------------------------------------------------------- reminders and the platform owner

describe("a manager's reminders, and the platform owner", () => {
  it("relationships flagged and exception review dates come, under Needs attention for managers, not the desk", async () => {
    const kid = await walkIn("Orkid");
    const dad = await adult("Encik Omar");
    const request = await requested(kid.id, dad);
    await patch(manager, kid.id, { venueId: venue, action: "exception", requestId: request.id, category: "guardian_unavailable", reason: "Mother abroad", reviewOn: addDays(todayISO(), 30) });
    const dadRel = (await getDb().prepare("SELECT id FROM participant_guardians WHERE participant_id = ? AND user_id = ?").get(kid.id, dad.id)) as { id: number };
    expect((await guardianReviews([venue]))[0]).toMatchObject({ venueId: venue, venueName: "Guardian Centre" });
    // Kept now; reminded again once its date comes.
    expect((await patch(manager, kid.id, { venueId: venue, action: "confirmGuardian", guardianId: dadRel.id, reason: "Letter from the mother seen" })).status).toBe(200);
    const before = (await guardianReviews([venue]))[0]?.datesDue ?? 0;
    await getDb().prepare("UPDATE guardian_requests SET exception_review_on = ?::date WHERE id = ?").run(todayISO(), request.id);
    await getDb().prepare("UPDATE participant_guardians SET reviewed_at = now() - interval '2 days' WHERE id = ?").run(dadRel.id);
    expect((await guardianReviews([venue]))[0].datesDue).toBe(before + 1);
    const reminders = (await attention(manager)) as { guardianReviews: { venueId: number; datesDue: number }[] };
    expect(reminders.guardianReviews.find((r) => r.venueId === venue)!.datesDue).toBe(before + 1);
    expect(((await attention(desk)) as { guardianReviews: unknown[] }).guardianReviews).toEqual([]);
    const queued = (await reviewQueue({ venueId: venue })).find((p) => p.id === kid.id)!;
    expect(queued.guardians.find((g) => g.id === dadRel.id)).toMatchObject({ reviewDue: true });
    // Looked at again: the reminder goes.
    expect((await patch(manager, kid.id, { venueId: venue, action: "confirmGuardian", guardianId: dadRel.id, reason: "Reviewed on the date" })).status).toBe(200);
    expect((await guardianReviews([venue]))[0]?.datesDue ?? 0).toBe(before);
  });

  it("the platform owner sees what waits for review for a participant no venue knows, and acts on it", async () => {
    const mum = await adult("Puan Pua");
    const dad = await adult("Encik Pua");
    const made = await (await import("../src/lib/managed-people")).addManaged(mum.id, { displayName: "Puteri", birthYear: 2015, relationship: "parent", authority: true }, mum.name);
    if (!made.ok) throw new Error(made.error);
    const { code } = (await createInvite(mum, made.person.id, "guardian")) as { code: string };
    expect(await json(await accept(dad, { code, relationship: "parent", authority: true }))).toMatchObject({ as: "guardian" });
    const dadRel = (await getDb().prepare("SELECT id FROM participant_guardians WHERE participant_id = ? AND user_id = ?").get(made.person.id, dad.id)) as { id: number };
    await getDb().prepare("UPDATE participant_guardians SET review_reason = 'reported', review_flagged_at = now(), review_note = 'Reported' WHERE id = ?").run(dadRel.id);
    // No venue knows her: not in a venue's list, in the owner's.
    expect((await reviewQueue({ venueId: venue })).map((p) => p.id)).not.toContain(made.person.id);
    const all = (await json(await participantsRoute.GET(req("http://localhost/api/admin/participants?review=1", "GET", owner.cookie)))) as { participants: { id: number }[] };
    expect(all.participants.map((p) => p.id)).toContain(made.person.id);
    expect(((await attention(owner)) as { guardianReviews: { venueId: number | null }[] }).guardianReviews).toEqual([expect.objectContaining({ venueId: null })]);
    expect((await patch(owner, made.person.id, { owner: true, action: "confirmGuardian", guardianId: dadRel.id, reason: "Both parents confirmed by email" })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------- at the same moment

describe("at the same moment (real concurrency on Postgres)", () => {
  it("one code entered twice at once agrees once; one claim code accepted twice at once binds once", async () => {
    smsOn();
    const kid = await walkIn("Qistina");
    const dad = await adult("Encik Qadir");
    const request = await requested(kid.id, dad);
    await contact(desk, kid.id, { action: "sendCode", guardianId: kid.mumGuardian, purpose: "agree", requestId: request.id });
    const code = lastCode();
    const at_ = { venueId: venue, admin: { id: desk.id, name: desk.name } };
    const entered = await Promise.all(
      Array.from({ length: 4 }, () => confirmContactCode(at_, { participantId: kid.id, guardianshipId: kid.mumGuardian, purpose: "agree", requestId: request.id, code }))
    );
    expect(entered.filter((r) => r.ok)).toHaveLength(1);
    expect(entered.every((r) => r.ok || ["GW5_CODE_EXPIRED", "GW5_ALREADY_AGREED", "GV_REQUEST_CLOSED"].includes(r.code))).toBe(true);
    expect(await count("SELECT COUNT(*)::int AS n FROM participant_guardians WHERE participant_id = ? AND user_id = ? AND revoked_at IS NULL", kid.id, dad.id)).toBe(1);

    const kid2 = await walkIn("Rania");
    const issued = (await json(await contact(desk, kid2.id, { action: "claimCode", guardianId: kid2.mumGuardian }))) as { code: string };
    const mum = await adult("Puan Aminah", kid2.mumPhone);
    const hash = createHash("sha256").update(issued.code.replace(/[^A-Z0-9]/g, "")).digest("hex");
    const claims = await Promise.all(Array.from({ length: 4 }, () => claimRelationship(mum, hash, { authority: true })));
    expect(claims.filter((r) => r.ok)).toHaveLength(1);
    expect(await count("SELECT COUNT(*)::int AS n FROM participant_guardians WHERE participant_id = ?", kid2.id)).toBe(1);
    expect(await count("SELECT COUNT(*)::int AS n FROM participant_guardians WHERE participant_id = ? AND user_id = ?", kid2.id, mum.id)).toBe(1);
  });
});
