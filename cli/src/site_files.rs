//! A site's files as FF serves them, by their names: the content type a file gets, as FF's website server gives one to
//! a file stored without its own, and how long a browser keeps it. `ff sites deploy` uploads each file with them, and
//! `ff local start`'s sites answer a `--site` folder's files with them.

/// The content type a file gets by its name's extension, as FF's website server gives one to a
/// file stored without its own (BE/src/storage/content-types.ts, which a test compares this with).
const CONTENT_TYPES: &[(&str, &str)] = &[
    ("html", "text/html; charset=utf-8"),
    ("htm", "text/html; charset=utf-8"),
    ("css", "text/css; charset=utf-8"),
    ("js", "text/javascript; charset=utf-8"),
    ("mjs", "text/javascript; charset=utf-8"),
    ("json", "application/json"),
    ("map", "application/json"),
    ("webmanifest", "application/manifest+json"),
    ("xml", "application/xml"),
    ("txt", "text/plain; charset=utf-8"),
    ("md", "text/markdown; charset=utf-8"),
    ("csv", "text/csv; charset=utf-8"),
    ("svg", "image/svg+xml"),
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("avif", "image/avif"),
    ("ico", "image/x-icon"),
    ("woff", "font/woff"),
    ("woff2", "font/woff2"),
    ("ttf", "font/ttf"),
    ("otf", "font/otf"),
    ("wasm", "application/wasm"),
    ("pdf", "application/pdf"),
    ("zip", "application/zip"),
    ("mp4", "video/mp4"),
    ("webm", "video/webm"),
    ("mp3", "audio/mpeg"),
    ("ogg", "audio/ogg"),
    ("wav", "audio/wav"),
];

/// A year, and never asked again: a file whose name changes with its content.
const IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// Kept, but asked again each time, which its ETag answers with 304 when it hasn't changed.
const REVALIDATE: &str = "no-cache";

/// A file's type by its name's extension; application/octet-stream for one not listed.
pub fn content_type(key: &str) -> &'static str {
    let name = key.rsplit('/').next().unwrap_or(key);
    match name.rfind('.') {
        Some(dot) if dot > 0 => {
            let extension = name[dot + 1..].to_ascii_lowercase();
            CONTENT_TYPES.iter().find(|(known, _)| *known == extension).map_or("application/octet-stream", |(_, t)| t)
        }
        _ => "application/octet-stream",
    }
}

/// Whether a file's name carries a hash of its content, as bundlers name assets
/// (`app-3c9d1a2b.js`, `main.8f3e2b1c.css`): its name's last part before the extension, after a
/// hyphen or a dot, 8 characters at least of letters, digits and underscores, with both letters
/// and digits. Any other file may change under the same name.
pub fn is_hashed(key: &str) -> bool {
    let name = key.rsplit('/').next().unwrap_or(key);
    let Some(stem) = name.rfind('.').filter(|dot| *dot > 0).map(|dot| &name[..dot]) else { return false };
    let Some(cut) = stem.rfind(['-', '.']) else { return false };
    let part = &stem[cut + 1..];
    part.len() >= 8
        && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && part.chars().any(|c| c.is_ascii_digit())
        && part.chars().any(|c| c.is_ascii_alphabetic())
}

/// How long browsers keep a file: a year for a hashed asset, never without asking for the rest,
/// HTML first, as FF's console serves its own.
pub fn cache_control(key: &str) -> &'static str {
    if is_hashed(key) && !content_type(key).starts_with("text/html") { IMMUTABLE } else { REVALIDATE }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn types_files_as_the_website_server_does() {
        // The website server's list, in the backend: the same names, the same types, in the same order.
        let source = include_str!("../../BE/src/storage/content-types.ts");
        let theirs: Vec<(String, String)> = source
            .lines()
            .filter_map(|line| {
                let (name, rest) = line.trim().split_once(": '")?;
                let value = rest.strip_suffix("',")?;
                name.chars().all(|c| c.is_ascii_alphanumeric()).then(|| (name.to_owned(), value.to_owned()))
            })
            .collect();
        let ours: Vec<(String, String)> =
            CONTENT_TYPES.iter().map(|(n, t)| ((*n).to_owned(), (*t).to_owned())).collect();
        assert_eq!(ours, theirs);
        assert_eq!(content_type("assets/App.JS"), "text/javascript; charset=utf-8");
        assert_eq!(content_type("docs/index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type("LICENSE"), "application/octet-stream");
        assert_eq!(content_type(".htaccess"), "application/octet-stream");
    }

    #[test]
    fn caches_hashed_assets_a_year_and_the_rest_never_without_asking() {
        for key in [
            "assets/app-3c9d1a2b.js",
            "assets/index-B4x9Qa1f.css",
            "static/js/main.8f3e2b1c.js",
            "img/logo-a1b2c3d4e5.svg",
        ] {
            assert_eq!(cache_control(key), IMMUTABLE, "{key}");
        }
        for key in [
            "index.html",
            "docs/page-1a2b3c4d.html",
            "favicon-32x32.png",
            "report-2026.pdf",
            "my-component.js",
            "robots.txt",
            "assets/index-DiwrgTda.js",
        ] {
            assert_eq!(cache_control(key), REVALIDATE, "{key}");
        }
    }
}
