import type { MetadataRoute } from "next";
import { siteName } from "@/lib/site";

/**
 * So the site can be added to a phone's or the front desk's tablet's home
 * screen and open like an app: full screen, on the booking search for
 * customers; staff open /admin from there once.
 */
export default function manifest(): MetadataRoute.Manifest {
  const name = siteName();
  return {
    name,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    description: "Book courts, classes and games.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#0d9488",
    icons: [
      { src: "/app-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/app-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/app-icon/512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
