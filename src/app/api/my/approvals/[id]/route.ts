import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { customerAct, readSubmission, refusalBody } from "@/lib/approvals";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * The customer's own application: `{ action: "answer", answer }` (with
 * `document` files as a form upload, where the venue asks for one) answers a
 * reviewer's question; `{ action: "withdraw" }`; `{ action: "slot", slot: {
 * courtId, date, start, end } }` asks for a slot (held while it is reviewed;
 * booked at once as the in-person session once the online part is accepted).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "booking", "approval");
  if (limited) return limited;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Application not found." }, { status: 404 });
  const read = await readSubmission(req);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.status });
  const action = read.body.action;
  if (action !== "answer" && action !== "withdraw" && action !== "slot")
    return NextResponse.json({ error: "action is answer, withdraw or slot." }, { status: 400 });
  const done = await customerAct(user, id, action, { answer: read.body.answer, slot: read.body.slot }, read.files);
  if (!done.ok) return NextResponse.json(refusalBody(done), { status: done.status });
  return NextResponse.json({ request: done.request, bookingCode: done.booking?.code ?? null });
}
