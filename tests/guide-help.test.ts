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

import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdmin, createAdminSession, ensureBootstrapAdmin, type Admin } from "../src/lib/admin-auth";
import { submitApplication } from "../src/lib/applications";
import { setCourtRates } from "../src/lib/dated-changes";
import { getDb } from "../src/lib/db";
import { createCourt } from "../src/lib/store";
import { staffTranslator, STAFF_DICTIONARIES, type StaffLocale } from "../src/lib/staff-i18n";
import { addDays, todayISO } from "../src/lib/time";
import { staffMay } from "../src/lib/roles";
import { HELP_PLACES, HELP_PLACE_IDS, TOPIC_IDS, TOPIC_ROLES, guideAddress, isTopicId, topicWrittenFor } from "../src/lib/guide/help";
import { emptyProfile } from "../src/lib/guide/profile-types";
import { readVenueProfile } from "../src/lib/guide/profile";
import { buildTopic } from "../src/lib/guide/playbook/topics";
import { blockLinks, blockText } from "../src/lib/guide/playbook/render";
import { linkAllowed } from "../src/lib/guide/playbook/dsl";
import type { BuiltTopic } from "../src/lib/guide/playbook/types";
import { GUIDE_ROLES } from "../src/lib/guide/shell";
import { GET as topicGet } from "../src/app/api/admin/guide/topic/route";

/**
 * Contextual help: the map from a place on a screen to a topic and a question,
 * the topic route (every staff role its own version, never another's, one
 * venue's only), and the dictionaries (docs/features/venue-guide.md,
 * "Contextual help and discovery"). Run on PGlite and on Postgres.
 */

const ZONE = "Asia/Kuala_Lumpur";
const today = todayISO(ZONE);
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
const get = (query: string, cookie?: string) => topicGet(new NextRequest(`http://localhost/api/admin/guide/topic${query}`, cookie ? { headers: { cookie } } : undefined));
const topic = async (venueId: number, id: string, cookie: string, extra = "") => {
  const res = await get(`?venueId=${venueId}&id=${id}${extra}`, cookie);
  return { res, body: res.status === 200 ? await res.clone().json() : await res.clone().json().catch(() => null) };
};
const textOf = (built: BuiltTopic, locale: StaffLocale = "en") => {
  const speaker = { t: staffTranslator(locale, "MySenam"), locale };
  return built.blocks.flatMap((b) => blockText(speaker, b)).join("\n");
};

let alpha: number;
let beta: number;
let asAlphaManager: string;
let asAlphaBranch: string;
let asAlphaDesk: string;
let asBetaManager: string;
let asBetaDesk: string;
let asOwner: string;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  asOwner = await cookieOf((await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!);

  const a = await signUp("Help Marker Alpha", "alpha@help.my");
  alpha = a.venueId;
  asAlphaManager = await cookieOf(a.manager);
  await getDb().prepare("UPDATE venues SET published_at = datetime('now'), cancel_cutoff_hours = 37 WHERE id = ?").run(alpha);
  const c1 = ok(await createCourt({ venueId: alpha, name: "Help Alpha 1", sport: "badminton", offPeakRate: 18, peakRate: 28 }));
  ok(await createCourt({ venueId: alpha, name: "Help Alpha 2", sport: "badminton", offPeakRate: 18, peakRate: 28 }));
  // A change of rates from a later date is not today's: the topic says today's.
  ok(await setCourtRates(c1.court, { from: addDays(today, 30), offPeakRate: 40, peakRate: 55 }));
  const desk = ok(await createAdmin({ name: "Alpha Help Desk", email: "desk@help.my", password: "desk-password-1", venueId: alpha, role: "desk" }));
  const branch = ok(await createAdmin({ name: "Alpha Help Branch", email: "branch@help.my", password: "branch-password-1", venueId: alpha }));
  asAlphaDesk = await cookieOf(desk.admin);
  asAlphaBranch = await cookieOf(branch.admin);

  const b = await signUp("Help Marker Beta", "beta@help.my");
  beta = b.venueId;
  asBetaManager = await cookieOf(b.manager);
  await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(beta);
  ok(await createCourt({ venueId: beta, name: "Help Beta 1", sport: "futsal", offPeakRate: 77, peakRate: 99 }));
  const betaDesk = ok(await createAdmin({ name: "Beta Help Desk", email: "desk@beta-help.my", password: "desk-password-1", venueId: beta, role: "desk" }));
  asBetaDesk = await cookieOf(betaDesk.admin);
});

