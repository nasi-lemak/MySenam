import { isActivity } from "../activities";
import { logAction } from "../activity";
import { aiPersonalData, withoutPersonalData } from "../ai-personal-data";
import type { ApiCaller } from "../api-keys";
import { setupView } from "../guide/http";
import type { Say } from "../guide/plan";
import { blockText, say as sayWords, type Speaker } from "../guide/playbook/render";
import { playbookFor } from "../guide/playbook/server";
import type { ReadinessItem } from "../guide/readiness";
import { bookThroughKey, cancelThroughKey } from "../key-bookings";
import { apiCourtDays, apiVenue, bookingForVenue, bookingsBetween, MAX_RANGE_DAYS, spanDays } from "../public-api";
import { staffTranslator, type StaffT } from "../staff-i18n";
import { STAFF_LOCALES, type StaffLocale } from "../staff-locales";
import { getAvailability, getVenue } from "../store";
import { todayISO } from "../time";
import type { Sport } from "../types";
import { ArgError, optDate, optEnum, optString, reqString } from "./args";
import { answer, READ_ONLY, refused, type McpContext, type McpTool, type ToolResult } from "./registry";
import { courtDay } from "./shape";
import { entryResources } from "../entries";

/**
 * Layer 2: the venue's own tools, with its API key
 * (docs/integrations/mcp.md#venue-tools). Each runs the function
 * `/api/v1` or the dashboard runs, for the key's venue only: another venue's
 * court or booking is not found. Customers' names, phone numbers and email
 * addresses are left out unless a manager of the venue turned them on
 * (lib/ai-personal-data.ts). Writes take `confirm: true`; without it they
 * answer what would happen and change nothing.
 *
 * A member of staff signed in through an assistant (lib/mcp/oauth.ts) reaches
 * the same tools by their grant's scopes, for the one venue they allowed, as
 * the API reaches them (no override, no payment taken), named in the staff
 * log as themselves acting through the assistant; the setup status is a
 * manager's, and the playbook their own role's.
 */

/** The caller as the API's code takes one: the key, or the signed-in person's one venue (no key: `keyId` 0, never logged). */
const caller = (ctx: McpContext): ApiCaller => (ctx.person ? { keyId: 0, venueId: ctx.person.venueId, scope: "write" } : ctx.caller!);

/** A booking as this venue lets an assistant see it. */
async function bookingView(ctx: McpContext, booking: Record<string, unknown>, shown?: boolean): Promise<Record<string, unknown>> {
  const on = shown ?? (await aiPersonalData(caller(ctx).venueId)).on;
  return on ? booking : withoutPersonalData(booking);
}

