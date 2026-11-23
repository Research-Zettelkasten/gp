import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import webPush from "npm:web-push@3.6.7";
import { allowedPushEndpoint, deliveryState } from "./push.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};
const url = Deno.env.get("SUPABASE_URL") ?? "";
const userKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const serverKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const publicKey = Deno.env.get("GP_PUSH_PUBLIC_KEY") ?? "";
const privateKey = Deno.env.get("GP_PUSH_PRIVATE_KEY") ?? "";
const subject = Deno.env.get("GP_PUSH_SUBJECT") ?? "";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: cors });
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };

let configured = false;
try {
  webPush.setVapidDetails(subject, publicKey, privateKey);
  configured = Boolean(url && userKey && serverKey);
} catch { /* The client can report that push needs setup. */ }

type Delivery = {
  delivery_id: string;
  device_id: string;
  registered_at: string;
  endpoint: string;
  p256dh: string;
  auth_key: string;
  attempts: number;
  ttl: number;
};

async function deliver(row: Delivery, id: string): Promise<number> {
  if (!allowedPushEndpoint(row.endpoint)) return 400;
  try {
    const details = webPush.generateRequestDetails({
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth_key },
    }, JSON.stringify({ announcementId: id }), { TTL: Math.max(0, row.ttl), urgency: "normal" });
    const headers = new Headers(details.headers as Record<string, string>);
    // Fetch supplies framing based on the bytes we pass.
    headers.delete("Content-Length");
    const response = await fetch(row.endpoint, {
      method: "POST",
      headers,
      body: details.body ? new Uint8Array(details.body) : null,
      redirect: "error",
      signal: AbortSignal.timeout(5500),
    });
    await response.body?.cancel().catch(() => {});
    return response.status;
  } catch {
    return 0;
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ error: "Use POST." }, 405);
  const token = request.headers.get("Authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token || !url || !userKey) return json({ error: "Sign in to GLASSPRO." }, 401);
  try {
    const session = createClient(url, userKey, clientOptions);
    const auth = await session.auth.getUser(token);
    if (auth.error || !auth.data.user) return json({ error: "Sign in to GLASSPRO." }, 401);
    const raw = await request.text();
    if (raw.length > 2048) return json({ error: "Request is too large." }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: "Invalid request." }, 400); }
    if (body?.action === "config") return json({ configured, publicKey: configured ? publicKey : null });
    if (body?.action !== "send" || typeof body.announcementId !== "string" || !uuid.test(body.announcementId)) {
      return json({ error: "Choose a published announcement." }, 400);
    }
    if (!configured) return json({ error: "Web Push is awaiting server setup." }, 503);
    const id = body.announcementId;
    const db = createClient(url, serverKey, clientOptions);
    const { data, error } = await db.rpc("gp_claim_announcement_push", {
      p_announcement: id, p_admin: auth.data.user.id,
    });
    if (error) {
      if (error.code === "42501") return json({ error: "Only an active administrator can send push alerts." }, 403);
      if (error.code === "22023") return json({ error: "Choose an announcement that is still active." }, 409);
      return json({ error: "Could not load the push queue. Check the SQL migration." }, 503);
    }
    const targets = data as Delivery[];
    // Limit outbound concurrency and use a bounded batch so the request fits
    // within the function runtime even when providers do not respond.
    let next = 0;
    async function worker() {
      for (let row = targets[next++]; row; row = targets[next++]) {
        const status = await deliver(row, id);
        const outcome = deliveryState(status, row.attempts);
        const update = await db.from("gp_push_deliveries").update({
          state: outcome, updated_at: new Date().toISOString(),
        }).eq("id", row.delivery_id).eq("attempts", row.attempts).eq("state", "sending");
        if (update.error) console.error("Could not record a push outcome");
        if (status === 404 || status === 410) {
          await db.from("gp_push_devices").delete().eq("id", row.device_id).eq("registered_at", row.registered_at);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(targets.length, 8) }, worker));
    const summary = await db.rpc("gp_announcement_push_summary", { p_announcement: id });
    if (summary.error) return json({ error: "Could not confirm push delivery. Try Notify devices again." }, 503);
    return json(summary.data);
  } catch {
    return json({ error: "Push is temporarily unavailable." }, 503);
  }
});
