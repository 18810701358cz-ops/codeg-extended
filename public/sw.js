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
 *   - Navigations are network-first. A successful HTML response is stored
 *     in the shell cache under its path — the query is stripped, because a
 *     reload comes back under whatever query the route launched with and a
 *     cache match is exact. Only a server that can't answer — the fetch
 *     fails outright, or a proxy in front of a restarting server says 5xx —
 *     makes the worker answer instead, with that route's cached document or
 *     else the root app shell. Every other response (a redirect to an auth
 *     proxy's login page, a 4xx) is the server's real answer and passes
 *     through untouched.
 *   - Cache Storage is only ever an optimization: a failed cache read falls
 *     through to the network, and a failed write (a full quota) is dropped
 *     without failing the response it was copying.
 *
 * Versions: the page registers this script as /sw.js?v=<app version>, so
 * each release installs a new worker whose caches are named after it, and
 * activate() drops the older codeg caches, keeping only the previous
 * release's assets for pages still running it. That is what bounds Cache
 * Storage — it never expires entries on its own, so hashed build output
 * would otherwise pile up release after release — and what keeps the files
 * without a content hash (Monaco's loader and editor entry points under
 * /vs, the icons, the manifest) from being served stale after an update.
 * Builds that keep the version keep their caches. Bump POLICY when a change
 * to the rules below must not inherit entries from the same release.
 *
 * Retiring this worker takes a replacement, not a deletion: the static
 * handler answers a missing /sw.js with index.html as text/html, the
 * browser's update check rejects that, and the installed worker keeps
 * running. Ship a sw.js that deletes the codeg caches and unregisters itself.
 */

const POLICY = "v1"
const BUILD = new URL(self.location.href).searchParams.get("v") || "unversioned"
const VERSION = `${POLICY}-${BUILD}`
const ASSETS_CACHE = `codeg-assets-${VERSION}`
const SHELL_CACHE = `codeg-shell-${VERSION}`
const SHELL_PATH = "/index.html"

// Stored at install, before this worker can answer anything. The root shell
// is what a route without a document of its own falls back to, and the root
// page redirects to /workspace or /login (src/app/page.tsx). Those two must
// be cached whenever the shell is: offline, the redirect's client-side
// fetch fails and Next falls back to a full navigation, which would land
// back on the shell — a reload loop for as long as the server is away.
const BOOT_DOCUMENTS = [SHELL_PATH, "/workspace", "/login"]

// Same-origin GETs under these prefixes may be cached: Next's hashed
// export output, the bundled Monaco under public/vs, and the app's own
// icons and manifest. Everything else — page HTML routes, /api, /ws — is
// served live. src/lib/service-worker.ts mirrors this list.
const CACHEABLE_PREFIXES = ["/_next/static/", "/vs/", "/icon", "/manifest.json"]

// Next names everything under here after its content, so a URL can never
// change what it serves; Monaco's entry points, the icons and the manifest
// keep their names from one release to the next.
const IMMUTABLE_PREFIX = "/_next/static/"

self.addEventListener("install", (event) => {
  // The page that registers this worker loaded its own document before any
  // worker existed, so no navigation handler has stored a shell yet: seed
  // them all or fail the install (the next page load registers again).
  // Then swap in immediately — a waiting worker would only delay that.
  event.waitUntil(seedBootDocuments())
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const older = (await caches.keys()).filter(
        (name) =>
          name.startsWith("codeg-") &&
          name !== ASSETS_CACHE &&
          name !== SHELL_CACHE
      )
      // Keep one older asset cache — the newest, i.e. the release this one
      // replaces (keys() lists caches in creation order). Pages still
      // running that release go on lazy-loading its hashed chunks from it
      // after the server has dropped them; the next release deletes it.
      const previousAssets = older
        .filter((name) => name.startsWith("codeg-assets-"))
        .pop()
      await Promise.all(
        older
          .filter((name) => name !== previousAssets)
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
    event.respondWith(navigateNetworkFirst(event, url.pathname))
    return
  }
  if (CACHEABLE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
    event.respondWith(cacheFirst(event, url.pathname))
  }
})

async function seedBootDocuments() {
  const documents = await Promise.all(
    BOOT_DOCUMENTS.map(async (path) => {
      const response = await fetch(path, { cache: "reload" })
      // A redirect here is an auth proxy's login page, not the app.
      if (!response.ok || response.redirected || !isHtml(response)) {
        throw new Error(`cannot seed ${path}: HTTP ${response.status}`)
      }
      return [path, response]
    })
  )
  const cache = await caches.open(SHELL_CACHE)
  await Promise.all(
    documents.map(([path, response]) => cache.put(path, response))
  )
}

async function navigateNetworkFirst(event, path) {
  let response
  try {
    response = await fetch(event.request)
  } catch (error) {
    const cached = await cachedDocument(path)
    if (cached) return cached
    throw error
  }
  if (response.status >= 500) {
    return (await cachedDocument(path)) || response
  }
  if (response.ok && isHtml(response)) {
    putInBackground(event, SHELL_CACHE, path, response.clone())
  }
  return response
}

async function cachedDocument(path) {
  return (
    (await cacheMatch(SHELL_CACHE, path)) ||
    (await cacheMatch(SHELL_CACHE, SHELL_PATH))
  )
}

async function cacheFirst(event, path) {
  const request = event.request
  const immutable = path.startsWith(IMMUTABLE_PREFIX)
  // A hashed URL serves the same bytes from any release's cache. A fixed
  // name only counts from this release's, and a miss revalidates with the
  // server: the HTTP cache may still hold the previous release's copy as
  // heuristically fresh (the static handler sends no Cache-Control), and
  // storing that would pin it here until the next release.
  const cached =
    (await cacheMatch(ASSETS_CACHE, request)) ||
    (immutable ? await anyCacheMatch(request) : undefined)
  if (cached) return cached
  const response = await (immutable
    ? fetch(request)
    : fetch(request, { cache: "no-cache" }))
  // A 200 here is not always the asset: the static handler falls back to
  // index.html for hashed URLs it no longer has (an app update orphans old
  // chunk names), and an auth proxy can answer anything with its login
  // page. Caching that HTML under a script URL would keep breaking the app
  // across a rollback, so a response that is not what its URL claims never
  // enters the cache.
  if (response.ok && response.type === "basic" && !isHtml(response)) {
    putInBackground(event, ASSETS_CACHE, request, response.clone())
  }
  return response
}

async function cacheMatch(cacheName, key) {
  try {
    const cache = await caches.open(cacheName)
    return await cache.match(key)
  } catch {
    return undefined
  }
}

async function anyCacheMatch(key) {
  try {
    return await caches.match(key)
  } catch {
    return undefined
  }
}

// Copies a response into a cache without holding it back: the caller
// returns the original at once (so it streams), and the event stays alive
// until the copy is stored or dropped.
function putInBackground(event, cacheName, key, response) {
  event.waitUntil(
    caches
      .open(cacheName)
      .then((cache) => cache.put(key, response))
      .catch(() => {})
  )
}

function isHtml(response) {
  return (response.headers.get("content-type") || "").includes("text/html")
}