describe("the places a tip can be", () => {
  it("name a topic that exists, written for the dashboard's roles, and a question every language has", () => {
    expect(HELP_PLACE_IDS.length).toBeGreaterThanOrEqual(15);
    for (const id of HELP_PLACE_IDS) {
      const place = HELP_PLACES[id];
      expect(TOPIC_IDS, id).toContain(place.topic);
      for (const locale of ["en", "ms", "zh"] as const) {
        const dictionary = STAFF_DICTIONARIES[locale] as Record<string, string>;
        expect(dictionary[place.question], `${id} ${locale}`).toBeTruthy();
      }
      expect(topicWrittenFor(place.topic, "manager"), id).toBe(true);
      expect(topicWrittenFor(place.topic, "desk"), id).toBe(true);
    }
    // Every topic of the playbook is explained somewhere, so none is written and never reachable.
    const used = new Set(HELP_PLACE_IDS.map((id) => HELP_PLACES[id].topic));
    expect([...used].sort()).toEqual([...TOPIC_IDS].sort());
  });

  it("agree with the playbook's topics about who each is written for: manager and desk have all, the coach none", () => {
    const profile = emptyProfile(1);
    for (const id of TOPIC_IDS)
      for (const role of GUIDE_ROLES) {
        const built = buildTopic(id, profile, role);
        expect(TOPIC_ROLES[id].includes(role), `${id} ${role}`).toBe(built !== null);
        expect(topicWrittenFor(id, role), `${id} ${role}`).toBe(built !== null);
      }
    expect(topicWrittenFor("buffers", "coach")).toBe(false);
    expect(topicWrittenFor("buffers", null)).toBe(true);
    expect(isTopicId("buffers")).toBe(true);
    for (const bad of ["", "nope", "constructor", "__proto__", "BUFFERS", null, undefined, 3]) expect(isTopicId(bad), String(bad)).toBe(false);
  });

  it("are each used once on a screen, and every tip a screen carries is a place", () => {
    const sources: { file: string; text: string }[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.tsx$/.test(entry.name)) sources.push({ file: p, text: fs.readFileSync(p, "utf8") });
      }
    };
    walk("src/components");
    const uses = new Map<string, string[]>();
    for (const { file, text } of sources) for (const m of text.matchAll(/<(?:HelpTip|CounterHelpTip)\s+place="([^"]+)"/g)) uses.set(m[1], [...(uses.get(m[1]) ?? []), file]);
    for (const id of HELP_PLACE_IDS) expect(uses.get(id)?.length, `${id} is used ${uses.get(id)?.length ?? 0} times`).toBe(1);
    for (const id of uses.keys()) expect(HELP_PLACE_IDS as string[], `${id} is not a place`).toContain(id);
  });

  it("send a visitor to the playbook of the same venue, at the topic", () => {
    expect(guideAddress(7, "buffers")).toBe("/admin?tab=guide&view=playbook&venue=7&topic=buffers");
  });
});

describe("the contextual-help phrases", () => {
  it("are all used: nothing is written for a tip or the discover view and never said", () => {
    const source = ["src/components", "src/lib/guide"]
      .flatMap((root) => {
        const out: string[] = [];
        const walk = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(p);
            else if (/\.tsx?$/.test(entry.name)) out.push(fs.readFileSync(p, "utf8"));
          }
        };
        walk(root);
        return out;
      })
      .join("\n");
    const dynamic = [/^gh\.q\./, /^gh\.avail\./, /^gh\.integ\./, /^gh\.group\./];
    const missing = Object.keys(STAFF_DICTIONARIES.en)
      .filter((k) => k.startsWith("gh."))
      .filter((k) => !source.includes(`"${k}"`))
      .filter((k) => !dynamic.some((re) => re.test(k)));
    expect(missing).toEqual([]);
    // The dynamic families are used through their prefix.
    for (const prefix of ["gh.avail.", "gh.integ.", "gh.group."]) expect(source, prefix).toContain(`\`${prefix}$`);
    // Every question is the question of a place.
    const asked = new Set(HELP_PLACE_IDS.map((id) => HELP_PLACES[id].question as string));
    for (const k of Object.keys(STAFF_DICTIONARIES.en).filter((k) => k.startsWith("gh.q."))) expect(asked.has(k), k).toBe(true);
  });

  it("have Malay and Chinese with the same values in the same places", () => {
    const keys = Object.keys(STAFF_DICTIONARIES.en).filter((k) => k.startsWith("gh."));
    expect(keys.length).toBeGreaterThan(50);
    for (const k of keys) {
      const slots = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const en = (STAFF_DICTIONARIES.en as Record<string, string>)[k];
      for (const locale of ["ms", "zh"] as const) {
        const said = (STAFF_DICTIONARIES[locale] as Record<string, string>)[k];
        expect(said, `${k} ${locale}`).toBeTruthy();
        expect(slots(said), `${k} ${locale}`).toEqual(slots(en));
      }
    }
  });
});

