import { getDb } from "./db";

/**
 * Whether an AI assistant using one of the venue's API keys through the MCP
 * server (lib/mcp, docs/integrations/mcp.md) is shown customers' names, phone
 * numbers and email addresses (migration 0262). Off by default: bookings then
 * read as their times, court, status, price, payment status and code only.
 *
 * Only a manager switches it (`/api/admin/integrations` is manager-only,
 * lib/roles.ts), after a warning that the assistant's provider may process the
 * data outside the country and that the venue answers for that choice. Who
 * changed it and when is kept here and in the staff activity log. Nothing here
 * says the choice is lawful: that is the venue's to decide with its adviser.
 * The public API (`/api/v1`) is not affected: a venue's own systems see what
 * they always saw.
 */

export interface AiPersonalData {
  on: boolean;
  /** When it was last switched, and by whom (the staff member's name as it was); null if never. */
  changedAt: string | null;
  changedBy: string | null;
}

export async function aiPersonalData(venueId: number): Promise<AiPersonalData> {
  const row = (await getDb()
    .prepare("SELECT ai_personal_data, ai_personal_data_changed_at, ai_personal_data_changed_by FROM venues WHERE id = ?")
    .get(venueId)) as { ai_personal_data: boolean | number | null; ai_personal_data_changed_at: string | null; ai_personal_data_changed_by: string | null } | undefined;
  return {
    on: row?.ai_personal_data === true || row?.ai_personal_data === 1,
    changedAt: row?.ai_personal_data_changed_at ?? null,
    changedBy: row?.ai_personal_data_changed_by ?? null,
  };
}

/** Switch it, recording who and when. The caller checks the role and writes the activity log. */
export async function setAiPersonalData(venueId: number, on: boolean, by: { name: string }): Promise<AiPersonalData> {
  await getDb()
    .prepare("UPDATE venues SET ai_personal_data = ?, ai_personal_data_changed_at = datetime('now'), ai_personal_data_changed_by = ? WHERE id = ?")
    .run(on, by.name.slice(0, 120), venueId);
  return aiPersonalData(venueId);
}

/** The fields of a booking (as the API gives it, lib/api-keys.ts `apiBooking`) that say who a customer is. */
export const PERSONAL_FIELDS = ["name", "phone", "email"] as const;

/**
 * A booking as the MCP server gives it: with the setting off, without the
 * customer's name, phone and email, and without who takes part (participants
 * are named people); everything else as the API gives it.
 */
export function withoutPersonalData(booking: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(booking)) {
    if ((PERSONAL_FIELDS as readonly string[]).includes(k) || k === "participants") continue;
    out[k] = v;
  }
  return out;
}
