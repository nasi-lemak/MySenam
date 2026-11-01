import { NextRequest } from "next/server";
import { PATCH as venuePatch } from "@/app/api/admin/venues/[id]/route";
import { POST as hoursChangesPost } from "@/app/api/admin/venues/[id]/hours-changes/route";
import { POST as courtsPost } from "@/app/api/admin/courts/route";
import { PATCH as courtPatch } from "@/app/api/admin/courts/[id]/route";
import { POST as courtChangesPost } from "@/app/api/admin/courts/[id]/changes/route";
import { POST as peakRulesPost } from "@/app/api/admin/peak-rules/route";
import { POST as bookingPoliciesPost } from "@/app/api/admin/booking-policies/route";
import { POST as cancelPolicyPost } from "@/app/api/admin/cancel-policy/route";
import { POST as guideSetupPost } from "@/app/api/admin/guide/setup/route";
import { asDelegate } from "../admin-auth";
import { readMinute } from "../api";
import { venuePolicyLevels } from "../booking-policy";
import { cancelPolicy } from "../cancel-policy";
import { listCourtChanges, listHoursChanges } from "../dated-changes";
import { withTransaction } from "../db";
import { readGuide } from "../guide/answers";
import { baseUrl } from "../outbox";
import { peakRules } from "../peak";
import type { StaffActionName } from "../roles";
import { keyedHash } from "../secrets";
import { getCourt, getVenue } from "../store";
import { ArgError, optDate, optInt, optString, reqInt, reqString } from "./args";
import type { PersonCaller } from "./oauth";
import { answer, refused, type McpContext, type McpTool, type ToolAnnotations, type ToolResult } from "./registry";
import { logCall } from "./venue-tools";

/**
 * Layer 3's configuration tools (docs/integrations/mcp.md#changing-the-venues-settings):
 * a manager signed in through an assistant (lib/mcp/oauth.ts) changing the
 * venue's settings that the setup journey changes, through the very route
 * handlers the dashboard and the journey call, never new logic.
 *
 * Each tool turns its arguments into the dashboard's own requests and runs
 * those routes' handlers as the person (lib/admin-auth.ts `asDelegate`): the
 * same validation, `MANAGER_ONLY`, refusals and their words, effective dating
 * and staff log entries, the log naming "<name> through <client> (AI
 * assistant)". A request carries no cookie.
 *
 * - **Preview first.** Without `confirm: true` the requests run inside a
 *   transaction that is then rolled back: the answer is what the routes
 *   would do, refused as they refuse (narrowed hours list every booking they
 *   would strand), with the saved settings it would change from and to, and a
 *   `previewToken`.
 * - **Applied only as previewed.** `confirm: true` needs that token. It is a
 *   keyed hash of the arguments and of the saved settings the change
 *   concerns as they were at the preview; if the venue changed since, nothing
 *   is applied and the answer is the settings as they are now
 *   (`MCP_PREVIEW_STALE`), for a new preview. The requests of one tool apply
 *   together or not at all.
 *
 * Never: payment keys or accounts, staff, roles, API keys, assistants'
 * connections, payouts, refunds, tax, e-invoicing, going live, or deleting.
 */

type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

/** One of the dashboard's own requests: its method and address (so `MANAGER_ONLY` reads it as it reads the dashboard's), and the route's handler. */
interface RouteCall {
  method: "POST" | "PATCH";
  path: string;
  id?: number;
  handler: Handler;
  body: Record<string, unknown>;
}

interface Answered {
  request: string;
  status: number;
  body: Record<string, unknown>;
}

interface Outcome {
  ok: boolean;
  answers: Answered[];
  after: unknown;
}

/** Thrown to roll back a preview, or a set of requests one of which was refused, carrying what the routes answered. */
class RolledBack extends Error {
  constructor(readonly outcome: Outcome) {
    super("rolled back");
  }
}

