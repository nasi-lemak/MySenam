import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { guideVenue, ownRole } from "@/lib/guide/http";
import { isTopicId, topicWrittenFor } from "@/lib/guide/help";
import { linkFor } from "@/lib/guide/playbook/dsl";
import { buildTopic } from "@/lib/guide/playbook/topics";
import { readVenueProfile } from "@/lib/guide/profile";

export const dynamic = "force-dynamic";

/**
 * One explanation of the operating playbook, for the "?" beside a control
 * (`?venueId=&id=`; docs/features/venue-guide.md#contextual-help-and-discovery):
 * the topic `id` written from the venue's saved settings, for the caller's OWN
 * role (`manager` or `desk`, from the session; there is no parameter to ask for
 * another's). A screen reads it only when its tip is opened, so a screen pays
 * nothing for the tips it carries.
 *
 * Every staff role may read it, the front desk included (each its own version);
 * the tenant is checked as for every guide route (403 for a venue the caller
 * may not manage, 400 for none named). 404 for a topic that does not exist or
 * is not written for the caller's role. The answer is `{ venueId, role, topic,
 * guide }`: `topic` is typed content (phrases and values, not English), `guide`
 * the link "Open this in the guide" or null where the role may not open it. It
 * is `no-store` and kept nowhere.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = guideVenue(admin, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  const id = req.nextUrl.searchParams.get("id");
  const role = ownRole(admin);
  if (!isTopicId(id) || !topicWrittenFor(id, role)) return NextResponse.json({ error: "There is no help for that." }, { status: 404 });
  const topic = buildTopic(id, await readVenueProfile(venueId), role);
  if (!topic) return NextResponse.json({ error: "There is no help for that." }, { status: 404 });
  return NextResponse.json({ venueId, role, topic, guide: linkFor(role, "guide", undefined, "playbook") ?? null }, { headers: { "Cache-Control": "no-store" } });
}
