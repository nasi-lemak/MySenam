import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { aiPersonalData, setAiPersonalData } from "@/lib/ai-personal-data";
import { createApiKey, listApiKeys, revokeApiKey } from "@/lib/api-keys";
import { googleReserveOn, setGoogleReserve } from "@/lib/google-feeds";
import { RETENTION } from "@/lib/privacy";
import { MAX_ATTEMPTS, REDELIVER_AT_MOST, addEndpoint, listEndpoints, pingEndpoint, redeliverFailed, removeEndpoint, resumeEndpoint } from "@/lib/webhooks";

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
    keys: await listApiKeys(venueId),
    endpoints: await listEndpoints(venueId),
    // What the failed-deliveries panel says: tries before giving up, days a delivery is kept.
    webhookRetry: { tries: MAX_ATTEMPTS, days: RETENTION.webhookDeliveryDays, most: REDELIVER_AT_MOST },
    google: await googleReserveOn(venueId),
    // Whether AI assistants using the venue's keys through the MCP server see customers' personal data (lib/ai-personal-data.ts).
    aiPersonalData: await aiPersonalData(venueId),
  });
}

/**
 * `{ venueId, action }`: `key` with `name`, `scope` (the key is in the answer,
 * this once); `revoke` with `id`; `webhook` with `url` (its signing secret in
 * the answer, this once); `remove`, `ping` or `resume` with `id`; `redeliver` with
 * `deliveryId` (one failed delivery) or `id` (an address's failed deliveries, at
 * most 50 at once): the same events sent again, audited (docs/integrations/external-api.md#webhooks); `google`
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
      const made = await createApiKey(venueId, { name: body.name, scope: body.scope }, admin.id);
      if (!made.ok) return NextResponse.json({ error: made.error }, { status: 400 });
      await log(`API key made: ${made.record.name} (${made.record.scope})`);
      return NextResponse.json({ key: made.key, record: made.record, keys: await listApiKeys(venueId) });
    }
    case "revoke":
      if (!Number.isInteger(id) || !(await revokeApiKey(id, venueId))) return NextResponse.json({ error: "Key not found." }, { status: 404 });
      await log(`API key revoked: ${id}`);
      return NextResponse.json({ keys: await listApiKeys(venueId) });
    case "webhook": {
      const added = await addEndpoint(venueId, body.url);
      if (!added.ok) return NextResponse.json({ error: added.error }, { status: 400 });
      await log(`Webhook added: ${added.endpoint.url}`);
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
    case "redeliver": {
      const deliveryId = body.deliveryId as number;
      const target = Number.isInteger(deliveryId) ? { deliveryId } : Number.isInteger(id) ? { endpointId: id } : null;
      if (!target) return NextResponse.json({ error: "Say which delivery or address to send again." }, { status: 400 });
      const again = await redeliverFailed(venueId, target);
      if (!again.ok)
        return again.reason === "NOT_FOUND"
          ? NextResponse.json({ error: "That delivery was not found for this venue." }, { status: 404 })
          : NextResponse.json({ error: "Turn the address back on before sending an event again." }, { status: 409 });
      // Every press is logged, with how many were sent again (none: it was already waiting or delivered).
      await log(`Webhook events sent again: ${"deliveryId" in target ? `delivery ${target.deliveryId}` : `address ${target.endpointId}`}, ${again.requeued} queued`);
      return NextResponse.json({ requeued: again.requeued, endpoints: await listEndpoints(venueId) });
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
