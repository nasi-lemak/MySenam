import { NextRequest, NextResponse } from "next/server";
import { requestEInvoice } from "@/lib/myinvois";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * `{ ref, t, name, tin, idType, idNumber, sst?, email, phone, addressLine, city, postcode, stateCode }`
 * → an LHDN e-invoice made out to the customer for this receipt, sent at once
 * (lib/myinvois.ts). The receipt's signed link is the proof they hold it.
 */
export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.ref !== "string" || typeof body.t !== "string")
    return NextResponse.json({ error: "ref and t are required." }, { status: 400 });
  const made = await requestEInvoice(body.ref, body.t, {
    name: body.name,
    tin: body.tin,
    idType: body.idType,
    idNumber: body.idNumber,
    sst: body.sst,
    email: body.email,
    phone: body.phone,
    addressLine: body.addressLine,
    city: body.city,
    postcode: body.postcode,
    stateCode: body.stateCode,
  });
  if (!made.ok) {
    const code = "code" in made ? made.code : undefined;
    return NextResponse.json(
      { error: made.error, code, vars: "vars" in made ? made.vars : undefined },
      { status: code === "EINVOICE_NO_RECEIPT" ? 404 : code ? 409 : 400 }
    );
  }
  return NextResponse.json({ einvoice: made.einvoice });
}
