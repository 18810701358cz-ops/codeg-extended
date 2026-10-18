// Shared helpers for web-mode HTTP calls — the JSON transport in
// `web-transport.ts` and direct multipart/file callers in `lib/api.ts` both
// need consistent token retrieval and 401 redirect behavior. Keeping them in
// one place means a future move from `localStorage` to cookies (or rotation
// rules, multi-tenant prefixing, etc.) doesn't have to be remembered at every
// call site.

const TOKEN_KEY = "codeg_token"

// Codeg marks its own 401 with this bearer challenge (`web/auth.rs`). A 401
// without it came from something in front of Codeg — typically an
// identity-aware proxy whose session expired — and re-entering the Codeg token
// cannot fix that; a top-level reload lets the proxy run its login flow.
const CODEG_CHALLENGE = /^bearer\s+realm="codeg"(?:\s*,|$)/i

export type UnauthorizedSource = "codeg" | "proxy"

export function codegAuthHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    // Asks a proxy in front of Codeg (e.g. Cloudflare Access) to answer an
    // expired session with 401 instead of a redirect to its login page on
    // another origin, which fetch cannot follow and reports as a network
    // error — leaving the UI reconnecting forever.
    "X-Requested-With": "XMLHttpRequest",
  }
}

/** Who answered a 401, from its `WWW-Authenticate` header (null if absent). */
export function unauthorizedSource(
  challenge: string | null
): UnauthorizedSource {
  return CODEG_CHALLENGE.test((challenge ?? "").trim()) ? "codeg" : "proxy"
}

export function getCodegToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ""
}

export function redirectToCodegLogin(): void {
  if (window.location.pathname.startsWith("/login")) return
  localStorage.removeItem(TOKEN_KEY)
  window.location.href = "/login"
}
