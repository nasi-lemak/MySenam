import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.YOUTH_QUIET_HOURS = "off";

import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { createGroup, decideMember, joinGroup } from "../src/lib/groups";
import { addManaged } from "../src/lib/managed-people";
import { saveMessageSettings, sendMessage } from "../src/lib/messages";
import { acceptInvite, createInvite } from "../src/lib/participants";
import { saveProfile } from "../src/lib/player-profiles";
import { listVenues } from "../src/lib/store";
import type { Sport } from "../src/lib/types";
import { lockYouthSeat, markYouthGroup, setConsent, setMinorOptIn, setYouthAdult, youthSeats } from "../src/lib/youth-messages";

/**
 * Races in supervised youth groups (lib/youth-messages.ts `lockYouthSeat`; ADR 0044): a consent switched off while a message posts, and two
 * supervisors starting the one conversation at once. Run on PGlite (one connection: the work queues) and on Postgres
 * (`TEST_DATABASE_URL`), where the locks are real: a message never lands after a revocation has taken effect.
 */

let n = 0;
let sport: Sport;

async function adult(name: string): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} Ra${n}`, email: `rc${n}@race.test`, phone: `01370${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await saveProfile(made.user.id, { adult: true });
  const on = await saveMessageSettings(made.user.id, { enabled: true, understood: true });
  if (!on.ok) throw new Error(on.error);
  return made.user;
}

async function world() {
  const org = await adult("Orla");
  const other = await adult("Olly");
  const grp = await createGroup(org.id, { name: `Race juniors ${n}`, sport });
  if (!grp.ok) throw new Error(grp.error);
  const g = grp.group.id;
  await markYouthGroup(org.id, g);
  const join = async (u: User) => {
    await joinGroup(u.id, g);
    const row = (await getDb().prepare("SELECT id FROM group_members WHERE group_id = ? AND user_id = ?").get(g, u.id)) as { id: number };
    await decideMember(org.id, row.id, "accept");
  };
  await join(other);
  await setYouthAdult(org.id, g, { memberUserId: other.id, role: "supervisor", declaredRole: "coach" });
  const young = async (name: string) => {
    const guardian = await adult("Gia");
    const made = await addManaged(guardian.id, { displayName: name, birthYear: 2014, relationship: "parent", authority: true }, guardian.name);
    if (!made.ok) throw new Error(made.error);
    const code = await createInvite(guardian, made.person.id, "link");
    if (!code.ok) throw new Error(code.error);
    n++;
    const reg = await registerUser({ name, email: `rk${n}@race.test`, phone: `01371${String(n).padStart(5, "0")}`, password: "a long enough password" });
    if (!reg.ok) throw new Error(reg.error);
    await saveProfile(reg.user.id, { adult: false });
    await acceptInvite(reg.user, { code: code.code });
    await join(reg.user);
    await setMinorOptIn(reg.user.id, g, true);
    await setConsent(guardian.id, made.person.id, g, true);
    return { kid: reg.user, guardian, pid: made.person.id };
  };
  return { org, other, g, a: await young("Aina Lee"), b: await young("Bo Tan") };
}

beforeAll(async () => {
  const v = (await listVenues()).find((x) => x.courts.length > 0)!;
  sport = ((await getDb().prepare("SELECT sport FROM courts WHERE id = ?").get(v.courts[0].id)) as { sport: Sport }).sport;
});

describe("a consent switched off while a message posts", () => {
  it("waits for a message in flight, and refuses every message after it, at once", async () => {
    const { org, g, a } = await world();
    await sendMessage(org.id, "group", g, "Welcome");
    const db = getDb();
    // A message being written holds the child's consent rows `FOR SHARE` until it commits; the guardian's switch-off has to wait for it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const writing = db.transaction(async () => {
      await lockYouthSeat(g, a.kid.id);
      locked();
      await held;
    })();
    await holding;
    let revoked = false;
    const revoking = setConsent(a.guardian.id, a.pid, g, false).then((r) => {
      revoked = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(revoked, "the switch-off must wait for the message being written").toBe(false);
    release();
    await writing;
    expect(await revoking).toMatchObject({ ok: true });
    expect(revoked).toBe(true);
    // From the moment the switch-off has taken effect, nothing the child writes is kept.
    expect(await sendMessage(a.kid.id, "group", g, "too late")).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
    expect((await youthSeats(g)).some((s) => s.userId === a.kid.id)).toBe(false);
  }, 60_000);

  it("never keeps a message from a child after their consent is off, whichever of the two ran first", async () => {
    const { org, g, a, b } = await world();
    await sendMessage(org.id, "group", g, "Welcome");
    // A child's limit is twelve messages an hour: five rounds of two stay under it.
    for (let round = 0; round < 5; round++) {
      await setConsent(a.guardian.id, a.pid, g, true);
      const sends = Array.from({ length: 2 }, (_, i) => sendMessage(a.kid.id, "group", g, `round ${round} message ${i}`));
      const off = setConsent(a.guardian.id, a.pid, g, false);
      const results = await Promise.all([...sends, off]);
      // Each send either went in before the switch-off took hold or was refused as not found; nothing else.
      for (const r of results.slice(0, 2)) expect(r.ok || (r as { code: string }).code === "PM_NOT_FOUND").toBe(true);
      expect(results[2]).toMatchObject({ ok: true });
      // Now it is off for certain: a further send is refused, and the other child is unaffected.
      expect(await sendMessage(a.kid.id, "group", g, "after")).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
      expect(await sendMessage(b.kid.id, "group", g, `bo ${round}`)).toMatchObject({ ok: true });
    }
    const kept = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM player_messages WHERE sender_id = ? AND body = 'after'").get(a.kid.id)) as { n: number };
    expect(kept.n).toBe(0);
  }, 120_000);

  it("keeps the conversation single and every message when two supervisors start it at once", async () => {
    const { org, other, g } = await world();
    const results = await Promise.all([sendMessage(org.id, "group", g, "from the organiser"), sendMessage(other.id, "group", g, "from the coach")]);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    const threads = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM player_message_threads WHERE context_kind = 'group' AND context_id = ?").get(g)) as { n: number };
    expect(threads.n).toBe(1);
    const t = (await getDb().prepare("SELECT youth, message_count FROM player_message_threads WHERE context_kind = 'group' AND context_id = ?").get(g)) as { youth: number; message_count: number };
    expect(t).toEqual({ youth: 1, message_count: 2 });
  }, 60_000);
});
