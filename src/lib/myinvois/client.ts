import { encodeForSubmission } from "./ubl";

/**
 * MyInvois's API, as far as MySenam needs it: a token, a submission, and what
 * became of it. Sandbox is LHDN's pre-production; credentials are an ERP
 * client registered in the MyInvois portal, the venue's own or the platform's
 * as an intermediary acting on the venue's TIN.
 */

export interface Connection {
  sandbox: boolean;
  clientId: string;
  clientSecret: string;
  /** Acting for this taxpayer as an intermediary; null: as the taxpayer itself. */
  onBehalfOf: string | null;
}

export function apiBase(sandbox: boolean): string {
  return sandbox ? "https://preprod-api.myinvois.hasil.gov.my" : "https://api.myinvois.hasil.gov.my";
}

/** Where anybody can check an e-invoice LHDN has validated: the link its QR code carries. */
export function validationLink(sandbox: boolean, uuid: string, longId: string): string {
  return `https://${sandbox ? "preprod." : ""}myinvois.hasil.gov.my/${uuid}/share/${longId}`;
}

const tokens = new Map<string, { token: string; until: number }>();

export class MyInvoisError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** A bearer token, reused until a minute before it runs out. */
export async function token(c: Connection): Promise<string> {
  const key = `${c.sandbox}:${c.clientId}:${c.onBehalfOf ?? ""}`;
  const held = tokens.get(key);
  if (held && held.until > Date.now() + 60_000) return held.token;
  const res = await fetch(`${apiBase(c.sandbox)}/connect/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(c.onBehalfOf ? { onbehalfof: c.onBehalfOf } : {}),
    },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: "client_credentials", scope: "InvoicingAPI" }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number; error?: string; error_description?: string } | null;
  if (!res.ok || !data?.access_token)
    throw new MyInvoisError(`MyInvois refused the sign-in (${res.status})${data?.error ? `: ${data.error_description ?? data.error}` : ""}`, res.status);
  tokens.set(key, { token: data.access_token, until: Date.now() + (data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

/** Test helper — forget every token. */
export function forgetTokens(): void {
  tokens.clear();
}

async function call<T>(c: Connection, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${apiBase(c.sandbox)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await token(c)}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(c.onBehalfOf ? { onbehalfof: c.onBehalfOf } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: { message?: string; details?: { message?: string }[] } }) | null;
  if (!res.ok || !data) {
    const why = data?.error?.details?.[0]?.message ?? data?.error?.message;
    throw new MyInvoisError(`MyInvois answered ${res.status}${why ? `: ${why}` : ""}`, res.status);
  }
  return data;
}

export interface SubmitOutcome {
  submissionUid: string;
  /** Accepted for validation, with LHDN's id; or refused at once, with why. */
  accepted: { uuid: string; codeNumber: string } | null;
  rejected: string | null;
}

/** Send one document. Accepted means it will be validated, not that it is valid yet. */
export async function submitDocument(c: Connection, codeNumber: string, json: string): Promise<SubmitOutcome> {
  const { document, documentHash } = encodeForSubmission(json);
  const data = await call<{
    submissionUid?: string;
    submissionUID?: string;
    acceptedDocuments?: { uuid: string; invoiceCodeNumber: string }[];
    rejectedDocuments?: { invoiceCodeNumber: string; error?: { message?: string; details?: { message?: string }[] } }[];
  }>(c, "POST", "/api/v1.0/documentsubmissions/", { documents: [{ format: "JSON", document, documentHash, codeNumber }] });
  const accepted = data.acceptedDocuments?.find((d) => d.invoiceCodeNumber === codeNumber) ?? null;
  const rejected = data.rejectedDocuments?.find((d) => d.invoiceCodeNumber === codeNumber) ?? null;
  return {
    submissionUid: data.submissionUid ?? data.submissionUID ?? "",
    accepted: accepted ? { uuid: accepted.uuid, codeNumber } : null,
    rejected: rejected ? (rejected.error?.details?.[0]?.message ?? rejected.error?.message ?? "Rejected") : null,
  };
}

export interface DocumentStatus {
  status: "Submitted" | "Valid" | "Invalid" | "Cancelled";
  longId: string | null;
  /** Why it is invalid, when it is. */
  problems: string[];
}

/** Where a document stands: still being validated, valid (with the long id for its public link), or invalid and why. */
export async function documentStatus(c: Connection, uuid: string): Promise<DocumentStatus> {
  const data = await call<{
    status: DocumentStatus["status"];
    longId?: string | null;
    validationResults?: { validationSteps?: { status?: string; error?: { innerError?: { error?: string }[]; error?: string } }[] };
  }>(c, "GET", `/api/v1.0/documents/${encodeURIComponent(uuid)}/details`);
  const problems = (data.validationResults?.validationSteps ?? [])
    .filter((s) => s.status === "Invalid")
    .flatMap((s) => (s.error?.innerError?.length ? s.error.innerError.map((e) => e.error ?? "") : [s.error?.error ?? ""]))
    .filter(Boolean);
  return { status: data.status, longId: data.longId ?? null, problems };
}
