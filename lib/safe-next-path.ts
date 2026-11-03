// Validation of the `next` return target used by the purchase path
// (`/kup/preselekcja` -> register/login/onboarding -> checkout).
//
// Only internal, absolute application paths are accepted. Anything that a
// browser could read as another origin (`//evil.example`, `/\evil.example`,
// `https://…`, `javascript:…`) or that carries control characters is rejected,
// so the parameter can never be used for an open redirect.

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function safeNextPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > 512) return null;
  if (!candidate.startsWith("/")) return null;
  // Protocol-relative and backslash forms resolve to another origin. A browser
  // reads "\" as "/", so it is rejected anywhere, not just at the start.
  if (candidate.startsWith("//") || candidate.includes("\\")) return null;
  if (CONTROL_CHARACTERS.test(candidate)) return null;
  let parsed: URL;
  try {
    parsed = new URL(candidate, "https://skillcheck.invalid");
  } catch {
    return null;
  }
  if (parsed.origin !== "https://skillcheck.invalid") return null;
  if (parsed.username || parsed.password) return null;
  // Dot segments are resolved AFTER the checks above, so "/..//evil.example"
  // normalises to "//evil.example". The returned value is the one that reaches
  // redirect(), so it is validated too — this keeps the function idempotent.
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
  return path;
}

/**
 * The only way a `next` value may reach redirect(). Re-validates a value that
 * crossed a request boundary (hidden form field, query string) and falls back
 * to a known-safe path, so no caller ever redirects to an unchecked string.
 */
export function nextRedirectTarget(next: unknown, fallback: string): string {
  return safeNextPath(next) ?? fallback;
}

/** Appends a validated `next` to a path, or returns the path unchanged. */
export function withNext(path: string, next: unknown): string {
  const target = safeNextPath(next);
  if (!target) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}next=${encodeURIComponent(target)}`;
}
