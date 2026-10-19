# Signing in through an identity-aware proxy

`codeg-server` normally asks every browser for its access token. When the
server sits behind an identity-aware proxy that already signs users in — such
as [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
— the token is a second login on top of the proxy's. With
`CODEG_AUTH=proxy-jwt` the server also lets a request in when it carries the
proxy's signed assertion (a JWT), so the browser needs no token.

The token keeps working in this mode. Clients that do not pass through the
proxy — `codeg-cli --url`, scripts — still use it.

## Why it is safe

The server does not trust the header because it is there: anything that can
reach the listener can set a header. It checks the assertion's signature
against the keys the proxy publishes (JWKS), and its issuer, audience and
expiry. A process that can reach the port cannot forge that signature.

Everything fails closed:

- `CODEG_AUTH=proxy-jwt` with a setting missing, a misspelled mode, or a proxy
  setting without `CODEG_AUTH=proxy-jwt` stops the server at startup (exit
  code 2) with the variable named.
- A request whose assertion is missing, malformed, expired, issued for another
  audience or by another issuer, signed with an unknown key or an algorithm
  other than RS256 / ES256 gets a 401. So does every request without the token
  while no keys could be fetched.
- A request with a valid assertion that another site's page sent gets a 403
  (see below).

### Requests from other sites

The assertion rides on the proxy's session cookie, and the browser attaches
that cookie to requests other sites' pages make as well (Cloudflare sets its
application cookie `SameSite=None` unless you change it). Without a further
check, any page the signed-in user opens could use Codeg's WebSockets or upload
endpoints in their name. So a request admitted by an assertion must come from
Codeg's own page: the server refuses it when the browser marks it as sent by
another site (`Sec-Fetch-Site`), or, in a browser that does not send that
header, when its `Origin` names a host other than the one the request was sent
to (`Host`, or `X-Forwarded-Host` from a proxy that rewrites `Host`). The
token is not affected: another site's page cannot send it.

Chrome sends no `Sec-Fetch-Site` on a WebSocket handshake, so for the event
socket the `Origin` always decides. A proxy between the browser and Codeg must
therefore pass on the browser's `Host`, or put it in `X-Forwarded-Host`.
Cloudflare Tunnel does: it keeps the `Host` unless `httpHostHeader` is set, and
then moves the original to `X-Forwarded-Host`. Otherwise the socket is refused
with a 403, and the server's warning names the `Origin` and the hosts it saw.

## Configuration

| Variable | Value |
| --- | --- |
| `CODEG_AUTH` | `proxy-jwt` turns the mode on. Unset or `token`: token only, as before. |
| `CODEG_PROXY_AUTH_HEADER` | The request header holding the assertion. |
| `CODEG_PROXY_AUTH_JWKS_URL` | Where the proxy publishes its signing keys. `https` (plain `http` only for a loopback host). |
| `CODEG_PROXY_AUTH_ISSUER` | The exact `iss` the assertion must carry. |
| `CODEG_PROXY_AUTH_AUDIENCE` | A value the assertion's `aud` must hold. |

The keys are fetched at startup, kept for an hour, and fetched again early when
an assertion names a key id the server has not seen (a key rotation) — at most
once every 30 seconds. If a fetch fails, the keys already held stay in use.
`exp` and `nbf` allow 60 seconds of clock skew.

### Cloudflare Access

With `<team>` your Zero Trust team name and the application's **Application
Audience (AUD) Tag** from its overview page:

```bash
CODEG_AUTH=proxy-jwt
CODEG_PROXY_AUTH_HEADER=Cf-Access-Jwt-Assertion
CODEG_PROXY_AUTH_JWKS_URL=https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
CODEG_PROXY_AUTH_ISSUER=https://<team>.cloudflareaccess.com
CODEG_PROXY_AUTH_AUDIENCE=<AUD tag>
```

Bind the server to loopback (`CODEG_HOST=127.0.0.1`) and reach it only through
the tunnel, so every browser request passes Access. In the application's
cookie settings, setting **SameSite Attribute** to `Lax` stops the browser from
attaching the cookie to other sites' requests in the first place, apart from a
link the user follows into Codeg.

## In the browser

Opened through the proxy, the web app finds that the server admits it without a
token and skips the token prompt. When the proxy's session expires, the app
shows **Sign-in expired** with **Reload**: reloading lets the proxy run its
login again, and the app comes back where it was. API calls send
`X-Requested-With: XMLHttpRequest`, which makes Cloudflare Access answer an
expired session with 401 rather than a redirect the browser cannot follow.

## Scope

This is a setting of the standalone `codeg-server`. The desktop app's web
service stays token-only.
