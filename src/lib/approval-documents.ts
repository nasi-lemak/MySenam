import crypto from "crypto";
import { constants as zlib, inflateSync } from "zlib";
import sharp from "sharp";
import { MAX_PIXELS, sniff } from "./photos";
import { DOCUMENT_POLICY } from "./security-headers";

/**
 * Supporting documents sent with an application to be approved for an
 * activity (lib/approvals.ts; docs/architecture/security.md#supporting-documents;
 * ADR 0021): a certificate, as a photo or scan, or as a PDF.
 *
 * What a file is comes from its bytes, never from its name or the type the
 * browser declared; where a name or a type is given it must agree with the
 * bytes, so a renamed program or a web page called `.pdf` is refused. A
 * photo or scan is redrawn as an image, as venue photos are, so nothing of
 * the upload survives but its pixels. A PDF cannot be redrawn without
 * rendering it, and the server never renders or runs one, so it is checked
 * for what a PDF can carry besides pages, and refused if it carries any of
 * it: encryption, scripts, actions that run on opening (beyond opening at a
 * page) or that launch, submit or import on a click, attached files, rich
 * media, or XFA forms. Its object streams (where a
 * modern PDF keeps most of its dictionaries, compressed) are decompressed,
 * within a bound, and checked the same way; one that cannot be checked is
 * refused. It has a page limit as well as a size limit.
 *
 * These checks stand in for malware scanning, which the platform does not
 * buy: they keep out the PDF features that attacks use, not every flaw a
 * PDF reader might have. So a PDF is only ever handed out as an attachment
 * (never shown inside the app's pages), with a policy under which nothing in
 * it can load or run, to the people entitled to it (lib/approvals.ts).
 *
 * Everything happens in memory: no temporary file is written, and the
 * documents live in the database, never in the public photo store.
 */

/** Each document, as uploaded, at most this big. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
/** A certificate is a page or two; this is generous. */
export const MAX_PDF_PAGES = 20;
/** Object streams decompressed to check them, all told, at most this much. */
export const MAX_PDF_INFLATED_BYTES = 40 * 1024 * 1024;

/** An uploaded file: its bytes, with the name and type the browser gave it, if any. */
export type UploadedFile = Buffer & { fileName?: string; declaredType?: string };

/** Bytes with the name and type the browser gave them (lib/approvals.ts readSubmission). */
export function uploaded(data: Buffer, fileName?: string | null, declaredType?: string | null): UploadedFile {
  return Object.assign(data, { fileName: fileName ?? undefined, declaredType: declaredType ?? undefined });
}

export type DocumentKind = "pdf" | "jpeg" | "png" | "webp";

export interface PreparedDocument {
  contentType: "image/webp" | "application/pdf";
  content: Buffer;
  fileName: string;
  /** A PDF's page count; null for an image. */
  pages: number | null;
  sha256: string;
}

export type DocumentRefusal = { ok: false; code: string; error: string };

const refusal = (code: string, error: string): DocumentRefusal => ({ ok: false, code, error });

/** The words of each refusal, in English (the customer reads them in their own language, by code: lib/i18n.ts). */
export const DOCUMENT_REFUSALS = {
  APR_DOCUMENT_BAD: "Send the document as a PDF, or a photo or scan (JPEG, PNG or WebP), up to 10 MB.",
  APRDOC_TOO_BIG: "That file is over 10 MB. Send a smaller one.",
  APRDOC_MISMATCH: "That file is not what its name or type says. Send a PDF, or a photo or scan as JPEG, PNG or WebP.",
  APRDOC_PDF_BROKEN: "That PDF could not be checked. Save or print it again as a plain PDF, or send a photo of it.",
  APRDOC_PDF_ENCRYPTED: "That PDF is password-protected or encrypted. Send one without a password, or a photo of it.",
  APRDOC_PDF_ACTIVE: "That PDF contains scripts, attachments, actions or interactive forms, which are not accepted. Print it to a plain PDF, or send a photo of it.",
  APRDOC_PDF_PAGES: `That PDF has more than ${MAX_PDF_PAGES} pages. Send only the pages the venue asks for.`,
} as const;
type RefusalCode = keyof typeof DOCUMENT_REFUSALS;
const refuse = (code: RefusalCode): DocumentRefusal => refusal(code, DOCUMENT_REFUSALS[code]);

/** What a file is, by its first bytes: a PDF, or one of the images a photo may be. */
export function sniffDocument(data: Buffer): DocumentKind | null {
  if (data.length >= 8 && data.toString("latin1", 0, 5) === "%PDF-") return "pdf";
  return sniff(data);
}

const EXTENSIONS: Record<DocumentKind, string[]> = {
  pdf: ["pdf"],
  jpeg: ["jpg", "jpeg", "jpe", "jfif"],
  png: ["png"],
  webp: ["webp"],
};
const TYPES: Record<DocumentKind, string[]> = {
  pdf: ["application/pdf", "application/x-pdf"],
  jpeg: ["image/jpeg", "image/jpg", "image/pjpeg"],
  png: ["image/png"],
  webp: ["image/webp"],
};
/** Types a browser declares when it does not know: no claim to check. */
const UNKNOWN_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

