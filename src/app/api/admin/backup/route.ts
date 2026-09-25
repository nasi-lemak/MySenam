import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireOwner } from "@/lib/admin-auth";
import { backupDir, createBackup, hoursSinceLastBackup, listBackups } from "@/lib/backup";
import { databaseFile } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Backups are whole-database, so they are the platform owner's business
 * rather than a venue operator's: one venue's staff have no reason to hold a
 * copy of every other venue's bookings.
 */
export function GET(req: NextRequest) {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;

  return NextResponse.json(
    {
      backups: listBackups(),
      directory: backupDir(),
      database: databaseFile(),
      hoursSinceLast: hoursSinceLastBackup(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/** Take one now — before a risky change, or because the schedule has not run. */
export async function POST(req: NextRequest) {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;

  const result = createBackup();
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({
    file: result.file,
    bookings: result.bookings,
    pruned: result.pruned,
  });
}
