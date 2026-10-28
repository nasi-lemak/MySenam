import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { ADMIN_SESSION_COOKIE, canAccessVenue, getAdminByToken } from "@/lib/admin-auth";
import { cashUpAs } from "@/lib/cash-up";
import { getVenue } from "@/lib/store";
import { momentClock } from "@/lib/region";
import { staffServerT } from "@/lib/staff-locale";
import { venueZoneOf } from "@/lib/zones";
import { PrintButton } from "@/components/PrintButton";
import { CashUpSheet } from "@/components/admin/CashUpSheet";

export const dynamic = "force-dynamic";

/**
 * A day's cash-up to print and sign at the end of a shift (lib/cash-up.ts):
 * `?venueId&date?&staffId?`, held to the same rule as the dashboard's: front
 * desk its own, today or yesterday; a manager anybody's, any day.
 */
export default async function CashUpPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const token = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
  const admin = token ? await getAdminByToken(token) : null;
  const ask = await searchParams;
  const venueId = Number(ask.venueId);
  if (!admin || !Number.isInteger(venueId) || venueId <= 0 || !canAccessVenue(admin, venueId)) notFound();
  const venue = await getVenue(venueId);
  if (!venue) notFound();
  const result = await cashUpAs(admin, venueId, { date: ask.date ?? null, staffId: ask.staffId ?? null });
  if (!result.ok) notFound();
  const t = await staffServerT();
  const data = result.cashUp;
  const zone = venueZoneOf({ time_zone: venue.timeZone ?? null, lat: venue.lat ?? null, lng: venue.lng ?? null });
  const who = data.staffId === null ? t("p8b.cash.everybody") : (data.entries.find((e) => e.staffName)?.staffName ?? (data.staffId === admin.id ? admin.name : "—"));

  return (
    <article className="mx-auto max-w-3xl space-y-5 rounded-2xl border border-slate-200 bg-white p-8 text-sm shadow-sm print:border-0 print:p-0 print:shadow-none">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{t("p8b.cash.title")}</h1>
          <p className="mt-1 text-slate-600">{venue.name}</p>
          <p className="text-slate-600">{t("p8b.cash.sheetFor", { date: data.date, who })}</p>
        </div>
        <PrintButton label={t("p8b.cash.print")} />
      </header>
      <CashUpSheet data={data} t={t} time={(at) => momentClock(at, zone, t.locale)} />
      <footer className="grid gap-8 pt-6 text-xs text-slate-500 sm:grid-cols-2">
        <p className="border-t border-slate-300 pt-1">{t("p8b.cash.countedBy")}</p>
        <p className="border-t border-slate-300 pt-1">{t("p8b.cash.checkedBy")}</p>
      </footer>
    </article>
  );
}
