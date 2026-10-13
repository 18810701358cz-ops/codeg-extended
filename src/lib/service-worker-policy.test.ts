// @vitest-environment node
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"

/**
 * Behavior of public/sw.js itself, run against an in-memory Cache Storage
 * and a scripted network. The worker ships as a plain script outside the
 * bundle, so these tests evaluate the real file with `self`, `caches` and
 * `fetch` injected — the same three globals it reads in a browser.
 *
 * The rules pinned here are the ones whose failure a user can't recover
 * from by reloading: an offline reload loop, a login redirect replaced by a
 * cached page, a storage error failing a response the network delivered,
 * and caches that outlive their release.
 */

const SW_SOURCE = readFileSync(
  path.resolve(__dirname, "../../public/sw.js"),
  "utf8"
)
const ROOT_PAGE_SOURCE = readFileSync(
  path.resolve(__dirname, "../app/page.tsx"),
  "utf8"
)

const ORIGIN = "https://codeg.example"
const BOOT_DOCUMENTS = ["/index.html", "/workspace", "/login"]

interface FakeRequest {
  method: string
  url: string
  mode: string
}

type CacheKey = FakeRequest | string

interface StoredResponse {
  status: number
  headers: [string, string][]
  body: ArrayBuffer
}

class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>()
  failOpen = false
  failWrites = false
  writeGate: Promise<void> = Promise.resolve()

  constructor(private readonly base: string) {}

  keyOf(key: CacheKey): string {
    return new URL(typeof key === "string" ? key : key.url, this.base).href
  }

  async open(name: string): Promise<FakeCache> {
    if (this.failOpen) throw new Error("storage unavailable")
    let cache = this.stores.get(name)
    if (!cache) {
      cache = new FakeCache(this)
      this.stores.set(name, cache)
    }
    return cache
  }

  async keys(): Promise<string[]> {
    return [...this.stores.keys()]
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name)
  }

  /** caches.match(): every cache, in creation order. */
  async match(key: CacheKey): Promise<Response | undefined> {
    if (this.failOpen) throw new Error("storage unavailable")
    for (const cache of this.stores.values()) {
      const hit = await cache.match(key)
      if (hit) return hit
    }
    return undefined
  }

  /** Paths stored in one cache, for assertions. */
  paths(name: string): string[] {
    const cache = this.stores.get(name)
    if (!cache) return []
    return [...cache.entries.keys()].map((href) => {
      const url = new URL(href)
      return url.pathname + url.search
    })
  }
}

class FakeCache {
  readonly entries = new Map<string, StoredResponse>()

  constructor(private readonly storage: FakeCacheStorage) {}

  async match(key: CacheKey): Promise<Response | undefined> {
    const entry = this.entries.get(this.storage.keyOf(key))
    if (!entry) return undefined
    return new Response(entry.body.slice(0), {
      status: entry.status,
      headers: entry.headers,
    })
  }

  async put(key: CacheKey, response: Response): Promise<void> {
    // Like the real thing: the body is read in full before the write lands
    // or fails, so a caller that awaits put() waits for the whole body.
    const body = await response.arrayBuffer()
    await this.storage.writeGate
    if (this.storage.failWrites) {
      throw new DOMException("quota exceeded", "QuotaExceededError")
    }
    this.entries.set(this.storage.keyOf(key), {
      status: response.status,
      headers: [...response.headers],
      body,
    })
  }
}

type Network = (
  input: string | FakeRequest,
  init?: RequestInit
) => Promise<Response>

interface Worker {
  storage: FakeCacheStorage
  fetch: ReturnType<typeof vi.fn<Network>>
  skipWaiting: ReturnType<typeof vi.fn>
  claim: ReturnType<typeof vi.fn>
  handlers: Map<string, (event: unknown) => void>
}

function loadWorker(network: Network, version: string | null = "1.2.3") {
  const scriptUrl =
    version === null ? `${ORIGIN}/sw.js` : `${ORIGIN}/sw.js?v=${version}`
  const handlers = new Map<string, (event: unknown) => void>()
  const skipWaiting = vi.fn(async () => {})
  const claim = vi.fn(async () => {})
  const self = {
    location: new URL(scriptUrl),
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      handlers.set(type, handler)
    },
    skipWaiting,
    clients: { claim },
  }
  const storage = new FakeCacheStorage(scriptUrl)
  const fetch = vi.fn<Network>(network)
  new Function("self", "caches", "fetch", SW_SOURCE)(self, storage, fetch)
  const worker: Worker = { storage, fetch, skipWaiting, claim, handlers }
  return worker
}

