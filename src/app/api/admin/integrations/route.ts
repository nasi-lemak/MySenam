import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { aiPersonalData, setAiPersonalData } from "@/lib/ai-personal-data";
import { createApiKey, listApiKeys, reassignApiKey, revokeApiKey, rotateApiKey } from "@/lib/api-keys";
import { googleReserveOn, setGoogleReserve } from "@/lib/google-feeds";
import { addEndpoint, listEndpoints, pingEndpoint, reassignEndpoint, removeEndpoint, resumeEndpoint, rotateEndpointSecret } from "@/lib/webhooks";

export const dynamic = "force-dynamic";

/** `?venueId=` → the venue's API keys (never the keys themselves), webhook addresses and recent deliveries. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({
    // Whose account is asking, so the screen can offer "take it over" for what is the venue's.
    me: admin.id,
    keys: await listApiKeys(venueId),
    endpoints: await listEndpoints(venueId),
    google: await googleReserveOn(venueId),
    // Whether AI assistants using the venue's keys through the MCP server see customers' personal data (lib/ai-personal-data.ts).
    aiPersonalData: await aiPersonalData(venueId),
  });
}

/**
 * `{ venueId, action }`: `key` with `name`, `scope` and `ownership` (`venue`, or
 * the maker's own, the default; the key is in the answer, this once); `revoke`
 * with `id`; `webhook` with `url` and `ownership` (its signing secret in the
 * answer, this once); `remove`, `ping` or `resume` with `id`; `handOver` with
 * `kind` (`key` or `webhook`), `id` and `to` (`venue`, or a manager's account
 * id); `rotate` with `kind` and `id` (a new key, or a new signing secret, in
 * the answer this once, the old one dead at once: ADR 0064); `google`
 * with `on`; `aiPersonalData` with `on` (true or false): whether AI assistants
 * using the venue's keys through the MCP server see customers' names, phone
 * numbers and emails, recorded with who and when (managers only, as all of
 * this; the screen warns first).
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Number.isInteger(body.venueId)) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const venueId = body.venueId as number;
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const id = body.id as number;
  const log = (detail: string) => logAction(admin, { venueId, action: "integration.changed", detail });
  switch (body.action) {
    case "key": {
      const made = await createApiKey(venueId, { name: body.name, scope: body.scope, ownership: body.ownership }, admin.id);
      if (!made.ok) return NextResponse.json({ error: made.error }, { status: 400 });
      await log(`API key made: ${made.record.name} (${made.record.scope}), ${made.record.ownership === "venue" ? "the venue's" : `${admin.name}'s`}`);
      return NextResponse.json({ key: made.key, record: made.record, keys: await listApiKeys(venueId) });
    }
    case "revoke":
      if (!Number.isInteger(id) || !(await revokeApiKey(id, venueId))) return NextResponse.json({ error: "Key not found." }, { status: 404 });
      await log(`API key revoked: ${id}`);
      return NextResponse.json({ keys: await listApiKeys(venueId) });
    case "webhook": {
      const added = await addEndpoint(venueId, body.url, { adminId: admin.id, ownership: body.ownership });
      if (!added.ok) return NextResponse.json({ error: added.error }, { status: 400 });
      await log(`Webhook added: ${added.endpoint.url}, ${added.endpoint.ownership === "venue" ? "the venue's" : `${admin.name}'s`}`);
      return NextResponse.json({ secret: added.secret, endpoints: await listEndpoints(venueId) });
    }
    case "remove":
    case "ping":
    case "resume": {
      const done =
        Number.isInteger(id) &&
        (body.action === "remove" ? await removeEndpoint(id, venueId) : body.action === "ping" ? await pingEndpoint(id, venueId) : await resumeEndpoint(id, venueId));
      if (!done) return NextResponse.json({ error: "Address not found, or turned off." }, { status: 404 });
      if (body.action !== "ping") await log(`Webhook ${body.action === "remove" ? "removed" : "turned back on"}: ${id}`);
      return NextResponse.json({ endpoints: await listEndpoints(venueId) });
    }
    case "handOver": {
      const to = body.to === "venue" ? "venue" : Number.isInteger(body.to) ? (body.to as number) : null;
      if ((body.kind !== "key" && body.kind !== "webhook") || !Number.isInteger(id) || to === null)
        return NextResponse.json({ error: "Say kind (key or webhook), id, and to (venue, or a manager's account id)." }, { status: 400 });
      const done = body.kind === "key" ? await reassignApiKey(id, venueId, to, admin) : await reassignEndpoint(id, venueId, to, admin);
      if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
      await log(done.detail);
      return NextResponse.json({ keys: await listApiKeys(venueId), endpoints: await listEndpoints(venueId) });
    }
    case "rotate": {
      if ((body.kind !== "key" && body.kind !== "webhook") || !Number.isInteger(id)) return NextResponse.json({ error: "Say kind (key or webhook) and id." }, { status: 400 });
      if (body.kind === "key") {
        const done = await rotateApiKey(id, venueId, admin);
        if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
        await log(done.detail);
        return NextResponse.json({ key: done.key, record: done.record, keys: await listApiKeys(venueId) });
      }
      const done = await rotateEndpointSecret(id, venueId, admin);
      if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
      await log(done.detail);
      return NextResponse.json({ secret: done.secret, endpoints: await listEndpoints(venueId) });
    }
    case "google":
      await setGoogleReserve(venueId, body.on === true);
      await log(`Reserve with Google feeds: ${body.on === true ? "in" : "out"}`);
      return NextResponse.json({ google: await googleReserveOn(venueId) });
    case "aiPersonalData": {
      if (typeof body.on !== "boolean") return NextResponse.json({ error: "Say on: true or on: false." }, { status: 400 });
      const now = await setAiPersonalData(venueId, body.on, admin);
      await logAction(admin, { venueId, action: "integration.ai_personal_data", detail: `Customers' personal data shown to AI assistants (MCP): ${body.on ? "on" : "off"}` });
      return NextResponse.json({ aiPersonalData: now });
    }
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
}
