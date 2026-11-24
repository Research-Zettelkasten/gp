import { allowedPushEndpoint, announcementPayload, deliveryState } from "./push.ts";

Deno.test("provider allowlist refuses alternate destinations", () => {
  for (const endpoint of [
    "https://web.push.apple.com/token",
    "https://fcm.googleapis.com/fcm/send/token",
    "https://updates.push.services.mozilla.com/wpush/v2/token",
  ]) if (!allowedPushEndpoint(endpoint)) throw Error("Supported provider was refused");

  for (const endpoint of [
    "http://fcm.googleapis.com/token", "https://web.push.apple.com.example.test/",
    "https://web.push.apple.com@127.0.0.1/", "https://fcm.googleapis.com:8888/token",
    "https://fcm.googleapis.com/token#fragment", "https://localhost/token",
  ]) if (allowedPushEndpoint(endpoint)) throw Error("Unexpected provider was accepted");
});

Deno.test("retry policy retires expired subscriptions and bounds transient retries", () => {
  if (deliveryState(201, 1) !== "sent") throw Error("Accepted");
  if (deliveryState(410, 1) !== "unavailable") throw Error("Expired");
  if (deliveryState(429, 1) !== "retry") throw Error("Rate limit");
  if (deliveryState(503, 3) !== "unavailable") throw Error("Retries exhausted");
});

Deno.test("announcement previews are opt-in and keep the encrypted payload small", () => {
  const id = "80000000-0000-0000-0000-000000000001";
  const expiry = "2026-11-25T13:00:00Z";
  const generic = announcementPayload(id, expiry);
  if ("preview" in generic || generic.expiresAt !== Date.parse(expiry)) throw Error("Generic alert exposed preview or lost its expiry");
  const title = "Daily   update";
  const body = "Hello\n\n" + "💬".repeat(1990);
  const rich = announcementPayload(id, expiry, {title,body});
  if (rich.preview?.title !== "Daily update" || !rich.preview?.body.startsWith("Hello 💬") ||
    !rich.preview.body.endsWith("…") || Array.from(rich.preview.body).length > 500) throw Error("Preview was not normalized or bounded");
  if (new TextEncoder().encode(JSON.stringify(rich)).byteLength >= 3000) throw Error("Payload is too large");
});
