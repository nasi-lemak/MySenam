import type { ApprovalDocumentInfo } from "@/lib/approvals";

/** A file's size, in the units every language here writes the same way. */
export function fileSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Whether a document can be opened: its malware scan released it (lib/document-scanning.ts). */
export function released(d: Pick<ApprovalDocumentInfo, "scan">): boolean {
  return d.scan === "clean";
}

/**
 * A supporting document sent with an application, as a link: its name, its
 * kind and its size. A PDF is downloaded, never shown in the app's pages; a
 * redrawn image opens on its own (lib/approval-documents.ts). No preview is
 * made of either. One its malware scan has not released (still being
 * checked, waiting for the scanner, refused, or not checkable) is named, with
 * where it stands, and is not a link. `status` is that state in the reader's
 * language.
 */
export function DocumentLink({
  href,
  document: d,
  status,
}: {
  href: string;
  document: Pick<ApprovalDocumentInfo, "fileName" | "contentType" | "size" | "scan"> & { scanWaiting?: boolean };
  status?: string | null;
}) {
  const pdf = d.contentType === "application/pdf";
  const kind = `(${d.contentType.split("/")[1].toUpperCase()}, ${fileSize(d.size)})`;
  const note = status ? (
    <span className={`ml-1 rounded px-1 font-normal ${d.scan === "pending" || d.scanWaiting ? "bg-amber-50 text-amber-800" : "bg-red-50 text-red-700"}`}>{status}</span>
  ) : null;
  if (!released(d))
    return (
      <span className="font-medium text-slate-500">
        {d.fileName} <span className="font-normal">{kind}</span>
        {note}
      </span>
    );
  return (
    <span>
      <a
        href={href}
        {...(pdf ? { download: d.fileName } : { target: "_blank" })}
        rel="noreferrer noopener"
        className="font-medium text-teal-700 underline"
      >
        {d.fileName} <span className="font-normal text-slate-500">{kind}</span>
      </a>
      {note}
    </span>
  );
}
