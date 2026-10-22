import { afterEach, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { readFileSync } from "fs";
import path from "path";
import { getDb } from "../src/lib/db";
import { internationalNumber, longEnough, phoneKey } from "../src/lib/phone";
import { addAccess } from "../src/lib/access";
import { createVenue } from "../src/lib/store";

/**
 * Phone numbers in Malaysia and Singapore: one key for every way a number is
 * written, in the code and in the database alike, and the right country code
 * in front of a local number.
 */

afterEach(() => {
  delete process.env.MYSENAM_COUNTRY;
  delete process.env.WHATSAPP_COUNTRY_CODE;
});

const SAME = [
  // Malaysia: national with its trunk 0, and international.
  ["012-345 6789", "+60 12-345 6789", "60123456789", "0123456789", "0060 12-345 6789"],
  ["03-7956 1234", "+60 3 7956 1234"],
  // Singapore: eight digits, and the same with 65 before it.
  ["9123 4567", "+65 9123 4567", "6591234567", "0065 9123 4567"],
  // A Singapore landline that begins 60 or 65 is not a Malaysian or international number.
  ["6012 3456"],
  ["6512 3456"],
];

describe("one key per number", () => {
  it("is the same however the number is written", () => {
    for (const group of SAME) expect(new Set(group.map(phoneKey)).size).toBe(1);
    expect(phoneKey("6012 3456")).toBe("60123456");
    expect(phoneKey("6512 3456")).toBe("65123456");
    expect(phoneKey("+65 9123 4567")).toBe("91234567");
    expect(phoneKey("+60 12-345 6789")).toBe("0123456789");
  });

  it("is the same in the database as in the code", async () => {
    for (const phone of SAME.flat().concat(["", "60123", "+1 415 555 0100"])) {
      const { key } = (await getDb().prepare("SELECT phone_key(?) AS key").get(phone)) as { key: string };
      expect(key).toBe(phoneKey(phone));
    }
  });

  it("is worked out again by migration 0035 for rows stored under the old rule", async () => {
    const db = getDb();
    const made = await createVenue({ name: "Key Hall", area: "x", address: "x", phone: "61234567" });
    if (!made.ok) throw new Error("venue");
    // The rule as it was, which took 60 off a Singapore landline.
    await db
      .prepare(
        `CREATE OR REPLACE FUNCTION phone_key(phone text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
           SELECT CASE WHEN d LIKE '60%' THEN '0' || substr(d, 3) ELSE d END
           FROM (SELECT regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') AS d) AS digits $$`
      )
      .run();
    await db.prepare("INSERT INTO venue_access_list (venue_id, phone, kind) VALUES (?, '6012 3456', 'resident')").run(made.venue.id);
    const key = async () =>
      ((await db.prepare("SELECT phone_key FROM venue_access_list WHERE venue_id = ?").get(made.venue.id)) as { phone_key: string }).phone_key;
    expect(await key()).toBe("0123456");

    const sql = readFileSync(path.join(process.cwd(), "db/migrations/0035_phone_key_countries.sql"), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(/;\s*\n/)
      .map((x) => x.trim())
      .filter(Boolean);
    for (const statement of sql) await db.prepare(statement).run();
    expect(await key()).toBe("60123456");
    // And on to today's rule, which leaves it be.
    const latest = readFileSync(path.join(process.cwd(), "db/migrations/0066_phone_key_00.sql"), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(/;\s*\n/)
      .map((x) => x.trim())
      .filter(Boolean);
    for (const statement of latest) await db.prepare(statement).run();
    expect(await key()).toBe("60123456");
    expect(((await db.prepare("SELECT phone_key('0060 12-345 6789') AS k").get()) as { k: string }).k).toBe("0123456789");
  });
});

describe("international numbers", () => {
  it("in Malaysia", () => {
    expect(internationalNumber("012-345 6789")).toBe("60123456789");
    expect(internationalNumber("+60 12-345 6789")).toBe("60123456789");
    expect(internationalNumber("60123456789")).toBe("60123456789");
    expect(internationalNumber("0065 9123 4567")).toBe("6591234567");
  });

  it("in Singapore", () => {
    process.env.MYSENAM_COUNTRY = "SG";
    expect(internationalNumber("9123 4567")).toBe("6591234567");
    // A local landline starting 65 is still local.
    expect(internationalNumber("6512 3456")).toBe("6565123456");
    expect(internationalNumber("6591234567")).toBe("6591234567");
    expect(internationalNumber("+60 12-345 6789")).toBe("60123456789");
  });

  it("can still be pointed elsewhere", () => {
    process.env.WHATSAPP_COUNTRY_CODE = "62";
    expect(internationalNumber("0812 3456 789")).toBe("628123456789");
  });
});

describe("how short a number may be", () => {
  it("allows Singapore's eight digits only in Singapore", async () => {
    expect(longEnough("9123 4567")).toBe(false);
    process.env.MYSENAM_COUNTRY = "SG";
    expect(longEnough("9123 4567")).toBe(true);
    const made = await createVenue({ name: "Bishan Courts", area: "Bishan", address: "x", phone: "61234567" });
    if (!made.ok) throw new Error("venue");
    expect(await addAccess(made.venue.id, [{ phone: "9123 4567", kind: "resident" }], null)).toMatchObject({ ok: true, added: 1 });
  });
});