function extendableEvent() {
  const lifetime: Promise<unknown>[] = []
  return {
    event: { waitUntil: (promise: Promise<unknown>) => lifetime.push(promise) },
    done: () => Promise.all(lifetime),
  }
}

async function install(worker: Worker) {
  const { event, done } = extendableEvent()
  worker.handlers.get("install")!(event)
  await done()
}

async function activate(worker: Worker) {
  const { event, done } = extendableEvent()
  worker.handlers.get("activate")!(event)
  await done()
}

function dispatchFetch(worker: Worker, request: FakeRequest) {
  let response: Promise<Response> | undefined
  const lifetime: Promise<unknown>[] = []
  worker.handlers.get("fetch")!({
    request,
    respondWith: (promise: Promise<Response>) => {
      response = Promise.resolve(promise)
      lifetime.push(response.catch(() => undefined))
    },
    waitUntil: (promise: Promise<unknown>) => lifetime.push(promise),
  })
  return {
    response,
    /** Resolves once every respondWith/waitUntil promise has settled. */
    settled: async () => {
      let seen = -1
      while (seen !== lifetime.length) {
        seen = lifetime.length
        await Promise.allSettled(lifetime)
      }
    },
  }
}

function navigation(pathAndQuery: string): FakeRequest {
  return { method: "GET", url: `${ORIGIN}${pathAndQuery}`, mode: "navigate" }
}

function subresource(pathAndQuery: string, origin = ORIGIN): FakeRequest {
  return { method: "GET", url: `${origin}${pathAndQuery}`, mode: "no-cors" }
}

function withProps(response: Response, props: Record<string, unknown>) {
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(response, key, { value })
  }
  return response
}

