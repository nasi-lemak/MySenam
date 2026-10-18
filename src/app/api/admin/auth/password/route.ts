import { changeRoute, passwordStatusRoute } from "@/lib/password-routes";

export const dynamic = "force-dynamic";

export const GET = passwordStatusRoute("admin");
export const POST = changeRoute("admin");
