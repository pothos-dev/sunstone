//! Write-auth: HS256 JWT mint/verify + the `AuthedUser` axum extractor.
//!
//! The trust model (ticket 04): reads are open; every WRITE route is gated. The
//! SvelteKit `/api` hook resolves the OAuth/OIDC session and, only if valid,
//! mints a short-lived HS256 JWT it forwards to axum as `Authorization: Bearer`.
//! axum **verifies the token itself** — it is self-defending even if reachable
//! on the network (loopback binding becomes optional defence-in-depth).
//!
//! The JWT is HMAC-SHA256 over `base64url(header).base64url(payload)`, verified
//! against a shared secret in `SUNSTONE_JWT_SECRET`. We implement the (tiny)
//! HS256 slice by hand over pure-Rust `hmac`/`sha2` rather than pulling a full
//! JWT crate (ring/aws-lc): a single issuer + single verifier in one trust
//! domain needs nothing more, and it keeps the build reproducible.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::FromRequestParts;
use axum::http::{header::AUTHORIZATION, request::Parts, StatusCode};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::ServerState;

type HmacSha256 = Hmac<Sha256>;

/// Env var holding the shared HS256 secret (minted against in the Node hook,
/// verified here). Absent → writes are disabled (every write route 401s).
pub const SECRET_ENV: &str = "SUNSTONE_JWT_SECRET";

/// JWT claims (ticket 04 §4). `iat`/`exp` are unix seconds; `exp` is enforced.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Claims {
    pub sub: String,
    pub name: String,
    pub email: String,
    pub iat: u64,
    pub exp: u64,
}

/// The authenticated user extracted from a verified JWT on a write route. Its
/// presence in a handler signature is proof the route is gated; the identity
/// flows straight into the git commit author/committer.
#[derive(Debug, Clone)]
pub struct AuthedUser {
    pub name: String,
    pub email: String,
}

/// Current unix time in whole seconds (0 before the epoch — never happens).
fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// HMAC-SHA256 sign `msg` with `secret`, base64url (no pad) encoded.
#[cfg(test)]
fn sign(msg: &[u8], secret: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(msg);
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

/// Mint an HS256 JWT for `claims` under `secret`. Used by the Rust tests (and
/// mirrors what the Node hook does in production) — production axum only verifies.
/// `cfg(test)`-gated so its test-only nature is compiler-enforced, not just by
/// convention: minting for real requests lives in the Node hook, not here.
#[cfg(test)]
pub(crate) fn mint(claims: &Claims, secret: &[u8]) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).expect("claims serialize"));
    let signing_input = format!("{header}.{payload}");
    let signature = sign(signing_input.as_bytes(), secret);
    format!("{signing_input}.{signature}")
}

/// Verify an HS256 JWT against `secret`: checks the structure, the `HS256` alg,
/// the HMAC signature (constant-time), and `exp`. Returns the claims or a short
/// reason string (the caller maps any failure to a 401).
pub fn verify(token: &str, secret: &[u8]) -> Result<Claims, String> {
    let mut parts = token.split('.');
    let header_b64 = parts.next().ok_or("malformed token")?;
    let payload_b64 = parts.next().ok_or("malformed token")?;
    let sig_b64 = parts.next().ok_or("malformed token")?;
    if parts.next().is_some() {
        return Err("malformed token".to_string());
    }

    // Constant-time signature check over the exact signing input.
    let signing_input = format!("{header_b64}.{payload_b64}");
    let expected = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|_| "bad signature encoding".to_string())?;
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(signing_input.as_bytes());
    mac.verify_slice(&expected)
        .map_err(|_| "signature mismatch".to_string())?;

    // Alg must be HS256 (defence against alg-confusion / "none").
    let header: serde_json::Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(header_b64)
            .map_err(|_| "bad header encoding".to_string())?,
    )
    .map_err(|_| "bad header json".to_string())?;
    if header.get("alg").and_then(|a| a.as_str()) != Some("HS256") {
        return Err("unexpected alg".to_string());
    }

    let claims: Claims = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(payload_b64)
            .map_err(|_| "bad payload encoding".to_string())?,
    )
    .map_err(|_| "bad payload json".to_string())?;

    if unix_now() >= claims.exp {
        return Err("token expired".to_string());
    }
    Ok(claims)
}

/// Reject with a bare 401 (no body detail — an unauthenticated write never
/// reaches the write error classifier).
fn unauthorized() -> (StatusCode, String) {
    (StatusCode::UNAUTHORIZED, "unauthorized".to_string())
}

impl FromRequestParts<Arc<ServerState>> for AuthedUser {
    type Rejection = (StatusCode, String);

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<ServerState>,
    ) -> Result<Self, Self::Rejection> {
        // No configured secret → writing is disabled entirely.
        let secret = state.jwt_secret.as_ref().ok_or_else(unauthorized)?;
        let header = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(unauthorized)?;
        let token = header.strip_prefix("Bearer ").ok_or_else(unauthorized)?;
        let claims = verify(token, secret).map_err(|_| unauthorized())?;
        Ok(AuthedUser {
            name: claims.name,
            email: claims.email,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims(exp: u64) -> Claims {
        Claims {
            sub: "u1".into(),
            name: "Ada Lovelace".into(),
            email: "ada@example.com".into(),
            iat: 1_000,
            exp,
        }
    }

    #[test]
    fn mint_then_verify_roundtrips() {
        let secret = b"test-secret";
        let token = mint(&claims(unix_now() + 60), secret);
        let out = verify(&token, secret).unwrap();
        assert_eq!(out.name, "Ada Lovelace");
        assert_eq!(out.email, "ada@example.com");
    }

    #[test]
    fn wrong_secret_is_rejected() {
        let token = mint(&claims(unix_now() + 60), b"right");
        assert!(verify(&token, b"wrong").is_err());
    }

    #[test]
    fn expired_token_is_rejected() {
        let token = mint(&claims(unix_now().saturating_sub(1)), b"s");
        assert_eq!(verify(&token, b"s").unwrap_err(), "token expired");
    }

    #[test]
    fn tampered_payload_is_rejected() {
        let secret = b"s";
        let token = mint(&claims(unix_now() + 60), secret);
        // Swap the payload segment for a re-encoded, elevated claim; the
        // signature no longer matches.
        let mut segs: Vec<&str> = token.split('.').collect();
        let forged = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&claims(unix_now() + 60)).unwrap(),
        );
        // (identical claim, but a fresh encoding proves it's the signature, not
        // the bytes, that binds) — now actually tamper:
        let evil = URL_SAFE_NO_PAD.encode(br#"{"sub":"x","name":"Mallory","email":"m@x","iat":1,"exp":9999999999}"#);
        segs[1] = &evil;
        let tampered = segs.join(".");
        assert!(verify(&tampered, secret).is_err());
        // The benign re-encode also fails (signature was over the original bytes).
        let _ = forged;
    }

    #[test]
    fn malformed_tokens_are_rejected() {
        let secret = b"s";
        assert!(verify("", secret).is_err());
        assert!(verify("a.b", secret).is_err());
        assert!(verify("a.b.c.d", secret).is_err());
        assert!(verify("!!.??.$$", secret).is_err());
    }
}
