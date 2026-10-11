/*
 * codeg's service worker for the web build.
 *
 * Why this exists: when a PWA window sits minimized, browser memory
 * policies (Edge sleeping tabs, Chrome's Memory Saver) can discard the tab,
 * and coming back is a full page reload. Nothing a page can do stops that
 * discard. This script makes the reload cheap instead: build assets with
 * hashed names are served from Cache Storage, and a navigation that can't
 * reach the server falls back to a cached copy of the app shell — which
 * boots the app and lets the existing connection guard show its
 * disconnected state rather than a blank tab.
 *
 * Policy, deliberately narrow:
 *   - /api/**, /ws* and any cross-origin request pass through untouched.
 *     (WebSockets never enter a fetch handler anyway; this is belt and
 *     braces for anything that looks like one.)
 *   - Same-origin GETs under the cacheable prefixes below are cache-first.
 *     They are content-hashed build output or versioned public assets, so a
 *     cached copy is never stale in a way that matters.
 *   - Navigations are network-first. A successful HTML response is stored
 *     in the shell cache under its path — the query is stripped, because a
 *     reload comes back under whatever query the route launched with and a
 *     cache match is exact. A failed navigation (connection refused, or a
 *     5xx from a server that is mid-restart) is answered with that route's
 *     cached document, falling back to the root app shell — which boots
 *     the app and lets the existing connection guard show its disconnected
 *     state rather than a blank tab.
 *
 * VERSION bounds Cache Storage: bump it when the shell document or this
 * policy changes, and activate() drops every codeg cache from before it.
 * Build output is content-hashed, so an app update simply starts using new
 * keys; orphaned entries age out under the browser's storage quota.
 */

const VERSION = "v1"
const ASSETS_CACHE = `codeg-assets-${VERSION}`
const SHELL_CACHE = `codeg-shell-${VERSION}`
const SHELL_URL = new URL("/index.html", self.location.href).href

// Same-origin GETs under these prefixes may be cached: Next's hashed
// export output, the bundled Monaco under public/vs, and the app's own
// icons and manifest. Everything else — page HTML routes, /api, /ws — is
// served live.
const CACHEABLE_PREFIXES = ["/_next/static/", "/vs/", "/icon", "/manifest.json"]

self.addEventListener("install", (event) => {
  // Seed the offline shell before the worker can take over, and swap in
  // immediately: until a navigation happens the new worker serving it is
  // what we want.
  event.waitUntil(seedShell())
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names
          .filter(
            (name) =>
              name.startsWith("codeg-") &&
              name !== ASSETS_CACHE &&
              name !== SHELL_CACHE
          )
          .map((name) => caches.delete(name))
      )
      await self.clients.claim()
    })()
  )
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return
  if (url.pathname === "/ws" || url.pathname.startsWith("/ws/")) return

  if (request.mode === "navigate") {
    event.respondWith(navigateNetworkFirst(request))
    return
  }
  if (CACHEABLE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
    event.respondWith(cacheFirst(request))
  }
})

async function seedShell() {
  // The install fetch, not the install-time navigation, is what guarantees a
  // shell after a first visit: the page that registers this worker loaded
  // its own document before the worker could take over, so no navigation
  // handler ever saw it.
  const cache = await caches.open(SHELL_CACHE)
  try {
    const response = await fetch(SHELL_URL, { cache: "reload" })
    if (response.ok) await cache.put(SHELL_URL, response)
  } catch {
    // No shell today; the first successful navigation stores it.
  }
}

async function navigateNetworkFirst(request) {
  const url = new URL(request.url)
  const routeKey = new Request(url.pathname, { method: "GET" })
  let response
  try {
    response = await fetch(request)
  } catch {
    const cached = await cachedDocument(routeKey)
    if (cached) return cached
    throw new Error("offline")
  }
  if (response.ok && isHtml(response)) {
    const cache = await caches.open(SHELL_CACHE)
    await cache.put(routeKey, response.clone())
  }
  if (response.ok) return response
  const cached = await cachedDocument(routeKey)
  return cached || response
}

async function cachedDocument(routeKey) {
  return (await caches.match(routeKey)) || (await caches.match(SHELL_URL))
}

function isHtml(response) {
  return (response.headers.get("content-type") || "").includes("text/html")
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSETS_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  // A 200 here is not always the asset: the static handler falls back to
  // index.html for hashed URLs it no longer has (an app update orphans old
  // chunk names), and an auth proxy can answer anything with its login
  // page. Caching that HTML under a script URL would keep breaking the app
  // across a rollback, so a response that is not what its URL claims never
  // enters the cache.
  if (response.ok && response.type === "basic" && !isHtml(response)) {
    await cache.put(request, response.clone())
  }
  return response
}
