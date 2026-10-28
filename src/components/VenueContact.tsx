import type { T } from "@/lib/i18n";
import type { VenueContact as Contact } from "@/lib/venue-contact";

/**
 * The venue's number, to call (a `tel:` link), and its WhatsApp chat where the
 * venue has said the number takes WhatsApp (lib/venue-contact.ts): shown
 * wherever a customer may be told to call the venue (audit R8 X2-10), so
 * nobody has to go looking for it. Nothing where the venue has no number.
 */
export default function VenueContact({
  t,
  venue,
  contact,
  code,
  className = "mt-2 text-sm text-slate-700",
}: {
  t: T;
  venue: string;
  contact: Contact | null | undefined;
  /** The booking it is about, written into the chat to start it. */
  code?: string;
  className?: string;
}) {
  if (!contact) return null;
  const dial = contact.phone.replace(/[^\d+]/g, "");
  return (
    <p className={className} data-testid="venue-contact">
      <span aria-hidden="true">📞 </span>
      {t("q8b.contact.call", { venue })}{" "}
      <a href={`tel:${dial}`} className="font-semibold text-teal-700 underline">
        {contact.phone}
      </a>
      {contact.whatsapp && (
        <>
          {" · "}
          <a
            href={`https://wa.me/${contact.whatsapp}${code ? `?text=${encodeURIComponent(t("q8b.contact.prefill", { code }))}` : ""}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-teal-700 underline"
          >
            {t("q8b.contact.whatsapp")}
          </a>
        </>
      )}
    </p>
  );
}
