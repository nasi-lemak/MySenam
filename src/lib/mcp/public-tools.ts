import { NextRequest } from "next/server";
import { GET as searchRoute } from "@/app/api/search/route";
import { GET as availabilityRoute } from "@/app/api/availability/route";
import { sportsOf } from "../court-activities";
import { BUSINESS_TYPES } from "../guide/business-types";
import type { Availability } from "../guide/capabilities";
import { activityName, list, presentCapability, presentChip, presentWorkflows, typeName } from "../guide/public/present";
import { applyAddress, guideAddress, knownActivities, knownTypes, type Selection } from "../guide/public/select";
import { fitView } from "../guide/public/view";
import { isLocale, translator, type Locale, type T } from "../i18n";
import { mayShowVenue } from "../listing";
import { venueRating } from "../reviews";
import { getVenue, SEARCH_SORTS } from "../store";
import { shows, storefrontForRequest } from "../storefront";
import { weekLines } from "../week-hours";
import { ArgError, optDate, optEnum, optInt, optList, optNumber, optString, reqInt } from "./args";
import { answer, READ_ONLY, refused, type McpContext, type McpTool } from "./registry";
import { clock, courtDay } from "./shape";

/**
 * Layer 1: the tools anybody may use, with no credentials
 * (docs/integrations/mcp.md#public-tools). Each answers only what a public
 * page or route already shows, through that page's or route's own code:
 *
 * - the public guide's (`/for-venues`, a marketplace's only) model,
 *   `fitView`, said by the same presenters in the asked language;
 * - search and a venue's day through the public routes' own handlers
 *   (`/api/search`, `/api/availability`), asked with a request that carries
 *   the visitor's host and address and no cookie and no key, so the answer is
 *   the one anybody signed out gets: drafts, suspended and private venues not
 *   found, a members-only venue as its public page shows it;
 * - a venue's facts as its public page shows them, for a venue that page
 *   would show to somebody signed out.
 */

const LOCALES_ARG = { type: "string", enum: ["en", "ms", "zh", "ta"], description: "Language of the answer: en (default), ms, zh or ta." };

function localeOf(args: Record<string, unknown>): Locale {
  const v = optString(args, "locale", 5) ?? "en";
  if (!isLocale(v)) throw new ArgError("locale must be one of: en, ms, zh, ta.");
  return v;
}

