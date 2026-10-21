import { ImageResponse } from "next/og";
import { siteName } from "@/lib/site";

export const dynamic = "force-dynamic";

const SIZES = new Set([192, 512]);

/**
 * The app's icon at 192 or 512 pixels, for the manifest: the first letter of
 * the site's name on its teal, drawn here so an install under its own name
 * gets its own initial without anybody making image files.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ size: string }> }) {
  const size = Number((await params).size);
  if (!SIZES.has(size)) return new Response("Not found", { status: 404 });
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0d9488",
          color: "white",
          fontSize: size * 0.58,
          fontWeight: 700,
        }}
      >
        {siteName().trim().charAt(0).toUpperCase() || "M"}
      </div>
    ),
    { width: size, height: size }
  );
}
