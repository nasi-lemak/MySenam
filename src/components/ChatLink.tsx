import type { T } from "@/lib/i18n";

/**
 * "Send it to my WhatsApp": opens a chat with the platform's number, the code
 * typed in. A message the customer starts is one we can answer for free.
 */
export default function ChatLink({ t, number, code }: { t: T; number: string | null | undefined; code: string }) {
  if (!number) return null;
  return (
    <div className="mt-4">
      <a
        href={`https://wa.me/${number}?text=${encodeURIComponent(t("chat.prefill", { code }))}`}
        target="_blank"
        rel="noopener noreferrer"
        className="block w-full rounded-lg bg-[#25D366] py-2.5 text-center font-semibold text-white hover:brightness-95"
      >
        💬 {t("chat.button")}
      </a>
      <p className="mt-1 text-center text-xs text-slate-500">{t("chat.note")}</p>
    </div>
  );
}