/** The name and type the browser gave must agree with what the bytes are, where they say anything. */
function agrees(kind: DocumentKind, file: UploadedFile): boolean {
  const declared = (file.declaredType ?? "").split(";")[0].trim().toLowerCase();
  if (!UNKNOWN_TYPES.has(declared) && !TYPES[kind].includes(declared)) return false;
  const name = baseName(file.fileName ?? "");
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const ext = name.slice(dot + 1).toLowerCase();
    if (!EXTENSIONS[kind].includes(ext)) return false;
  }
  return true;
}

function baseName(name: string): string {
  return name.split(/[\\/]/).pop() ?? "";
}

/**
 * A file name safe to show and to send in a Content-Disposition header:
 * letters, digits, spaces and a little punctuation, at most 80 characters,
 * with the extension of what the file actually is.
 */
export function safeFileName(name: string | undefined, ext: string): string {
  let base = baseName(name ?? "").normalize("NFC");
  const dot = base.lastIndexOf(".");
  if (dot > 0) base = base.slice(0, dot);
  base = base
    .replace(/[^\p{L}\p{N} ._()-]+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[ .]+|[ .]+$/g, "")
    .slice(0, 80)
    .trim();
  return `${base || "document"}.${ext}`;
}

/**
 * Check an upload and make it what is kept: an image redrawn as WebP, or a
 * PDF that passed its checks, kept as sent.
 */
export async function prepareDocument(file: UploadedFile): Promise<{ ok: true; document: PreparedDocument } | DocumentRefusal> {
  if (file.length === 0) return refuse("APR_DOCUMENT_BAD");
  if (file.length > MAX_DOCUMENT_BYTES) return refuse("APRDOC_TOO_BIG");
  const kind = sniffDocument(file);
  if (!kind) return refuse("APR_DOCUMENT_BAD");
  if (!agrees(kind, file)) return refuse("APRDOC_MISMATCH");
  if (kind === "pdf") {
    const checked = inspectPdf(file);
    if (!checked.ok) return checked;
    const content = Buffer.from(file);
    return {
      ok: true,
      document: {
        contentType: "application/pdf",
        content,
        fileName: safeFileName(file.fileName, "pdf"),
        pages: checked.pages,
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
      },
    };
  }
  try {
    const opts = { limitInputPixels: MAX_PIXELS, failOn: "error" as const };
    const meta = await sharp(file, opts).metadata();
    if (meta.format !== kind) return refuse("APR_DOCUMENT_BAD");
    const content = await sharp(file, opts).rotate().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    return {
      ok: true,
      document: {
        contentType: "image/webp",
        content,
        fileName: safeFileName(file.fileName, "webp"),
        pages: null,
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
      },
    };
  } catch {
    return refuse("APR_DOCUMENT_BAD");
  }
}

// ------------------------------------------------------------ checking a PDF

/**
 * Names a PDF uses for what is more than pages: scripts (JavaScript, JS),
 * actions run on a page or field event, or on a click that launches a
 * program, opens another file, submits or imports data, or plays media (AA,
 * Launch, GoToR, GoToE, SubmitForm, ImportData, Rendition, Movie, Sound),
 * attached files (EmbeddedFile(s), FileAttachment), rich media and XFA
 * forms. A link to a web address (URI) a reader clicks is allowed:
 * certificates carry them. An action on opening is refused (openingAction).
 */
const ACTIVE_NAMES = new Set([
  "JavaScript",
  "JS",
  "AA",
  "Rendition",
  "Movie",
  "Sound",
  "Launch",
  "GoToR",
  "GoToE",
  "SubmitForm",
  "ImportData",
  "EmbeddedFile",
  "EmbeddedFiles",
  "FileAttachment",
  "RichMedia",
  "XFA",
]);

/** A name token: a solidus and the regular characters after it (PDF 32000-1, 7.3.5). */
const NAME = /\/([^\s/[\]<>(){}%]*)/g;

/** A name with its #xx escapes decoded, so `/J#61vaScript` is read as `/JavaScript`. */
function decodeName(raw: string): string {
  return raw.replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** Every name in some PDF syntax, decoded. */
function namesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(NAME)) out.push(decodeName(m[1]));
  return out;
}

/**
 * What the PDF does on opening, if anything. A destination written in
 * place (`/OpenAction [3 0 R /Fit]`: open at that page, that zoom) is only a
 * view, and office suites write one into every PDF they make; anything else
 * (an action dictionary, which may open a web address or run something, or a
 * reference that could lead to one) is refused.
 */
function openingAction(decoded: string): boolean {
  for (const m of decoded.matchAll(/\/OpenAction\s*(\S)/g)) if (m[1] !== "[") return true;
  return false;
}

/** Pages: page objects, `/Type /Page` (and not `/Pages`), in syntax with its names decoded. */
function pageCount(decoded: string): number {
  return (decoded.match(/\/Type\s*\/Page(?![A-Za-z0-9])/g) ?? []).length;
}

