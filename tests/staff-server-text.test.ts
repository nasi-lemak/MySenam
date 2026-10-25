import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
// An empty backup folder of its own, so "no backup yet" is what it finds.
process.env.MYSENAM_BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "staff-text-backups-"));
process.env.MYSENAM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "staff-text-data-"));

import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { raiseAlert, recentAlerts } from "../src/lib/alerts";
import { goLiveStatus } from "../src/lib/applications";
import { registerUser } from "../src/lib/auth";
import { backupHealth } from "../src/lib/backup-health";
import { describePolicy, PLATFORM_POLICY, policySummary, type BookingPolicy } from "../src/lib/booking-policy";
import { BUILTIN_ACTIVITIES } from "../src/lib/activity-catalogue";
import { TEMPLATES } from "../src/lib/competition-templates";
import { DEDUCTION_INFO, DEDUCTION_REASONS } from "../src/lib/deposit-deductions";
import { documentsForVenue, paidHowOf, paidVia } from "../src/lib/documents";
import { allGateways } from "../src/lib/gateways";
import { formatLength } from "../src/lib/interval";
import { offsiteTransferCheck, offsiteTransferPause } from "../src/lib/offsite";
import { retentionDue } from "../src/lib/privacy";
import { createBooking, createVenue, issuePass, listVenues, topUpWallet, voidPass } from "../src/lib/store";
import { englishOf, isStaffText, joinSaid, lengthText, said, type StaffText } from "../src/lib/staff-text";
import { STAFF_DICTIONARIES, staffTranslator } from "../src/lib/staff-i18n";
import { createNotice, openNotices } from "../src/lib/urgent";
import { addDays, todayISO } from "../src/lib/time";
import { PAID_VIA_LABELS, type PaidVia } from "../src/lib/types";

/**
 * Text MySenam composes on the server for staff screens, said in the staff
 * member's language (lib/staff-text.ts): the server sends a phrase with its
 * values beside the English it always sent, and the English is that same
 * phrase said in English, so nothing a test or an email reads changes.
 */

const en = staffTranslator("en", "MySenam");
const ms = staffTranslator("ms", "MySenam");
const zh = staffTranslator("zh", "MySenam");

await ensureBootstrapAdmin();

afterEach(() => {
  delete process.env.OFFSITE_DATA_LOCATION;
  delete process.env.OFFSITE_TRANSFER_APPROVED;
});

describe("a phrase from the server", () => {
  it("is said in the staff language, values that are phrases first, and its English is the server's", () => {
    const text = said("srv.tn.change.sides", { match: said("srv.round.semi", { n: 2 }), sides: said("srv.tn.sides", { a: "Aisyah", b: said("srv.tn.nobody") }), was: "Wei v Ravi" });
    expect(englishOf(text)).toBe("Semi-final 2: now Aisyah v nobody (was Wei v Ravi).");
    expect(en.say(text)).toBe(englishOf(text));
    expect(ms.say(text)).toBe("Separuh akhir 2: kini Aisyah lwn tiada sesiapa (sebelum ini Wei v Ravi).");
    expect(zh.say(text)).toBe("半决赛 2：现为 Aisyah 对 无人（原为 Wei v Ravi）。");
    // None sent (a row from before): what was stored, as it was.
    expect(ms.say(undefined, "As stored")).toBe("As stored");
    // Lists, and names joined with "and".
    expect(englishOf(said("srv.app.nearby", { name: "A", distance: "40 m" }))).toBe("A is already listed 40 m from the pin.");
    expect(englishOf(said("srv.tn.change.group", { n: 1, now: joinSaid(["A", "B", "C"], "srv.list.and"), was: said("srv.tn.nobody") }))).toBe(
      "Group 1 now puts A and B and C on top (was nobody)."
    );
    expect(isStaffText(JSON.parse(JSON.stringify(text)))).toBe(true);
    // A court's day: what a buffer is kept for, a booking's code and name staying as they are.
    expect(englishOf(said("srv.sch.kept.before", { label: "ABC123 Ali" }))).toBe("Kept free before ABC123 Ali");
    expect(ms.say(said("srv.sch.kept.after", { label: said("srv.sch.offer") }))).toBe("Dikosongkan selepas Ditawarkan kepada senarai menunggu");
  });

  it("names phrases at run time only where the dictionaries have them", () => {
    expect(ms.known("srv.gw.billplz.methods")).toBe("Perbankan dalam talian FPX atau kad");
    expect(ms.known("srv.gw.nobody.methods")).toBeNull();
  });
});

