const BLOCKED_HOST_SUFFIXES = [
  ".localhost", ".local", ".internal", ".lan", ".arpa", ".home.arpa", ".cluster.local", ".svc",
  ".test", ".invalid", ".example", ".onion", ".workers.dev", ".pages.dev", ".trycloudflare.com",
  ".cloudflare.com", ".cloudflare.net", ".cloudflareworkers.com", ".cloudflareinternal.com",
  ".cloudflare-dns.com", ".cfargotunnel.com", ".cloudflareclient.com",
  ".cloudflareaccess.com", ".cloudflaregateway.com", ".esembe.app", ".example.com", ".example.net", ".example.org",
  ".test.com", ".invalid.com",
] as const;

const BLOCKED_HOSTS = new Set([
  "localhost", "metadata", "metadata.google.internal", "instance-data", "host.docker.internal",
  "cloudflare-dns.com", "brobot.esembe.app", "brobot-staging.esembe.app",
  "example.com", "example.net", "example.org", "test.com", "invalid.com",
]);

const isIpLiteral = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) return true;
  // WHATWG URL canonicalizes decimal, hexadecimal, octal, and shortened IPv4 forms.
  return /^[0-9.]+$/u.test(host);
};

const publicHostName = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  if (host.length === 0 || !host.includes(".")) return false;
  if (BLOCKED_HOSTS.has(host)) return false;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) || host === suffix.slice(1))) return false;
  return host.split(".").every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9-]+$/u.test(label) &&
    !label.startsWith("-") && !label.endsWith("-"));
};

export const validateApiSourceUrl = (input: string, ownOrigin?: string): URL => {
  if (input.length === 0 || input.length > 2_048 || input.trim() !== input) throw new Error("Invalid API source URL.");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Invalid API source URL.");
  }
  if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0 || url.port !== "" ||
      url.hash.length > 0 || isIpLiteral(url.hostname) || !publicHostName(url.hostname)) {
    throw new Error("API source URL is not allowed.");
  }
  if (ownOrigin !== undefined) {
    try {
      const ownHost = new URL(ownOrigin).hostname.toLowerCase().replace(/\.$/u, "");
      if (url.hostname.toLowerCase().replace(/\.$/u, "") === ownHost) {
        throw new Error("API source URL must not target this service.");
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "API source URL must not target this service.") throw error;
      // An invalid local origin cannot make an otherwise allowed URL less safe.
    }
  }
  return url;
};

export const isValidApiSourceUrl = (input: string, ownOrigin?: string): boolean => {
  try {
    validateApiSourceUrl(input, ownOrigin);
    return true;
  } catch {
    return false;
  }
};