/** The public route's own handler, asked as somebody signed out on the same site: the caller's host and address, never a cookie or a key. */
async function askPublicRoute(ctx: McpContext, handler: (req: NextRequest) => Promise<Response>, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers();
  for (const name of ["host", "x-forwarded-host", "x-forwarded-for", "x-real-ip", "x-forwarded-proto"]) {
    const v = ctx.req.headers.get(name);
    if (v) headers.set(name, v);
  }
  const res = await handler(new NextRequest(new URL(path, ctx.req.nextUrl.origin), { headers }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

// ------------------------------------------------------------------ the public guide

const AVAILABILITY_ORDER: Availability[] = ["now", "configuration", "integration", "approval", "unsupported"];

/** What the public guide shows for a selection, said in a language: the same model and the same words as the page. */
export function fitAnswer(selection: Selection, t: T, origin: string): Record<string, unknown> {
  const view = fitView(selection);
  return {
    chosen: [...view.types.map((id) => typeName(t, id)), ...view.selection.activities.map((k) => activityName(t, k))],
    byAvailability: AVAILABILITY_ORDER.filter((a) => view.byAvailability[a].length > 0).map((a) => ({
      availability: a,
      label: t(`fit.avail.${a}`),
      items: view.byAvailability[a].map((l) => {
        const chip = presentChip(t, l);
        return { id: chip.id, title: chip.title, what: chip.blurb, ...(chip.needs ? { needs: chip.needs } : {}), ...(chip.alternative ? { instead: chip.alternative } : {}) };
      }),
    })),
    partialSupport: view.partial.map((a) => ({
      activity: activityName(t, a.key),
      support: t(a.support === "specialised" ? "fit.support.specialised" : "fit.support.basic"),
      ...(a.supportNote ? { noteInEnglish: a.supportNote } : {}),
    })),
    notSupported: {
      forThisChoice: view.limits.relevant.map((c) => {
        const p = presentCapability(t, c);
        return { id: c.id, title: p.title, what: p.blurb, ...(p.alternative ? { instead: p.alternative } : {}) };
      }),
      otherwise: view.limits.others.map((c) => {
        const p = presentCapability(t, c);
        return { id: c.id, title: p.title, ...(p.alternative ? { instead: p.alternative } : {}) };
      }),
    },
    journeys: presentWorkflows(view, t).map((w) => ({ id: w.id, title: w.title, intro: w.intro, steps: w.steps.map((s) => `${s.actor}: ${s.title}`) })),
    ...(view.combined ? { together: view.combinedClaims.map((id) => t(`fit.combined.${id}` as Parameters<T>[0])) } : {}),
    guidePage: `${origin}${guideAddress(view.selection)}`,
    applyLink: `${origin}${applyAddress(view.selection)}`,
  };
}

const guideBusinessTypes: McpTool = {
  name: "guide_business_types",
  title: "Kinds of business MySenam's guide covers",
  description:
    "Lists the 13 kinds of business the public guide 'How MySenam fits your business' covers, each with its id, its name and the activities it usually offers, as the guide's picker shows them. Use the ids with guide_fit.",
  authority: "public",
  marketplaceOnly: true,
  inputSchema: { type: "object", properties: { locale: LOCALES_ARG }, additionalProperties: false },
  annotations: { ...READ_ONLY, title: "Business types" },
  async run(args, ctx) {
    const t = translator(localeOf(args));
    const types = BUSINESS_TYPES.map((b) => ({
      id: b.id,
      name: t(b.titleKey),
      activities: b.activities.map((key) => ({ key, name: activityName(t, key) })),
      page: `${ctx.origin}/for-venues/${b.id}`,
    }));
    return answer(`${types.length} kinds of business. Pass one or more ids to guide_fit to see what MySenam does for them.`, { types });
  },
};

const guideFit: McpTool = {
  name: "guide_fit",
  title: "How MySenam fits a business",
  description:
    "For one or more kinds of business (ids from guide_business_types) and optional activity keys, returns what the public guide shows: each capability labelled available now, available with configuration, requires an external integration, requires the operator's approval, or not currently supported, with what to do instead; activities with partial support and the catalogue's note; the everyday journeys; and the link to apply with this choice. From MySenam's capability register, never verified for a particular venue.",
  authority: "public",
  marketplaceOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      businessTypes: { type: "array", items: { type: "string" }, description: "Business type ids, e.g. badminton-and-pickleball." },
      activities: { type: "array", items: { type: "string" }, description: "Optional activity keys from guide_business_types, e.g. padel." },
      locale: LOCALES_ARG,
    },
    required: ["businessTypes"],
    additionalProperties: false,
  },
  annotations: { ...READ_ONLY, title: "Fit for a business" },
  async run(args, ctx) {
    const t = translator(localeOf(args));
    const askedTypes = optList(args, "businessTypes") ?? [];
    const askedActivities = optList(args, "activities") ?? [];
    // As the guide's address is read: what is not a known choice is left out, never an error.
    const selection: Selection = { types: knownTypes(askedTypes), activities: knownActivities(askedActivities) };
    const ignored = [...askedTypes.filter((x) => !(selection.types as string[]).includes(x)), ...askedActivities.filter((x) => !selection.activities.includes(x))];
    if (selection.types.length === 0 && selection.activities.length === 0)
      return refused("Choose at least one business type or activity that the guide knows: guide_business_types lists them.");
    const data = fitAnswer(selection, t, ctx.origin);
    const sentence = `How MySenam fits ${list(t, data.chosen as string[])}, as the public guide shows it.${ignored.length ? ` Not known to the guide, left out: ${ignored.join(", ")}.` : ""}`;
    return answer(sentence, { ...data, ...(ignored.length ? { ignored } : {}) });
  },
};

// ------------------------------------------------------------------ finding venues

const searchVenues: McpTool = {
  name: "search_venues",
  title: "Search free courts",
  description:
    "Finds live, public venues with a court (or other resource) free for an activity on a date, in a named area or near a point (never the whole country), as the public search does: each result is the cheapest free court at a venue with its start, end and price, how many others are free then, and what its rules ask first. Optional earliest and latest start (HH:MM), length in minutes and sort.",
  authority: "public",
  inputSchema: {
    type: "object",
    properties: {
      activity: { type: "string", description: "Activity key, e.g. badminton, futsal, padel." },
      words: { type: "string", description: "Or words for the activity, as people type them (e.g. 'ping pong')." },
      date: { type: "string", description: "YYYY-MM-DD; today if left out." },
      area: { type: "string", description: "An area as the search lists them, e.g. Petaling Jaya." },
      near: {
        type: "object",
        properties: { lat: { type: "number" }, lng: { type: "number" }, km: { type: "number" } },
        required: ["lat", "lng"],
        description: "Or a point, with a radius in km.",
      },
      from: { type: "string", description: "Earliest start, HH:MM." },
      to: { type: "string", description: "Latest start, HH:MM." },
      minutes: { type: "integer", description: "Length in minutes; 60 if left out." },
      sort: { type: "string", enum: [...SEARCH_SORTS] },
    },
    additionalProperties: false,
  },
  annotations: { ...READ_ONLY, title: "Search" },
  async run(args, ctx) {
    const activity = optString(args, "activity", 60);
    const words = optString(args, "words", 60);
    const date = optDate(args, "date");
    const area = optString(args, "area", 80);
    const near = args.near;
    let point: { lat: number; lng: number; km?: number } | undefined;
    if (near !== undefined && near !== null) {
      if (typeof near !== "object" || Array.isArray(near)) throw new ArgError("near must be { lat, lng, km? }.");
      const n = near as Record<string, unknown>;
      const lat = optNumber(n, "lat", -90, 90);
      const lng = optNumber(n, "lng", -180, 180);
      if (lat === undefined || lng === undefined) throw new ArgError("near must be { lat, lng, km? }.");
      point = { lat, lng, km: optNumber(n, "km", 0.1, 200) };
    }
    if (!activity && !words) throw new ArgError("Name the activity (activity), or describe it (words).");
    // The public search asks where first rather than search a whole country; here it is always asked.
    if (!area && !point) throw new ArgError("Name an area, or give a point near which to search.");
    const q = new URLSearchParams();
    if (activity) q.set("sport", activity);
    else if (words) q.set("q", words);
    if (date) q.set("date", date);
    if (point) {
      q.set("near", `${point.lat},${point.lng}`);
      if (point.km !== undefined) q.set("km", String(point.km));
    } else if (area) q.set("area", area);
    for (const k of ["from", "to"]) {
      const v = optString(args, k, 5);
      if (v) q.set(k, v);
    }
    const minutes = optInt(args, "minutes", 1, 720);
    if (minutes) q.set("minutes", String(minutes));
    const sort = optEnum(args, "sort", SEARCH_SORTS);
    if (sort) q.set("sort", sort);
    const { status, body } = await askPublicRoute(ctx, searchRoute, `/api/search?${q}`);
    if (status !== 200) return refused(String(body.error ?? "The search could not be made."));
    if (body.needsArea) return refused(`Too many courts there to search at once: name an area. Areas: ${(body.areas as string[]).join(", ")}.`);
    const results = (body.results as Record<string, unknown>[]).map((r) => {
      const v = r.venue as { id: number; name: string; area: string; address: string };
      const c = r.court as { id: number; name: string; sport: string };
      return {
        venue: { id: v.id, name: v.name, area: v.area, address: v.address },
        ...(r.distanceKm !== undefined ? { distanceKm: r.distanceKm } : {}),
        court: { id: c.id, name: c.name, sport: c.sport },
        start: clock(r.startMin as number),
        end: clock(r.endMin as number),
        totalPrice: r.totalPrice,
        alsoFree: r.alsoFree,
        pricesVary: r.pricesVary,
        ...(r.needs ? { needs: r.needs } : {}),
        page: `${ctx.origin}/venue/${v.id}`,
      };
    });
    return answer(
      results.length ? `${results.length} free ${results.length === 1 ? "time" : "times"} for ${body.sport} on ${body.date}, as the public search shows them. Prices are for the whole booking.` : `Nothing free for ${body.sport} on ${body.date} there.`,
      { date: body.date, activity: body.sport, minutes: body.minutes, results }
    );
  },
};

/** The venue as somebody signed out may see it on this site, or null where its public page would say it is not there. */
async function shownVenue(ctx: McpContext, venueId: number) {
  const venue = await getVenue(venueId);
  if (!venue || !shows(await storefrontForRequest(ctx.req), venue.id)) return null;
  // Nobody signed in: never the request's cookies (lib/listing.ts).
  if (!(await mayShowVenue(venue.id, { admin: null, userId: null })).show) return null;
  return venue;
}

const venueDetails: McpTool = {
  name: "venue_details",
  title: "A venue's public page",
  description:
    "Returns a live venue's public facts as its page shows them: name, area, address, its phone number, time zone, the activities it offers, opening hours by weekday, facilities, whether it is for its members only, the free-cancellation cutoff, its rating and the page's link. Drafts, suspended and private venues are not found, as on their pages.",
  authority: "public",
  inputSchema: { type: "object", properties: { venueId: { type: "integer" } }, required: ["venueId"], additionalProperties: false },
  annotations: { ...READ_ONLY, title: "Venue" },
  async run(args, ctx) {
    const venue = await shownVenue(ctx, reqInt(args, "venueId"));
    if (!venue) return refused("Venue not found.");
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const data = {
      id: venue.id,
      name: venue.name,
      area: venue.area,
      address: venue.address,
      phone: venue.phone,
      timeZone: venue.timeZone,
      activities: sportsOf(venue.courts),
      hours: weekLines(venue).map((l) => ({
        days: l.from === l.to ? days[l.from] : `${days[l.from]} to ${days[l.to]}`,
        hours: l.hours === "closed" ? "closed" : `${clock(l.hours.open)}–${clock(l.hours.close)}`,
      })),
      facilities: venue.amenities,
      membersOnly: venue.access === "members",
      freeCancellationHoursBefore: venue.cancelCutoffHours,
      rating: await venueRating(venue.id),
      page: `${ctx.origin}/venue/${venue.id}`,
    };
    return answer(`${venue.name}, ${venue.area}: its public page's facts. venue_availability gives a day's courts and prices.`, data);
  },
};

const venueAvailability: McpTool = {
  name: "venue_availability",
  title: "A venue's day",
  description:
    "Returns a live venue's courts for a date as its public page's booking grid shows them to somebody signed out: for each court the lengths its rules take, each time a booking may start with the longest it may run, and the day in columns with each column's price and whether it is free; and a closure that day, if any. Optional activity filter.",
  authority: "public",
  inputSchema: {
    type: "object",
    properties: { venueId: { type: "integer" }, date: { type: "string", description: "YYYY-MM-DD; today if left out." }, activity: { type: "string" } },
    required: ["venueId"],
    additionalProperties: false,
  },
  annotations: { ...READ_ONLY, title: "Venue availability" },
  async run(args, ctx) {
    const venueId = reqInt(args, "venueId");
    const q = new URLSearchParams({ venueId: String(venueId) });
    const date = optDate(args, "date");
    if (date) q.set("date", date);
    const activity = optString(args, "activity", 60);
    if (activity) q.set("sport", activity);
    const { status, body } = await askPublicRoute(ctx, availabilityRoute, `/api/availability?${q}`);
    if (status !== 200) return refused(String(body.error ?? "Venue not found."));
    const courts = (body.availability as Parameters<typeof courtDay>[0][]).map(courtDay);
    return answer(`${courts.length} ${courts.length === 1 ? "court" : "courts"} on ${body.date}, times in the venue's own time (${body.timeZone}).`, {
      date: body.date,
      timeZone: body.timeZone,
      closure: body.closure ?? null,
      courts,
      page: `${ctx.origin}/venue/${venueId}?date=${body.date}`,
    });
  },
};

export const PUBLIC_TOOLS: McpTool[] = [guideBusinessTypes, guideFit, searchVenues, venueDetails, venueAvailability];
