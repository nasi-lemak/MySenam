import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { createAdmin, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { raiseAlert } from "../src/lib/alerts";
import { getDb } from "../src/lib/db";
import { tellOwnersEach, tellVenueStaffEach } from "../src/lib/owner-alerts";
import { liftVenue, suspendVenue } from "../src/lib/suspensions";
import { createVenue } from "../src/lib/store";
import { said } from "../src/lib/staff-text";

/**
 * Alerts MySenam sends staff on its own (lib/owner-alerts.ts): to platform
 * owners and to a venue's managers and staff, each written in the reader's
 * own staff language (`admins.locale`, else the install's first), from the
 * staff dictionaries (lib/staff-i18n/alerts.ts). What people typed stays as
 * typed.
 */

let venueId: number;
let n = 0;
const ownerEmail = async () => (await listAdmins()).find((a) => a.venueId === null && a.businessId === null)!.email;

const mailTo = async (to: string) =>
  (await getDb()
    .prepare("SELECT subject, body, locale FROM messages WHERE kind = 'staff_alert' AND recipient = ? ORDER BY id")
    .all(to)) as { subject: string; body: string; locale: string }[];

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const made = await createVenue({ name: "Dewan Bahasa", area: "Ipoh", address: "1 Jalan Ipoh", phone: "0512345678" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  for (const [email, locale] of [
    ["melayu@dewan.my", "ms"],
    ["zhong@dewan.my", "zh"],
    ["plain@dewan.my", undefined],
  ] as const) {
    const staff = await createAdmin({ name: `Staff ${++n}`, email, password: "a long enough password", venueId, locale });
    if (!staff.ok) throw new Error(staff.error);
  }
  await getDb().prepare("UPDATE admins SET locale = 'zh' WHERE email = ?").run(await ownerEmail());
});

describe("an alert to a venue's staff", () => {
  it("is written to each of them in their own language, what was typed kept as typed", async () => {
    expect((await suspendVenue(venueId, "Lantai tidak selamat")).ok).toBe(true);
    const [ms] = await mailTo("melayu@dewan.my");
    expect(ms.locale).toBe("ms");
    expect(ms.subject).toBe("Dewan Bahasa telah digantung di MySenam");
    expect(ms.body).toMatch(/^Hai Staff \d+,/);
    expect(ms.body).toContain("Dewan Bahasa telah dikeluarkan dari MySenam: Lantai tidak selamat");
    const [zh] = await mailTo("zhong@dewan.my");
    expect(zh.locale).toBe("zh");
    expect(zh.subject).toBe("Dewan Bahasa 已在 MySenam 上被暂停");
    expect(zh.body).toContain("您好");
    expect(zh.body).toContain("Lantai tidak selamat");
    // None chosen: the install's first staff language, as before.
    const [en] = await mailTo("plain@dewan.my");
    expect(en.locale).toBe("en");
    expect(en.subject).toBe("Dewan Bahasa has been suspended on MySenam");
    expect(en.body).toContain("Customers cannot find, book or pay it online until this is lifted.");

    expect((await liftVenue(venueId)).ok).toBe(true);
    expect((await mailTo("melayu@dewan.my")).at(-1)!.body).toContain("Penggantungan Dewan Bahasa telah ditarik balik.");
    expect((await mailTo("zhong@dewan.my")).at(-1)!.subject).toBe("Dewan Bahasa 已重新在 MySenam 上线");
  });

  it("is written once for each reader, with the lookup in that reader's language", async () => {
    const seen: string[] = [];
    await tellVenueStaffEach(venueId, (t) => {
      seen.push(t.locale);
      return { subject: t("r9d.review.hidden.s"), body: t("r9d.review.hidden.b", { why: "spam" }) };
    });
    expect(seen.sort()).toEqual(["en", "ms", "zh"]);
    expect((await mailTo("melayu@dewan.my")).at(-1)!.subject).toBe("Sebuah ulasan telah disembunyikan");
  });
});

describe("an alert to the platform's owners", () => {
  it("is in the owner's language, with the owners' footer in it too", async () => {
    await tellOwnersEach((t) => ({ subject: t("r9d.codes.s"), body: t("r9d.codes.b", { n: 500, setting: "MYSENAM_PHONE_CODES_PER_DAY" }) }));
    const sent = (await mailTo(await ownerEmail())).at(-1)!;
    expect(sent.locale).toBe("zh");
    expect(sent.subject).toBe("今日暂停发送手机验证码");
    expect(sent.body).toContain("MYSENAM_PHONE_CODES_PER_DAY");
    expect(sent.body).toContain("场馆与员工");
  });

  it("when something breaks, says MySenam's phrases in the owner's language and an error's own text as it came", async () => {
    const detail = said("srv.alert.messagesDetail", { n: 7, error: "550 mailbox full" });
    expect(await raiseAlert(`r9d-test-${++n}`, said("srv.alert.messages"), "English detail", [detail])).toBe(true);
    const sent = (await mailTo(await ownerEmail())).at(-1)!;
    expect(sent.subject).toBe("⚠ MySenam：发给顾客的消息没有发出");
    expect(sent.body).toContain("过去一小时有 7 条失败");
    expect(sent.body).toContain("550 mailbox full");
    expect(sent.body).toContain("您将在 6 小时后再次收到通知");
    expect(sent.body).not.toContain("English detail");
  });
});
