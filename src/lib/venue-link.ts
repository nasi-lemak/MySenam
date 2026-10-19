import QRCode from "qrcode";
import { venueBaseUrl } from "./storefront";

/**
 * A venue's own booking link — on its storefront domain if it has one — and
 * the same link as a QR code, for the counter, the door and the WhatsApp
 * group: the cheapest way a venue has to move its regulars online.
 */
export async function venueBookingUrl(venueId: number): Promise<string> {
  return `${await venueBaseUrl(venueId)}/venue/${venueId}`;
}

export async function venueQrSvg(venueId: number): Promise<string> {
  return QRCode.toString(await venueBookingUrl(venueId), {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#0f172a", light: "#ffffff" },
  });
}
