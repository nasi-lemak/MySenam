import type { Metadata } from "next";
import Link from "next/link";
import { siteName } from "@/lib/site";
import { creditScope, isMarketplace } from "@/lib/mode";
import { currentLocale } from "@/lib/locale";
import { region } from "@/lib/region";
import { offeredGateways } from "@/lib/gateways";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: `Terms · ${siteName()}` };
}

/**
 * Terms of use: for the people booking, and on a marketplace, for venues.
 *
 * A starting draft written to match what the software actually does — who
 * holds the money, who refunds it, whose credit is whose — not legal advice.
 * The operator's legal name and registration come from OPERATOR_* settings,
 * and until they are set the page says plainly that it is not finished.
 */
export default async function TermsPage() {
  const site = siteName();
  const locale = await currentLocale();
  const operator = {
    name: process.env.OPERATOR_NAME?.trim() || null,
    registration: process.env.OPERATOR_REG_NO?.trim() || null,
    address: process.env.OPERATOR_ADDRESS?.trim() || null,
    email: process.env.OPERATOR_EMAIL?.trim() || null,
  };
  const marketplace = isMarketplace();
  const perVenueCredit = creditScope() === "venue";
  const { legal } = region();
  const gateway = offeredGateways().map((g) => g.name).join(" or ");
  const who = operator.name ?? `the operator of ${site}`;

  return (
    <article className="mx-auto max-w-2xl space-y-6 py-2 text-sm leading-relaxed text-slate-700">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Terms of use</h1>
        {locale === "ms" && (
          <p className="mt-2 text-slate-500">Terma ini disediakan dalam Bahasa Inggeris.</p>
        )}
        {!operator.name && (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
            These terms have not been completed by the operator of this site yet.
          </p>
        )}
      </header>

      <section className="space-y-2">
        <h2 className="text-lg font-bold text-slate-900">1. Who we are</h2>
        <p>
          {site} is run by {who}
          {operator.registration && ` (registration no. ${operator.registration})`}
          {operator.address && `, ${operator.address}`}.
          {operator.email && (
            <>
              {" "}
              You can reach us at{" "}
              <a className="underline" href={`mailto:${operator.email}`}>
                {operator.email}
              </a>
              .
            </>
          )}{" "}
          {marketplace
            ? "We run the booking service. The courts, gyms, pools and classes are provided by the venues listed here, which are independent businesses."
            : "We run the booking service for the venues listed here."}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-bold text-slate-900">2. Booking</h2>
        <p>
          A booking is for the court, place or class, date and hours shown when you make it, at the
          price shown then. {marketplace && "Your booking is with the venue, which provides what you booked. "}
          Bring the booking code; staff may ask for it.
        </p>
        <p>
          You may cancel free of charge up to the time each venue sets, which is shown with your
          booking. After that, or if you do not turn up, the venue may keep any payment and may
          record the no-show against your phone number.
        </p>
        <p>
          A venue may cancel a booking it cannot honour — a closure, a fault, bad weather. You are
          then owed back anything you paid for it.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-bold text-slate-900">3. Paying</h2>
        <p>
          You pay at the venue&apos;s counter, or where the venue offers it, online through{" "}
          {gateway}. Online payments go{" "}
          {marketplace ? "directly into the venue's own account; we do not receive or hold them." : "to the venue's account."}{" "}
          Refunds of online payments are made by the venue through the same service.
        </p>
        <p>
          Stored credit, multi-visit passes and memberships are sold by{" "}
          {perVenueCredit ? "a venue and can be used only at that venue" : "the venues and can be used as described when you buy them"}.
          Credit is not a bank deposit and earns no interest. Ask whoever sold it about refunding
          what you have not used.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-bold text-slate-900">4. At the venue</h2>
        <p>
          Each venue&apos;s own rules apply while you are there. Where a venue lets you in with a door
          code, keep it to yourself and the people in your booking, and follow the safety
          information shown with it.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-bold text-slate-900">5. If something goes wrong</h2>
        <p>
          {marketplace
            ? "The venue is responsible for its premises and what happens there. We are responsible for the booking service."
            : "We are responsible for the booking service and the venues it books."}{" "}
          Nothing in these terms takes away rights you have under {legal.governingLaw}, including{" "}
          {legal.consumerAct}, that cannot be taken away by agreement.
        </p>
        <p>
          What we hold about you and why is set out in the{" "}
          <Link href="/privacy" className="underline">
            privacy notice
          </Link>
          .
        </p>
      </section>

      {marketplace && (
        <section id="venues" className="space-y-2 border-t border-slate-200 pt-6">
          <h2 className="text-lg font-bold text-slate-900">6. For venues</h2>
          <p>
            <strong>Joining.</strong> Anyone may sign up and set a venue up. Customers see it once we
            have checked it, and we may decline to put a venue live. A venue that never went live, and
            that nobody has signed in to for 90 days, is deleted. Keep your venue&apos;s details, prices
            and hours accurate; customers book on what you show.
          </p>
          <p>
            <strong>Fees.</strong> Nothing is charged while you set up. Once your venue is live, and
            after any free period shown to you then, listing is charged monthly: at the fee agreed with
            you, or else at the price for your venue&apos;s size on our{" "}
            <Link href="/pricing" className="text-teal-700 underline">
              prices page
            </Link>{" "}
            when the month is invoiced. Each month&apos;s invoice is shown in your admin panel and is due within 14 days. While
            an invoice is more than 14 days overdue your venue is hidden from customers; bookings
            already made stand. If it stays unpaid after we have reminded you, we may end your listing
            on 14 days&apos; notice.
          </p>
          <p>
            <strong>Your customers&apos; money.</strong> Customers pay you — at your counter, or
            online into your own {gateway} account. We never receive or hold it. You make any refunds
            owed, including for online payments; your admin panel lists those that are due.
            {perVenueCredit &&
              " Stored credit, passes and memberships you sell are yours to honour and to refund."}
          </p>
          <p>
            <strong>Customer details.</strong> Use what you see of your customers only to run their
            bookings with you. You and we each handle personal data in line with {legal.dataAct}.
          </p>
          <p>
            <strong>Leaving.</strong> Either of us may end the listing with 30 days&apos; notice. We
            will give you a copy of your venue&apos;s bookings when you go.
          </p>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-bold text-slate-900">{marketplace ? "7" : "6"}. The law</h2>
        <p>These terms are governed by {legal.governingLaw}.</p>
      </section>
    </article>
  );
}
