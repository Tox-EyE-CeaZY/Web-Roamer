//! The few things that differ between Windows, macOS and Linux: where files live and how to hand a file or folder to the system.

use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};

#[cfg_attr(not(windows), allow(dead_code))]
/// Spawn a child without flashing a console window (Windows only; a no-op elsewhere).
pub fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

pub fn home() -> PathBuf {
    env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")).map(PathBuf::from).unwrap_or_default()
}

/// Where the app keeps its own data (the browser profile: cookies, cache, the chrome's bookmarks and history).
pub fn data_dir() -> PathBuf {
    #[cfg(windows)]
    let base = env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = Some(home().join("Library").join("Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| Some(home().join(".local").join("share")));
    let d = base.unwrap_or_else(env::temp_dir).join("WebRoamer");
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn downloads_dir() -> PathBuf {
    home().join("Downloads")
}

pub fn os_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// Open a file with whatever the system uses for it.
pub fn open(path: &Path) {
    if !path.exists() {
        return;
    }
    #[cfg(windows)]
    let _ = quiet(Command::new("explorer").arg(path)).spawn();
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").arg(path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = Command::new("xdg-open").arg(path).spawn();
}

/// Show a file (selected) or a folder in the system file manager.
pub fn reveal(path: &Path) {
    let dir_of = |p: &Path| p.parent().map(Path::to_path_buf).unwrap_or_else(downloads_dir);
    #[cfg(windows)]
    {
        if path.is_dir() {
            let _ = quiet(Command::new("explorer").arg(path)).spawn();
        } else if path.exists() {
            let _ = quiet(Command::new("explorer").arg(format!("/select,{}", path.display()))).spawn();
        } else {
            let _ = quiet(Command::new("explorer").arg(dir_of(path))).spawn();
        }
    }
    #[cfg(target_os = "macos")]
    {
        if path.is_file() {
            let _ = Command::new("open").arg("-R").arg(path).spawn();
        } else {
            let _ = Command::new("open").arg(if path.is_dir() { path.to_path_buf() } else { dir_of(path) }).spawn();
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = Command::new("xdg-open").arg(if path.is_dir() { path.to_path_buf() } else { dir_of(path) }).spawn();
    }
}

/// A file name that is safe on every system, taken from a download's suggested path or its URL.
pub fn download_name(suggested: &Path, url: &str) -> String {
    let from_url = || {
        let path = url.split(['?', '#']).next().unwrap_or("");
        let last = path.rsplit('/').next().unwrap_or("");
        percent_decode(last)
    };
    let raw = suggested.file_name().map(|n| n.to_string_lossy().into_owned()).filter(|n| !n.is_empty()).unwrap_or_else(from_url);
    let clean: String = raw
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .collect();
    let clean = clean.trim().trim_matches('.').to_string();
    if clean.is_empty() { "download".into() } else { clean.chars().take(180).collect() }
}

/// `name.ext`, or `name (2).ext`, ... whichever doesn't exist yet in `dir`.
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    (2..10_000).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap_or(first)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