describe("the English beside each phrase is what the server already wrote", () => {
  it("for a length of time and a court's booking rules", () => {
    for (let m = 0; m <= 600; m += 5) expect(englishOf(lengthText(m))).toBe(formatLength(m));
    const base = { ...PLATFORM_POLICY, defaultLength: 60 } as unknown as BookingPolicy;
    const policies: BookingPolicy[] = [
      base,
      { ...base, startEvery: 30 },
      { ...base, startOffset: 30 },
      { ...base, startTimes: [18 * 60, 19 * 60 + 30] },
      { ...base, lengths: [60, 90, 120] },
      { ...base, minLength: 30, lengthStep: 30, maxLength: 150, bufferBefore: 10 },
      { ...base, bufferAfter: 15 },
      { ...base, bufferBefore: 5, bufferAfter: 75 },
    ];
    for (const p of policies) expect(englishOf(policySummary(p))).toBe(describePolicy(p));
    expect(ms.say(policySummary(policies[7]))).toBe("bermula tepat pada jam; 1 jam hingga 4 jam, dalam langkah 1 jam; dikosongkan 5 minit sebelum dan 1 jam 15 minit selepas");
  });

  it("for what the dashboard names by a code: deposit reasons, templates, gateways, catalogue notes, chargebacks", () => {
    for (const r of DEDUCTION_REASONS) expect(en(`srv.deduction.${r}`)).toBe(DEDUCTION_INFO[r].label);
    for (const t of TEMPLATES) {
      expect(en.known(`srv.tpl.${t.key}`)).toBe(t.label);
      expect(en.known(`srv.tpl.${t.key}.note`)).toBe(t.note);
    }
    for (const g of allGateways()) {
      expect(en.known(`srv.gw.${g.id}.methods`)).toBe(g.methods);
      for (const f of g.fields) {
        expect(en.known(`srv.gw.${g.id}.${f.key}`)).toBe(f.label);
        if (f.help) expect(en.known(`srv.gw.${g.id}.${f.key}.help`)).toBe(f.help);
      }
      expect(g.setupPhrase && englishOf(g.setupPhrase)).toBe(g.setup);
    }
    for (const a of BUILTIN_ACTIVITIES) if (a.supportNote) expect(en.known(`srv.support.${a.key}`)).toBe(a.supportNote);
    const disputeKeys = Object.keys(STAFF_DICTIONARIES.en).filter((k) => k.startsWith("srv.dispute."));
    expect(disputeKeys.length).toBeGreaterThan(10);
    for (const k of disputeKeys) expect(en.known(k)).toBe(k.split(".").at(-1)!.replace(/_/g, " "));
  });

  it("for how a voucher was paid, read back as a method", () => {
    for (const via of Object.keys(PAID_VIA_LABELS) as PaidVia[]) {
      expect(paidHowOf(paidVia(via))).toEqual({ via });
      expect(en(`c.via.${via}`)).toBe(PAID_VIA_LABELS[via]);
    }
    expect(paidHowOf(paidVia("online", "Billplz"))).toEqual({ via: "online", gateway: "Billplz" });
    expect(en("srv.via.onlineGateway", { gateway: "Billplz" })).toBe("Online (Billplz)");
    expect(paidHowOf("At the counter")).toEqual({ via: "counter" });
    expect(en("srv.via.counter")).toBe("At the counter");
    expect(paidHowOf("Something typed")).toBeNull();
  });
});

