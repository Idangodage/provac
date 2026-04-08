export function getClientIpFromHeaders(headers: Headers): string | null {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    // X-Forwarded-For can be a comma-separated list.
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp =
    headers.get("x-real-ip") ??
    headers.get("cf-connecting-ip") ??
    headers.get("true-client-ip");

  return realIp?.trim() || null;
}

export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    // For POST/PUT/DELETE, require Origin or Referer header
    const method = request.method.toUpperCase();
    if (method === "GET" || method === "HEAD") return true;
    // Fall back to Referer for mutation requests without Origin
    const referer = request.headers.get("referer");
    if (!referer) return false;
    try {
      return new URL(referer).origin === new URL(request.url).origin;
    } catch {
      return false;
    }
  }
  return origin === new URL(request.url).origin;
}

