import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { closeRequirement, coachAccounts, requirementsAt, saveRequirement } from "@/lib/approvals";
import { listCoaches } from "@/lib/coaching";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * What a venue asks before approving somebody for an activity online
 * (lib/approvals.ts). `?venueId` → each activity's requirements, the
 * venue's coaches who could be authorised to review (with the account each
 * is linked to, `account`: the email, or null), and its front-desk staff
 * who could be delegated safety decisions (`desk`).
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const coaches = await listCoaches(venueId, { activeOnly: true });
  const accounts = await coachAccounts(venueId);
  const desk = (await getDb().prepare("SELECT id, name FROM admins WHERE venue_id = ? AND role = 'desk' ORDER BY name").all(venueId)) as { id: number; name: string }[];
  return NextResponse.json(
    {
      requirements: await requirementsAt(venueId),
      coaches: coaches.map((c) => ({ id: c.id, name: c.name, sports: c.sports, account: accounts[c.id] ?? null })),
      desk,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * `{ venueId, sport, kind?, intro?, declaration?, documentLabel?, videoUrl?,
 * inPerson?, questions?: [{ text, required? }], waiver?, validDays?,
 * pendingDays?, holdHours?, payHours?, open?, coachIds?, reviewLevel?:
 * "safety" | "administrative", delegateIds? }`: take applications online for
 * an activity, or change what is asked and who may grant it (managers). Recorded.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = Number(body.venueId);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const saved = await saveRequirement(venueId, body);
  if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 400 });
  const r = saved.requirement;
  const methods = [r.declaration && "declaration", r.documentLabel && "documents", r.videoUrl && "video briefing", r.inPerson && "in-person step"].filter(Boolean);
  await logAction(admin, {
    venueId,
    action: "approval.settings",
    detail: `Online applications for ${r.sport}: ${r.open ? "open" : "closed"}; ${methods.join(", ")}; ${r.questions.length} questions; ${
      r.validDays ? `lasting ${r.validDays} days` : "until taken back"
    }; ${r.coachIds.length} coaches may review; ${r.reviewLevel === "safety" ? `a safety assessment (${r.delegateIds.length} front-desk staff delegated)` : "an administrative check"}; ${r.payHours} hours to pay`,
  });
  return NextResponse.json({ requirement: r });
}

/** `?venueId&sport`: no more applications online for it; those already in are still decided (managers). Recorded. */
export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  const sport = req.nextUrl.searchParams.get("sport");
  if (!Number.isInteger(venueId) || venueId <= 0 || !sport) return NextResponse.json({ error: "venueId and sport are required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  if (!(await closeRequirement(venueId, sport))) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await logAction(admin, { venueId, action: "approval.settings", detail: `Online applications for ${sport}: closed` });
  return NextResponse.json({ ok: true });
}
