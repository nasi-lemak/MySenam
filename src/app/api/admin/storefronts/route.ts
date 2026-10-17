import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireOwner } from "@/lib/admin-auth";
import { deleteStorefront, listStorefronts, saveStorefront } from "@/lib/storefront";

export const dynamic = "force-dynamic";

/**
 * Storefronts are the platform owner's to set up: which domain shows which
 * venues is a promise about the marketplace, and the domain has to be pointed
 * at the server before it means anything.
 */
async function owner(req: NextRequest): Promise<NextResponse | null> {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  return requireOwner(admin);
}

export async function GET(req: NextRequest) {
  const denied = await owner(req);
  if (denied) return denied;
  return NextResponse.json({ storefronts: await listStorefronts() });
}

/** Create, or with `id` update: `{ id?, hostname, name, tagline?, accentColor?, logoUrl?, venueIds }` */
export async function POST(req: NextRequest) {
  const denied = await owner(req);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;
  if (typeof input.hostname !== "string" || typeof input.name !== "string")
    return NextResponse.json({ error: "A domain and a name are required." }, { status: 400 });
  if (!Array.isArray(input.venueIds) || input.venueIds.some((v) => !Number.isInteger(v)))
    return NextResponse.json({ error: "venueIds must be a list of venue ids." }, { status: 400 });
  for (const field of ["tagline", "accentColor", "logoUrl"] as const)
    if (input[field] !== undefined && input[field] !== null && typeof input[field] !== "string")
      return NextResponse.json({ error: `${field} must be text.` }, { status: 400 });
  if (input.id !== undefined && !Number.isInteger(input.id))
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });

  const result = await saveStorefront({
    id: input.id as number | undefined,
    hostname: input.hostname,
    name: input.name,
    tagline: input.tagline as string | null | undefined,
    accentColor: input.accentColor as string | null | undefined,
    logoUrl: input.logoUrl as string | null | undefined,
    venueIds: input.venueIds as number[],
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ storefront: result.storefront });
}

/** `?id=` */
export async function DELETE(req: NextRequest) {
  const denied = await owner(req);
  if (denied) return denied;
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  if (!await deleteStorefront(id)) return NextResponse.json({ error: "Storefront not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
