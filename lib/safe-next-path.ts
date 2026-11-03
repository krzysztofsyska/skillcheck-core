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
  // Protocol-relative and backslash forms resolve to another origin.
  if (candidate.startsWith("//") || candidate.startsWith("/\\")) return null;
  if (CONTROL_CHARACTERS.test(candidate)) return null;
  // A second absolute path inside the value (e.g. "/a\\/evil") never happens in
  // our own links; parse against a fixed base and require the origin to survive.
  let parsed: URL;
  try {
    parsed = new URL(candidate, "https://skillcheck.invalid");
  } catch {
    return null;
  }
  if (parsed.origin !== "https://skillcheck.invalid") return null;
  if (parsed.username || parsed.password) return null;
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** Appends a validated `next` to a path, or returns the path unchanged. */
export function withNext(path: string, next: unknown): string {
  const target = safeNextPath(next);
  if (!target) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}next=${encodeURIComponent(target)}`;
}
