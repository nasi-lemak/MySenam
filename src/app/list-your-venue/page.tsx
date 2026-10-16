import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isMarketplace } from "@/lib/mode";
import { serverT } from "@/lib/locale";
import ApplyForm from "./ApplyForm";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await serverT();
  return { title: t("apply.title") };
}

/** Where a venue asks to join. A business's own copy has no such page. */
export default function ListYourVenuePage() {
  if (!isMarketplace()) notFound();
  return <ApplyForm />;
}
