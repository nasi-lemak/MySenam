import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { submitApplication } from "@/lib/applications";
import { isMarketplace } from "@/lib/mode";

export const dynamic = "force-dynamic";

/** A venue asking to join. Only a marketplace takes them. */
export async function POST(req: NextRequest) {
  if (!isMarketplace()) return NextResponse.json({ error: "Not found." }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;
  const fields = ["businessName", "area", "address", "venuePhone", "contactName", "email", "password"] as const;
  for (const f of fields)
    if (typeof input[f] !== "string")
      return NextResponse.json({ error: "Please fill in every field." }, { status: 400 });
  if (input.message !== undefined && typeof input.message !== "string")
    return NextResponse.json({ error: "The message must be text." }, { status: 400 });
  // A field no person sees: a form that fills it in is a script.
  if (typeof input.website === "string" && input.website !== "")
    return NextResponse.json({ ok: true, emailSent: true }, { status: 201 });

  const limited = rateLimit(req, "register");
  if (limited) return limited;

  const result = await submitApplication({
    businessName: input.businessName as string,
    area: input.area as string,
    address: input.address as string,
    venuePhone: input.venuePhone as string,
    contactName: input.contactName as string,
    email: input.email as string,
    password: input.password as string,
    message: input.message as string | undefined,
    lat: input.lat,
    lng: input.lng,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  // Whether to tell them to look for a link in their email.
  return NextResponse.json({ ok: true, emailSent: result.emailSent }, { status: 201 });
}
