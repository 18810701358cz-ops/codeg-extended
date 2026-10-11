/**
 * Service Worker registration for the web build.
 *
 * The SW exists to make a discarded PWA tab cheap to reload and to answer
 * navigations offline with the app shell — see `public/sw.js` for the
 * caching policy. It cannot prevent the discard itself (that is the
 * browser's memory policy), and registration here is deliberately narrow:
 *
 *   - never on desktop (the Tauri webview must not have its resource loads
 *     intercepted by a service worker),
 *   - never outside a secure context (http://LAN deployments: the browser
 *     would reject the registration anyway, and Notification needs the same
 *     context),
 *   - never in development, where the served asset layout doesn't match the
 *     static export the policy is written for.
 *
 * Everything is fire-and-forget: a failed registration has no visible
 * consequence and the next page load retries.
 */

import { isDesktop } from "./transport"

export const SERVICE_WORKER_URL = "/sw.js"
export const SERVICE_WORKER_SCOPE = "/"

/** Whether this environment should have the app service worker (no side effects). */
export function serviceWorkerEligible(): boolean {
  if (typeof window === "undefined") return false
  if (!("serviceWorker" in navigator)) return false
  if (!window.isSecureContext) return false
  if (isDesktop()) return false
  if (process.env.NODE_ENV !== "production") return false
  return true
}

/**
 * Register the service worker; resolves whether a registration was issued.
 * A rejection from the browser API is swallowed — registration is an
 * optimization, not a feature gate.
 */
export async function registerAppServiceWorker(): Promise<boolean> {
  if (!serviceWorkerEligible()) return false
  try {
    await navigator.serviceWorker.register(SERVICE_WORKER_URL, {
      scope: SERVICE_WORKER_SCOPE,
    })
    return true
  } catch {
    return false
  }
}
