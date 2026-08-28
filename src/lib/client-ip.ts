/**
 * Identifying the caller for rate limiting.
 *
 * `X-Forwarded-For` is written by whoever sends the request, so trusting it
 * blindly makes anonymous rate limiting worthless: rotating the header yields
 * a fresh counter per request. It is only meaningful when you know how many
 * proxies sit in front of you, because each appends the address it received
 * the request *from* — so the trustworthy entry is counted from the RIGHT,
 * where your own edge wrote it, never the left, which the client controls.
 *
 * Default is zero trusted hops: headers ignored, socket address only.
 */

export interface ClientIpSources {
  /** The TCP peer address. Cannot be forged by the client. */
  socketAddress?: string;
  xForwardedFor?: string;
  xRealIp?: string;
}

/**
 * @param sources The socket address and any forwarding headers on the request.
 * @param trustedHops How many proxies of your own sit in front of the app.
 *   0 means the app is exposed directly and headers are ignored. 1 means a
 *   single load balancer, and so on. Setting this higher than the real number
 *   lets a client push a forged value into the position we read.
 */
export function resolveClientIp(
  sources: ClientIpSources,
  trustedHops: number,
): string | undefined {
  const socket = sources.socketAddress?.trim() || undefined;

  if (trustedHops <= 0)
    return socket;

  const chain = sources.xForwardedFor
    ?.split(",")
    .map(entry => entry.trim())
    .filter(Boolean) ?? [];

  // Count from the right: with client -> lb -> app and one trusted hop, the
  // load balancer appended the client's address as the last entry.
  const candidate = chain[chain.length - trustedHops];
  if (candidate)
    return candidate;

  // Some proxies set only X-Real-IP. It carries no hop structure, so it is
  // all-or-nothing — acceptable here only because a trusted edge is declared.
  const realIp = sources.xRealIp?.trim();
  if (realIp)
    return realIp;

  return socket;
}
