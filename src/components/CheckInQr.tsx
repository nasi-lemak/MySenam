"use client";

import { useState } from "react";
import { useT } from "@/components/Language";

/** The scannable self check-in code for a booking. */
export default function CheckInQr({ token }: { token: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-center">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-xs font-semibold text-teal-700 hover:underline"
      >
        {open ? t("qr.hide") : `📱 ${t("qr.show")}`}
      </button>
      {open && (
        <div className="mt-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/checkin/qr?token=${token}`}
            alt={t("qr.alt")}
            className="mx-auto h-40 w-40"
          />
          <p className="mt-2 text-xs text-slate-500">
            {t("qr.note")}
          </p>
        </div>
      )}
    </div>
  );
}
