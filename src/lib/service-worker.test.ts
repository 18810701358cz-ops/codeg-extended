import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/transport", () => ({
  isDesktop: vi.fn(() => false),
}))

import { isDesktop } from "@/lib/transport"
import {
  SERVICE_WORKER_SCOPE,
  SERVICE_WORKER_URL,
  registerAppServiceWorker,
  serviceWorkerEligible,
} from "./service-worker"

/**
 * Registration is an optimization with several silent no-op gates, and a
 * wrong gate has a real cost: registering on desktop would let the worker
 * intercept the Tauri webview's resource loads. So each gate gets its own
 * case, and the passing case asserts the exact register() arguments.
 */

const mockIsDesktop = vi.mocked(isDesktop)

function setServiceWorkerApi(value: ServiceWorkerRegistration | undefined) {
  if (value === undefined) {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker
  } else {
    Object.defineProperty(navigator, "serviceWorker", {
      value,
      configurable: true,
    })
  }
}

function mockRegistration(register: () => Promise<unknown>) {
  setServiceWorkerApi({
    register,
  } as unknown as ServiceWorkerRegistration)
  return register
}

let originalSecureContext: boolean
let originalApi: unknown

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production")
  mockIsDesktop.mockReturnValue(false)
  originalSecureContext = window.isSecureContext
  originalApi = (navigator as { serviceWorker?: unknown }).serviceWorker
  window.isSecureContext = true
})

afterEach(() => {
  vi.unstubAllEnvs()
  window.isSecureContext = originalSecureContext
  setServiceWorkerApi(originalApi as ServiceWorkerRegistration | undefined)
})

describe("serviceWorkerEligible", () => {
  it("is eligible on a secure web runtime in production", () => {
    mockRegistration(async () => ({}))
    expect(serviceWorkerEligible()).toBe(true)
  })

  it("stays out of development builds", () => {
    vi.stubEnv("NODE_ENV", "development")
    mockRegistration(async () => ({}))
    expect(serviceWorkerEligible()).toBe(false)
  })

  it("stays out of the desktop shell", () => {
    mockIsDesktop.mockReturnValue(true)
    mockRegistration(async () => ({}))
    expect(serviceWorkerEligible()).toBe(false)
  })

  it("stays out of non-secure contexts", () => {
    window.isSecureContext = false
    mockRegistration(async () => ({}))
    expect(serviceWorkerEligible()).toBe(false)
  })

  it("reports ineligible where the API is absent", () => {
    setServiceWorkerApi(undefined)
    expect(serviceWorkerEligible()).toBe(false)
  })
})

describe("registerAppServiceWorker", () => {
  it("registers at the root scope and reports success", async () => {
    const register = vi.fn(async () => ({}))
    mockRegistration(register)
    await expect(registerAppServiceWorker()).resolves.toBe(true)
    expect(register).toHaveBeenCalledWith(SERVICE_WORKER_URL, {
      scope: SERVICE_WORKER_SCOPE,
    })
  })

  it("swallows a rejected registration", async () => {
    mockRegistration(async () => {
      throw new Error("blocked")
    })
    await expect(registerAppServiceWorker()).resolves.toBe(false)
  })

  it("never touches the API when ineligible", async () => {
    window.isSecureContext = false
    const register = vi.fn(async () => ({}))
    mockRegistration(register)
    await expect(registerAppServiceWorker()).resolves.toBe(false)
    expect(register).not.toHaveBeenCalled()
  })
})
