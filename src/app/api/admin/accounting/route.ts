import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { readJsonObject } from "@/lib/api";
import {
  beginConnect,
  connectionView,
  disconnect,
  enqueueNew,
  loadChart,
  loadMapping,
  previewStart,
  pushDue,
  queueView,
  reconcile,
  refreshChart,
  retry,
  saveMapping,
  startFrom,
  taxKeysInUse,
  ACCOUNT_KEYS,
  OWED_KEYS,
  PAYMENT_KEYS,
} from "@/lib/accounting-push";

export const dynamic = "force-dynamic";

/**
 * `?venueId=` → the venue's live accounting: the connection (never a token), the mapping and the organisation's accounts and
 * tax rates last read, the queue (counts, what is held for mapping, what failed). With `&reconcile=1&from=&to=`, also the
 * venue's totals against what was sent. Manager-only, like all of this route (lib/roles.ts).
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const p = req.nextUrl.searchParams;
  const venueId = Number(p.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const connection = await connectionView(venueId);
  const reconciliation =
    p.get("reconcile") === "1" && connection.status !== "not_connected" ? await reconcile(venueId, p.get("from") ?? "", p.get("to") ?? "") : null;
  if (reconciliation && !reconciliation.ok) return NextResponse.json({ error: reconciliation.error }, { status: 400 });
  return NextResponse.json(
    {
      connection,
      mapping: await loadMapping(venueId),
      chart: await loadChart(venueId),
      keys: { account: ACCOUNT_KEYS, owed: OWED_KEYS, payment: PAYMENT_KEYS, tax: await taxKeysInUse(venueId) },
      queue: await queueView(venueId),
      ...(reconciliation?.ok ? { reconciliation: reconciliation.report } : {}),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * `{ venueId, action }`:
 * - `connect` with `acknowledged: true` and the `noticeVersion` read: the address to send the manager to at Xero (the
 *   venue's acknowledgement of what is sent is recorded when the sign-in is begun and kept with the connection);
 * - `disconnect`: the access is given back to Xero and deleted here;
 * - `chart`: read the organisation's accounts and tax rates again;
 * - `mapping` with `account`, `tax`, `payment` (code per key; an empty code removes one);
 * - `send_now`: read the journal for new sales and send what is due, now rather than at the next tick;
 * - `retry` with an `id` (or none, for every failed one);
 * - `preview_start` with `from`: how many documents and what total would be queued;
 * - `start` with `from` and the preview's `count` and `totalCents`: queue everything from that day.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  if (!Number.isInteger(body.venueId)) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const venueId = body.venueId as number;
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const refuse = (error: string, status = 409) => NextResponse.json({ error }, { status });

  switch (body.action) {
    case "connect": {
      const begun = await beginConnect(venueId, { id: admin.id, name: admin.name }, { acknowledged: body.acknowledged, noticeVersion: body.noticeVersion });
      if (!begun.ok) return refuse(begun.error, 400);
      // Logged again when it is finished (the callback): beginning is not connecting.
      await logAction(admin, { venueId, action: "accounting.connect_started", detail: "Xero" });
      return NextResponse.json({ url: begun.url });
    }
    case "disconnect": {
      const done = await disconnect(venueId);
      if (!done.ok) return refuse(done.error);
      await logAction(admin, { venueId, action: "accounting.disconnected", detail: done.revoked ? "Xero, access revoked" : "Xero, Xero could not be reached to revoke" });
      return NextResponse.json({ revoked: done.revoked, connection: await connectionView(venueId) });
    }
    case "chart": {
      const read = await refreshChart(venueId);
      if (!read.ok) return refuse(read.error);
      return NextResponse.json({ chart: read.chart });
    }
    case "mapping": {
      const saved = await saveMapping(venueId, body);
      if (!saved.ok) return refuse(saved.error, 400);
      await logAction(admin, {
        venueId,
        action: "accounting.mapping",
        detail: `${Object.keys(saved.mapping.account).length} accounts, ${Object.keys(saved.mapping.tax).length} tax types, ${Object.keys(saved.mapping.payment).length} payment accounts`,
      });
      return NextResponse.json({ mapping: saved.mapping, queue: await queueView(venueId) });
    }
    case "send_now": {
      if ((await connectionView(venueId)).status !== "connected") return refuse("Connect the venue's Xero organisation first.");
      const added = await enqueueNew(venueId, new Date(), true);
      const sent = await pushDue(venueId);
      await logAction(admin, { venueId, action: "accounting.send_now", detail: `${added} new, ${sent.sent ?? 0} sent` });
      return NextResponse.json({ added, sent: sent.sent ?? 0, idle: sent.idle ?? null, queue: await queueView(venueId), connection: await connectionView(venueId) });
    }
    case "retry": {
      const id = body.id === undefined ? null : Number.isInteger(body.id) ? (body.id as number) : NaN;
      if (id !== null && Number.isNaN(id)) return refuse("id must be a number.", 400);
      const done = await retry(venueId, id);
      if (!done.ok) return refuse(done.error);
      await logAction(admin, { venueId, action: "accounting.retried", detail: id === null ? `${done.count} failed, sent again` : "one sale, sent again" });
      return NextResponse.json({ count: done.count, queue: await queueView(venueId) });
    }
    case "preview_start": {
      const preview = await previewStart(venueId, body.from);
      return preview.ok ? NextResponse.json({ preview: preview.preview }) : refuse(preview.error, 400);
    }
    case "start": {
      const started = await startFrom(venueId, body.from, { count: body.count, totalCents: body.totalCents });
      if (!started.ok) return refuse(started.error, 409);
      await logAction(admin, { venueId, action: "accounting.start", detail: `from ${String(body.from)}: ${started.added} queued` });
      return NextResponse.json({ added: started.added, queue: await queueView(venueId), connection: await connectionView(venueId) });
    }
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
}
