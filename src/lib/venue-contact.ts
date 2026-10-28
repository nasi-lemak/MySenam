import { internationalNumber } from "./phone";

/**
 * How a customer reaches a venue (audit R8 X2-10): its phone number, and the
 * same number as WhatsApp wants it where the venue says the number takes
 * WhatsApp (`venues.phone_whatsapp`, migration 0249). Sent with whatever a
 * customer reads that may tell them to call the venue (My Booking, the
 * account's bookings, the booking form), and shown there by
 * components/VenueContact.tsx.
 */
export interface VenueContact {
  phone: string;
  /** Digits with the country code, for https://wa.me/; null where the venue has not said its number takes WhatsApp. */
  whatsapp: string | null;
}

export function venueContact(venue: { phone: string | null | undefined; phoneWhatsapp?: boolean | null }): VenueContact | null {
  const phone = venue.phone?.trim() ?? "";
  if (phone.replace(/\D/g, "").length < 6) return null;
  return { phone, whatsapp: venue.phoneWhatsapp ? internationalNumber(phone) : null };
}
