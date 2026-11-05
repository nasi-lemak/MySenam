import { NextRequest, NextResponse } from "next/server";
import { readMinute } from "@/lib/api";
import { formatMinute, isMinute } from "@/lib/interval";
import { denyVenue, isOwner, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { ALERT_EVERY, crossed, upcomingClassSessions, VENUE_CAPS } from "@/lib/limits";
import { tellOwnersEach } from "@/lib/owner-alerts";
import { createClassSessions, getCourt, getVenue, listClasses, listClassWaitlist } from "@/lib/store";
import { isValidDateString } from "@/lib/time";
import { MAX_CLASS_WEEKS } from "@/lib/types";
import { money, isAmount } from "@/lib/region";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const venueParam = req.nextUrl.searchParams.get("venueId");
  const venueId = venueParam ? Number(venueParam) : undefined;
  if (venueId !== undefined) {
    const denied = denyVenue(admin, venueId);
    if (denied) return denied;
  }
  // No venue named: every venue this admin manages (all of them, for the owner).
  const classes = await listClasses({
    venueId,
    venueIds: venueId === undefined ? (admin.venueIds ?? undefined) : undefined,
    includeCancelled: true,
  });
  // Queue length per class, so the list can flag demand at a glance.
  const waiting: Record<number, number> = {};
  for (const session of classes) {
    const queue = (await listClassWaitlist(session.id)).length;
    if (queue > 0) waiting[session.id] = queue;
  }
  return NextResponse.json({ classes, waiting });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { courtId, name, instructor, date, capacity, price, weeks, who, termOffPercent } = (body ?? {}) as Record<string, unknown>;
  // Its time: start and end in minutes of the day or HH:MM (startHour and endHour, the older form).
  const start = readMinute((body ?? {}) as Record<string, unknown>, "start", "startHour");
  const end = readMinute((body ?? {}) as Record<string, unknown>, "end", "endHour");

  if (!Number.isInteger(courtId) || (courtId as number) <= 0)
    return NextResponse.json({ error: "courtId is required." }, { status: 400 });
  const court = await getCourt(courtId as number);
  if (!court) return NextResponse.json({ error: "Court not found." }, { status: 404 });
  const denied = denyVenue(admin, court.venueId);
  if (denied) return denied;

  if (typeof name !== "string" || name.trim().length < 2)
    return NextResponse.json({ error: "Class name is required." }, { status: 400 });
  if (typeof instructor !== "string" || instructor.trim().length < 2)
    return NextResponse.json({ error: "Instructor name is required." }, { status: 400 });
  if (typeof date !== "string" || !isValidDateString(date))
    return NextResponse.json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });
  if (!isMinute(start) || !isMinute(end) || end <= start)
    return NextResponse.json({ error: "start and end must be minutes of the day or HH:MM, the end after the start." }, { status: 400 });
  if (!Number.isInteger(capacity) || (capacity as number) < 1)
    return NextResponse.json({ error: "Capacity must be at least 1." }, { status: 400 });
  if (!isAmount(price))
    return NextResponse.json({ error: `Price must be ${money(0)} or more.` }, { status: 400 });
  if (weeks !== undefined &&
      (!Number.isInteger(weeks) || (weeks as number) < 1 || (weeks as number) > MAX_CLASS_WEEKS))
    return NextResponse.json(
      { error: `weeks must be between 1 and ${MAX_CLASS_WEEKS}.` },
      { status: 400 }
    );

  // A venue's own staff can keep so many sessions in the diary; past that,
  // the platform owner adds them.
  const before = await upcomingClassSessions(court.venueId);
  const adding = (weeks as number) ?? 1;
  if (!isOwner(admin) && before + adding > VENUE_CAPS.upcomingClassSessions)
    return NextResponse.json(
      {
        error: `A venue can have up to ${VENUE_CAPS.upcomingClassSessions} upcoming class sessions; it has ${before}. Ask the platform for more.`,
      },
      { status: 409 }
    );

  const result = await createClassSessions({
    courtId: courtId as number,
    name: name as string,
    instructor: instructor as string,
    date,
    start,
    end,
    capacity: capacity as number,
    price: price as number,
    weeks: (weeks as number) ?? 1,
    who: who === "women" || who === "men" ? who : "anyone",
    termOffPercent: termOffPercent === undefined || termOffPercent === null || termOffPercent === "" ? null : Number(termOffPercent),
  });
  if (!result.ok) return NextResponse.json({ error: result.error, ...(result.code ? { code: result.code, ...(result.vars ? { vars: result.vars } : {}) } : {}) }, { status: 409 });
  await logAction(admin, {
    venueId: court.venueId,
    action: "class.scheduled",
    detail: `${(name as string).trim()} with ${(instructor as string).trim()}, ${court.name}, ${date} ${formatMinute(start)}–${formatMinute(end)}, ${capacity as number} places at ${money(price as number)}${
      result.seriesCode ? `, weekly for ${result.classes.length} weeks (${result.seriesCode})` : ""
    }`,
  });
  const after = before + result.classes.length;
  if (!isOwner(admin) && crossed(before, after, ALERT_EVERY.upcomingClassSessions)) {
    const venue = await getVenue(court.venueId);
    await tellOwnersEach((t) => ({
      subject: t("r9d.classes.s", { venue: venue?.name ?? t("r9d.aVenue"), n: after }),
      body: t("r9d.classes.b", { email: admin.email, venue: venue?.name ?? t("r9d.venueNo", { id: court.venueId }), n: after }),
    }));
  }
  return NextResponse.json(
    { classes: result.classes, seriesCode: result.seriesCode },
    { status: 201 }
  );
}
