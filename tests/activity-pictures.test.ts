import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { activity } from "../src/lib/activity-registry";
import { loadActivities, syncBuiltinActivities, type ActivityRunner } from "../src/lib/activities";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { createVenue } from "../src/lib/store";
import { PATCH as activitiesPatch, POST as activitiesPost } from "../src/app/api/admin/activities/route";

/**
 * An activity's picture (docs/development/images.md, docs/features/activities.md):
 * built-ins are drawn with their own glyph, refreshed at every start; an
 * operator's own takes a glyph from the list, or its category's; one still
 * holding an emoji from before glyphs keeps it until somebody changes it; and
 * the route refuses anything else.
 */

let venueId: number;
let cookie: string;

const runner: ActivityRunner = {
  async query(sql, params) {
    return { rows: (await getDb().prepare(sql.replace(/\$\d+/g, "?")).all(...params)) as Record<string, unknown>[] };
  },
};

const send = async (method: "POST" | "PATCH", body: unknown) => {
  const req = new NextRequest("http://localhost/api/admin/activities", {
    method,
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  const res = await (method === "POST" ? activitiesPost(req) : activitiesPatch(req));
  return { status: res.status, body: (await res.json()) as { activity?: { key: string; icon: string }; error?: string } };
};
const iconOf = async (key: string) => ((await getDb().prepare("SELECT icon FROM activities WHERE key = ?").get(key)) as { icon: string }).icon;

beforeAll(async () => {
  const made = await createVenue({ name: "Picture Hall", area: "Ampang", address: "x", phone: "0312340101" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const manager = await createAdmin({ name: "M", email: "m@pictures.my", password: "a long enough password", venueId });
  if (!manager.ok) throw new Error("admin");
  cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
});

describe("built-in activities", () => {
  it("are drawn with their own glyph, and a start puts it back over whatever the row held", async () => {
    expect(await iconOf("badminton")).toBe("activity/badminton");
    await getDb().prepare("UPDATE activities SET icon = '🏸' WHERE key = 'badminton'").run();
    await syncBuiltinActivities(runner);
    await loadActivities(runner);
    expect(await iconOf("badminton")).toBe("activity/badminton");
    expect(activity("badminton").icon).toBe("activity/badminton");
  });
});

describe("an operator's own activity", () => {
  const base = { names: { en: "" }, category: "team", model: "exclusive", noun: "court" };

  it("takes a glyph from the generic set or an activity's, or its category's when none is chosen", async () => {
    const ball = await send("POST", { ...base, venueId, names: { en: "Tchoukball" }, icon: "generic/ball" });
    expect(ball).toMatchObject({ status: 201, body: { activity: { icon: "generic/ball" } } });
    const padel = await send("POST", { ...base, venueId, names: { en: "Beach tennis" }, category: "racket", icon: "activity/padel" });
    expect(padel.body.activity?.icon).toBe("activity/padel");
    const none = await send("POST", { ...base, venueId, names: { en: "Kabaddi" } });
    expect(none.body.activity?.icon).toBe("category/team");
    expect(await iconOf(none.body.activity!.key)).toBe("category/team");
  });

  it("is refused a picture that is not on the list, and nothing is made", async () => {
    for (const icon of ["business/mixed", "generic/unicorn", "<svg onload=x>", "abc"]) {
      const res = await send("POST", { ...base, venueId, names: { en: `Odd ${icon.length}` }, icon });
      expect(res, icon).toEqual({ status: 400, body: { error: "Choose a picture from the list." } });
    }
    expect(await getDb().prepare("SELECT key FROM activities WHERE names LIKE '%Odd%'").all()).toEqual([]);
  });

  it("keeps an emoji it was given before glyphs, until somebody chooses a glyph", async () => {
    // A row from before glyphs: its picture an emoji (no data was rewritten).
    await getDb()
      .prepare(
        `INSERT INTO activities (key, venue_id, category, icon, names, template, support)
         VALUES ('hockey_old', ?, 'team', '🏑', '{"en":"Old hockey"}', '{"model":"exclusive","noun":"pitch","capacity":1,"count":1,"perPlayer":false,"maxPlayers":null,"setting":null,"signOff":false}', 'basic')`
      )
      .run(venueId);
    await loadActivities(runner);
    // Changing something else leaves the emoji as it is.
    const renamed = await send("PATCH", { key: "hockey_old", venueId, names: { en: "Field hockey (old)" } });
    expect(renamed).toMatchObject({ status: 200, body: { activity: { icon: "🏑" } } });
    // Sent back as it is, it is kept too.
    expect((await send("PATCH", { key: "hockey_old", venueId, icon: "🏑" })).body.activity?.icon).toBe("🏑");
    // Something not on the list is refused (what was sent is wrong: 400), and the emoji stays.
    expect(await send("PATCH", { key: "hockey_old", venueId, icon: "business/mixed" })).toEqual({ status: 400, body: { error: "Choose a picture from the list." } });
    expect(await iconOf("hockey_old")).toBe("🏑");
    // A glyph chosen replaces it.
    expect((await send("PATCH", { key: "hockey_old", venueId, icon: "generic/goal" })).body.activity?.icon).toBe("generic/goal");
    expect(await iconOf("hockey_old")).toBe("generic/goal");
  });

  it("still says a built-in is not the operator's to change (403)", async () => {
    expect((await send("PATCH", { key: "badminton", venueId, icon: "generic/ball" })).status).toBe(403);
  });
});
