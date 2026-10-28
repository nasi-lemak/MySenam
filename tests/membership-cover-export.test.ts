import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

import { createAdmin } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { addManaged } from "../src/lib/managed-people";
import { correctCover } from "../src/lib/membership-purchases";
import { exportCustomerData } from "../src/lib/privacy";
import { createVenue, sellMembership } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Who a family membership covered when, in the holder's data export
 * (lib/membership-purchases.ts `coverChangesExport`): every change on the
 * memberships the account holds, with when and whether the account or staff
 * made it (never a staff member's name); a person named, and a correction's
 * reason given, only where the holder is already shown them (covered now, or
 * somebody the account acts for); nothing in another account's export.
 */

let venue: number;
let manager: { id: number; name: string };
let n = 0;

async function adult(name: string) {
  const made = await registerUser({ name: `${name} ${++n}`, email: `mce${n}@mce.test`, phone: `0178800${String(n).padStart(3, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}
async function kid(parent: { id: number; name: string }, displayName: string) {
  const made = await addManaged(parent.id, { displayName, relationship: "parent", authority: true }, parent.name);
  if (!made.ok) throw new Error(made.error);
  return made.person.id;
}

beforeAll(async () => {
  const v = await createVenue({ name: "Family Club", area: "Bangsar", address: "x", phone: "0312370801" });
  if (!v.ok) throw new Error("venue");
  venue = v.venue.id;
  const m = await createAdmin({ name: "Mahmud Manager", email: "mce-mgr@mce.test", password: "a long enough password", venueId: venue, role: "manager" });
  if (!m.ok) throw new Error(m.error);
  manager = { id: m.admin.id, name: "Mahmud Manager" };
});

describe("a family membership's cover history in the export", () => {
  it("lists every change, naming only whom the holder is shown, and never a member of staff", async () => {
    const mum = await adult("Puan Aini");
    const [a, b, c, d] = [await kid(mum, "Adam"), await kid(mum, "Balqis"), await kid(mum, "Cempaka"), await kid(mum, "Darwisy")];
    const sold = await sellMembership({
      venueId: venue,
      holderName: mum.name,
      holderPhone: mum.phone,
      userId: mum.id,
      startsOn: todayISO(),
      expiresOn: addDays(todayISO(), 90),
      price: 300,
      adminId: manager.id,
      covers: [a, b, c],
    });
    if (!sold.ok) throw new Error(sold.error);
    const m = sold.membership;
    // A manager corrects Balqis to Darwisy, and takes Cempaka off.
    expect((await correctCover(manager, m.id, { remove: b, add: d, reason: "Balqis entered instead of Darwisy" })).ok).toBe(true);
    expect((await correctCover(manager, m.id, { remove: c, reason: "Cempaka was never meant to be on it" })).ok).toBe(true);
    // Cempaka is no longer somebody the account acts for: not covered, not hers to be shown.
    await getDb().prepare("UPDATE participant_guardians SET revoked_at = now(), revoke_reason = 'test' WHERE participant_id = ? AND user_id = ?").run(c, mum.id);

    const exported = (await exportCustomerData(mum.id))!;
    const changes = exported.membershipCoverChanges as { membership: string; venue: string; change: string; person: string | null; madeBy: string; reason: string | null; at: string }[];
    expect(changes.map((x) => [x.change, x.person, x.madeBy, x.reason])).toEqual([
      ["named", "Adam", "staff", null],
      ["named", "Balqis", "staff", null],
      ["named", null, "staff", null],
      ["corrected_out", "Balqis", "staff", "Balqis entered instead of Darwisy"],
      ["corrected_in", "Darwisy", "staff", "Balqis entered instead of Darwisy"],
      ["corrected_out", null, "staff", null],
    ]);
    for (const x of changes) expect(x).toMatchObject({ membership: m.code, venue: "Family Club", at: expect.any(String) });
    const text = JSON.stringify(changes);
    for (const never of ["Cempaka", "Mahmud", "never meant"]) expect(text).not.toContain(never);

    // Nobody else's export has it.
    const stranger = await adult("Stranger");
    expect((await exportCustomerData(stranger.id))!.membershipCoverChanges).toEqual([]);
  });
});
