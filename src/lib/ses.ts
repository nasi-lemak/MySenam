import { amzDate, signV4 } from "./offsite.ts";
import crypto from "crypto";

/**
 * Amazon SES over its HTTPS API (SESv2 `SendEmail`), the second way email leaves.
 *
 * Raw SMTP ports are refused by many cloud hosts, so the same SES account that
 * works over SMTP elsewhere may not work from the host this runs on; its API is
 * plain HTTPS. The request is signed with the AWS Signature Version 4 code the
 * off-site copies already use (`signV4` in offsite.ts), with no SDK.
 *
 * This file holds only the service (config, signing, the call, its errors). The
 * message itself is built in transports.ts, the same for SMTP and SES.
 *
 * Imports here carry their `.ts` extension so that scripts/verify-integrations.mjs
 * can load this file with plain Node.
 */

export interface SesConfig {
  kind: "ses";
  /** e.g. ap-southeast-1 */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** A configuration set SES applies to each message (event destinations, reputation tracking). */
  configurationSet?: string;
  from: string;
}

/**
 * SES is chosen when all of SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY, SES_REGION and MAIL_FROM
 * are set. The AWS_* names are deliberately not read: other tools on the same machine set them
 * (sometimes to placeholders), and a mail account must never be picked up by accident.
 */
export function sesConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SesConfig | null {
  const region = env.SES_REGION?.trim();
  const accessKeyId = env.SES_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.SES_SECRET_ACCESS_KEY?.trim();
  const from = env.MAIL_FROM;
  if (!region || !accessKeyId || !secretAccessKey || !from) return null;
  return {
    kind: "ses",
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken: env.SES_SESSION_TOKEN?.trim() || undefined,
    configurationSet: env.SES_CONFIGURATION_SET?.trim() || undefined,
    from,
  };
}

/** A region as AWS names them (ap-southeast-1, us-gov-west-1): checked before it becomes part of a host name. */
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

export function sesHost(region: string): string {
  if (!REGION.test(region)) throw new Error("SES_REGION is not an AWS region name (for example ap-southeast-1).");
  return `email.${region}.amazonaws.com`;
}

/** Why SES said no: its own words, the HTTP status and AWS's error type, never a credential. */
export class SesError extends Error {
  readonly status: number;
  readonly type: string | null;
  /** Throttled or SES's own trouble: worth trying again later. (The outbox retries every failure with its backoff; this only says why.) */
  readonly transient: boolean;
  // Plain fields, not constructor parameter properties: scripts load this file with Node's type stripping, which refuses those.
  constructor(message: string, status: number, type: string | null, transient: boolean) {
    super(message);
    this.name = "SesError";
    this.status = status;
    this.type = type;
    this.transient = transient;
  }
}

export interface SesReply {
  status: number;
  /** The parsed JSON body, or null when there was none. */
  json: Record<string, unknown> | null;
  type: string | null;
}

const TIMEOUT_MS = 15_000;

/**
 * One signed call to the SESv2 API. Returns whatever SES answered (any status); throws only when
 * SES could not be reached or did not answer in time.
 */
export async function sesCall(
  config: SesConfig,
  request: { method: "GET" | "POST"; path: string; json?: unknown },
  now: Date = new Date()
): Promise<SesReply> {
  const host = sesHost(config.region);
  const url = new URL(`https://${host}${request.path}`);
  const body = request.json === undefined ? undefined : JSON.stringify(request.json);
  const headers: Record<string, string> = { host, "x-amz-date": amzDate(now) };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (config.sessionToken) headers["x-amz-security-token"] = config.sessionToken;
  const authorization = signV4({
    method: request.method,
    url,
    headers,
    payloadHash: crypto.createHash("sha256").update(body ?? "").digest("hex"),
    region: config.region,
    service: "ses",
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    now,
  });
  // fetch sets Host itself from the URL; it was signed above.
  const sent = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== "host"));
  let res: Response;
  try {
    res = await fetch(url, {
      method: request.method,
      headers: { ...sent, authorization },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError")
      throw new Error(`Amazon SES did not answer within ${TIMEOUT_MS / 1000} seconds.`);
    throw new Error(`Amazon SES could not be reached: ${scrub(config, err instanceof Error ? err.message : String(err))}`);
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const type = errorType(res, json);
  return { status: res.status, json: json && typeof json === "object" ? json : null, type };
}

/** AWS's error type: the `x-amzn-errortype` header (`MessageRejected:http://…`), or `__type` in the body. */
function errorType(res: Response, json: Record<string, unknown> | null): string | null {
  const raw = res.headers.get("x-amzn-errortype") ?? (typeof json?.__type === "string" ? json.__type : null);
  if (!raw) return null;
  return raw.split(":")[0].split("#").pop() || null;
}

/** Nothing secret in a message that may be stored and shown to staff. */
function scrub(config: SesConfig, text: string): string {
  return [config.accessKeyId, config.secretAccessKey, config.sessionToken]
    .filter((s): s is string => !!s)
    .reduce((t, s) => t.split(s).join("***"), text);
}

const TRANSIENT = /Throttl|TooManyRequests|ServiceUnavailable|InternalFailure|RequestTimeout/i;

/** The error for a reply that was not a success. */
export function sesRefusal(config: SesConfig, reply: SesReply): SesError {
  const said = reply.json?.message ?? reply.json?.Message;
  const why = scrub(config, typeof said === "string" && said ? said : reply.type ?? "no reason given");
  const transient = reply.status === 429 || reply.status >= 500 || (reply.type !== null && TRANSIENT.test(reply.type));
  const text = transient
    ? `Amazon SES is throttling or unavailable (${reply.status}): ${why}`
    : `Amazon SES refused it (${reply.status}): ${why}`;
  return new SesError(text, reply.status, reply.type, transient);
}

/** Send a finished MIME message (`SendEmail` with raw content). Returns SES's id for it. */
export async function sendRawEmail(
  config: SesConfig,
  mail: { from: string; to: string; raw: Buffer }
): Promise<{ providerId?: string }> {
  const reply = await sesCall(config, {
    method: "POST",
    path: "/v2/email/outbound-emails",
    json: {
      FromEmailAddress: mail.from,
      Destination: { ToAddresses: [mail.to] },
      Content: { Raw: { Data: mail.raw.toString("base64") } },
      ...(config.configurationSet ? { ConfigurationSetName: config.configurationSet } : {}),
    },
  });
  if (reply.status < 200 || reply.status > 299) throw sesRefusal(config, reply);
  const id = reply.json?.MessageId;
  return { providerId: typeof id === "string" ? id : undefined };
}
