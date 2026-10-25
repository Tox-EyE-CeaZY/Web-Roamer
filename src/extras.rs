//! Things the chrome asks the native side to fetch or start: instant answers, a site's search description and the
//! hand-over of image board links to Board Roamer. All of it runs off the event loop.

use std::{
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use serde_json::{json, Value};

use crate::{os, update};

pub fn pct(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

fn text(v: &Value, k: &str, max: usize) -> String {
    v[k].as_str().unwrap_or("").trim().chars().take(max).collect()
}

fn https(u: &str) -> String {
    if u.starts_with("http://") || u.starts_with("https://") {
        u.to_string()
    } else {
        String::new()
    }
}

/// DuckDuckGo's instant answer for a query (an abstract, a direct answer, a definition), or null when it has nothing.
pub fn instant(q: &str) -> Value {
    let url = format!("https://api.duckduckgo.com/?q={}&format=json&no_html=1&skip_disambig=1&t=webroamer", pct(q));
    let Some(v) = update::http(4).get(&url).call().ok().and_then(|r| r.into_string().ok()).and_then(|s| serde_json::from_str::<Value>(&s).ok()) else {
        return Value::Null;
    };
    let answer = match &v["Answer"] {
        Value::String(s) => s.trim().chars().take(300).collect(),
        _ => String::new(),
    };
    let mut related = Vec::new();
    if let Some(list) = v["RelatedTopics"].as_array() {
        for t in list.iter().filter(|t| t["Text"].is_string()).take(4) {
            related.push(json!({ "text": text(t, "Text", 160), "url": https(&text(t, "FirstURL", 300)) }));
        }
    }
    let image = text(&v, "Image", 300);
    let image = if image.starts_with('/') { format!("https://duckduckgo.com{image}") } else { https(&image) };
    let out = json!({
        "heading": text(&v, "Heading", 80),
        "text": if text(&v, "AbstractText", 600).is_empty() { text(&v, "Definition", 600) } else { text(&v, "AbstractText", 600) },
        "url": https(&if text(&v, "AbstractURL", 300).is_empty() { text(&v, "DefinitionURL", 300) } else { text(&v, "AbstractURL", 300) }),
        "source": if text(&v, "AbstractSource", 60).is_empty() { text(&v, "DefinitionSource", 60) } else { text(&v, "AbstractSource", 60) },
        "answer": answer,
        "image": image,
        "related": related,
    });
    if out["text"] == "" && out["answer"] == "" && out["related"].as_array().is_some_and(|r| r.is_empty()) {
        Value::Null
    } else {
        out
    }
}

/// The value of an attribute inside one tag's text.
fn attr(tag: &str, name: &str) -> Option<String> {
    let low = tag.to_ascii_lowercase();
    let at = low.find(&format!("{name}="))? + name.len() + 1;
    let rest = &tag[at..];
    let q = rest.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let end = rest[1..].find(q)?;
    Some(rest[1..1 + end].replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\""))
}

/// A site's OpenSearch description → (name, search address with %s where the words go).
pub fn opensearch(href: &str) -> Option<(String, String)> {
    let mut xml = String::new();
    update::http(4).get(href).call().ok()?.into_reader().take(200_000).read_to_string(&mut xml).ok()?;
    let name = xml
        .find("<ShortName>")
        .and_then(|i| xml[i + 11..].find("</ShortName>").map(|j| xml[i + 11..i + 11 + j].trim().to_string()))
        .filter(|n| !n.is_empty())?;
    let mut from = 0;
    while let Some(i) = xml[from..].find("<Url") {
        let start = from + i;
        let end = xml[start..].find('>').map(|j| start + j)?;
        let tag = &xml[start..end];
        from = end;
        let kind = attr(tag, "type").unwrap_or_default();
        if !(kind.is_empty() || kind.contains("html")) || attr(tag, "method").is_some_and(|m| m.eq_ignore_ascii_case("post")) {
            continue;
        }
        let Some(t) = attr(tag, "template") else { continue };
        // {searchTerms} is the words; every other placeholder is left out
        let mut out = String::new();
        let mut rest = t.as_str();
        while let Some(o) = rest.find('{') {
            out.push_str(&rest[..o]);
            let Some(c) = rest[o..].find('}') else { break };
            if rest[o + 1..o + c].starts_with("searchTerms") {
                out.push_str("%s");
            }
            rest = &rest[o + c + 1..];
        }
        out.push_str(rest);
        if out.starts_with("http") && out.contains("%s") {
            return Some((name.chars().take(40).collect(), out));
        }
    }
    None
}

fn board_roamer_exe(hint: &str) -> Option<PathBuf> {
    let hint = Path::new(hint);
    if !hint.as_os_str().is_empty() && hint.is_file() {
        return Some(hint.to_path_buf());
    }
    // Board Roamer notes where it lives each time it starts
    let note = os::data_dir().parent()?.join("BoardRoamer").join("exe.path");
    if let Some(p) = std::fs::read_to_string(note).ok().map(|s| PathBuf::from(s.trim())).filter(|p| p.is_file()) {
        return Some(p);
    }
    let home = os::home();
    let mut dirs = vec![home.join("Downloads"), home.join("Desktop")];
    if cfg!(windows) {
        if let Some(l) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(l).join("Programs").join("Board Roamer"));
        }
        dirs.push(PathBuf::from(r"C:\Program Files\Board Roamer"));
    }
    for d in dirs {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_ascii_lowercase().replace(' ', "-");
            let ext = if cfg!(windows) { n.ends_with(".exe") } else { !n.contains('.') };
            if n.starts_with("board-roamer") && ext && e.path().is_file() {
                return Some(e.path());
            }
        }
    }
    None
}

/// Show a link in Board Roamer: in the running one, or by starting it. Err says why that was not possible.
pub fn board_roamer(link: &str, hint: &str) -> Result<(), &'static str> {
    let agent = update::http(2);
    let base = "http://127.0.0.1:4621";
    let running = agent.get(&format!("{base}/ping")).timeout(Duration::from_millis(600)).call().ok().and_then(|r| r.into_string().ok()).is_some_and(|b| b == "board-roamer");
    if running {
        return match agent.post(&format!("{base}/app/open")).timeout(Duration::from_millis(1500)).send_string(link) {
            Ok(_) => Ok(()),
            Err(_) => {
                let _ = agent.post(&format!("{base}/app/show")).call();
                Err("old")
            }
        };
    }
    #[cfg(target_os = "macos")]
    if hint.is_empty() && Path::new("/Applications/Board Roamer.app").exists() {
        return Command::new("open").args(["-a", "Board Roamer", "--args", "--open", link]).spawn().map(|_| ()).map_err(|_| "start");
    }
    let exe = board_roamer_exe(hint).ok_or("missing")?;
    os::quiet(Command::new(exe).arg("--open").arg(link)).spawn().map(|_| ()).map_err(|_| "start")
}