describe("the topic route", () => {
  it("answers each of the thirteen topics to a manager: the topic built from the venue, no-store, with the way into the guide", async () => {
    const profile = await readVenueProfile(alpha);
    for (const id of TOPIC_IDS) {
      const { res, body } = await topic(alpha, id, asAlphaManager);
      expect(res.status, id).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(Object.keys(body).sort()).toEqual(["guide", "role", "topic", "venueId"]);
      expect(body).toMatchObject({ venueId: alpha, role: "manager" });
      expect(body.topic.id).toBe(id);
      expect(body.topic.blocks.length).toBeGreaterThan(0);
      expect(JSON.stringify(body.topic)).toBe(JSON.stringify(buildTopic(id, profile, "manager")));
      expect(body.guide).toMatchObject({ tab: "guide", view: "playbook" });
    }
    // A branch manager of the venue reads their own, with no venue named.
    const own = await get(`?id=buffers`, asAlphaBranch);
    expect(own.status).toBe(200);
    expect((await own.json()).venueId).toBe(alpha);
  });

  it("gives the front desk the desk's version: its own words, and no link to a screen a manager alone has", async () => {
    const profile = await readVenueProfile(alpha);
    let different = 0;
    for (const id of TOPIC_IDS) {
      const { res, body } = await topic(alpha, id, asAlphaDesk);
      expect(res.status, id).toBe(200);
      expect(body.role).toBe("desk");
      expect(JSON.stringify(body.topic)).toBe(JSON.stringify(buildTopic(id, profile, "desk")));
      for (const block of body.topic.blocks)
        for (const link of blockLinks(block)) {
          expect(linkAllowed("desk", link.tab, link.staffAction), `${id} ${link.tab}`).toBe(true);
          if (link.staffAction) expect(staffMay("desk")[link.staffAction], `${id} ${link.staffAction}`).toBe(true);
          expect(["reports", "courts", "venues"]).not.toContain(link.tab);
        }
      const manager = await topic(alpha, id, asAlphaManager);
      if (JSON.stringify(manager.body.topic.blocks) !== JSON.stringify(body.topic.blocks)) different++;
      // The desk is told a manager changes it.
    }
    expect(different).toBeGreaterThanOrEqual(9);
    const desk = await topic(alpha, "buffers", asAlphaDesk);
    const manager = await topic(alpha, "buffers", asAlphaManager);
    expect(textOf(desk.body.topic)).toMatch(/manager/i);
    expect(JSON.stringify(desk.body.topic)).not.toContain('"tab":"courts"');
    expect(JSON.stringify(manager.body.topic)).toContain('"tab":"courts"');
    // Its way into the guide is the desk's too: the guide tab is every account's.
    expect(desk.body.guide).toMatchObject({ tab: "guide", view: "playbook" });
  });

  it("takes the role from the session alone: nothing asked for changes it", async () => {
    const asDesk = await topic(alpha, "refunds", asAlphaDesk);
    for (const extra of ["&as=manager", "&role=manager", "&as=coach", "&ownRole=manager"]) {
      const { res, body } = await topic(alpha, "refunds", asAlphaDesk, extra);
      expect(res.status, extra).toBe(200);
      expect(body.role, extra).toBe("desk");
      expect(JSON.stringify(body.topic), extra).toBe(JSON.stringify(asDesk.body.topic));
    }
    // And a manager is not given the desk's by asking.
    expect((await topic(alpha, "refunds", asAlphaManager, "&as=desk")).body.role).toBe("manager");
  });

  it("is not found for a topic that does not exist, and there is no help for a word that only looks like one", async () => {
    for (const id of ["nope", "", "BUFFERS", "constructor", "__proto__", "buffers%20", "buffers,refunds"]) expect((await get(`?venueId=${alpha}&id=${id}`, asAlphaManager)).status, id).toBe(404);
    expect((await get(`?venueId=${alpha}`, asAlphaManager)).status).toBe(404);
  });

  it("asks who is asking and about which venue: signed out is refused, a venue is named, the platform owner reads any", async () => {
    expect((await get(`?venueId=${alpha}&id=buffers`)).status).toBe(401);
    expect((await get(`?id=buffers`, asOwner)).status).toBe(400);
    expect((await get(`?venueId=abc&id=buffers`, asOwner)).status).toBe(400);
    const owner = await topic(beta, "buffers", asOwner);
    expect(owner.res.status).toBe(200);
    expect(owner.body.role).toBe("manager");
  });

  it("refuses another tenant's venue to a manager, a branch manager and the desk, whatever is asked, and an unknown topic does not make it a 404", async () => {
    for (const [cookie, who] of [
      [asAlphaManager, "alpha manager"],
      [asAlphaBranch, "alpha branch"],
      [asAlphaDesk, "alpha desk"],
    ] as const)
      for (const id of ["buffers", "refunds", "nope"]) expect((await get(`?venueId=${beta}&id=${id}`, cookie)).status, `${who} ${id}`).toBe(403);
    for (const [cookie, who] of [
      [asBetaManager, "beta manager"],
      [asBetaDesk, "beta desk"],
    ] as const) for (const id of ["buffers", "nope"]) expect((await get(`?venueId=${alpha}&id=${id}`, cookie)).status, `${who} ${id}`).toBe(403);
    expect((await get(`?venueId=999999&id=buffers`, asAlphaManager)).status).toBe(403);
  });

  it("writes from this venue's own settings, never another's, in every language", async () => {
    const mine = await topic(alpha, "peak-dated", asAlphaManager);
    const theirs = await topic(beta, "peak-dated", asBetaManager);
    for (const locale of ["en", "ms", "zh"] as const) {
      expect(textOf(mine.body.topic, locale)).toContain("RM18");
      expect(textOf(mine.body.topic, locale)).toContain("RM28");
      expect(textOf(mine.body.topic, locale)).not.toContain("RM77");
      expect(textOf(theirs.body.topic, locale)).toContain("RM77");
      expect(textOf(theirs.body.topic, locale)).toContain("RM99");
      expect(textOf(theirs.body.topic, locale)).not.toContain("RM18");
    }
    // Rates set from a later date are not today's: the topic's sentence about the range is today's.
    expect(textOf(mine.body.topic)).not.toContain("RM55");
    // Nothing of the other venue, and no secret or person, in anything it sends.
    for (const id of TOPIC_IDS) {
      const json = JSON.stringify((await topic(alpha, id, asAlphaManager)).body);
      for (const marker of ["Help Marker Beta", "Help Beta 1", "beta@help.my", "Owner of", "desk@help.my", "branch@help.my", "password", "token", "secret"]) expect(json.toLowerCase(), `${id}: ${marker}`).not.toContain(marker.toLowerCase());
    }
  });

  it("changes with the venue's settings on the very next request: nothing is kept", async () => {
    const before = textOf((await topic(alpha, "peak-dated", asAlphaManager)).body.topic);
    expect(before).toContain("RM18");
    await getDb().prepare("UPDATE courts SET off_peak_rate = 21 WHERE venue_id = ?").run(alpha);
    const after = textOf((await topic(alpha, "peak-dated", asAlphaManager)).body.topic);
    expect(after).toContain("RM21");
    expect(after).not.toContain("RM18");
    await getDb().prepare("UPDATE courts SET off_peak_rate = 18 WHERE venue_id = ?").run(alpha);
    expect(textOf((await topic(alpha, "peak-dated", asAlphaManager)).body.topic)).toBe(before);
    expect(textOf((await topic(alpha, "buffers", asAlphaManager)).body.topic)).toContain("No buffers are set");
  });
});
