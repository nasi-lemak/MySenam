import { RETENTION } from "@/lib/privacy";

export const metadata = {
  title: "Privacy notice · MySenam",
  description: "What MySenam holds about you, why, for how long, and how to get it back or removed.",
};

const HELD: [string, string, string][] = [
  ["Your name and phone number", "To hold the court in your name and to reach you if something changes", "On the booking"],
  ["Your email, if you give one", "To send you the booking confirmation you asked for", "On the booking"],
  ["What you paid and how", "The venue's accounting record, which it has to keep", "Kept, without your name, after the period below"],
  ["When you arrived and left", "So the venue knows who is inside, and the live crowd figure is honest", `${RETENTION.checkInDays} days`],
  ["Door codes shown to you", "So a venue running unstaffed hours knows who was let in", `${RETENTION.accessRevealDays} days`],
  ["Your induction, if you use unstaffed hours", "Proof that somebody showed you the emergency button in person", "While it stands"],
  ["Stored credit, passes and memberships", "Money and entries the venue owes you", "Until spent or expired"],
];

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-8 py-2">
      <header>
        <h1 className="text-2xl font-bold">Privacy notice</h1>
        <p className="mt-2 text-sm text-slate-600">
          MySenam books courts, gym places and classes for the venues listed on this site. This
          says what we hold about you, why, how long for, and what you can do about it. It is
          written to be read rather than to be survived.
        </p>
      </header>

      <section>
        <h2 className="text-lg font-bold">What we hold, and why</h2>
        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                {["What", "Why", "How long"].map((h) => (
                  <th key={h} className="px-3 py-2 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {HELD.map(([what, why, how]) => (
                <tr key={what} className="border-b border-slate-100 last:border-0 align-top">
                  <td className="px-3 py-2 font-medium">{what}</td>
                  <td className="px-3 py-2 text-slate-600">{why}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-600">{how}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-sm text-slate-600">
          Bookings stop naming anybody after{" "}
          <strong>{Math.round(RETENTION.bookingIdentityDays / 365)} years</strong>. The hour and
          the price stay, because that is the venue&apos;s record of its own takings; your name,
          number and email come off it.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-bold">Who can see it</h2>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-slate-600">
          <li>
            <strong>The venue you booked.</strong> Its staff see your booking, your payment status
            and whether you arrived. They cannot see another venue&apos;s customers — that is
            enforced by the software, not by asking nicely.
          </li>
          <li>
            <strong>Nobody else.</strong> We do not sell anything to anybody, and there is no
            advertising or analytics service in this site.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-bold">What you can do</h2>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-slate-600">
          <li>
            <strong>See it.</strong> Sign in and use <em>Download a copy</em> on your account page
            to get everything held against your account, in one file. Anything bought at a counter
            — a pass, a membership, an induction — is filed against a phone number rather than a
            login, so ask the venue for those: they check who you are in person, which a website
            cannot.
          </li>
          <li>
            <strong>Correct it.</strong> Ask the venue — they can change a name or a number on a
            booking.
          </li>
          <li>
            <strong>Have it removed.</strong> <em>Close my account</em> on the same page. Upcoming
            bookings made from the account are cancelled and your name comes off the past ones. A
            booking you made as a guest, without signing in, is not linked to the account — ask the
            venue to remove those. If a venue still owes you credit, a pass or a membership, settle
            that first: we will not erase the record of whose money it is.
          </li>
          <li>
            <strong>Book without an account at all.</strong> A name and a phone number is enough,
            and then there is no account to close.
          </li>
        </ul>
      </section>

      <section className="rounded-xl border border-amber-200 bg-amber-50/70 p-4">
        <h2 className="text-sm font-bold text-amber-900">Before this site goes live</h2>
        <p className="mt-1 text-sm text-amber-800">
          This notice describes what the software actually does, which is the hard part — but it is
          not legal advice and it is not finished. Malaysia&apos;s PDPA expects a notice like this
          in <strong>Bahasa Malaysia as well as English</strong>, and it expects a named person to
          write to. Add both, and have a lawyer read it, before taking a real customer&apos;s
          booking.
        </p>
      </section>
    </div>
  );
}
