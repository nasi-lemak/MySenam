import { NextRequest, NextResponse } from "next/server";
import { refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { teamHistory } from "@/lib/teams";

export const dynamic = "force-dynamic";

/** What the team has entered and how it went: for its members, and the guardian of a child on it. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid team." }, { status: 400 });
  const history = await teamHistory(user.id, id);
  if (!history.ok) return refusal(history, history.status ?? 404);
  return NextResponse.json({ history: history.value });
}
