"use client";

export default function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="rounded-lg bg-teal-600 px-5 py-2.5 font-semibold text-white hover:bg-teal-700"
    >
      🖨️ Print this poster
    </button>
  );
}
