import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import {
  checkSubmitted,
  consolidate,
  einvoiceSettings,
  listEInvoices,
  lastMonthAt,
  recheckEInvoice,
  recordFromPortal,
  retryEInvoice,
  saveEInvoiceSettings,
  submitPending,
  testEInvoiceConnection,
} from "@/lib/myinvois";

export const dynamic = "force-dynamic";

/** `?venueId=` → the venue's MyInvois settings and its recent e-invoices (lib/myinvois.ts). */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({ settings: await einvoiceSettings(venueId), einvoices: await listEInvoices(venueId) });
}

/**
 * `{ venueId, action }`:
 * - `save` with the settings' fields;
 * - `test`: sign in to MyInvois with them;
 * - `consolidate`: send last month now, rather than waiting for the scheduler;
 * - `retry` with `id`: one never sent, sent as it is; one LHDN refused,
 *   found invalid or reported cancelled, a new document sent in its place
 *   (the one refused stays as it was sent); one whose outcome at LHDN is
 *   unknown (it may have arrived) only with `notAtLhdn: true`, the manager's
 *   word that they checked the MyInvois portal and LHDN does not have it,
 *   which is logged and kept in the document's history, never otherwise;
 * - `record` with `id` and `submissionUid` and/or `documentUuid`: for one
 *   whose outcome is unknown, record what the MyInvois portal shows LHDN
 *   holds, once LHDN confirms the document under it is this one;
 * - `recheck` with `id`: ask LHDN where one it accepted stands now (a
 *   cancellation made in the MyInvois portal);
 * - `check`: ask LHDN about those sent and not yet decided.
 *
 * Each e-invoice in the list says which of `retry`, `record` and `recheck`
 * it takes (`actions`); anything else is refused. Manager-only, like all of
 * this route (lib/roles.ts).
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Number.isInteger(body.venueId)) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const venueId = body.venueId as number;
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  switch (body.action) {
    case "save": {
      const saved = await saveEInvoiceSettings(venueId, body);
      if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 400 });
      await logAction(admin, {
        venueId,
        action: "einvoice.settings",
        detail: `${saved.settings.enabled ? "On" : "Off"}, ${saved.settings.sandbox ? "sandbox" : "production"}, ${saved.settings.mode === "own" ? "own credentials" : "through the platform"}${
          saved.settings.enabled && body.acknowledgeStoredValue === true && (saved.settings.storedValueSales.credit || saved.settings.storedValueSales.vouchers)
            ? "; the manager acknowledged that stored credit or vouchers have been sold and their e-invoicing is unsettled (audit C2)"
            : ""
        }`,
      });
      return NextResponse.json({ settings: saved.settings });
    }
    case "test": {
      const tested = await testEInvoiceConnection(venueId);
      return tested.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: tested.error }, { status: 400 });
    }
    case "consolidate": {
      const settings = await einvoiceSettings(venueId);
      if (!settings.enabled) return NextResponse.json({ error: "Turn e-invoicing on first." }, { status: 409 });
      const period = await lastMonthAt(venueId);
      const made = await consolidate(venueId, period);
      await submitPending(venueId);
      await logAction(admin, { venueId, action: "einvoice.consolidated", detail: `${period}: ${made.length} document${made.length === 1 ? "" : "s"}` });
      return NextResponse.json({ period, made: made.length, einvoices: await listEInvoices(venueId) });
    }
    case "retry": {
      if (!Number.isInteger(body.id)) return NextResponse.json({ error: "id is required." }, { status: 400 });
      const sent = await retryEInvoice(body.id as number, venueId, { notAtLhdn: body.notAtLhdn === true, by: { id: admin.id, name: admin.name } });
      if (!sent.ok) return NextResponse.json({ error: sent.error }, { status: 409 });
      const code = sent.einvoice.codeNumber;
      await logAction(admin, {
        venueId,
        action: sent.confirmedNotAtLhdn ? "einvoice.not_at_lhdn" : "einvoice.retried",
        detail: code === sent.from ? code : `${sent.from} → ${code}`,
      });
      return NextResponse.json({ einvoice: sent.einvoice });
    }
    case "record": {
      if (!Number.isInteger(body.id)) return NextResponse.json({ error: "id is required." }, { status: 400 });
      const recorded = await recordFromPortal(body.id as number, venueId, { submissionUid: body.submissionUid, documentUuid: body.documentUuid }, { id: admin.id, name: admin.name });
      if (!recorded.ok) return NextResponse.json({ error: recorded.error }, { status: 409 });
      await logAction(admin, { venueId, action: "einvoice.recorded", detail: recorded.einvoice.codeNumber });
      return NextResponse.json({ einvoice: recorded.einvoice });
    }
    case "recheck": {
      if (!Number.isInteger(body.id)) return NextResponse.json({ error: "id is required." }, { status: 400 });
      const checked = await recheckEInvoice(body.id as number, venueId);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 409 });
      return NextResponse.json({ einvoice: checked.einvoice });
    }
    case "check": {
      await checkSubmitted(venueId);
      return NextResponse.json({ einvoices: await listEInvoices(venueId) });
    }
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
}
