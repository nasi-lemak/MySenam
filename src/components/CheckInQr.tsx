"use client";

import { useState } from "react";

/** The scannable self check-in code for a booking. */
export default function CheckInQr({ token }: { token: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-center">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-xs font-semibold text-teal-700 hover:underline"
      >
        {open ? "Hide check-in code" : "📱 Show check-in code"}
      </button>
      {open && (
        <div className="mt-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/checkin/qr?token=${token}`}
            alt="Scan this code at the venue to check in"
            className="mx-auto h-40 w-40"
          />
          <p className="mt-2 text-xs text-slate-500">
            Scan at the venue to check yourself in. Opens an hour before your slot.
          </p>
        </div>
      )}
    </div>
  );
}