function html(body: string, status = 200) {
  return withProps(
    new Response(body, {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
    { type: "basic" }
  )
}

function script(body = "export {}", contentType = "text/javascript") {
  return withProps(
    new Response(body, {
      status: 200,
      headers: { "content-type": contentType },
    }),
    { type: "basic" }
  )
}

function plain(status: number) {
  return withProps(
    new Response("no", { status, headers: { "content-type": "text/plain" } }),
    { type: "basic" }
  )
}

function opaqueRedirect() {
  return withProps(new Response(null, { status: 200 }), {
    type: "opaqueredirect",
    status: 0,
    ok: false,
  })
}

function pathOf(input: string | FakeRequest): string {
  const url = new URL(typeof input === "string" ? input : input.url, ORIGIN)
  return url.pathname
}

/** Serves each boot document as `doc:<path>` and fails anything else. */
const bootNetwork: Network = async (input) => {
  const p = pathOf(input)
  if (BOOT_DOCUMENTS.includes(p)) return html(`doc:${p}`)
  throw new TypeError(`unexpected fetch ${p}`)
}

const offline: Network = async () => {
  throw new TypeError("Failed to fetch")
}

const SHELL = "codeg-shell-v1-1.2.3"
const ASSETS = "codeg-assets-v1-1.2.3"

/** A worker that installed against a healthy server, then lost it. */
async function installedWorker(network: Network = offline) {
  let current: Network = bootNetwork
  const worker = loadWorker((input) => current(input))
  await install(worker)
  current = network
  return worker
}

async function bodyOf(response: Promise<Response> | undefined) {
  expect(response).toBeDefined()
  return (await response!).text()
}

describe("install", () => {
  it("seeds the root shell and every document the root page redirects to", async () => {
    const worker = loadWorker(bootNetwork)
    await install(worker)
    expect(worker.storage.paths(SHELL).sort()).toEqual(
      [...BOOT_DOCUMENTS].sort()
    )
    for (const p of BOOT_DOCUMENTS) {
      expect(worker.fetch).toHaveBeenCalledWith(p, { cache: "reload" })
    }
    expect(worker.skipWaiting).toHaveBeenCalled()
  })

  it("covers every route src/app/page.tsx can redirect to", async () => {
    // The root shell is the fallback for routes without a document of their
    // own. If it redirects somewhere unseeded, an offline reload loops.
    const targets = new Set(
      [
        ...ROOT_PAGE_SOURCE.matchAll(
          /router\.replace\(\s*["'`]([^"'`?]+)["'`?]/g
        ),
      ].map((m) => m[1])
    )
    expect(targets.size).toBeGreaterThan(0)
    const worker = loadWorker(bootNetwork)
    await install(worker)
    const seeded = worker.storage.paths(SHELL)
    for (const target of targets) expect(seeded).toContain(target)
  })

  it.each([
    ["the network fails", async () => Promise.reject(new TypeError("down"))],
    ["the server answers 503", async () => html("busy", 503)],
    [
      "an auth proxy redirects to its login page",
      async () => withProps(html("sso login"), { redirected: true }),
    ],
    ["the answer is not HTML", async () => script("{}", "application/json")],
  ])("fails the install when %s for one document", async (_, answer) => {
    const worker = loadWorker(async (input) =>
      pathOf(input) === "/login" ? answer() : bootNetwork(input)
    )
    await expect(install(worker)).rejects.toThrow()
    // Nothing is stored unless every document can be: a shell without the
    // pages it redirects to is exactly the loop the seed exists to prevent.
    expect(worker.storage.paths(SHELL)).toEqual([])
  })

  it("fails the install when the documents cannot be stored", async () => {
    const worker = loadWorker(bootNetwork)
    worker.storage.failWrites = true
    await expect(install(worker)).rejects.toThrow()
  })
})

describe("cache names follow the release", () => {
  it("names caches after the script URL's version", async () => {
    const worker = loadWorker(bootNetwork, "2.0.0")
    await install(worker)
    expect(await worker.storage.keys()).toEqual(["codeg-shell-v1-2.0.0"])
  })

  it("still works when registered without a version", async () => {
    const worker = loadWorker(bootNetwork, null)
    await install(worker)
    expect(await worker.storage.keys()).toEqual(["codeg-shell-v1-unversioned"])
  })

  it("keeps the previous release's assets, drops older codeg caches, and claims open pages", async () => {
    const worker = loadWorker(bootNetwork)
    for (const name of [
      "codeg-assets-v1", // unversioned, from before caches followed releases
      "codeg-shell-v1",
      "codeg-assets-v1-1.2.2", // the release this one replaces
      "codeg-shell-v1-1.2.2",
      ASSETS,
      SHELL,
      "someone-elses-cache",
    ]) {
      await worker.storage.open(name)
    }
    await activate(worker)
    expect((await worker.storage.keys()).sort()).toEqual(
      ["codeg-assets-v1-1.2.2", ASSETS, SHELL, "someone-elses-cache"].sort()
    )
    expect(worker.claim).toHaveBeenCalled()
  })

  it("takes the previous release by creation order, not by name", async () => {
    const worker = loadWorker(bootNetwork)
    // As strings 1.10.0 sorts before 1.9.0; it was created after it.
    for (const name of ["codeg-assets-v1-1.9.0", "codeg-assets-v1-1.10.0"]) {
      await worker.storage.open(name)
    }
    await activate(worker)
    expect(await worker.storage.keys()).toEqual(["codeg-assets-v1-1.10.0"])
  })
})

describe("requests the worker leaves alone", () => {
  it.each([
    ["a non-GET navigation", { ...navigation("/workspace"), method: "POST" }],
    [
      "a cross-origin asset",
      subresource("/_next/static/a.js", "https://cdn.example"),
    ],
    ["an API call", subresource("/api/health")],
    ["the bare API root", subresource("/api")],
    ["an API navigation", navigation("/api/office-watch-proxy/3000/")],
    ["the event socket", subresource("/ws/events")],
    ["the bare socket root", subresource("/ws")],
    ["an RSC payload", subresource("/workspace.txt?_rsc=abc")],
    ["the worker script", subresource("/sw.js?v=1.2.3")],
  ])("%s", async (_, request) => {
    const worker = loadWorker(bootNetwork)
    expect(dispatchFetch(worker, request).response).toBeUndefined()
  })
})

describe("navigations", () => {
  it("stores a fresh document under its path without the query", async () => {
    const worker = await installedWorker(async () => html("fresh settings"))
    const { response, settled } = dispatchFetch(
      worker,
      navigation("/settings?tab=appearance")
    )
    expect(await bodyOf(response)).toBe("fresh settings")
    await settled()
    expect(worker.storage.paths(SHELL)).toContain("/settings")
    expect(worker.storage.paths(SHELL)).not.toContain(
      "/settings?tab=appearance"
    )
  })

  it("does not store a successful answer that is not HTML", async () => {
    const worker = await installedWorker(async () =>
      script("%PDF", "application/pdf")
    )
    const { response, settled } = dispatchFetch(worker, navigation("/report"))
    expect(await bodyOf(response)).toBe("%PDF")
    await settled()
    expect(worker.storage.paths(SHELL)).not.toContain("/report")
  })

  it("boots a route reached by client-side navigation from its own seed when offline", async () => {
    // The loop this guards: offline, /workspace answered with the root shell
    // redirects to /workspace, whose fetch fails, which reloads the shell.
    const worker = await installedWorker(offline)
    const { response } = dispatchFetch(
      worker,
      navigation("/workspace?folder=7")
    )
    expect(await bodyOf(response)).toBe("doc:/workspace")
  })

  it("prefers the route's own document, then the root shell, when offline", async () => {
    const worker = await installedWorker(async () => html("cached settings"))
    await dispatchFetch(worker, navigation("/settings")).settled()
    worker.fetch.mockImplementation(offline)
    expect(
      await bodyOf(dispatchFetch(worker, navigation("/settings")).response)
    ).toBe("cached settings")
    expect(
      await bodyOf(dispatchFetch(worker, navigation("/merge")).response)
    ).toBe("doc:/index.html")
  })

  it("rejects like the network when offline with nothing cached", async () => {
    const worker = loadWorker(offline)
    const { response } = dispatchFetch(worker, navigation("/workspace"))
    await expect(response).rejects.toThrow("Failed to fetch")
  })

  it.each([502, 503, 504])(
    "treats a %i from a proxy in front of a restarting server as unreachable",
    async (status) => {
      const worker = await installedWorker(async () => plain(status))
      const { response } = dispatchFetch(worker, navigation("/workspace"))
      expect(await bodyOf(response)).toBe("doc:/workspace")
    }
  )

  it("passes a 5xx through when nothing is cached", async () => {
    const worker = loadWorker(async () => plain(503))
    const response = await dispatchFetch(worker, navigation("/workspace"))
      .response
    expect(response?.status).toBe(503)
  })

  it("passes a redirect through so an auth proxy can send the user to log in", async () => {
    const redirect = opaqueRedirect()
    const worker = await installedWorker(async () => redirect)
    const { response, settled } = dispatchFetch(
      worker,
      navigation("/workspace")
    )
    expect(await response).toBe(redirect)
    await settled()
    // ...and the seeded document is still the app, not the redirect.
    worker.fetch.mockImplementation(offline)
    expect(
      await bodyOf(dispatchFetch(worker, navigation("/workspace")).response)
    ).toBe("doc:/workspace")
  })

  it.each([401, 403, 404])("passes a %i through untouched", async (status) => {
    const worker = await installedWorker(async () => plain(status))
    const response = await dispatchFetch(worker, navigation("/workspace"))
      .response
    expect(response?.status).toBe(status)
    expect(await response?.text()).toBe("no")
  })

  it("answers with the network response when storing it fails", async () => {
    const worker = await installedWorker(async () => html("fresh"))
    worker.storage.failWrites = true
    const { response, settled } = dispatchFetch(worker, navigation("/settings"))
    expect(await bodyOf(response)).toBe("fresh")
    await settled()
    expect(worker.storage.paths(SHELL)).not.toContain("/settings")
  })

  it("answers before the copy is stored, so the document streams", async () => {
    const worker = await installedWorker(async () => html("fresh"))
    let release!: () => void
    worker.storage.writeGate = new Promise((resolve) => (release = resolve))
    const { response, settled } = dispatchFetch(worker, navigation("/settings"))
    expect(await bodyOf(response)).toBe("fresh")
    expect(worker.storage.paths(SHELL)).not.toContain("/settings")
    release()
    await settled()
    expect(worker.storage.paths(SHELL)).toContain("/settings")
  })
})

describe("cache-first assets", () => {
  it("fetches once, then serves the stored copy without the network", async () => {
    const worker = loadWorker(async () => script("chunk-a"))
    const first = dispatchFetch(
      worker,
      subresource("/_next/static/chunks/a.js")
    )
    expect(await bodyOf(first.response)).toBe("chunk-a")
    await first.settled()
    worker.fetch.mockImplementation(offline)
    const again = dispatchFetch(
      worker,
      subresource("/_next/static/chunks/a.js")
    )
    expect(await bodyOf(again.response)).toBe("chunk-a")
    expect(worker.fetch).toHaveBeenCalledTimes(1)
  })

  it.each(["/vs/loader.js", "/icon-192x192.png", "/manifest.json"])(
    "caches %s for this release",
    async (assetPath) => {
      const worker = loadWorker(async () => script("asset"))
      await dispatchFetch(worker, subresource(assetPath)).settled()
      expect(worker.storage.paths(ASSETS)).toEqual([assetPath])
    }
  )

  it("never stores HTML answered for an asset URL", async () => {
    const worker = loadWorker(async () => html("index fallback"))
    const { response, settled } = dispatchFetch(
      worker,
      subresource("/_next/static/chunks/orphaned.js")
    )
    expect(await bodyOf(response)).toBe("index fallback")
    await settled()
    expect(worker.storage.paths(ASSETS)).toEqual([])
  })

  it.each([
    ["an opaque response", () => withProps(script(), { type: "opaque" })],
    ["a 404", () => plain(404)],
  ])("never stores %s", async (_, answer) => {
    const worker = loadWorker(async () => answer())
    await dispatchFetch(
      worker,
      subresource("/_next/static/chunks/a.js")
    ).settled()
    expect(worker.storage.paths(ASSETS)).toEqual([])
  })

  it("serves a hashed chunk from the previous release's cache without the network", async () => {
    // A page still running that release lazy-loads a chunk the server has
    // already dropped; any cached copy of a hashed URL is the right one.
    const worker = loadWorker(offline)
    const previous = await worker.storage.open("codeg-assets-v1-1.2.2")
    await previous.put(
      subresource("/_next/static/chunks/old.js"),
      script("old chunk")
    )
    const { response } = dispatchFetch(
      worker,
      subresource("/_next/static/chunks/old.js")
    )
    expect(await bodyOf(response)).toBe("old chunk")
    expect(worker.fetch).not.toHaveBeenCalled()
  })

  it("never serves a fixed-name file from another release, and revalidates it", async () => {
    const worker = loadWorker(async () => script("new loader"))
    const previous = await worker.storage.open("codeg-assets-v1-1.2.2")
    await previous.put(subresource("/vs/loader.js"), script("old loader"))
    const { response, settled } = dispatchFetch(
      worker,
      subresource("/vs/loader.js")
    )
    expect(await bodyOf(response)).toBe("new loader")
    // The HTTP cache may still hold the old release's copy as fresh.
    expect(worker.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: `${ORIGIN}/vs/loader.js` }),
      { cache: "no-cache" }
    )
    await settled()
    expect(worker.storage.paths(ASSETS)).toEqual(["/vs/loader.js"])
  })

  it("fetches a hashed chunk with the page's own cache mode", async () => {
    const worker = loadWorker(async () => script("chunk"))
    await dispatchFetch(
      worker,
      subresource("/_next/static/chunks/a.js")
    ).settled()
    expect(worker.fetch.mock.calls).toEqual([
      [expect.objectContaining({ url: `${ORIGIN}/_next/static/chunks/a.js` })],
    ])
  })

  it("serves from the network when Cache Storage is unavailable", async () => {
    const worker = loadWorker(async () => script("live"))
    worker.storage.failOpen = true
    const { response, settled } = dispatchFetch(
      worker,
      subresource("/_next/static/chunks/a.js")
    )
    expect(await bodyOf(response)).toBe("live")
    await settled()
  })

  it("serves the network response when storing it fails", async () => {
    const worker = loadWorker(async () => script("live"))
    worker.storage.failWrites = true
    const { response, settled } = dispatchFetch(
      worker,
      subresource("/_next/static/chunks/a.js")
    )
    expect(await bodyOf(response)).toBe("live")
    await settled()
    expect(worker.storage.paths(ASSETS)).toEqual([])
  })
})
