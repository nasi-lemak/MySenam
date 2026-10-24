import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { region } from "@/lib/region";
import { setVenueTax, venueTax } from "@/lib/tax";
import { approveDeductionTreatments, deductionHistory, deductionReview, deductionTreatments, setDeductionTreatments } from "@/lib/deposit-deductions";
import { logFromRequest } from "@/lib/activity";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? { admin, venueId };
}

/**
 * `?venueId` → the venue's own tax, the country's usual one to start from, which reasons for keeping a hire
 * deposit carry it and on what footing (provisional, the venue's own, reviewed), the review if any, and the record
 * of changes.
 */
export async function GET(req: NextRequest) {
  const found = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (found instanceof NextResponse) return found;
  const { venueId } = found;
  return NextResponse.json({
    tax: await venueTax(venueId),
    usual: region().tax,
    deductions: await deductionTreatments(venueId),
    deductionReview: await deductionReview(venueId),
    deductionHistory: await deductionHistory(venueId),
  });
}

/**
 * `{ venueId, registered, name, rate, regNo }`; `{ venueId, deductions: { reason: true | false | null } }` for which
 * reasons for keeping a hire deposit carry the tax (null: the country's usual), which needs reviewing again; or
 * `{ venueId, approveDeductions: { reviewer } }` to record that the treatments as they stand were reviewed by the
 * adviser named. Managers only (lib/roles.ts).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const found = await venueOf(req, body.venueId);
  if (found instanceof NextResponse) return found;
  const { admin, venueId } = found;
  if (body.approveDeductions !== undefined) {
    const reviewer = String((body.approveDeductions as Record<string, unknown> | null)?.reviewer ?? "");
    const approved = await approveDeductionTreatments(venueId, reviewer, admin);
    if (!approved.ok) return NextResponse.json(approved, { status: 400 });
    await logFromRequest(req, { venueId, action: "settings.changed", detail: `Hire deposit deduction tax reviewed by ${approved.review.reviewer}` });
    return NextResponse.json({ deductions: await deductionTreatments(venueId), deductionReview: approved.review, deductionHistory: await deductionHistory(venueId) });
  }
  if (body.deductions !== undefined) {
    if (!body.deductions || typeof body.deductions !== "object" || Array.isArray(body.deductions))
      return NextResponse.json({ error: "deductions is { reason: true | false | null }." }, { status: 400 });
    const set = await setDeductionTreatments(venueId, body.deductions as Record<string, unknown>, admin);
    if (!set.ok) return NextResponse.json(set, { status: 400 });
    await logFromRequest(req, {
      venueId,
      action: "settings.changed",
      detail: `Hire deposit deductions taxed: ${set.treatments.filter((t) => t.taxed).map((t) => t.reason).join(", ") || "none"} (needs review)`,
    });
    return NextResponse.json({ deductions: set.treatments, deductionReview: null, deductionHistory: await deductionHistory(venueId) });
  }
  const result = await setVenueTax(venueId, { registered: body.registered, name: body.name, rate: body.rate, regNo: body.regNo });
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  await logFromRequest(req, {
    venueId,
    action: "settings.changed",
    detail: result.tax.registered ? `${result.tax.name}: ${result.tax.rate}%, no. ${result.tax.regNo}` : "Not registered for tax",
  });
  return NextResponse.json({ tax: result.tax });
}
