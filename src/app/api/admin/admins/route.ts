import { NextRequest, NextResponse } from "next/server";
import { createAdmin, isOwner, listAdminsFor, requireAdmin, type Admin } from "@/lib/admin-auth";
import { getVenue } from "@/lib/store";
import { logAction } from "@/lib/activity";
import { readJsonObject } from "@/lib/api";
import type { StaffRole } from "@/lib/roles";
import { chosenStaffLocale } from "@/lib/staff-locales";
import {
  inviteStaff,
  isBranchManager,
  listInvitationsFor,
  managesStaff,
  mayManage,
  staffSignUpOptions,
  typedPasswordAllowed,
} from "@/lib/staff-accounts";

export const dynamic = "force-dynamic";

/**
 * Staff accounts (lib/staff-accounts.ts). The platform owner manages them
 * all; a business manager their own business's; a branch manager their own
 * branch's front desk. Front desk manages none (`MANAGER_ONLY`).
 */
function mayManageStaff(admin: Admin): NextResponse | null {
  if (managesStaff(admin)) return null;
  return NextResponse.json({ error: "Only a manager can do that." }, { status: 403 });
}

/** The accounts the caller sees, the invitations still out, and whether new staff are invited or given a password. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = mayManageStaff(admin);
  if (denied) return denied;
  const admins = await listAdminsFor(admin);
  return NextResponse.json({
    admins: admins.map((a) => ({ ...a, manageable: a.id !== admin.id && mayManage(admin, a) })),
    invitations: (await listInvitationsFor(admin)).map((i) => ({ ...i, manageable: mayManage(admin, i) })),
    ...staffSignUpOptions(),
  });
}

/**
 * `{ name, email, venueId, role }` — staff at that branch; `{ name, email,
 * businessId }` — a manager of that whole business; neither, from the
 * platform owner only — another platform owner. Any of them may carry
 * `locale` (`en`, `ms`, `zh`): their language, which they can change
 * themselves.
 *
 * Without `password`, an invitation is emailed and `{ invitation }` answered;
 * the account is made when it is accepted. With `password` (where the
 * install has no email account to invite with), the account is made now and
 * `{ admin }` answered.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = mayManageStaff(admin);
  if (denied) return denied;

  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const { name, email, password, venueId, businessId, role, locale } = body;

  if (typeof name !== "string" || name.trim().length < 2)
    return NextResponse.json({ error: "Name is required." }, { status: 400 });
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
  const typed = password !== undefined && password !== null && password !== "";
  if (typed && !typedPasswordAllowed())
    return NextResponse.json({ error: "This install sends email: new staff choose their own password from the invitation." }, { status: 400 });
  if (typed && (typeof password !== "string" || password.length < 8))
    return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });

  const hasVenue = venueId !== null && venueId !== undefined;
  const hasBusiness = businessId !== null && businessId !== undefined;
  if (hasVenue && (!Number.isInteger(venueId) || (venueId as number) <= 0))
    return NextResponse.json({ error: "Invalid venueId." }, { status: 400 });
  if (hasBusiness && (!Number.isInteger(businessId) || (businessId as number) <= 0))
    return NextResponse.json({ error: "Invalid businessId." }, { status: 400 });
  if (hasVenue && hasBusiness)
    return NextResponse.json({ error: "Staff work at one branch, or manage the whole business — not both." }, { status: 400 });
  // Their language, where the manager knows it: one of the dashboard's; none given is none chosen.
  if (locale !== undefined && locale !== null && locale !== "" && chosenStaffLocale(locale) === null)
    return NextResponse.json({ error: "The dashboard is not offered in that language." }, { status: 400 });

  // Branch staff are a manager unless made front desk; what a branch manager adds is front desk.
  const staffRole: StaffRole = role === "desk" ? "desk" : role === "manager" ? "manager" : isBranchManager(admin) ? "desk" : "manager";
  const place = {
    venueId: hasVenue ? (venueId as number) : null,
    businessId: hasBusiness ? (businessId as number) : null,
    role: hasVenue ? staffRole : ("manager" as StaffRole),
  };
  if (!isOwner(admin) && !mayManage(admin, place))
    return NextResponse.json(
      {
        error: isBranchManager(admin)
          ? "At your own branch you add, change and remove front-desk staff; a business manager looks after managers."
          : "You can only add staff to your own business.",
      },
      { status: 403 }
    );
  if (hasVenue && !(await getVenue(venueId as number)))
    return NextResponse.json({ error: "Venue not found." }, { status: 404 });

  if (!typed) {
    const invited = await inviteStaff(admin, { name, email, venueId: place.venueId, businessId: place.businessId, role: place.role, locale });
    if (!invited.ok) return NextResponse.json({ error: invited.error }, { status: invited.status });
    return NextResponse.json({ invitation: invited.invitation }, { status: 201 });
  }

  const result = await createAdmin({
    name,
    email,
    password: password as string,
    venueId: place.venueId,
    businessId: place.businessId,
    role: place.role,
    locale,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  await logAction(admin, {
    venueId: place.venueId,
    action: "staff.added",
    detail: `${result.admin.name} (${result.admin.email})${hasVenue ? `, ${result.admin.role === "desk" ? "front desk" : "manager"}` : ", business manager"}`,
  });
  return NextResponse.json({ admin: result.admin }, { status: 201 });
}
