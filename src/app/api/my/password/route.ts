import { changeRoute, passwordStatusRoute } from "@/lib/password-routes";

export const dynamic = "force-dynamic";

export const GET = passwordStatusRoute("user");
export const POST = changeRoute("user");