/**
 * Check a PDF's structure without rendering it: its header and end; no
 * encryption; none of the active names above, in its dictionaries or inside
 * its (decompressed) object streams; at least one page and at most
 * MAX_PDF_PAGES. What cannot be checked is refused.
 */
export function inspectPdf(data: Buffer): { ok: true; pages: number } | DocumentRefusal {
  if (!/^%PDF-[12]\.\d/.test(data.toString("latin1", 0, 8))) return refuse("APR_DOCUMENT_BAD");
  if (!data.toString("latin1", Math.max(0, data.length - 1024)).includes("%%EOF")) return refuse("APRDOC_PDF_BROKEN");
  const text = data.toString("latin1");

  // The PDF's own syntax, apart from stream contents (page drawing, images,
  // fonts, compressed objects), where bytes are data and not names.
  const syntax: string[] = [];
  const objectStreams: { dict: string; body: Buffer }[] = [];
  const keyword = /stream(\r\n|\n|\r)/g;
  let from = 0;
  for (let m = keyword.exec(text); m; m = keyword.exec(text)) {
    const before = text.slice(from, m.index);
    // "stream" as a keyword follows a dictionary's end; "endstream" is not it.
    if (!/>>\s*$/.test(before)) continue;
    const start = m.index + m[0].length;
    const end = text.indexOf("endstream", start);
    if (end < 0) return refuse("APRDOC_PDF_BROKEN");
    syntax.push(before);
    // The stream's own dictionary: from its object's header to the keyword.
    const header = before.lastIndexOf(" obj");
    const dict = header >= 0 ? before.slice(header) : before.slice(-4096);
    if (/\/Type\s*\/ObjStm\b/.test(dict.replace(NAME, (n) => decodeName(n)))) objectStreams.push({ dict, body: data.subarray(start, end) });
    from = end + "endstream".length;
    keyword.lastIndex = from;
  }
  syntax.push(text.slice(from));
  const plain = syntax.join("\n");
  const plainNames = namesIn(plain);
  if (plainNames.includes("Encrypt")) return refuse("APRDOC_PDF_ENCRYPTED");

  // Object streams hold dictionaries out of sight: open them, within a bound.
  let inflated = 0;
  const hidden: string[] = [];
  for (const s of objectStreams) {
    const names = namesIn(s.dict);
    const filters = names.filter((n) => n.endsWith("Decode"));
    // Only what can be checked here: no filter, or Flate alone, with no predictor.
    if (filters.some((f) => f !== "FlateDecode") || filters.length > 1 || names.includes("DecodeParms")) return refuse("APRDOC_PDF_BROKEN");
    const budget = MAX_PDF_INFLATED_BYTES - inflated;
    if (budget <= 0) return refuse("APRDOC_TOO_BIG");
    let body: Buffer;
    try {
      // Sync flush: a stream followed by its line end, or cut short, still opens.
      body = filters.length === 0 ? s.body : inflateSync(s.body, { maxOutputLength: budget, finishFlush: zlib.Z_SYNC_FLUSH });
    } catch (err) {
      return (err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" ? refuse("APRDOC_TOO_BIG") : refuse("APRDOC_PDF_BROKEN");
    }
    inflated += body.length;
    if (inflated > MAX_PDF_INFLATED_BYTES) return refuse("APRDOC_TOO_BIG");
    hidden.push(body.toString("latin1"));
  }
  const decoded = [plain, ...hidden].join("\n").replace(NAME, (m) => decodeName(m));
  const names = hidden.length > 0 ? [...plainNames, ...namesIn(hidden.join("\n"))] : plainNames;
  if (names.includes("Encrypt")) return refuse("APRDOC_PDF_ENCRYPTED");
  if (names.some((n) => ACTIVE_NAMES.has(n)) || openingAction(decoded)) return refuse("APRDOC_PDF_ACTIVE");
  const pages = pageCount(decoded);
  if (pages === 0) return refuse("APRDOC_PDF_BROKEN");
  if (pages > MAX_PDF_PAGES) return refuse("APRDOC_PDF_PAGES");
  return { ok: true, pages };
}

// ------------------------------------------------------------ handing one out

/** A document as handed to somebody entitled to it. */
export interface DocumentDownload {
  contentType: string;
  content: Buffer;
  fileName: string;
}

/** A header-safe ASCII version of a file name, for browsers that do not read `filename*`. */
function asciiName(name: string): string {
  return name.normalize("NFKD").replace(/[^\x20-\x7e]/g, "").replace(/["\\;]/g, "").trim() || "document";
}

/**
 * The headers a document goes out with: never cached; a PDF as an attachment
 * (saved, never opened in the app's origin), a redrawn image inline; the
 * document policy (nothing may load or run, sandboxed); no sniffing; not to
 * be embedded by another site.
 */
export function downloadHeaders(doc: Pick<DocumentDownload, "contentType" | "fileName">): Record<string, string> {
  const disposition = doc.contentType === "application/pdf" ? "attachment" : "inline";
  return {
    "Content-Type": doc.contentType,
    "Content-Disposition": `${disposition}; filename="${asciiName(doc.fileName)}"; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": DOCUMENT_POLICY,
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Download-Options": "noopen",
  };
}