describe("what the server composes for staff screens carries its phrase", () => {
  it("an alert's subject and the detail MySenam wrote; one raised with words alone has none", async () => {
    const detail = [said("srv.backup.none")];
    await raiseAlert("test:phrase", said("srv.alert.failed", { what: said("srv.work.webhooks") }), englishOf(detail[0]), detail);
    await raiseAlert("test:words", "Something broke", "a stack trace");
    const alerts = await recentAlerts();
    const phrased = alerts.find((a) => a.key === "test:phrase")!;
    expect(phrased.subject).toBe("Scheduled work failed: webhooks");
    expect(zh.say(phrased.subjectPhrase, phrased.subject)).toBe("定时任务失败：Webhook");
    expect(phrased.detailPhrases?.map((p) => ms.say(p))).toEqual(["Belum ada sandaran pada pelayan ini."]);
    expect(alerts.find((a) => a.key === "test:words")).toMatchObject({ subject: "Something broke", subjectPhrase: null, detailPhrases: null });
  });

  it("a credit line MySenam wrote, not one staff typed; a pass that cannot be used, and why", async () => {
    const user = await registerUser({ name: "Siti Phrase", email: "siti.phrase@example.my", phone: "0123334455", password: "a long enough password" });
    if (!user.ok) throw new Error(user.error);
    const owner = (await listAdmins()).find((a) => a.venueId === null)!;
    const venueId = (await listVenues())[0].id;
    const counter = await topUpWallet({ userId: user.user.id, amount: 20, adminId: owner.id, venueId });
    if (!counter.ok) throw new Error(counter.error);
    expect(counter.entry.reason).toBe("Counter top-up");
    expect(ms.say(counter.entry.reasonPhrase, counter.entry.reason)).toBe("Tambah nilai di kaunter");
    const typed = await topUpWallet({ userId: user.user.id, amount: 10, adminId: owner.id, venueId, reason: "Hadiah hari jadi" });
    if (!typed.ok) throw new Error(typed.error);
    expect(typed.entry).toMatchObject({ reason: "Hadiah hari jadi" });
    expect(typed.entry.reasonPhrase).toBeUndefined();
    // Their receipts: the line's words in the staff language, what staff typed inside them as typed.
    const lines = (await documentsForVenue(venueId)).map((d) => d.lines[0]);
    const counterLine = lines.find((l) => l.description === "Stored credit: counter top-up")!;
    expect(ms.say(counterLine.phrase, counterLine.description)).toBe("Kredit tersimpan: tambah nilai di kaunter");
    const typedLine = lines.find((l) => l.description === "Stored credit: Hadiah hari jadi")!;
    expect(zh.say(typedLine.phrase, typedLine.description)).toBe("储值：Hadiah hari jadi");

    const sold = await issuePass({ venueId, name: "Ten hours", entries: 10, price: 100, holderName: "Siti", holderPhone: "0123334455", expiresOn: addDays(todayISO(), 30), adminId: owner.id });
    if (!sold.ok) throw new Error(sold.error);
    expect(sold.pass.unusablePhrase).toBeUndefined();
    const voided = await voidPass(sold.pass.id);
    if (!voided.ok) throw new Error(voided.error);
    expect(voided.pass.unusableReason).toBe("This pass was cancelled.");
    expect(zh.say(voided.pass.unusablePhrase, voided.pass.unusableReason)).toBe("此次卡已取消。");
  });

  it("backup problems, why off-site copies are paused, and what the retention policy covers", async () => {
    const health = await backupHealth();
    expect(health.problemPhrases.map(englishOf)).toEqual(health.problems);
    expect(health.problems).toContain("There is no backup on this server yet.");
    expect(offsiteTransferPause()).toEqual(said("srv.offsite.noLocation"));
    process.env.OFFSITE_DATA_LOCATION = "US";
    const abroad = offsiteTransferPause()!;
    expect(englishOf(abroad)).toBe(offsiteTransferCheck());
    expect(ms.say(abroad)).toMatch(/^Baldi menyimpan data di US, di luar /);
    const lines = await retentionDue();
    for (const line of lines) expect(englishOf(line.whatPhrase)).toBe(line.what);
    expect(zh.say(lines.find((l) => l.what === "Expired sign-in sessions")!.whatPhrase)).toBe("已过期的登录会话");
  });

  it("what a draft still needs, and an urgent notice's line on the staff's list", async () => {
    const made = await createVenue({ name: "Phrase Hall", area: "Cheras", address: "1 Jalan Ujian", phone: "0312345678", draft: true });
    if (!made.ok) throw new Error(made.error);
    const status = (await goLiveStatus(made.venue.id))!;
    expect(status.missing).toEqual(["Add at least one court, with its rates."]);
    expect(status.missingPhrases.map((p) => ms.say(p))).toEqual(["Tambah sekurang-kurangnya satu gelanggang, dengan kadarnya."]);

    const venue = (await listVenues()).find((v) => v.courts.some((c) => c.capacity === 1))!;
    const booked = await createBooking({ courtId: venue.courts.find((c) => c.capacity === 1)!.id, date: addDays(todayISO(), 3), hours: [20], name: "Ali", phone: "0123334466" });
    if (!booked.ok) throw new Error(booked.error);
    const phrase: StaffText = said("srv.urgent.cancelled", {
      venue: "Arena",
      code: "ABC123",
      where: said("srv.urgent.where", { court: "Court 1", venue: "Arena" }),
      when: said("srv.urgent.when", { date: "2026-11-02", from: "8pm", to: "9pm" }),
    });
    await createNotice({ venueId: venue.id, bookingId: booked.booking.id, kind: "cancelled", name: "Ali", phone: "0123334466", email: null, date: booked.booking.date, startMin: 1200, summary: englishOf(phrase), summaryPhrase: phrase });
    const notice = (await openNotices([venue.id])).find((n) => n.bookingId === booked.booking.id)!;
    expect(notice.summary).toBe("Arena cancelled booking ABC123: Court 1 at Arena, 2026-11-02, 8pm to 9pm.");
    expect(zh.say(notice.summaryPhrase, notice.summary)).toBe("Arena 取消了预订 ABC123：Arena 的 Court 1，2026-11-02，8pm 至 9pm。");
  });
});
