//! Updating from GitHub releases: find the newest release, download this system's file, check it against the
//! release's SHA256SUMS.txt, then swap it in for the running program and start it again.
//! A running exe can't be overwritten on Windows, but it can be renamed, so the old one steps aside as *.old
//! and is deleted on the next start.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::PathBuf,
    time::Duration,
};

const LATEST: &str = "https://api.github.com/repos/Tox-EyE-CeaZY/Web-Roamer/releases/latest";

/// The release file built for this system (see .github/workflows/build.yml), when this system can update itself.
pub fn asset_name() -> Option<&'static str> {
    if cfg!(all(windows, target_arch = "x86_64")) {
        Some("web-roamer-windows-x64.exe")
    } else if cfg!(all(windows, target_arch = "aarch64")) {
        Some("web-roamer-windows-arm64.exe")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some("web-roamer-linux-x64")
    } else {
        None // macOS ships as an app bundle in a zip: that one is opened from the release page instead
    }
}

/// An HTTP client using the system's own TLS (SChannel, Secure Transport, OpenSSL).
pub fn http(read_secs: u64) -> ureq::Agent {
    let mut b = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(read_secs))
        .user_agent(&format!("WebRoamer/{}", env!("CARGO_PKG_VERSION")));
    if let Ok(tls) = native_tls::TlsConnector::new() {
        b = b.tls_connector(std::sync::Arc::new(tls));
    }
    b.build()
}

fn agent() -> ureq::Agent {
    http(60)
}

/// Where the new program waits until the restart.
pub fn staged() -> PathBuf {
    crate::os::data_dir().join("update").join(asset_name().unwrap_or("web-roamer-new"))
}

/// Download and check the newest release. `report` gets progress messages for the chrome:
/// {state: "downloading", pct} → {state: "ready", tag} or {state: "error", error}.
pub fn download(report: impl Fn(Value)) {
    let fail = |e: String| report(json!({ "state": "error", "error": e }));
    let Some(name) = asset_name() else { return fail("This system updates from the release page".into()) };
    let rel: Value = match agent().get(LATEST).set("Accept", "application/vnd.github+json").call().map(|r| r.into_string()) {
        Ok(Ok(s)) => serde_json::from_str(&s).unwrap_or_default(),
        _ => return fail("Could not reach GitHub".into()),
    };
    let tag = rel["tag_name"].as_str().unwrap_or("").to_string();
    let assets = rel["assets"].as_array().cloned().unwrap_or_default();
    let url_of = |n: &str| assets.iter().find(|a| a["name"].as_str() == Some(n)).and_then(|a| a["browser_download_url"].as_str()).map(str::to_string);
    let Some(url) = url_of(name) else { return fail(format!("Release {tag} has no {name}")) };
    // the checksum the release was published with
    let want = url_of("SHA256SUMS.txt")
        .and_then(|u| agent().get(&u).call().ok()?.into_string().ok())
        .and_then(|sums| sums.lines().find(|l| l.trim_end().ends_with(name)).and_then(|l| l.split_whitespace().next()).map(str::to_lowercase));
    let Some(want) = want else { return fail("The release has no checksum for this file".into()) };

    let resp = match agent().get(&url).call() {
        Ok(r) => r,
        Err(e) => return fail(format!("Download failed: {e}")),
    };
    let total: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let path = staged();
    let _ = std::fs::create_dir_all(path.parent().unwrap());
    let part = path.with_extension("part");
    let Ok(mut out) = std::fs::File::create(&part) else { return fail("Could not write the download".into()) };
    let (mut rd, mut buf, mut got, mut hash, mut last) = (resp.into_reader(), vec![0u8; 64 * 1024], 0u64, Sha256::new(), 0u64);
    loop {
        let n = match rd.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => return fail(format!("Download failed: {e}")),
        };
        if out.write_all(&buf[..n]).is_err() {
            return fail("Could not write the download".into());
        }
        hash.update(&buf[..n]);
        got += n as u64;
        if total > 0 && got * 100 / total != last {
            last = got * 100 / total;
            report(json!({ "state": "downloading", "pct": last, "tag": tag }));
        }
    }
    drop(out);
    let have: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if have != want {
        let _ = std::fs::remove_file(&part);
        return fail("The download didn't match the release's checksum, so it was thrown away".into());
    }
    if std::fs::rename(&part, &path).is_err() {
        return fail("Could not keep the download".into());
    }
    let _ = std::fs::write(path.with_extension("tag"), &tag);
    report(json!({ "state": "ready", "tag": tag }));
}

/// The version waiting to be put in place, if one was downloaded.
pub fn staged_tag() -> Option<String> {
    staged().is_file().then(|| std::fs::read_to_string(staged().with_extension("tag")).ok()).flatten().map(|s| s.trim().to_string())
}

/// Put the downloaded program where this one is, and start it. Returns false (changing nothing) when it can't.
pub fn apply() -> bool {
    let (Ok(exe), new) = (std::env::current_exe(), staged()) else { return false };
    if !new.is_file() {
        return false;
    }
    let old = exe.with_extension("old");
    let _ = std::fs::remove_file(&old);
    if std::fs::rename(&exe, &old).is_err() {
        return false;
    }
    if std::fs::copy(&new, &exe).is_err() {
        let _ = std::fs::rename(&old, &exe); // put it back
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755));
    }
    let _ = std::fs::remove_file(&new);
    let _ = std::fs::remove_file(new.with_extension("tag"));
    let mut cmd = std::process::Command::new(&exe);
    crate::os::quiet(&mut cmd).spawn().is_ok()
}

/// Remove what the last update left behind.
pub fn tidy() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::fs::remove_file(exe.with_extension("old"));
    }
}
