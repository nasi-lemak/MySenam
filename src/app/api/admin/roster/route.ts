import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { jsonObject } from "@/lib/api";
import {
  addException,
  addShift,
  listRoles,
  recordQualification,
  removeException,
  removeRule,
  removeShift,
  revokeQualificationChecked,
  rosterOverview,
  saveRole,
  setRule,
} from "@/lib/rosters";
import { getVenue } from "@/lib/store";
import { formatMinute } from "@/lib/interval";

export const dynamic = "force-dynamic";

/** What each change answers: its result (and the sessions it left uncovered), or a refusal. */
interface Answer {
  ok: boolean;
  error?: string;
  code?: string;
  status?: number;
  affected?: unknown[];
}

const venueIdOf = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * `?venueId` → the venue's roster (lib/rosters.ts): the roles it rosters, the people it can roster (its own staff accounts
 * and its coaches), the qualifications recorded, the weekly shifts, the dated exceptions from today on, the rules that ask for
 * somebody on shift, and what is wrong with it now (`flags`). Front desk may read it.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = venueIdOf(req.nextUrl.searchParams.get("venueId"));
  if (venueId === null) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json(await rosterOverview(venueId), { headers: { "Cache-Control": "no-store" } });
}

const ACTIONS = [
  "role_save",
  "qualification_add",
  "qualification_revoke",
  "shift_add",
  "shift_remove",
  "exception_add",
  "exception_remove",
  "rule_set",
  "rule_remove",
] as const;

/**
 * A manager changes the roster: `{ venueId, action, … }` with `action` one of `role_save` (`id?`, `name`, `qualification`,
 * `active`), `qualification_add` (`personKind`, `personId`, `qualification`, `reference?`, `expiresOn?`),
 * `qualification_revoke` (`id`), `shift_add` (`roleId`, `personKind`, `personId`, `weekday`, `fromMin`, `toMin`),
 * `shift_remove` (`id`), `exception_add` (`kind`: `extra` | `leave`, `personKind`, `personId`, `date`, and for an extra shift
 * `roleId`, `fromMin`, `toMin`; leave may name a time), `exception_remove` (`id`), `rule_set` (`courtId?`, `activity?`,
 * `roleId`, `needed`), `rule_remove` (`id`). Removing a shift, adding leave and the like never cancel a booking: `affected`
 * lists the sessions the change left without their supervisors, which stay listed for a manager to decide.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let b: Record<string, unknown>;
  try {
    b = await jsonObject(req);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const venueId = venueIdOf(b.venueId);
  if (venueId === null || !(await getVenue(venueId))) return NextResponse.json({ error: "Venue not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const action = ACTIONS.find((a) => a === b.action);
  if (!action) return NextResponse.json({ error: "Unknown action." }, { status: 400 });

  const roles = new Map((await listRoles(venueId)).map((r) => [r.id, r.name]));
  const role = (id: unknown) => (typeof id === "number" ? (roles.get(id) ?? `role ${id}`) : "a role");
  const who = `${String(b.personKind ?? "")} ${String(b.personId ?? "")}`.trim();
  const left = (n: number) => (n > 0 ? `; ${n} session${n === 1 ? "" : "s"} left without a supervisor, for a manager to decide` : "");
  let result: Answer;
  let log: { action: string; detail: string };

  switch (action) {
    case "role_save": {
      result = await saveRole(venueId, { id: b.id, name: b.name, qualification: b.qualification, active: b.active });
      log = { action: "roster.role", detail: `Role ${typeof b.name === "string" ? b.name : role(b.id)}${b.active === false ? " turned off" : " saved"}${result.ok ? left((result.affected ?? []).length) : ""}` };
      break;
    }
    case "qualification_add": {
      result = await recordQualification(venueId, { personKind: b.personKind, personId: b.personId, qualification: b.qualification, reference: b.reference, expiresOn: b.expiresOn }, { id: admin.id, name: admin.name });
      log = { action: "roster.qualification", detail: `Recorded ${String(b.qualification)} for ${who}${typeof b.expiresOn === "string" && b.expiresOn ? ` until ${b.expiresOn}` : ""}` };
      break;
    }
    case "qualification_revoke": {
      result = await revokeQualificationChecked(venueId, b.id);
      log = { action: "roster.qualification", detail: `Took back qualification ${String(b.id)}${result.ok ? left((result.affected ?? []).length) : ""}` };
      break;
    }
    case "shift_add": {
      result = await addShift(venueId, { roleId: b.roleId, personKind: b.personKind, personId: b.personId, weekday: b.weekday, fromMin: b.fromMin, toMin: b.toMin });
      log = {
        action: "roster.shift_added",
        detail: `${who} as ${role(b.roleId)}, weekday ${String(b.weekday)} ${typeof b.fromMin === "number" ? formatMinute(b.fromMin) : ""}–${typeof b.toMin === "number" ? formatMinute(b.toMin) : ""}`,
      };
      break;
    }
    case "shift_remove": {
      result = await removeShift(venueId, b.id);
      log = { action: "roster.shift_removed", detail: `Removed shift ${String(b.id)}${result.ok ? left((result.affected ?? []).length) : ""}` };
      break;
    }
    case "exception_add": {
      result = await addException(venueId, { kind: b.kind, personKind: b.personKind, personId: b.personId, date: b.date, roleId: b.roleId, fromMin: b.fromMin, toMin: b.toMin, note: b.note });
      log = {
        action: "roster.exception_added",
        detail: `${b.kind === "leave" ? "Leave" : "Extra shift"} for ${who} on ${String(b.date)}${result.ok ? left((result.affected ?? []).length) : ""}`,
      };
      break;
    }
    case "exception_remove": {
      result = await removeException(venueId, b.id);
      log = { action: "roster.exception_removed", detail: `Removed exception ${String(b.id)}${result.ok ? left((result.affected ?? []).length) : ""}` };
      break;
    }
    case "rule_set": {
      result = await setRule(venueId, { courtId: b.courtId, activity: b.activity, roleId: b.roleId, needed: b.needed });
      log = {
        action: "roster.rule_set",
        detail: `${String(b.needed ?? 1)} ${role(b.roleId)} needed for ${typeof b.activity === "string" ? b.activity : "any activity"}${b.courtId ? ` on resource ${String(b.courtId)}` : ""}${result.ok ? left((result.affected ?? []).length) : ""}`,
      };
      break;
    }
    case "rule_remove": {
      result = await removeRule(venueId, b.id);
      log = { action: "roster.rule_removed", detail: `Removed rule ${String(b.id)}` };
      break;
    }
  }
  if (!result.ok) return NextResponse.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.status ?? 400 });
  await logAction(admin, { venueId, ...log });
  return NextResponse.json(result);
}
