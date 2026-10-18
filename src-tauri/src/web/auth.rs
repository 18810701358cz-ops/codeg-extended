use axum::{
    extract::Request,
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

pub const WS_EVENT_PROTOCOL: &str = "codeg-events";
const WS_TOKEN_PROTOCOL_PREFIX: &str = "codeg-token.";
// Sent with every 401 this middleware returns. The web client reads it to
// tell Codeg's own rejection (re-enter the token) from a 401 sent by an
// identity-aware proxy in front of Codeg whose session expired (reload, so the
// proxy can run its login flow); see `src/lib/transport/web-auth.ts`.
const CODEG_CHALLENGE: &str = r#"Bearer realm="codeg""#;

fn unauthorized(message: &'static str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, CODEG_CHALLENGE)],
        message,
    )
        .into_response()
}

fn token_from_ws_protocols(value: &str) -> Option<String> {
    value
        .split(',')
        .map(str::trim)
        .find_map(|protocol| protocol.strip_prefix(WS_TOKEN_PROTOCOL_PREFIX))
        .and_then(|encoded| URL_SAFE_NO_PAD.decode(encoded).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

pub async fn require_token(request: Request, next: Next, token: String) -> Response {
    // Fail closed on a misconfigured empty token: otherwise `Bearer ` (an empty
    // bearer value) would match it and silently disable authentication.
    if token.is_empty() {
        return unauthorized("Server token is not configured");
    }

    if let Some(auth_header) = request.headers().get("authorization") {
        if let Ok(auth_str) = auth_header.to_str() {
            if auth_str.strip_prefix("Bearer ").is_some_and(|t| t == token) {
                return next.run(request).await;
            }
        }
    }

    if let Some(protocol_header) = request.headers().get("sec-websocket-protocol") {
        if let Ok(protocols) = protocol_header.to_str() {
            if token_from_ws_protocols(protocols).is_some_and(|t| t == token) {
                return next.run(request).await;
            }
        }
    }

    unauthorized("Invalid or missing token")
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    #[test]
    fn parses_token_from_ws_protocols() {
        let token = "secret/token+value";
        let encoded = URL_SAFE_NO_PAD.encode(token);
        assert_eq!(
            token_from_ws_protocols(&format!("codeg-events, codeg-token.{encoded}")).as_deref(),
            Some(token)
        );
    }

    #[test]
    fn ignores_invalid_ws_protocol_token() {
        assert!(token_from_ws_protocols("codeg-events, codeg-token.not-valid-@@@@").is_none());
    }

    fn guarded(server_token: &str) -> axum_test::TestServer {
        let server_token = server_token.to_string();
        let app = axum::Router::new()
            .route("/api/health", axum::routing::post(|| async { "ok" }))
            .layer(axum::middleware::from_fn(move |req, next| {
                require_token(req, next, server_token.clone())
            }));
        axum_test::TestServer::new(app).unwrap()
    }

    // The web client tells Codeg's own 401 from one sent by a proxy in front
    // of it (whose session expired) by this challenge; see `web-auth.ts`.
    #[tokio::test]
    async fn every_rejection_carries_the_codeg_challenge() {
        let server = guarded("tok");

        let missing = server.post("/api/health").await;
        missing.assert_status_unauthorized();
        assert_eq!(missing.header("www-authenticate"), CODEG_CHALLENGE);

        let wrong = server
            .post("/api/health")
            .authorization_bearer("nope")
            .await;
        wrong.assert_status_unauthorized();
        assert_eq!(wrong.header("www-authenticate"), CODEG_CHALLENGE);

        let unconfigured = guarded("").post("/api/health").await;
        unconfigured.assert_status_unauthorized();
        assert_eq!(unconfigured.header("www-authenticate"), CODEG_CHALLENGE);
    }

    #[tokio::test]
    async fn an_accepted_request_carries_no_challenge() {
        let ok = guarded("tok")
            .post("/api/health")
            .authorization_bearer("tok")
            .await;
        ok.assert_status_ok();
        assert!(ok.maybe_header("www-authenticate").is_none());
    }
}
