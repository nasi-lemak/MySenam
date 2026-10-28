import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { createAdmin, createAdminSession, getAdminById, getAdminByToken, type Admin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { listVenues } from "../src/lib/store";
import { confirmSetup, currentStep, hasTwoFactor, startSetup, totpCode, base32Decode } from "../src/lib/two-factor";
import { resetFromConsole, resetTwoFactorFor } from "../src/lib/two-factor-reset";

/**
 * A member of staff who lost both their authenticator and their recovery
 * codes is reset by somebody with authority over the account, who proves it
 * is them with their own code and says how they knew who asked; the account
 * is signed out and told, and so are the owners. Never by themselves, never
 * by someone without two-factor, never an owner by a manager.
 */

// Today, on a 30-second step: the database's own clock judges session expiry, so a fixed date would lapse a week on.
let clock = Math.floor(Date.now() / 30_000) * 30_000;
const secrets = new Map<number, Buffer>();
const code = (id: number) => {
  clock += 30_000;
  vi.setSystemTime(clock);
  return totpCode(secrets.get(id)!, currentStep(clock));
};

async function staff(email: string, where: { venueId?: number | null; businessId?: number | null; role?: "manager" | "desk" }, twoFactor = true): Promise<Admin> {
  const made = await createAdmin({ name: email.split("@")[0], email, password: "a long enough password", venueId: where.venueId ?? null, businessId: where.businessId ?? null, role: where.role });
  if (!made.ok) throw new Error(made.error);
  if (twoFactor) {
    const setup = await startSetup(made.admin.id);
    const secret = base32Decode(setup!.secret);
    secrets.set(made.admin.id, secret);
    clock += 30_000;
    vi.setSystemTime(clock);
    const done = await confirmSetup(made.admin.id, totpCode(secret, currentStep(clock)));
    if (!done.ok) throw new Error(done.error);
  }
  return (await getAdminById(made.admin.id))!;
}

let owner: Admin;
let secondOwner: Admin;
let manager: Admin;
let desk: Admin;
let deskElsewhere: Admin;
let managerNoTwoFactor: Admin;

const outbox = async (to: string) =>
  ((await getDb().prepare("SELECT subject FROM messages WHERE recipient = ? ORDER BY id").all(to)) as { subject: string }[]).map((r) => r.subject);

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
  const venues = await listVenues();
  const business = ((await getDb().prepare("INSERT INTO businesses (name) VALUES ('Reset Group') RETURNING id").get()) as { id: number }).id;
  await getDb().prepare("UPDATE venues SET business_id = ? WHERE id = ?").run(business, venues[0].id);
  owner = await staff("owner@reset.my", {});
  secondOwner = await staff("second@reset.my", {});
  manager = await staff("manager@reset.my", { businessId: business });
  managerNoTwoFactor = await staff("plain@reset.my", { businessId: business }, false);
  desk = await staff("desk@reset.my", { venueId: venues[0].id, role: "desk" });
  deskElsewhere = await staff("other@reset.my", { venueId: venues[1].id, role: "desk" });
});

describe("resetting a lost two-factor", () => {
  it("is done by a manager over their own staff, with their own code and a reason, and signs the account out", async () => {
    const session = await createAdminSession(desk.id);
    expect(await getAdminByToken(session.token)).not.toBeNull();
    const done = await resetTwoFactorFor(manager, desk.id, { reason: "Seen in person at the front desk with staff ID", code: code(manager.id) });
    expect(done).toEqual({ ok: true });
    expect(await hasTwoFactor(desk.id)).toBe(false);
    expect(await getAdminByToken(session.token)).toBeNull();
    const logged = (await getDb().prepare("SELECT reset_by, by_console, reason FROM two_factor_resets WHERE admin_id = ?").get(desk.id)) as {
      reset_by: number;
      by_console: boolean;
    };
    expect(logged).toMatchObject({ reset_by: manager.id, by_console: false });
    const action = (await getDb().prepare("SELECT action FROM staff_actions WHERE admin_id = ? AND action = 'staff.twoFactorReset'").get(manager.id)) as { action: string } | undefined;
    expect(action?.action).toBe("staff.twoFactorReset");
    // The account is told, and so are the owners.
    expect((await outbox(desk.email)).some((s) => s.includes("two-factor sign-in was reset"))).toBe(true);
    expect((await outbox(owner.email)).some((s) => s.includes("two-factor sign-in reset for"))).toBe(true);
  });

  it("is refused without the resetter's own right code, or a reason, and changes nothing", async () => {
    const target = await staff("desk2@reset.my", { venueId: desk.venueId, role: "desk" });
    expect(await resetTwoFactorFor(manager, target.id, { reason: "Seen in person", code: "000000" })).toMatchObject({ ok: false, status: 401 });
    expect(await resetTwoFactorFor(manager, target.id, { reason: "ok", code: code(manager.id) })).toMatchObject({ ok: false, status: 400 });
    expect(await hasTwoFactor(target.id)).toBe(true);
  });

  it("is refused to somebody without two-factor themselves, to the account itself, and outside the manager's business", async () => {
    const target = await staff("desk3@reset.my", { venueId: desk.venueId, role: "desk" });
    expect(await resetTwoFactorFor(managerNoTwoFactor, target.id, { reason: "Seen in person today", code: "123456" })).toMatchObject({ ok: false, status: 403 });
    expect(await resetTwoFactorFor(manager, manager.id, { reason: "Lost my phone and codes", code: code(manager.id) })).toMatchObject({ ok: false, status: 409 });
    expect(await resetTwoFactorFor(manager, deskElsewhere.id, { reason: "Seen in person today", code: code(manager.id) })).toMatchObject({ ok: false, status: 403 });
    expect(await resetTwoFactorFor(desk, target.id, { reason: "Seen in person today", code: "123456" })).toMatchObject({ ok: false, status: 403 });
    expect(await hasTwoFactor(target.id)).toBe(true);
  });

  it("resets an owner only by another owner", async () => {
    expect(await resetTwoFactorFor(manager, owner.id, { reason: "Called on the number on file", code: code(manager.id) })).toMatchObject({ ok: false, status: 403 });
    expect(await resetTwoFactorFor(secondOwner, owner.id, { reason: "Called on the number on file", code: code(secondOwner.id) })).toEqual({ ok: true });
    expect(await hasTwoFactor(owner.id)).toBe(false);
  });

  it("resets the last owner from the server's console, recorded as such", async () => {
    expect(await resetFromConsole(secondOwner.email, "short")).toMatchObject({ ok: false, status: 400 });
    expect(await resetFromConsole("nobody@reset.my", "Operator confirmed by phone")).toMatchObject({ ok: false, status: 404 });
    expect(await resetFromConsole(secondOwner.email, "Operator confirmed by phone")).toEqual({ ok: true });
    expect(await hasTwoFactor(secondOwner.id)).toBe(false);
    const logged = (await getDb().prepare("SELECT reset_by, by_console FROM two_factor_resets WHERE admin_id = ?").get(secondOwner.id)) as {
      reset_by: number | null;
      by_console: boolean;
    };
    expect(logged).toMatchObject({ reset_by: null, by_console: true });
  });
});