/** Run one route's handler as the person: a request with no cookie, the person found by `requireAdmin` (lib/admin-auth.ts). */
async function invoke(person: PersonCaller, call: RouteCall): Promise<Answered> {
  const req = new NextRequest(new URL(call.path, baseUrl()), {
    method: call.method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(call.body),
  });
  const res = await asDelegate(person.acting, () => call.handler(req, { params: Promise.resolve({ id: String(call.id ?? "") }) }));
  return { request: `${call.method} ${call.path}`, status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** The requests in one transaction: kept only when `apply` and every one succeeded; otherwise rolled back, with what they answered. */
async function runCalls(person: PersonCaller, calls: RouteCall[], state: () => Promise<unknown>, apply: boolean): Promise<Outcome> {
  try {
    return await withTransaction(async () => {
      const answers: Answered[] = [];
      for (const call of calls) {
        const a = await invoke(person, call);
        answers.push(a);
        if (a.status >= 300) throw new RolledBack({ ok: false, answers, after: null });
      }
      const after = await state();
      if (!apply) throw new RolledBack({ ok: true, answers, after });
      return { ok: true, answers, after };
    });
  } catch (err) {
    if (err instanceof RolledBack) return err.outcome;
    throw err;
  }
}

/** JSON with its keys in order, so the same settings always hash the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

/** What changes from `before` to `after`, setting by setting (at most 60). */
function differences(before: unknown, after: unknown, path = "", out: { setting: string; from: unknown; to: unknown }[] = []): { setting: string; from: unknown; to: unknown }[] {
  if (out.length >= 60) return out;
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (isObj(before) && isObj(after)) {
    for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) differences(before[k], after[k], path ? `${path}.${k}` : k, out);
    return out;
  }
  if (canonical(before) !== canonical(after)) out.push({ setting: path || "(all)", from: before ?? null, to: after ?? null });
  return out;
}

const withoutControls = (args: Record<string, unknown>): Record<string, unknown> => {
  const { confirm: _c, previewToken: _p, ...rest } = args;
  return rest;
};

const tokenFor = (person: PersonCaller, tool: string, args: Record<string, unknown>, state: unknown): string =>
  keyedHash("mcp-preview", canonical([person.grantId, person.venueId, tool, withoutControls(args), state])).slice(0, 40);

/** The refusal a route answered, in its own words and code, with what it lists (bookings stranded, a stale save). */
function routeRefusal(a: Answered): ToolResult {
  const error = String(a.body.error ?? "Refused.");
  const code = typeof a.body.code === "string" ? a.body.code : null;
  const extra: Record<string, unknown> = {};
  for (const k of ["stranded", "stale", "rev", "answers"]) if (a.body[k] !== undefined) extra[k] = a.body[k];
  const text = `${code ? `${error} (${code})` : error}${Object.keys(extra).length ? `\n\n${JSON.stringify(extra)}` : ""}`;
  return { content: [{ type: "text", text }], isError: true };
}

const CONTROLS = {
  confirm: { type: "boolean", description: "true to apply, with the previewToken of the preview; otherwise only the preview." },
  previewToken: { type: "string", description: "The previewToken the preview answered." },
};

interface ConfigSpec {
  name: string;
  title: string;
  description: string;
  staffAction: StaffActionName;
  properties: Record<string, unknown>;
  required?: string[];
  annotations: Omit<ToolAnnotations, "readOnlyHint" | "openWorldHint">;
  /** The dashboard's requests this change is, from the arguments (an ArgError for arguments that do not read). */
  calls(args: Record<string, unknown>, venueId: number): Promise<RouteCall[]>;
  /** The saved settings the change concerns, read as the dashboard reads them: what the preview compares and its token covers. */
  state(venueId: number, args: Record<string, unknown>): Promise<unknown>;
  /** What the application does beyond the settings, in its own terms, for the preview. */
  note?: (args: Record<string, unknown>) => string | null;
}

function configTool(spec: ConfigSpec): McpTool {
  return {
    name: spec.name,
    title: spec.title,
    description: `${spec.description} Without confirm: true nothing changes: the answer is the preview (what would change, from what to what, or the refusal in the dashboard's words) and a previewToken; call again with confirm: true and that previewToken to apply it. A manager's, signed in through the assistant with venue:configure.`,
    authority: "signedIn",
    scope: "venue:configure",
    staffAction: spec.staffAction,
    inputSchema: { type: "object", properties: { ...spec.properties, ...CONTROLS }, ...(spec.required ? { required: spec.required } : {}), additionalProperties: false },
    annotations: { readOnlyHint: false, openWorldHint: false, ...spec.annotations },
    async run(args, ctx: McpContext) {
      const person = ctx.person!;
      const venueId = person.venueId;
      let calls: RouteCall[];
      try {
        calls = await spec.calls(args, venueId);
      } catch (err) {
        // Arguments that do not read: refused before anything runs, and logged as every call is.
        if (err instanceof ArgError) await logCall(ctx, spec.name, "refused");
        throw err;
      }
      const before = await spec.state(venueId, args);
      const token = tokenFor(person, spec.name, args, before);
      const note = spec.note?.(args) ?? null;
      if (args.confirm !== true) {
        const out = await runCalls(person, calls, () => spec.state(venueId, args), false);
        const refusedBy = out.answers.find((a) => a.status >= 300);
        await logCall(ctx, spec.name, refusedBy ? `preview refused${typeof refusedBy.body.code === "string" ? `: ${refusedBy.body.code}` : ""}` : "preview, nothing changed");
        if (refusedBy) return routeRefusal(refusedBy);
        const changes = differences(before, out.after);
        return answer(
          changes.length === 0
            ? "Nothing would change: the settings are already so. Nothing was changed."
            : `Nothing was changed. Applying it would change ${changes.length} setting${changes.length === 1 ? "" : "s"}; call again with confirm: true and this previewToken to apply it.`,
          { changes, ...(note ? { note } : {}), requests: out.answers.map((a) => a.request), previewToken: token }
        );
      }
      if (typeof args.previewToken !== "string" || args.previewToken === "") {
        await logCall(ctx, spec.name, "refused: no preview");
        return refused("Preview it first: call without confirm, then again with confirm: true and the previewToken it answers.", "MCP_PREVIEW_FIRST");
      }
      if (args.previewToken !== token) {
        await logCall(ctx, spec.name, "refused: the preview is out of date");
        return {
          content: [
            {
              type: "text",
              text: `The venue's settings, or the arguments, are not the ones that preview was for: nothing was changed. This is how they are now; preview again. (MCP_PREVIEW_STALE)\n\n${JSON.stringify({ current: before })}`,
            },
          ],
          isError: true,
        };
      }
      const out = await runCalls(person, calls, () => spec.state(venueId, args), true);
      const refusedBy = out.answers.find((a) => a.status >= 300);
      if (refusedBy) {
        await logCall(ctx, spec.name, `refused${typeof refusedBy.body.code === "string" ? `: ${refusedBy.body.code}` : ""}`);
        return routeRefusal(refusedBy);
      }
      // Logged by the routes themselves, as the person through the assistant.
      const changes = differences(before, out.after);
      return answer(`Done: ${changes.length} setting${changes.length === 1 ? "" : "s"} changed, through the dashboard's own requests, in the staff activity log as ${person.acting.name}.`, {
        changes,
        ...(note ? { note } : {}),
        requests: out.answers.map((a) => a.request),
      });
    },
  };
}

// ------------------------------------------------------------------ arguments

/** A time of day as minutes or HH:MM (as the dashboard's routes read them). */
function minuteArg(args: Record<string, unknown>, key: string): number {
  const m = readMinute(args, key);
  if (!Number.isFinite(m)) throw new ArgError(`${key} is a time of day: HH:MM, or minutes from midnight.`);
  return m;
}

function amountArg(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ArgError(`${key} is an amount of money, a number.`);
  return v;
}

function objectArg(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = args[key];
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ArgError(`${key} is an object.`);
  return v as Record<string, unknown>;
}

const SET = { destructiveHint: true, idempotentHint: true };

// ------------------------------------------------------------------ the tools

const venueHours = async (venueId: number) => {
  const v = await getVenue(venueId);
  return { openMin: v?.openMin ?? null, closeMin: v?.closeMin ?? null, weekHours: v?.weekHours ?? null, scheduled: await listHoursChanges(venueId) };
};

const setOpeningHours = configTool({
  name: "set_opening_hours",
  title: "Set the venue's opening hours",
  description:
    "Sets the venue's usual opening and closing time, and optionally hours of its own for each weekday, now (as Venue details does, PATCH /api/admin/venues/<id>) or from a later date (as Hours from a date does; it then shows in the playbook's Coming later). Refused, with every booking listed, where bookings already made would fall outside the new hours.",
  staffAction: "venueDetails",
  properties: {
    open: { type: ["string", "integer"], description: "Opening time, HH:MM or minutes from midnight." },
    close: { type: ["string", "integer"], description: "Closing time, HH:MM or minutes from midnight (past midnight up to 04:00 the next day: 24:00 to 28:00)." },
    weekHours: { type: "object", description: "Optional: weekdays with their own hours or closed, as Venue details takes them." },
    from: { type: "string", description: "YYYY-MM-DD: from a later date; left out, now." },
  },
  required: ["open", "close"],
  annotations: { ...SET },
  async calls(args, venueId) {
    const openMin = minuteArg(args, "open");
    const closeMin = minuteArg(args, "close");
    const from = optDate(args, "from");
    const weekHours = args.weekHours === undefined ? undefined : args.weekHours;
    if (from)
      return [{ method: "POST", path: `/api/admin/venues/${venueId}/hours-changes`, id: venueId, handler: hoursChangesPost, body: { from, openMin, closeMin, ...(weekHours !== undefined ? { weekHours } : {}) } }];
    return [{ method: "PATCH", path: `/api/admin/venues/${venueId}`, id: venueId, handler: venuePatch, body: { openMin, closeMin, ...(weekHours !== undefined ? { weekHours } : {}) } }];
  },
  state: (venueId) => venueHours(venueId),
  note: (args) => (args.from ? "From that date the new hours apply; until then the current ones do. It shows in the playbook's Coming later." : null),
});

const courtRates = async (venueId: number, courtId: number) => {
  const court = await getCourt(courtId);
  const mine = court && court.venueId === venueId ? court : null;
  return {
    courtId,
    offPeakRate: mine?.offPeakRate ?? null,
    peakRate: mine?.peakRate ?? null,
    scheduled: mine ? ((await listCourtChanges(venueId)).find((c) => c.courtId === courtId)?.rates ?? []) : [],
  };
};

const setCourtRates = configTool({
  name: "set_court_rates",
  title: "Set a court's rates",
  description:
    "Sets one court's off-peak and peak rate, now (as Courts & rates and the setup journey do, PATCH /api/admin/courts/<id>) or from a later date (as Rates from a date does, POST /api/admin/courts/<id>/changes; it then shows in the playbook's Coming later). Bookings already made keep the price they were made at.",
  staffAction: "courtChange",
  properties: {
    courtId: { type: "integer" },
    offPeakRate: { type: "number" },
    peakRate: { type: "number" },
    from: { type: "string", description: "YYYY-MM-DD: from a later date; left out, now." },
  },
  required: ["courtId", "offPeakRate", "peakRate"],
  annotations: { ...SET },
  async calls(args) {
    const courtId = reqInt(args, "courtId");
    const offPeakRate = amountArg(args, "offPeakRate");
    const peakRate = amountArg(args, "peakRate");
    const from = optDate(args, "from");
    if (from) return [{ method: "POST", path: `/api/admin/courts/${courtId}/changes`, id: courtId, handler: courtChangesPost, body: { kind: "rates", from, offPeakRate, peakRate } }];
    return [{ method: "PATCH", path: `/api/admin/courts/${courtId}`, id: courtId, handler: courtPatch, body: { offPeakRate, peakRate } }];
  },
  state: (venueId, args) => courtRates(venueId, Number(args.courtId)),
  note: () => "Bookings already made keep the price they were made at.",
});

const courtList = async (venueId: number) =>
  ((await getVenue(venueId))?.courts ?? []).map((c) => ({ id: c.id, name: c.name, sport: c.sport, offPeakRate: c.offPeakRate, peakRate: c.peakRate, capacity: c.capacity }));

const addCourts = configTool({
  name: "add_courts",
  title: "Add courts or other resources",
  description:
    "Adds courts (or lanes, bays, rooms…) for an activity from its template, as the setup journey's Add resources does (POST /api/admin/courts): one by name, or several at once by count, numbered after the activity's noun.",
  staffAction: "courts",
  properties: {
    sport: { type: "string", description: "The activity's key, as the venue's activities name it (e.g. badminton)." },
    count: { type: "integer", description: "How many to add at once; or give name for one." },
    name: { type: "string", description: "The name of one." },
    noun: { type: "string", description: "Optional: what one is called (court, lane, bay)." },
    offPeakRate: { type: "number" },
    peakRate: { type: "number" },
    capacity: { type: "integer", description: "Optional: places on each, for one shared by several bookings." },
  },
  required: ["sport", "offPeakRate", "peakRate"],
  annotations: { destructiveHint: false, idempotentHint: false },
  async calls(args, venueId) {
    const sport = reqString(args, "sport", 60);
    const count = optInt(args, "count", 1, 100);
    const name = optString(args, "name", 80);
    if (count === undefined && name === undefined) throw new ArgError("Give count, or name for one.");
    const noun = optString(args, "noun", 30);
    const capacity = optInt(args, "capacity", 1, 10_000);
    return [
      {
        method: "POST",
        path: "/api/admin/courts",
        handler: courtsPost,
        body: {
          venueId,
          sport,
          ...(count !== undefined ? { count } : { name }),
          ...(noun ? { noun } : {}),
          offPeakRate: amountArg(args, "offPeakRate"),
          peakRate: amountArg(args, "peakRate"),
          ...(capacity !== undefined ? { capacity } : {}),
        },
      },
    ];
  },
  state: (venueId) => courtList(venueId),
});

const setPeakHours = configTool({
  name: "set_peak_hours",
  title: "Set when peak rates apply",
  description:
    "Sets when the courts' peak rates apply, on weekdays and on the weekend days chosen, as Courts & rates' peak hours do (POST /api/admin/peak-rules). Holidays are set there.",
  staffAction: "peakRules",
  properties: {
    weekdayFrom: { type: ["string", "integer"], description: "HH:MM or minutes; the same as weekdayUntil for no peak on weekdays." },
    weekdayUntil: { type: ["string", "integer"] },
    weekendDays: { type: "array", items: { type: "integer" }, description: "Days of the week counted as the weekend: 0 Sunday … 6 Saturday." },
    weekendFrom: { type: ["string", "integer"] },
    weekendUntil: { type: ["string", "integer"] },
  },
  required: ["weekdayFrom", "weekdayUntil", "weekendDays", "weekendFrom", "weekendUntil"],
  annotations: { ...SET },
  async calls(args, venueId) {
    return [
      {
        method: "POST",
        path: "/api/admin/peak-rules",
        handler: peakRulesPost,
        body: {
          venueId,
          weekdayFrom: minuteArg(args, "weekdayFrom"),
          weekdayUntil: minuteArg(args, "weekdayUntil"),
          weekendDays: args.weekendDays,
          weekendFrom: minuteArg(args, "weekendFrom"),
          weekendUntil: minuteArg(args, "weekendUntil"),
        },
      },
    ];
  },
  async state(venueId) {
    const { holidays: _holidays, ...rules } = await peakRules(venueId);
    return rules;
  },
  note: () => "Bookings already made keep the price they were made at.",
});

const setBookingRules = configTool({
  name: "set_booking_rules",
  title: "Set booking rules",
  description:
    "Sets booking rules (when bookings may start, how long they run, buffers, notice) for the venue, one activity at it, or one court, as Courts & rates' booking rules do (POST /api/admin/booking-policies): a setting given as null goes back to inheriting, one left out is kept. Refused, with every booking listed, where bookings already made would fall outside the hours it sets. Rules for every branch of a business are not set here.",
  staffAction: "bookingPolicies",
  properties: {
    level: { type: "string", enum: ["venue", "sport", "court"] },
    sport: { type: "string", description: "For level sport, or one activity on a court." },
    courtId: { type: "integer", description: "For level court." },
    settings: { type: "object", description: "The settings as the booking rules editor sends them." },
  },
  required: ["level", "settings"],
  annotations: { ...SET },
  async calls(args, venueId) {
    const level = reqString(args, "level", 10);
    if (!["venue", "sport", "court"].includes(level)) throw new ArgError("level is venue, sport or court.");
    const sport = optString(args, "sport", 60);
    const courtId = optInt(args, "courtId");
    return [
      {
        method: "POST",
        path: "/api/admin/booking-policies",
        handler: bookingPoliciesPost,
        body: { venueId, level, ...(sport ? { sport } : {}), ...(courtId !== undefined ? { courtId } : {}), settings: objectArg(args, "settings") },
      },
    ];
  },
  state: (venueId) => venuePolicyLevels(venueId),
  note: () => "Bookings already made keep the time and price they were made at.",
});

const POLICY_FIELDS = ["lateKeep", "giveBack", "strikeLimit", "strikeDays", "onlineRefunds", "refundWithinDays"] as const;

const cancellationState = async (venueId: number) => ({
  cutoffHours: (await getVenue(venueId))?.cancelCutoffHours ?? null,
  policy: await cancelPolicy(venueId),
  reviewed: (await readGuide(venueId)).acknowledged["cancellation-terms"] !== undefined,
});

const setCancellationTerms = configTool({
  name: "set_cancellation_terms",
  title: "Set the cancellation terms",
  description:
    "Sets the venue's cancellation terms as the setup journey's cancellation step does: the free-cancellation cutoff in hours (PATCH /api/admin/venues/<id>), what a late cancellation keeps, giving a court back late, strikes before paying online and how money paid online goes back (POST /api/admin/cancel-policy, the fields left out kept as they are), and, with reviewed: true, records that the manager reviewed the terms (the journey's review). All of it applies together or not at all.",
  staffAction: "cancelPolicy",
  properties: {
    cutoffHours: { type: "integer", description: "Hours before the start until which a customer may cancel in full." },
    lateKeep: { type: ["integer", "null"], description: "Percent kept on a late cancellation; null for no late cancelling online." },
    giveBack: { type: "boolean" },
    strikeLimit: { type: ["integer", "null"], description: "No-shows and late cancellations before a number must pay online; null for off." },
    strikeDays: { type: "integer" },
    onlineRefunds: { type: "string", description: "How money paid online goes back, as the editor offers it." },
    refundWithinDays: { type: "integer" },
    reviewed: { type: "boolean", description: "true to record that the terms were reviewed, as the journey's step does." },
  },
  annotations: { ...SET },
  async calls(args, venueId) {
    const calls: RouteCall[] = [];
    const cutoff = optInt(args, "cutoffHours", 0, 10_000);
    if (cutoff !== undefined) calls.push({ method: "PATCH", path: `/api/admin/venues/${venueId}`, id: venueId, handler: venuePatch, body: { cancelCutoffHours: cutoff } });
    const given = POLICY_FIELDS.filter((k) => args[k] !== undefined);
    if (given.length > 0) {
      // The editor sends the whole form: the terms as they are, with what was changed.
      const current = await cancelPolicy(venueId);
      const body: Record<string, unknown> = { venueId, ...current };
      for (const k of given) body[k] = args[k];
      calls.push({ method: "POST", path: "/api/admin/cancel-policy", handler: cancelPolicyPost, body });
    }
    if (args.reviewed === true) calls.push({ method: "POST", path: "/api/admin/guide/setup", handler: guideSetupPost, body: { venueId, action: "acknowledge", step: "cancellation-terms" } });
    if (calls.length === 0) throw new ArgError("Give the cutoff, a term to change, or reviewed: true.");
    return calls;
  },
  state: (venueId) => cancellationState(venueId),
});

const guideAnswers = async (venueId: number) => {
  const g = await readGuide(venueId);
  return { rev: g.rev, answers: g.answers };
};

const saveSetupAnswers = configTool({
  name: "save_setup_answers",
  title: "Save the setup journey's answers",
  description:
    "Saves answers to the setup journey's questions about the business (types, activities, customersDo, resources, branches, staffing, channels, memberships, coaching, children, audience, competitions, discounts; null takes an answer back), on top of revision rev, as the journey does (POST /api/admin/guide/setup): refused, with the answers now saved, if somebody saved since. Answers are intent, not settings: they change which setup steps are shown, never a saved setting. my_setup_status shows the steps.",
  staffAction: "guideSetup",
  properties: {
    answers: { type: "object", description: "The answers to set, key by key." },
    rev: { type: "integer", description: "The revision of the answers being changed (my_setup_status, or this tool's preview, shows it)." },
  },
  required: ["answers", "rev"],
  annotations: { destructiveHint: false, idempotentHint: false },
  async calls(args, venueId) {
    return [{ method: "POST", path: "/api/admin/guide/setup", handler: guideSetupPost, body: { venueId, action: "answers", answers: objectArg(args, "answers"), rev: reqInt(args, "rev", 0) } }];
  },
  state: (venueId) => guideAnswers(venueId),
});

const acknowledgeSetupStep = configTool({
  name: "acknowledge_setup_step",
  title: "Record a setup step as reviewed",
  description:
    "Records that the manager reviewed one of the setup journey's review steps (my_setup_status shows them, e.g. communications, counter-payments, guardians), as the journey's Reviewed button does (POST /api/admin/guide/setup). It changes no setting.",
  staffAction: "guideSetup",
  properties: { step: { type: "string", description: "The step's id." } },
  required: ["step"],
  annotations: { destructiveHint: false, idempotentHint: true },
  async calls(args, venueId) {
    return [{ method: "POST", path: "/api/admin/guide/setup", handler: guideSetupPost, body: { venueId, action: "acknowledge", step: reqString(args, "step", 60) } }];
  },
  async state(venueId) {
    return { reviewed: Object.keys((await readGuide(venueId)).acknowledged).sort() };
  },
});

export const CONFIG_TOOLS: McpTool[] = [saveSetupAnswers, acknowledgeSetupStep, setOpeningHours, setCourtRates, addCourts, setPeakHours, setBookingRules, setCancellationTerms];
