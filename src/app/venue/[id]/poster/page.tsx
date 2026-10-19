import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { mayShowVenue, pageViewer } from "@/lib/listing";
import { siteName } from "@/lib/site";
import { getVenue } from "@/lib/store";
import { venueBookingUrl, venueQrSvg } from "@/lib/venue-link";
import PrintButton from "./PrintButton";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Booking poster", robots: { index: false } };

/**
 * A page to print and stick up at the counter: the venue's QR code and link,
 * in English and Malay, so a customer can book the next game from their phone
 * instead of asking at the desk or on WhatsApp.
 */
export default async function PosterPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || !(await mayShowVenue(id, await pageViewer())).show) notFound();
  const venue = await getVenue(id);
  if (!venue) notFound();
  const url = await venueBookingUrl(id);
  const svg = await venueQrSvg(id);

  return (
    <div className="mx-auto max-w-xl py-4 text-center">
      <div className="mb-6 flex justify-center print:hidden">
        <PrintButton />
      </div>
      <article className="rounded-2xl border-2 border-slate-900 bg-white p-8 print:border-0 print:p-0">
        <p className="text-sm font-semibold uppercase tracking-widest text-slate-500">{venue.name}</p>
        <h1 className="mt-3 text-4xl font-black leading-tight text-slate-900">Book your court online</h1>
        <p className="mt-1 text-2xl font-bold text-teal-700">Tempah gelanggang anda dalam talian</p>
        <div className="mx-auto mt-6 w-72 max-w-full [&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
        <p className="mt-4 text-lg font-semibold text-slate-800">Scan with your phone camera · Imbas dengan kamera telefon</p>
        <p className="mt-2 break-all font-mono text-sm text-slate-600">{url}</p>
        <ol className="mx-auto mt-6 max-w-sm space-y-1 text-left text-base text-slate-700">
          <li>1. Pick a day and a free time · Pilih hari dan masa kosong</li>
          <li>2. Enter your name and phone · Masukkan nama dan telefon</li>
          <li>3. Show your booking code here · Tunjukkan kod tempahan di sini</li>
        </ol>
        <p className="mt-6 text-xs text-slate-400">{siteName()}</p>
      </article>
    </div>
  );
}