/** A refusal as the API answered it. */
async function fromResponse(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const refusedBy = (body: Record<string, unknown>): ToolResult => refused(String(body.error ?? "Refused."), typeof body.code === "string" ? body.code : null);

const STAFF_LOCALE_ARG = { type: "string", enum: [...STAFF_LOCALES], description: "Language of the answer: en (default), ms or zh." };
const staffT = (args: Record<string, unknown>): StaffT => staffTranslator((optEnum(args, "locale", STAFF_LOCALES) ?? "en") as StaffLocale);

const myVenue: McpTool = {
  name: "my_venue",
  title: "This key's venue",
  description: "Returns the venue this API key belongs to, as GET /api/v1/venue does: name, area, address, phone, time zone, usual and weekday hours, and each court with its sport, off-peak and peak rates and places (and, where it takes entries with no set time, its entry price, longest stay and whether customers check themselves in; nobody is let in through this server); and whether this venue shows customers' personal data to AI assistants.",
  authority: "availability",
  scope: "venue:read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { ...READ_ONLY, title: "My venue" },
  async run(_args, ctx) {
    const v = (await getVenue(caller(ctx).venueId))!;
    const pd = await aiPersonalData(v.id);
    return answer(`${v.name}: the venue this key belongs to.`, { ...apiVenue(v, await entryResources(v.id)), personalDataShownToAssistants: pd.on });
  },
};

const myAvailability: McpTool = {
  name: "my_availability",
  title: "My venue's day",
  description: "Returns each of the venue's courts on a date as GET /api/v1/availability does (rooms run as classes included): the lengths its rules take, each start a booking may have with the longest it may run, and the day in columns with each column's price and whether it is free.",
  authority: "availability",
  scope: "venue:read",
  inputSchema: {
    type: "object",
    properties: { date: { type: "string", description: "YYYY-MM-DD; today if left out." }, activity: { type: "string" } },
    additionalProperties: false,
  },
  annotations: { ...READ_ONLY, title: "My availability" },
  async run(args, ctx) {
    const date = optDate(args, "date") ?? todayISO();
    const sport = optString(args, "activity", 60);
    if (sport && !(await isActivity(sport))) throw new ArgError("Unknown sport.");
    // The venue's own system sees everything it may hire out, rooms run as classes included (as /api/v1/availability).
    const days = apiCourtDays(await getAvailability(caller(ctx).venueId, date, (sport as Sport) || undefined, false, true));
    const courts = days.map((d) => courtDay(d as unknown as Parameters<typeof courtDay>[0]));
    return answer(`${courts.length} ${courts.length === 1 ? "court" : "courts"} on ${date}.`, { date, courts });
  },
};

const myBookings: McpTool = {
  name: "my_bookings",
  title: "My venue's bookings",
  description: `Returns the venue's bookings from one date to another (at most ${MAX_RANGE_DAYS} days), cancelled ones included, as GET /api/v1/bookings does: code, status, payment status, date and times, court, price and what was paid. Customers' names, phone numbers and emails only if a manager turned that on for AI assistants.`,
  authority: "read",
  scope: "venue:read",
  inputSchema: {
    type: "object",
    properties: { from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD; the same day if left out." } },
    required: ["from"],
    additionalProperties: false,
  },
  annotations: { ...READ_ONLY, title: "My bookings" },
  async run(args, ctx) {
    const from = optDate(args, "from");
    const to = optDate(args, "to") ?? from;
    if (!from || !to || to < from) throw new ArgError("from and to (YYYY-MM-DD) are required, to not before from.");
    if (spanDays(from, to) > MAX_RANGE_DAYS) throw new ArgError(`At most ${MAX_RANGE_DAYS} days at a time.`);
    const shown = (await aiPersonalData(caller(ctx).venueId)).on;
    const bookings = await Promise.all((await bookingsBetween(caller(ctx).venueId, from, to)).map((b) => bookingView(ctx, b, shown)));
    return answer(`${bookings.length} ${bookings.length === 1 ? "booking" : "bookings"} from ${from} to ${to}${shown ? "" : "; customers' personal data is not shown to AI assistants at this venue"}.`, {
      from,
      to,
      count: bookings.length,
      bookings,
    });
  },
};

const myBooking: McpTool = {
  name: "my_booking",
  title: "One of my venue's bookings",
  description: "Returns one of the venue's bookings by its code, as GET /api/v1/bookings/<code> does. Another venue's booking is not found. Customers' personal data only if a manager turned it on for AI assistants.",
  authority: "read",
  scope: "venue:read",
  inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false },
  annotations: { ...READ_ONLY, title: "My booking" },
  async run(args, ctx) {
    const booking = await bookingForVenue(caller(ctx).venueId, reqString(args, "code", 40));
    if (!booking) return refused("Booking not found.");
    return answer(`Booking ${booking.code}.`, { booking: await bookingView(ctx, booking) });
  },
};

const said = (t: StaffT, s: Say | null | undefined): string | null => (s ? t(s.key, s.vars) : null);

function readinessLines(t: StaffT, items: ReadinessItem[]): string[] {
  return items.map((i) => (i.say ? t.say(i.say, said(t, i.label) ?? "") : (said(t, i.label) ?? "")));
}

const mySetupStatus: McpTool = {
  name: "my_setup_status",
  title: "My venue's setup and launch readiness",
  description:
    "Returns the venue's setup plan as its manager's setup guide shows it, read afresh from the venue's saved configuration: each step with its group, whether it is done, to do, optional, to review or waiting for another, and why it is shown; and launch readiness in its six lists (complete, optional, required and missing, configured but not verified against the real service, the venue adviser's to decide, feature needs). Never a percentage.",
  authority: "read",
  scope: "venue:read",
  // The manager's setup guide: front desk does not have it on the dashboard either (lib/roles.ts MANAGER_ONLY).
  staffAction: "guideSetup",
  inputSchema: { type: "object", properties: { locale: STAFF_LOCALE_ARG }, additionalProperties: false },
  annotations: { ...READ_ONLY, title: "Setup status" },
  async run(args, ctx) {
    const t = staffT(args);
    // The manager's guide, as an API key belongs to the venue and is made by its manager; nothing kept.
    const view = await setupView(caller(ctx).venueId, "manager");
    const steps = view.plan.items.map((i) => ({
      id: i.id,
      group: i.group,
      title: t(i.titleKey),
      status: i.state.status,
      required: i.required,
      because: said(t, i.because),
      ...(i.state.note ? { note: said(t, i.state.note) } : {}),
      ...(i.state.blockedBy ? { waitsFor: i.state.blockedBy } : {}),
      ...(i.state.verified === false ? { verified: false } : {}),
      ...(i.recommend ? { recommendation: said(t, i.recommend) } : {}),
    }));
    const r = view.readiness;
    const readiness = {
      configurationComplete: readinessLines(t, r.configurationComplete),
      optionalEnhancements: readinessLines(t, r.optionalEnhancements),
      requiredMissing: readinessLines(t, r.requiredMissing),
      unverifiedExternal: r.unverifiedExternal.map((i) => ({ item: readinessLines(t, [i])[0], integration: i.integration })),
      legalPrerequisite: readinessLines(t, r.legalPrerequisite),
      featureSpecific: readinessLines(t, r.featureSpecific),
    };
    const c = view.plan.counts;
    return answer(`${c.requiredOpen} of ${c.requiredTotal} required setup steps still open; ${r.requiredMissing.length} required item(s) missing before going live.`, {
      counts: c,
      steps,
      readiness,
    });
  },
};

const myPlaybook: McpTool = {
  name: "my_playbook",
  title: "My venue's operating playbook",
  description:
    "Returns the venue's operating playbook, the manager's version (signed in as a member of staff, the version for their own role), as plain-text sections composed from the venue's saved configuration: what the venue is, the day, bookings, money, specialised activities and quick references. Screens are named, not linked. It contains no secrets.",
  authority: "read",
  scope: "venue:read",
  inputSchema: { type: "object", properties: { locale: STAFF_LOCALE_ARG }, additionalProperties: false },
  annotations: { ...READ_ONLY, title: "Playbook" },
  async run(args, ctx) {
    const t = staffT(args);
    const speaker: Speaker = { t, locale: t.locale };
    const book = await playbookFor(caller(ctx).venueId, ctx.person?.role ?? "manager");
    // Links said as their labels, the screens' names (lib/guide/playbook/render.ts `blockText`); no address is given.
    const sections = book.sections.map((s) => ({ title: sayWords(speaker, s.title), lines: s.blocks.flatMap((b) => blockText(speaker, b)) }));
    return answer(`The operating playbook of ${book.venue.name ?? "the venue"} for its ${ctx.person?.role === "desk" ? "front desk" : "manager"}, ${sections.length} sections.`, {
      summary: book.summary.map((w) => sayWords(speaker, w)),
      sections,
    });
  },
};

const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const createBooking: McpTool = {
  name: "create_booking",
  title: "Book a court for a customer",
  description:
    "Books a court at this venue for a customer, unpaid, exactly as POST /api/v1/bookings does: the court's booking rules, the venue's policies and the customer's waiver are checked, and the customer is sent the usual confirmation. Without confirm: true it books nothing and answers the preview: court, date, time, price now, and what the customer will be told. Times are minutes of the venue's day or HH:MM; a court sold by the game takes games from a start instead of an end. A key never overrides the venue's policies or takes payment.",
  authority: "write",
  scope: "venue:book",
  inputSchema: {
    type: "object",
    properties: {
      courtId: { type: "integer" },
      date: { type: "string", description: "YYYY-MM-DD" },
      start: { type: ["string", "integer"], description: "HH:MM, or minutes of the day." },
      end: { type: ["string", "integer"], description: "HH:MM, or minutes of the day." },
      minutes: { type: "integer", description: "Or the length, in place of end." },
      games: { type: "integer", description: "On a court sold by the game (bowling): how many games from start, in place of end; the lane is held for the venue's estimate of them." },
      name: { type: "string", description: "The customer's name." },
      phone: { type: "string", description: "The customer's phone number." },
      email: { type: "string" },
      players: { type: "integer" },
      participantIds: { type: "array", items: { type: "integer" } },
      customerTakesPart: { type: "boolean" },
      concessionId: { type: "integer" },
      placeConcessions: { type: "array", items: { type: "object" } },
      promoCode: { type: "string" },
      guestOf: { type: "string", description: "The host's phone number, for a member's or resident's guest." },
      confirm: { type: "boolean", description: "true to book; otherwise only the preview." },
    },
    required: ["courtId", "date", "start", "name", "phone"],
  },
  annotations: { ...WRITE, title: "Create booking" },
  async run(args, ctx) {
    const body: Record<string, unknown> = {};
    // Anything else sent is passed on, so a field the API refuses (an override) is refused here too, never ignored.
    for (const [k, v] of Object.entries(args)) if (k !== "confirm") body[k] = v;
    if (args.confirm !== true) {
      const { status, body: out } = await fromResponse(await bookThroughKey(caller(ctx), body, { preview: true, actor: actor(ctx) }));
      await logCall(ctx, "create_booking", status === 200 ? "preview, nothing booked" : `preview refused${out.code ? `: ${out.code}` : ""}`);
      if (status !== 200) return refusedBy(out);
      return answer("Nothing was booked. This is what booking it would do; call again with confirm: true to book. Whether the time is still free is known only when booking.", out.preview);
    }
    const { status, body: out } = await fromResponse(await bookThroughKey(caller(ctx), body, { actor: actor(ctx) }));
    if (status !== 201) {
      await logCall(ctx, "create_booking", `refused${out.code ? `: ${out.code}` : ""}`);
      return refusedBy(out);
    }
    const booking = out.booking as Record<string, unknown>;
    await logAction(by(ctx), { venueId: caller(ctx).venueId, action: "booking.created", bookingCode: String(booking.code), detail: `Booked through an AI assistant (MCP) ${how(ctx)}` });
    return answer(`Booked: ${booking.code}, unpaid. The customer is sent the usual confirmation.`, { ...out, booking: await bookingView(ctx, booking) });
  },
};

const cancelBooking: McpTool = {
  name: "cancel_booking",
  title: "Cancel a booking",
  description:
    "Cancels one of this venue's bookings as its staff would, exactly as POST /api/v1/bookings/<code>/cancel does: in full, money paid online, with credit or a pass goes back, a counter payment is written down as owed back for the desk, and the customer is told. Without confirm: true it cancels nothing and answers the preview: the booking and what cancelling it would do.",
  authority: "write",
  scope: "venue:book",
  inputSchema: {
    type: "object",
    properties: { code: { type: "string" }, confirm: { type: "boolean", description: "true to cancel; otherwise only the preview." } },
    required: ["code"],
    additionalProperties: false,
  },
  annotations: { ...WRITE, idempotentHint: true, title: "Cancel booking" },
  async run(args, ctx) {
    const code = reqString(args, "code", 40);
    if (args.confirm !== true) {
      const { status, body } = await fromResponse(await cancelThroughKey(caller(ctx), code, { preview: true }));
      await logCall(ctx, "cancel_booking", status === 200 ? "preview, nothing cancelled" : "preview refused");
      if (status !== 200) return refusedBy(body);
      const preview = body.preview as Record<string, unknown>;
      return answer("Nothing was cancelled. This is what cancelling it would do; call again with confirm: true to cancel.", {
        ...preview,
        booking: await bookingView(ctx, preview.booking as Record<string, unknown>),
      });
    }
    const { status, body } = await fromResponse(await cancelThroughKey(caller(ctx), code));
    if (status !== 200) {
      await logCall(ctx, "cancel_booking", `refused${body.code ? `: ${body.code}` : ""}`);
      return refusedBy(body);
    }
    const booking = body.booking as Record<string, unknown>;
    await logAction(by(ctx), { venueId: caller(ctx).venueId, action: "booking.cancelled", bookingCode: code, detail: `Cancelled through an AI assistant (MCP) ${how(ctx)}` });
    return answer(`Cancelled: ${code}. The customer is told.`, { booking: await bookingView(ctx, booking) });
  },
};

/**
 * Who the staff activity log names for a call: the key, as the API's own
 * entries do; or the member of staff signed in through an assistant, by name,
 * as acting through it ("Maya through Claude (AI assistant)").
 */
export const by = (ctx: McpContext): { id: number | null; name: string } =>
  ctx.person ? { id: ctx.person.adminId, name: ctx.person.acting.name } : { id: null, name: `API key ${caller(ctx).keyId}` };

/** Who a participant's record names as booking them through an assistant. */
const actor = (ctx: McpContext): { adminId: number | null; name: string } => {
  const who = by(ctx);
  return { adminId: who.id, name: who.name };
};

/** How a booking made or cancelled through an assistant was reached, for the log's detail. */
const how = (ctx: McpContext): string => (ctx.person ? `by ${ctx.person.acting.name}` : `with API key ${caller(ctx).keyId}`);

/**
 * One entry in the staff activity log for a call that changed nothing:
 * `mcp.tool` through a key, `mcp.staff_tool` for a member of staff signed in
 * through an assistant: which tool, never its arguments, so no customer's
 * name or number is written there. A booking made or cancelled is logged as
 * such instead (`booking.created`, `booking.cancelled`), naming the key or
 * the person, and a setting changed by the dashboard's own route's entry.
 */
export async function logCall(ctx: McpContext, tool: string, outcome?: string): Promise<void> {
  await logAction(by(ctx), {
    venueId: caller(ctx).venueId,
    action: ctx.person ? "mcp.staff_tool" : "mcp.tool",
    detail: `${tool} through an AI assistant (MCP)${outcome ? `: ${outcome}` : ""}`,
  });
}

export const VENUE_TOOLS: McpTool[] = [myVenue, myAvailability, myBookings, myBooking, mySetupStatus, myPlaybook, createBooking, cancelBooking];

/** The write tools, whose calls log themselves (a preview, a refusal, or what they did). */
export const SELF_LOGGING = new Set(["create_booking", "cancel_booking"]);
