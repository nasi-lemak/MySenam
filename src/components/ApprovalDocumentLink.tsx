import type { ApprovalDocumentInfo } from "@/lib/approvals";

/** A file's size, in the units every language here writes the same way. */
export function fileSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * A supporting document sent with an application, as a link: its name, its
 * kind and its size. A PDF is downloaded, never shown in the app's pages; a
 * redrawn image opens on its own (lib/approval-documents.ts). No preview is
 * made of either.
 */
export function DocumentLink({ href, document: d }: { href: string; document: Pick<ApprovalDocumentInfo, "fileName" | "contentType" | "size"> }) {
  const pdf = d.contentType === "application/pdf";
  return (
    <a
      href={href}
      {...(pdf ? { download: d.fileName } : { target: "_blank" })}
      rel="noreferrer noopener"
      className="font-medium text-teal-700 underline"
    >
      {d.fileName} <span className="font-normal text-slate-500">({d.contentType.split("/")[1].toUpperCase()}, {fileSize(d.size)})</span>
    </a>
  );
}
