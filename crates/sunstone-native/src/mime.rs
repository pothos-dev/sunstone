//! The ONE Content-Type table for **Attachment** bytes (ADR-0011).
//!
//! Both shells serve Attachment bytes — the desktop over the
//! `sunstone-asset://` URI scheme (`src-tauri/src/asset.rs`) and the web over
//! `GET /api/asset` (`sunstone-server`'s `routes_asset.rs`) — and they must
//! agree on the header, so the mapping lives here rather than twice.
//!
//! Deliberately a `match` and not a MIME-sniffing crate: the recognised set is
//! the Embed extension list from
//! [af-1](/tickets/attachment-files/af-1-attachment-files-in-concepts.md)
//! (`png`, `jpg`/`jpeg`, `gif`, `webp`, `avif`, `bmp`, `svg`), matched
//! case-insensitively. Anything else is served as opaque bytes, which is both
//! honest and inert in an `<img>`.

/// `Content-Security-Policy` sent with every Attachment response. An `<img>`
/// never runs an SVG's script, but the same URL opened as a *document* (a new
/// tab, a link) would run it in the app's origin; `sandbox` plus
/// `default-src 'none'` makes such a document inert while leaving inline SVG
/// styling intact. Sent alongside `X-Content-Type-Options: nosniff`, so an
/// `application/octet-stream` body is never sniffed into HTML.
pub const ATTACHMENT_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/// The `Content-Type` for a bundle-relative Attachment path, by extension.
/// Unknown / missing extension → `application/octet-stream`.
pub fn content_type_for(rel_path: &str) -> &'static str {
    let ext = rel_path
        .rsplit_once('.')
        // A dot in a *directory* segment is not an extension.
        .filter(|(_, ext)| !ext.contains('/'))
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_recognised_image_extension() {
        assert_eq!(content_type_for("a.png"), "image/png");
        assert_eq!(content_type_for("a.jpg"), "image/jpeg");
        assert_eq!(content_type_for("a.jpeg"), "image/jpeg");
        assert_eq!(content_type_for("a.gif"), "image/gif");
        assert_eq!(content_type_for("a.webp"), "image/webp");
        assert_eq!(content_type_for("a.avif"), "image/avif");
        assert_eq!(content_type_for("a.bmp"), "image/bmp");
        assert_eq!(content_type_for("a.svg"), "image/svg+xml");
    }

    #[test]
    fn extension_match_is_case_insensitive() {
        assert_eq!(content_type_for("assets/LOGO.PNG"), "image/png");
        assert_eq!(content_type_for("assets/photo.JpEg"), "image/jpeg");
    }

    #[test]
    fn unknown_or_missing_extension_is_octet_stream() {
        assert_eq!(content_type_for("a.md"), "application/octet-stream");
        assert_eq!(content_type_for("notes.tar.gz"), "application/octet-stream");
        assert_eq!(content_type_for("README"), "application/octet-stream");
        // A dot in a folder name is not the file's extension.
        assert_eq!(content_type_for("v1.2/README"), "application/octet-stream");
    }
}
