import { describe, expect, it } from "vitest"
import { codegAuthHeaders, unauthorizedSource } from "./web-auth"

// The challenge as fetch reads it from a real 401 response.
const with401 = (challenge?: string) =>
  new Response(null, {
    status: 401,
    headers: challenge ? { "WWW-Authenticate": challenge } : {},
  }).headers.get("www-authenticate")

describe("codegAuthHeaders", () => {
  it("carries the bearer token and asks a proxy for a 401 instead of a redirect", () => {
    expect(codegAuthHeaders("tok")).toEqual({
      Authorization: "Bearer tok",
      "X-Requested-With": "XMLHttpRequest",
    })
  })
})

describe("unauthorizedSource", () => {
  it("attributes a 401 carrying Codeg's challenge to Codeg", () => {
    expect(unauthorizedSource(with401('Bearer realm="codeg"'))).toBe("codeg")
  })

  it("matches the challenge case-insensitively, as HTTP auth schemes are", () => {
    expect(unauthorizedSource(with401('bearer REALM="codeg"'))).toBe("codeg")
  })

  it("attributes a 401 with another challenge to the proxy", () => {
    expect(
      unauthorizedSource(
        with401('Cloudflare-Access resource_metadata="https://x.test/m"')
      )
    ).toBe("proxy")
  })

  it("attributes a 401 with no challenge at all to the proxy", () => {
    expect(unauthorizedSource(with401())).toBe("proxy")
  })

  it("does not take another realm's bearer challenge for Codeg's", () => {
    expect(unauthorizedSource(with401('Bearer realm="codeg-other"'))).toBe(
      "proxy"
    )
  })
})
