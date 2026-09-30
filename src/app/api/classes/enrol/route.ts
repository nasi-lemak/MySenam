import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { enrolInClass, getClass, payBookingFromWallet } from "@/lib/store";
import { currentLocale } from "@/lib/locale";
import { notifyClassEnrolled, tickOutbox } from "@/lib/notify";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { classId, name, phone, email, payFromWallet } = (body ?? {}) as Record<
    string,
    unknown
  >;

  if (!Number.isInteger(classId) || (classId as number) <= 0)
    return NextResponse.json({ error: "classId is required." }, { status: 400 });
  if (typeof name !== "string" || name.trim().length < 2)
    return NextResponse.json({ error: "Please provide your name." }, { status: 400 });
  if (typeof phone !== "string" || !/^\+?[0-9 -]{7,20}$/.test(phone.trim()))
    return NextResponse.json({ error: "Please provide a valid phone number." }, { status: 400 });
  if (email !== undefined && email !== null && email !== "" &&
      (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
    return NextResponse.json({ error: "Please provide a valid email address." }, { status: 400 });

  const limited = rateLimit(req, "booking");
  if (limited) return limited;

  const user = getSessionUser(req);
  const result = enrolInClass({
    classId: classId as number,
    name: name.trim(),
    phone: phone.trim(),
    email: typeof email === "string" && email !== "" ? email.trim() : undefined,
    userId: user?.id,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });

  let walletError: string | null = null;
  if (payFromWallet === true && user) {
    const paid = payBookingFromWallet(result.booking.id);
    if (paid.ok) result.booking.paymentStatus = "paid";
    else walletError = paid.error;
  }

  const session = getClass(classId as number);
  if (session)
    notifyClassEnrolled(result.booking, await currentLocale(), session);
  await tickOutbox();

  return NextResponse.json({ booking: result.booking, session, walletError }, { status: 201 });
}
