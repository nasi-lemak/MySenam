"use client";

import { useRouter } from "next/navigation";
import { NearPicker, type NearChoice } from "@/components/NearPicker";

/** The home page's "near me": the choice goes in the address, so it can be shared and paged. */
export function HomeNear({ value }: { value: NearChoice | null }) {
  const router = useRouter();
  return (
    <NearPicker
      value={value}
      onChange={(near) => {
        if (!near) return router.push("/");
        const params = new URLSearchParams({ near: `${near.lat.toFixed(5)},${near.lng.toFixed(5)}`, km: String(near.km) });
        if (near.where) params.set("where", near.where);
        router.push(`/?${params}`);
      }}
    />
  );
}
