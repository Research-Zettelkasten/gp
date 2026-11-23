import { allowedPushEndpoint, deliveryState } from "./push.ts";

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
