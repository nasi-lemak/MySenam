import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { answerChat } from "@/lib/whatsapp-chat";
import { recordDelivery } from "@/lib/outbox";

export const dynamic = "force-dynamic";

/**
 * Meta's webhook for the platform's WhatsApp number: customers who opened the
 * chat from a confirmation screen (lib/whatsapp-chat.ts).
 *
 * Subscribe it in the Meta app (WhatsApp → Configuration) at
 * `<MYSENAM_URL>/api/whatsapp/webhook`, with WHATSAPP_VERIFY_TOKEN as the
 * verify token, to the `messages` field. Every delivery is signed with the
 * app's secret (WHATSAPP_APP_SECRET); one that is not is refused.
 */

/** Meta checking the address when it is subscribed. */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!expected || q.get("hub.mode") !== "subscribe" || q.get("hub.verify_token") !== expected)
    return NextResponse.json({ error: "Not subscribed." }, { status: 403 });
  return new NextResponse(q.get("hub.challenge") ?? "", { status: 200, headers: { "content-type": "text/plain" } });
}

function signedBy(secret: string, raw: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  const ours = createHmac("sha256", secret).update(raw).digest();
  return given.length === ours.length && timingSafeEqual(given, ours);
}

interface Delivery {
  entry?: {
    changes?: {
      value?: {
        messages?: { from?: string; type?: string; text?: { body?: string } }[];
        statuses?: { id?: string; status?: string; timestamp?: string; errors?: { title?: string; message?: string }[] }[];
      };
    }[];
  }[];
}

export async function POST(req: NextRequest) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return NextResponse.json({ error: "Chat replies are not set up." }, { status: 404 });
  const raw = await req.text();
  if (!signedBy(secret, raw, req.headers.get("x-hub-signature-256")))
    return NextResponse.json({ error: "Bad signature." }, { status: 401 });
  let delivery: Delivery;
  try {
    delivery = JSON.parse(raw) as Delivery;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  // Answered here and now; Meta is told it arrived whatever happens, or it
  // sends the same message again and again.
  let answered = 0;
  let reports = 0;
  for (const entry of delivery.entry ?? [])
    for (const change of entry.changes ?? []) {
      // Delivered, read, or failed after all, for what we sent.
      for (const st of change.value?.statuses ?? []) {
        if (!st.id || !st.status) continue;
        const error = st.errors?.[0] ? st.errors[0].message || st.errors[0].title : undefined;
        if (await recordDelivery({ id: st.id, status: st.status, timestamp: st.timestamp, error })) reports++;
      }
      for (const m of change.value?.messages ?? []) {
        if (m.type !== "text" || !m.from || !m.text?.body) continue;
        try {
          if ((await answerChat(m.from, m.text.body.slice(0, 1000))).answered) answered++;
        } catch (err) {
          console.error("[mysenam] answering a WhatsApp chat failed:", err);
        }
      }
    }
  return NextResponse.json({ ok: true, answered, reports });
}
