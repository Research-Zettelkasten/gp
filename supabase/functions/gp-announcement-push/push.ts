// Pure helpers so provider restrictions and delivery outcomes can be tested without network access.
export function allowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    const host = url.hostname;
    return url.protocol === "https:" && !url.port && !url.username && !url.password && !url.hash
      && !/[\s\\]/.test(endpoint) && endpoint.length <= 2048
      && (host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com"
        || host.endsWith(".push.apple.com") || host.endsWith(".notify.windows.com"));
  } catch {
    return false;
  }
}

export function deliveryState(status: number, attempts: number): "sent" | "retry" | "unavailable" {
  if (status >= 200 && status < 300) return "sent";
  if ([400, 404, 410, 413].includes(status) || attempts >= 3) return "unavailable";
  return "retry";
}
