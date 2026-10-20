"use client";

/** Print the page: a receipt, a tax invoice. Hidden on the printout itself. */
export function PrintButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 print:hidden"
    >
      {label}
    </button>
  );
}
