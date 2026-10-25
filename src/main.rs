#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod os;
mod update;

use rust_embed::RustEmbed;
use serde_json::{json, Value};
use std::{borrow::Cow, cell::RefCell, collections::HashMap, path::PathBuf, rc::Rc, sync::Mutex};
use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy},
    window::{Fullscreen, Icon, ResizeDirection, Window, WindowBuilder},
};
#[cfg(target_os = "macos")]
use tao::platform::macos::WindowBuilderExtMacOS;
#[cfg(windows)]
use tao::platform::windows::WindowBuilderExtWindows;
use wry::{
    dpi::{LogicalPosition, LogicalSize},
    http::{header::CONTENT_TYPE, Request, Response},
    NewWindowResponse, PageLoadEvent, Rect, WebContext, WebView, WebViewBuilder,
};

/// The browser's own interface (title bar, tabs, address bar, start page, history...). Pages are separate web views laid over it.
#[derive(RustEmbed)]
#[folder = "ui/"]
struct Assets;

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(windows)]
const CHROME_ORIGIN: &str = "http://roamer.localhost/";
#[cfg(not(windows))]
const CHROME_ORIGIN: &str = "roamer://localhost/";

/// Runs in every page (main frame only): forwards the browser's shortcuts and mouse back/forward, reports the favicon,
/// in-page (pushState) navigations, sound, full screen and the site's look (see docs/SITE-THEMING.md), shows where a
/// hovered link goes and opens Ctrl/middle-clicked links in background tabs. A page can post these messages itself, so
/// the native side treats them as hints only.
const PAGE_JS: &str = r#"(() => {
  if (window.top !== window || window.__roamer) return;
  window.__roamer = 1;
  // wry's WebKitGTK side panics on a message from a file:// page, so those pages stay quiet there
  const quiet = window.__roamerQuietFiles && location.protocol === 'file:';
  const post = (m) => { if (quiet) return; try { window.ipc.postMessage(m); } catch (_) {} };
  const combo = (e) => ((e.ctrlKey || e.metaKey) ? 'c' : '') + (e.shiftKey ? 's' : '') + (e.altKey ? 'a' : '') + '+' + (e.key || '').toLowerCase();
  // the browser's own keys always win; the others only when the page did not use them itself (an editor's Ctrl+F ...)
  const HARD = new Set(['c+t','c+n','c+w','cs+t','cs+n','cs+w','c+tab','cs+tab','c+pageup','c+pagedown','cs+q','+f11']);
  const SOFT = new Set(['c+l','a+d','c+r','cs+r','c+d','c+h','c+j','cs+b','c+f','c+=','c++','cs++','c+-','c+0','c+1','c+2','c+3','c+4',
    'c+5','c+6','c+7','c+8','c+9','a+arrowleft','a+arrowright','c+,','cs+delete','+f5','+f6','+f12','c+f5','c+p','c+u','cs+a','cs+o',
    'a+home','a+f','a+e','cs+g','+f3','s+f3','c+g','cs+g']);
  addEventListener('keydown', (e) => {
    const k = combo(e);
    if (HARD.has(k)) { e.preventDefault(); e.stopImmediatePropagation(); post('key:' + k); }
  }, true);
  addEventListener('keydown', (e) => {
    const k = combo(e);
    if (!e.defaultPrevented && SOFT.has(k)) { e.preventDefault(); post('key:' + k); }
  });
  addEventListener('mouseup', (e) => { if (e.button === 3) history.back(); else if (e.button === 4) history.forward(); });
  let lastFocus = 0;
  const focused = () => { const n = Date.now(); if (n - lastFocus > 300) { lastFocus = n; post('focus'); } };
  addEventListener('pointerdown', focused, true);
  addEventListener('focus', focused, true);

  // Ctrl+click and middle click open links in a background tab, Shift+click in a new one
  const linkOf = (e) => { const a = e.target && e.target.closest && e.target.closest('a[href]'); return a && /^(https?|file):/i.test(a.href) ? a : null; };
  addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || !(e.ctrlKey || e.metaKey || e.shiftKey)) return;
    const a = linkOf(e);
    if (!a) return;
    e.preventDefault();
    post('open:' + (e.ctrlKey || e.metaKey ? 'bg:' : 'fg:') + a.href);
  });
  addEventListener('auxclick', (e) => {
    if (e.defaultPrevented || e.button !== 1) return;
    const a = linkOf(e);
    if (!a) return;
    e.preventDefault();
    post('open:bg:' + a.href);
  });

  // where a hovered link goes, in a little ticket at the bottom of the page
  let tip = null, tipText = null, tipTimer = 0;
  const showTip = (href, x, y) => {
    if (!tip) {
      const host = document.createElement('roamer-status');
      host.style.cssText = 'all:initial;position:fixed;left:0;bottom:0;z-index:2147483647;pointer-events:none;';
      const sr = host.attachShadow({ mode: 'closed' });
      sr.innerHTML = '<style>b{position:fixed;bottom:0;max-width:min(62vw,720px);padding:4px 10px 5px;font:500 12px/1.3 "JetBrains Mono","Cascadia Mono",Consolas,monospace;'
        + 'color:#eef3e6;background:#0e1a1d;border:1px solid #2c3d40;border-bottom:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
        + 'transition:opacity .12s;opacity:0}b.in{opacity:1}b.l{left:0;border-left:0;clip-path:polygon(0 0,calc(100% - 8px) 0,100% 8px,100% 100%,0 100%)}'
        + 'b.r{right:0;border-right:0;clip-path:polygon(8px 0,100% 0,100% 100%,0 100%,0 8px)}</style><b></b>';
      tipText = sr.querySelector('b');
      tip = host;
    }
    if (!tip.isConnected) document.documentElement.appendChild(tip);
    let t = href;
    try { t = decodeURI(href); } catch (_) {}
    tipText.textContent = t.replace(/^https:\/\//, '');
    // step out of the way when the pointer is down in the corner
    const right = x < innerWidth * 0.45 && y > innerHeight - 60;
    tipText.className = 'in ' + (right ? 'r' : 'l');
  };
  const hideTip = () => { if (tipText) tipText.className = tipText.className.replace('in', ''); };
  addEventListener('mouseover', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    clearTimeout(tipTimer);
    if (a && !/^javascript:/i.test(a.href)) showTip(a.href, e.clientX, e.clientY);
    else tipTimer = setTimeout(hideTip, 120);
  }, { passive: true, capture: true });
  addEventListener('focusin', (e) => { const a = e.target && e.target.closest && e.target.closest('a[href]'); if (a) showTip(a.href, 0, 0); else hideTip(); });
  addEventListener('blur', hideTip);

  // the favicon
  const icon = () => {
    const l = document.querySelector('link[rel~="icon"][href], link[rel="apple-touch-icon"][href]');
    post('icon:' + (l ? l.href : location.origin + '/favicon.ico'));
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', icon, { once: true }); else icon();
  const moved = () => post('url');
  for (const m of ['pushState', 'replaceState']) {
    const f = history[m];
    history[m] = function () { const r = f.apply(this, arguments); moved(); return r; };
  }
  addEventListener('popstate', moved);
  addEventListener('hashchange', moved);

  // full screen video and the like: the browser makes the page fill the window
  const fs = () => post('fs:' + (document.fullscreenElement || document.webkitFullscreenElement ? 1 : 0));
  document.addEventListener('fullscreenchange', fs);
  document.addEventListener('webkitfullscreenchange', fs);

  // sound, for the tab's speaker; the browser mutes a tab through window.__roamerMute
  let audible = false, soundTimer = 0;
  const sound = () => {
    clearTimeout(soundTimer);
    soundTimer = setTimeout(() => {
      const on = [...document.querySelectorAll('video, audio')].some((m) => !m.paused && !m.ended && !m.muted && m.volume > 0 && m.readyState > 2);
      if (on !== audible) { audible = on; post('audio:' + (on ? 1 : 0)); }
    }, 80);
  };
  for (const ev of ['play', 'playing', 'pause', 'ended', 'volumechange', 'emptied']) {
    document.addEventListener(ev, (e) => { if (window.__roamerMute && ev === 'play' && e.target) e.target.muted = true; sound(); }, true);
  }

  // the Site Theming SDK: <meta name="roamer-theme"> and window.roamer.theme.set(); plain theme-color too
  let sdkTheme = null, lastTheme = '';
  const readTheme = () => {
    let meta = null;
    const m = document.querySelector('meta[name="roamer-theme"][content]');
    if (m) {
      try { meta = JSON.parse(m.content); } catch (_) {
        meta = {};
        for (const part of m.content.split(';')) { const i = part.indexOf(':'); if (i > 0) meta[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
      }
    }
    let color = '';
    for (const t of document.querySelectorAll('meta[name="theme-color"][content]')) {
      const media = t.getAttribute('media');
      if (!media || matchMedia(media).matches) { color = t.content; break; }
    }
    const s = JSON.stringify({ sdk: sdkTheme || meta, color });
    if (s !== lastTheme) { lastTheme = s; post('theme:' + s); }
  };
  const clean = (t) => { try { return t && typeof t === 'object' ? JSON.parse(JSON.stringify(t)) : null; } catch (_) { return null; } };
  try {
    Object.defineProperty(window, 'roamer', { configurable: false, enumerable: false, writable: false, value: Object.freeze({
      browser: 'Web Roamer', sdk: 1,
      theme: Object.freeze({
        set: (t) => { sdkTheme = clean(t); readTheme(); },
        clear: () => { sdkTheme = null; readTheme(); },
      }),
    }) });
  } catch (_) {}
  const watchHead = () => {
    readTheme();
    if (document.head) new MutationObserver(readTheme).observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['content', 'name', 'media'] });
    try { dispatchEvent(new Event('roamer:ready')); } catch (_) {}
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', watchHead, { once: true }); else watchHead();
})();"#;

/// Things that happen inside a page's web view, reported back to the event loop.
enum Msg {
    Loading(bool, String),
    Title(String),
    Ipc(String),
    NewWindow(String),
    DlStart(String, PathBuf),
    DlDone(String, Option<PathBuf>, bool),
}

enum Ev {
    Chrome(String),
    Page(u32, Msg),
    /// search suggestions fetched in the background: (request number, query, suggestions)
    Suggest(u64, String, Vec<String>),
    /// progress of an update download (see update.rs)
    Update(Value),
}

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn serve(req: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let mut p = req.uri().path().trim_start_matches('/').to_string();
    if p.is_empty() {
        p = "index.html".into();
    }
    match Assets::get(&p) {
        Some(f) => Response::builder()
            .header(CONTENT_TYPE, mime(&p))
            .header("Cache-Control", "no-cache")
            .body(Cow::Owned(f.data.into_owned()))
            .unwrap(),
        None => Response::builder().status(404).body(Cow::Borrowed(&b"not found"[..])).unwrap(),
    }
}

/// The window, the chrome web view and one web view per open web page.
struct Browser {
    window: Window,
    #[cfg(target_os = "linux")]
    fixed: gtk::Fixed,
    ctx: WebContext,
    proxy: EventLoopProxy<Ev>,
    chrome: WebView,
    pages: HashMap<u32, WebView>,
    /// each page's address as of its last load event
    urls: HashMap<u32, String>,
    /// the pages on screen and where they go, in logical pixels, as laid out by the chrome (one page, or several on a
    /// desktop); every other page is hidden
    shown: Vec<(u32, (f64, f64, f64, f64))>,
    /// a menu or panel of the chrome is open over the page area, so pages are hidden
    overlay: bool,
    /// pages asked for their source (view source), waiting for it
    want_source: Vec<u32>,
    /// the window's size and place when it was last neither maximized nor full screen
    normal: Option<WinPlace>,
    /// a second window opened with "New window": it neither restores nor saves the tabs
    secondary: bool,
    dl_dir: Rc<RefCell<PathBuf>>,
    dl_pending: Vec<(u64, String)>,
    dl_next: u64,
    #[cfg(target_os = "linux")]
    dl_hooked: bool,
}

/// Where the window was, in logical pixels.
#[derive(Clone, Copy)]
struct WinPlace {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Browser {
    fn tell(&self, v: Value) {
        let _ = self.chrome.evaluate_script(&format!("window.__rr&&window.__rr({v})"));
    }

    fn full_rect(&self) -> Rect {
        let s = self.window.inner_size().to_logical::<f64>(self.window.scale_factor());
        Rect { position: LogicalPosition::new(0.0, 0.0).into(), size: LogicalSize::new(s.width, s.height).into() }
    }

    fn rect_of(&self, id: u32) -> Option<Rect> {
        let (_, (x, y, w, h)) = *self.shown.iter().find(|(i, _)| *i == id)?;
        Some(Rect { position: LogicalPosition::new(x, y).into(), size: LogicalSize::new(w.max(1.0), h.max(1.0)).into() })
    }

    fn push_state(&self) {
        self.tell(json!({ "t": "wstate", "max": self.window.is_maximized(), "fs": self.window.fullscreen().is_some() }));
    }

    fn sync_visibility(&self) {
        for (id, wv) in &self.pages {
            match self.rect_of(*id) {
                Some(r) if !self.overlay => {
                    let _ = wv.set_visible(true);
                    let _ = wv.set_bounds(r);
                }
                // WebKitGTK doesn't draw a view again once it was hidden, so there pages step off screen instead
                #[cfg(target_os = "linux")]
                r => {
                    let size = r.map_or(LogicalSize::new(800.0, 600.0).into(), |r| r.size);
                    let _ = wv.set_bounds(Rect { position: LogicalPosition::new(-30000.0, -30000.0).into(), size });
                }
                #[cfg(not(target_os = "linux"))]
                _ => {
                    let _ = wv.set_visible(false);
                }
            }
        }
    }

    /// Remember where the window is while it is a normal window, so the next start opens it there.
    fn note_place(&mut self) {
        let w = &self.window;
        if w.is_maximized() || w.fullscreen().is_some() || w.is_minimized() {
            return;
        }
        let f = w.scale_factor();
        let (Ok(pos), size) = (w.outer_position(), w.inner_size()) else { return };
        let (pos, size) = (pos.to_logical::<f64>(f), size.to_logical::<f64>(f));
        if size.width >= 200.0 && size.height >= 150.0 {
            self.normal = Some(WinPlace { x: pos.x, y: pos.y, w: size.width, h: size.height });
        }
    }

    fn save_place(&self) {
        if self.secondary {
            return;
        }
        let Some(p) = self.normal else { return };
        let v = json!({ "x": p.x, "y": p.y, "w": p.w, "h": p.h, "max": self.window.is_maximized() });
        let _ = std::fs::write(os::data_dir().join("window.json"), v.to_string());
    }

    fn make_page(&mut self, id: u32, url: &str) -> Option<WebView> {
        let rect = self.rect_of(id).unwrap_or(Rect { position: LogicalPosition::new(0.0, 0.0).into(), size: LogicalSize::new(1.0, 1.0).into() });
        let sender = |p: EventLoopProxy<Ev>| {
            move |m: Msg| {
                let _ = p.send_event(Ev::Page(id, m));
            }
        };
        let (s_ipc, s_load, s_title) = (sender(self.proxy.clone()), sender(self.proxy.clone()), sender(self.proxy.clone()));
        let popup = Mutex::new(self.proxy.clone());
        let page_js_linux = format!("window.__roamerQuietFiles=1;{PAGE_JS}");
        let builder = WebViewBuilder::new_with_web_context(&mut self.ctx)
            .with_url(url)
            .with_bounds(rect)
            .with_visible(false)
            .with_devtools(true)
            .with_initialization_script(if cfg!(target_os = "linux") { &page_js_linux } else { PAGE_JS })
            .with_ipc_handler(move |r| s_ipc(Msg::Ipc(r.body().clone())))
            .with_on_page_load_handler(move |e, u| s_load(Msg::Loading(matches!(e, PageLoadEvent::Started), u)))
            .with_document_title_changed_handler(move |t| s_title(Msg::Title(t)))
            .with_new_window_req_handler(move |u, _| {
                // links that want a new window (target=_blank, window.open) open as a tab instead
                if let Ok(p) = popup.lock() {
                    let _ = p.send_event(Ev::Page(id, Msg::NewWindow(u)));
                }
                NewWindowResponse::Deny
            });
        // Linux downloads are wired up on the shared web context instead (linux_downloads)
        #[cfg(not(target_os = "linux"))]
        let builder = {
            let (s_dl, s_done) = (sender(self.proxy.clone()), sender(self.proxy.clone()));
            let dl_dir = self.dl_dir.clone();
            builder
                .with_download_started_handler(move |u, path| {
                    *path = download_target(&dl_dir.borrow(), path, &u);
                    s_dl(Msg::DlStart(u, path.clone()));
                    true
                })
                .with_download_completed_handler(move |u, p, ok| s_done(Msg::DlDone(u, p, ok)))
        };
        #[cfg(not(target_os = "linux"))]
        let wv = builder.build_as_child(&self.window);
        #[cfg(target_os = "linux")]
        let wv = {
            use wry::WebViewBuilderExtUnix;
            builder.build_gtk(&self.fixed)
        };
        let wv = wv.map_err(|e| eprintln!("could not open a page: {e}")).ok()?;
        #[cfg(target_os = "linux")]
        {
            download_files(&wv);
            if !self.dl_hooked {
                self.dl_hooked = true;
                linux_downloads(&wv, self.proxy.clone(), self.dl_dir.clone());
            }
        }
        Some(wv)
    }

    fn navigate(&mut self, id: u32, url: &str) {
        if !is_web(url) {
            return;
        }
        if let Some(wv) = self.pages.get(&id) {
            let _ = wv.load_url(url);
        } else if let Some(wv) = self.make_page(id, url) {
            self.pages.insert(id, wv);
        }
        self.sync_visibility();
    }

    /// A page's real address (not what its scripts claim). WebKitGTK's url() panics on file:// addresses, so those come
    /// from the last load event instead.
    fn real_url(&self, id: u32) -> String {
        let known = self.urls.get(&id).cloned().unwrap_or_default();
        if !known.starts_with("http") {
            return known;
        }
        self.pages.get(&id).and_then(|w| w.url().ok()).unwrap_or(known)
    }

    fn page(&self, v: &Value) -> Option<&WebView> {
        self.pages.get(&(v["id"].as_u64()? as u32))
    }

    /// Fetch search suggestions off the event loop; they come back as Ev::Suggest.
    fn suggest(&self, n: u64, engine: &str, q: String) {
        let enc: String = q.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
        let url = match engine {
            "google" => format!("https://suggestqueries.google.com/complete/search?client=firefox&q={enc}"),
            "bing" => format!("https://api.bing.com/osjson.aspx?query={enc}"),
            "brave" => format!("https://search.brave.com/api/suggest?q={enc}"),
            _ => format!("https://duckduckgo.com/ac/?q={enc}&type=list"),
        };
        let proxy = self.proxy.clone();
        std::thread::spawn(move || {
            let agent = update::http(4);
            let list = agent
                .get(&url)
                .call()
                .ok()
                .and_then(|r| r.into_string().ok())
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .and_then(|v| v.get(1).and_then(|l| l.as_array().cloned()))
                .map(|l| l.iter().filter_map(|x| x.as_str().map(|s| s.chars().take(200).collect::<String>())).take(8).collect())
                .unwrap_or_default();
            let _ = proxy.send_event(Ev::Suggest(n, q, list));
        });
    }

    /// A message from the chrome (ui/js/native.js).
    fn on_chrome(&mut self, body: &str, flow: &mut ControlFlow) {
        let Ok(v) = serde_json::from_str::<Value>(body) else { return };
        let id = v["id"].as_u64().map(|i| i as u32);
        let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
        if std::env::var_os("ROAMER_DEBUG").is_some() {
            eprintln!("chrome: {}", body.chars().take(200).collect::<String>());
        }
        match s("t").as_str() {
            "ready" => {
                self.tell(json!({ "t": "init", "plat": os::os_name(), "version": VERSION, "downloads": os::downloads_dir(),
                    "data": os::data_dir(), "secondary": self.secondary,
                    "selfUpdate": update::asset_name().is_some(), "staged": update::staged_tag() }));
                self.push_state();
            }
            "nav" => {
                if let Some(id) = id {
                    self.navigate(id, &s("url"));
                }
            }
            "drop" => {
                if let Some(id) = id {
                    self.pages.remove(&id); // dropping the web view closes the page
                    self.urls.remove(&id);
                    self.shown.retain(|(i, _)| *i != id);
                    self.want_source.retain(|i| *i != id);
                }
            }
            "layout" => {
                // [{id, x, y, w, h}, ...]: the pages to show and where
                let n = |p: &Value, k: &str| p[k].as_f64().unwrap_or(0.0);
                self.shown = v["views"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|p| Some((p["id"].as_u64()? as u32, (n(p, "x"), n(p, "y"), n(p, "w"), n(p, "h"))))).collect())
                    .unwrap_or_default();
                self.sync_visibility();
            }
            "overlay" => {
                self.overlay = v["on"].as_bool().unwrap_or(false);
                self.sync_visibility();
            }
            "focus" => {
                if let Some(wv) = self.page(&v) {
                    let _ = wv.focus();
                }
            }
            "focuschrome" => {
                let _ = self.chrome.focus();
            }
            t @ ("back" | "fwd" | "stop" | "reload" | "hardreload" | "zoom" | "find" | "devtools" | "print" | "mute" | "source") => {
                if t == "source" {
                    if let Some(id) = id.filter(|i| self.pages.contains_key(i)) {
                        self.want_source.push(id);
                    }
                }
                let Some(wv) = self.page(&v) else { return };
                let _ = match t {
                    "back" => wv.evaluate_script("history.back()"),
                    "fwd" => wv.evaluate_script("history.forward()"),
                    "stop" => wv.evaluate_script("window.stop()"),
                    "reload" => wv.reload(),
                    "hardreload" => wv.evaluate_script("location.reload()"),
                    "zoom" => wv.zoom(v["z"].as_f64().unwrap_or(1.0).clamp(0.25, 5.0)),
                    "devtools" => {
                        wv.open_devtools();
                        Ok(())
                    }
                    "print" => wv.print(),
                    "mute" => {
                        let on = v["on"].as_bool().unwrap_or(false);
                        wv.evaluate_script(&format!(
                            "window.__roamerMute={on};document.querySelectorAll('video,audio').forEach(m=>{{if({on}){{if(!m.muted){{m.muted=true;m.__rm=1}}}}else if(m.__rm){{m.muted=false;m.__rm=0}}}})"
                        ))
                    }
                    "source" => {
                        // the page fetches its own address (with its cookies) and posts the text back as src:...
                        wv.evaluate_script(
                            "fetch(location.href,{credentials:'include',cache:'force-cache'}).then(r=>r.text()).catch(()=>document.documentElement.outerHTML)\
                             .then(t=>window.ipc.postMessage('src:'+t))",
                        )
                    }
                    _ => {
                        let q = serde_json::to_string(&s("q")).unwrap_or_default();
                        let back = v["back"].as_bool().unwrap_or(false);
                        let (p, tab) = (Mutex::new(self.proxy.clone()), id.unwrap_or(0));
                        // a new search starts from the top instead of from the last match
                        let reset = if v["fresh"].as_bool() == Some(true) { "window.getSelection().removeAllRanges();" } else { "" };
                        // also count the matches in the visible text, for "3 / 12"
                        let script = format!(
                            "(()=>{{{reset}const q={q};const f=window.find(q,false,{back},true);let n=0;\
                             try{{const t=(document.body&&document.body.innerText||'').toLowerCase(),w=q.toLowerCase();if(w)for(let i=t.indexOf(w);i>=0&&n<9999;i=t.indexOf(w,i+w.length))n++;}}catch(_){{}}\
                             return f+':'+n}})()"
                        );
                        wv.evaluate_script_with_callback(&script, move |r| {
                            if let Ok(p) = p.lock() {
                                let _ = p.send_event(Ev::Page(tab, Msg::Ipc(format!("found:{}", r.trim_matches('"')))));
                            }
                        })
                    }
                };
            }
            "suggest" => {
                let q = s("q");
                if !q.trim().is_empty() && q.len() < 400 {
                    self.suggest(v["n"].as_u64().unwrap_or(0), &s("engine"), q);
                }
            }
            "newwindow" => {
                if let Ok(exe) = std::env::current_exe() {
                    let mut cmd = std::process::Command::new(exe);
                    cmd.arg("--new-window");
                    let url = s("url");
                    if is_web(&url) {
                        cmd.arg(url);
                    }
                    let _ = os::quiet(&mut cmd).spawn();
                }
            }
            "update" => {
                // download the newest release in the background; progress arrives as Ev::Update
                let proxy = self.proxy.clone();
                std::thread::spawn(move || update::download(|v| {
                    let _ = proxy.send_event(Ev::Update(v));
                }));
            }
            "applyupdate" => {
                if update::apply() {
                    self.save_place();
                    *flow = ControlFlow::Exit;
                } else {
                    self.tell(json!({ "t": "update", "state": "error", "error": "Could not replace the program file. Download it from the release page instead." }));
                }
            }
            "savefile" => {
                // a file the chrome made (exported bookmarks ...): into the downloads folder, then shown there
                let dir = self.dl_dir.borrow().clone();
                let _ = std::fs::create_dir_all(&dir);
                let path = os::unique_path(&dir, &os::download_name(std::path::Path::new(&s("name")), ""));
                let ok = std::fs::write(&path, s("text")).is_ok();
                if ok {
                    os::reveal(&path);
                }
                self.tell(json!({ "t": "saved", "ok": ok, "path": path }));
            }
            "dldir" => {
                let p = s("path");
                let p = p.trim();
                *self.dl_dir.borrow_mut() = if p.is_empty() { os::downloads_dir() } else { PathBuf::from(p) };
            }
            "openfile" => os::open(&PathBuf::from(s("path"))),
            "reveal" => os::reveal(&PathBuf::from(s("path"))),
            "clear" => {
                // cookies, cache and storage of every site; the chrome clears its own history itself
                if let Some(wv) = self.pages.values().next() {
                    let _ = wv.clear_all_browsing_data();
                }
            }
            "title" => self.window.set_title(&s("s")),
            "win" => {
                match s("c").as_str() {
                    "min" => self.window.set_minimized(true),
                    "max" => self.window.set_maximized(!self.window.is_maximized()),
                    "close" => {
                        self.save_place();
                        *flow = ControlFlow::Exit;
                    }
                    "drag" => {
                        if self.window.fullscreen().is_none() {
                            let _ = self.window.drag_window();
                        }
                    }
                    "fs" | "fson" | "fsoff" => {
                        let on = match s("c").as_str() {
                            "fson" => true,
                            "fsoff" => false,
                            _ => self.window.fullscreen().is_none(),
                        };
                        if on != self.window.fullscreen().is_some() {
                            self.window.set_fullscreen(on.then_some(Fullscreen::Borderless(None)));
                        }
                    }
                    c => {
                        let dir = match c.strip_prefix("resize:").unwrap_or("") {
                            "N" => Some(ResizeDirection::North),
                            "S" => Some(ResizeDirection::South),
                            "E" => Some(ResizeDirection::East),
                            "W" => Some(ResizeDirection::West),
                            "NE" => Some(ResizeDirection::NorthEast),
                            "NW" => Some(ResizeDirection::NorthWest),
                            "SE" => Some(ResizeDirection::SouthEast),
                            "SW" => Some(ResizeDirection::SouthWest),
                            _ => None,
                        };
                        if let Some(d) = dir {
                            let _ = self.window.drag_resize_window(d);
                        }
                    }
                }
                self.push_state();
            }
            _ => {}
        }
    }

    fn on_page(&mut self, id: u32, m: Msg) {
        match m {
            Msg::Loading(started, url) => {
                self.urls.insert(id, url.clone());
                self.tell(json!({ "t": "tab", "id": id, "loading": started, "url": url }));
            }
            Msg::Title(title) => self.tell(json!({ "t": "tab", "id": id, "title": title })),
            Msg::Ipc(s) => {
                if let Some(k) = s.strip_prefix("key:") {
                    self.tell(json!({ "t": "key", "id": id, "k": k }));
                } else if let Some(icon) = s.strip_prefix("icon:") {
                    if icon.starts_with("https://") || icon.starts_with("http://") || icon.starts_with("data:image/") {
                        self.tell(json!({ "t": "tab", "id": id, "icon": icon }));
                    }
                } else if s == "url" {
                    // read the real address rather than trusting the page
                    let u = self.real_url(id);
                    if !u.is_empty() {
                        self.urls.insert(id, u.clone());
                        self.tell(json!({ "t": "tab", "id": id, "url": u }));
                    }
                } else if s == "focus" {
                    self.tell(json!({ "t": "pagefocus", "id": id }));
                } else if let Some(r) = s.strip_prefix("found:") {
                    let (ok, n) = r.split_once(':').unwrap_or((r, "0"));
                    self.tell(json!({ "t": "found", "id": id, "ok": ok.trim() == "true", "n": n.trim().parse::<u32>().unwrap_or(0) }));
                } else if let Some(rest) = s.strip_prefix("open:") {
                    let (bg, url) = match rest.split_once(':') {
                        Some(("bg", u)) => (true, u),
                        Some(("fg", u)) => (false, u),
                        _ => return,
                    };
                    if is_web(url) {
                        self.tell(json!({ "t": "newtab", "url": url, "opener": id, "bg": bg }));
                    }
                } else if let Some(on) = s.strip_prefix("fs:") {
                    self.tell(json!({ "t": "pagefs", "id": id, "on": on == "1" }));
                } else if let Some(on) = s.strip_prefix("audio:") {
                    self.tell(json!({ "t": "tab", "id": id, "audible": on == "1" }));
                } else if let Some(theme) = s.strip_prefix("theme:") {
                    // the chrome checks every value; here it only has to be small and well-formed
                    if theme.len() <= 8192 {
                        if let Ok(t) = serde_json::from_str::<Value>(theme) {
                            let url = self.real_url(id);
                            self.tell(json!({ "t": "sitetheme", "id": id, "theme": t, "url": url }));
                        }
                    }
                } else if let Some(text) = s.strip_prefix("src:") {
                    if let Some(i) = self.want_source.iter().position(|w| *w == id) {
                        self.want_source.remove(i);
                        let url = self.real_url(id);
                        let text: String = text.chars().take(4_000_000).collect();
                        self.tell(json!({ "t": "source", "id": id, "url": url, "text": text }));
                    }
                }
            }
            Msg::NewWindow(url) => {
                if is_web(&url) {
                    self.tell(json!({ "t": "newtab", "url": url, "opener": id }));
                }
            }
            Msg::DlStart(url, path) => {
                self.dl_next += 1;
                let dl = self.dl_next;
                self.dl_pending.push((dl, url.clone()));
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                self.tell(json!({ "t": "dl", "dl": dl, "url": url, "path": path, "name": name, "state": "active" }));
            }
            Msg::DlDone(url, path, ok) => {
                let Some(i) = self.dl_pending.iter().position(|(_, u)| *u == url) else { return };
                let (dl, _) = self.dl_pending.remove(i);
                let mut v = json!({ "t": "dl", "dl": dl, "state": if ok { "done" } else { "failed" } });
                if let Some(p) = path {
                    v["path"] = json!(p);
                }
                self.tell(v);
            }
        }
    }
}

/// Where a download goes: the downloads folder, under the name the site suggested (or the URL's), never over an existing file.
fn download_target(dir: &std::path::Path, suggested: &std::path::Path, url: &str) -> PathBuf {
    let _ = std::fs::create_dir_all(dir);
    os::unique_path(dir, &os::download_name(suggested, url))
}

/// WebKitGTK leaves a response it cannot show (a zip, an installer, anything sent as an attachment) to the app,
/// and doing nothing means the click does nothing. Turn those into downloads like the other platforms do.
#[cfg(target_os = "linux")]
fn download_files(wv: &WebView) {
    use gtk::glib::Cast;
    use webkit2gtk::{PolicyDecisionExt, PolicyDecisionType, ResponsePolicyDecision, ResponsePolicyDecisionExt, URIResponseExt, WebViewExt};
    use wry::WebViewExtUnix;
    wv.webview().connect_decide_policy(|_, decision, kind| {
        if kind != PolicyDecisionType::Response {
            return false;
        }
        let Some(d) = decision.downcast_ref::<ResponsePolicyDecision>() else { return false };
        let attachment = d
            .response()
            .and_then(|r| r.http_headers())
            .and_then(|h| h.one("Content-Disposition"))
            .map_or(false, |v| v.trim_start().to_ascii_lowercase().starts_with("attachment"));
        if attachment || !d.is_mime_type_supported() {
            decision.download();
            return true;
        }
        false
    });
}

/// Downloads on Linux. wry's own hook waits for WebKit's decide-destination signal, which never comes on recent WebKitGTK,
/// so files landed in whatever folder the app was started from. Pick the destination as soon as the download starts instead.
/// Hooked once: every page shares the one web context.
#[cfg(target_os = "linux")]
fn linux_downloads(wv: &WebView, proxy: EventLoopProxy<Ev>, dl_dir: Rc<RefCell<PathBuf>>) {
    use std::cell::Cell;
    use webkit2gtk::{Download, DownloadExt, URIRequestExt, URIResponseExt, WebContextExt, WebViewExt};
    use wry::WebViewExtUnix;
    let Some(ctx) = wv.webview().context() else { return };
    ctx.connect_download_started(move |_, d| {
        let url = d.request().and_then(|r| r.uri()).map(|u| u.to_string()).unwrap_or_default();
        let target: Rc<RefCell<Option<PathBuf>>> = Rc::default();
        let place = {
            let (proxy, dl_dir, url, target) = (proxy.clone(), dl_dir.clone(), url.clone(), target.clone());
            move |d: &Download, suggested: &str| {
                if target.borrow().is_some() {
                    return;
                }
                let path = download_target(&dl_dir.borrow(), std::path::Path::new(suggested), &url);
                if let Ok(uri) = gtk::glib::filename_to_uri(&path, None) {
                    d.set_destination(&uri);
                }
                *target.borrow_mut() = Some(path.clone());
                let _ = proxy.send_event(Ev::Page(0, Msg::DlStart(url.clone(), path)));
            }
        };
        // Choose now: WebKitGTK 2.52 never emits decide-destination for these and quietly drops the file in the working
        // folder. The response (and the site's file name) is usually not in yet, so the name comes from the URL.
        place(d, &d.response().and_then(|r| r.suggested_filename()).unwrap_or_default());
        let failed = Rc::new(Cell::new(false));
        let f = failed.clone();
        d.connect_failed(move |_, _| f.set(true));
        let (proxy, url) = (proxy.clone(), url.clone());
        d.connect_finished(move |_| {
            let ok = !failed.get() && target.borrow().is_some();
            let _ = proxy.send_event(Ev::Page(0, Msg::DlDone(url.clone(), target.borrow().clone().filter(|_| ok), ok)));
        });
    });
}

fn is_web(url: &str) -> bool {
    let u = url.to_ascii_lowercase();
    u.starts_with("http://") || u.starts_with("https://") || u.starts_with("file://") || u.starts_with("about:") || u.starts_with("data:")
}

/// macOS apps need a menu bar for Cmd+C / Cmd+V / Cmd+Q to work inside a web view.
#[cfg(target_os = "macos")]
fn install_menu() {
    use muda::{Menu, PredefinedMenuItem, Submenu};
    let menu = Menu::new();
    let app = Submenu::new("Web Roamer", true);
    let _ = app.append_items(&[
        &PredefinedMenuItem::about(None, None),
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::hide(None),
        &PredefinedMenuItem::hide_others(None),
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::quit(None),
    ]);
    let edit = Submenu::new("Edit", true);
    let _ = edit.append_items(&[
        &PredefinedMenuItem::undo(None),
        &PredefinedMenuItem::redo(None),
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::cut(None),
        &PredefinedMenuItem::copy(None),
        &PredefinedMenuItem::paste(None),
        &PredefinedMenuItem::select_all(None),
    ]);
    let window = Submenu::new("Window", true);
    let _ = window.append_items(&[&PredefinedMenuItem::minimize(None), &PredefinedMenuItem::fullscreen(None)]);
    let _ = menu.append_items(&[&app, &edit, &window]);
    menu.init_for_nsapp();
    std::mem::forget(menu);
}

/// Where the window was last time (window.json in the data folder), if that is still on a screen.
fn saved_place(event_loop: &tao::event_loop::EventLoop<Ev>) -> Option<(WinPlace, bool)> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(os::data_dir().join("window.json")).ok()?).ok()?;
    let n = |k: &str| v[k].as_f64();
    let p = WinPlace { x: n("x")?, y: n("y")?, w: n("w")?.clamp(640.0, 10000.0), h: n("h")?.clamp(420.0, 10000.0) };
    // a screen that was unplugged since: keep the size, let the system place it
    let visible = event_loop.available_monitors().any(|m| {
        let f = m.scale_factor();
        let (mp, ms) = (m.position().to_logical::<f64>(f), m.size().to_logical::<f64>(f));
        p.x + 80.0 > mp.x && p.x < mp.x + ms.width - 80.0 && p.y + 20.0 > mp.y && p.y < mp.y + ms.height - 40.0
    });
    let p = if visible { p } else { WinPlace { x: f64::NAN, ..p } };
    Some((p, v["max"].as_bool().unwrap_or(false)))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version") {
        println!("Web Roamer {VERSION}");
        return;
    }
    let secondary = args.iter().any(|a| a == "--new-window");
    if !secondary {
        update::tidy();
    }
    // web addresses on the command line open as the first tabs (also how the system hands us links once we're the default browser)
    let start: Vec<String> = args.iter().skip(1).filter(|a| is_web(a)).cloned().collect();

    // WebKitGTK sometimes ignores the destination we pick and saves into the working folder; make that the downloads folder
    #[cfg(target_os = "linux")]
    {
        let _ = std::fs::create_dir_all(os::downloads_dir());
        let _ = std::env::set_current_dir(os::downloads_dir());
    }

    let event_loop = EventLoopBuilder::<Ev>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    #[cfg(target_os = "macos")]
    install_menu();
    let icon = Icon::from_rgba(include_bytes!("../assets/icon-64.rgba").to_vec(), 64, 64).ok();
    let place = if secondary { None } else { saved_place(&event_loop) };
    // Windows and Linux get our own title bar (ui/js/app.js); macOS keeps its traffic lights over a see-through bar.
    #[allow(unused_mut)]
    let mut wb = WindowBuilder::new()
        .with_title("Web Roamer")
        .with_window_icon(icon)
        .with_decorations(cfg!(target_os = "macos"))
        .with_inner_size(place.map_or(tao::dpi::LogicalSize::new(1440.0, 900.0), |(p, _)| tao::dpi::LogicalSize::new(p.w, p.h)))
        .with_min_inner_size(tao::dpi::LogicalSize::new(640.0, 420.0))
        .with_maximized(place.is_some_and(|(_, max)| max));
    if let Some((p, _)) = place.filter(|(p, _)| !p.x.is_nan()) {
        wb = wb.with_position(tao::dpi::LogicalPosition::new(p.x, p.y));
    }
    #[cfg(windows)]
    {
        wb = wb.with_undecorated_shadow(true);
    }
    #[cfg(target_os = "macos")]
    {
        wb = wb.with_titlebar_transparent(true).with_title_hidden(true).with_fullsize_content_view(true);
    }
    let window = wb.build(&event_loop).expect("window");

    #[cfg(target_os = "linux")]
    let fixed = {
        use gtk::prelude::*;
        use tao::platform::unix::WindowExtUnix;
        let fixed = gtk::Fixed::new();
        let vbox = window.default_vbox().expect("window layout");
        vbox.pack_start(&fixed, true, true, 0);
        fixed.show_all();
        fixed
    };

    let mut ctx = WebContext::new(Some(os::data_dir().join("profile")));
    let size = window.inner_size().to_logical::<f64>(window.scale_factor());
    let chrome_proxy = proxy.clone();
    let boot = format!("window.__plat='{}';window.__start={};window.__secondary={secondary};", os::os_name(), json!(start));
    let builder = WebViewBuilder::new_with_web_context(&mut ctx)
        .with_custom_protocol("roamer".into(), |_, req| serve(req))
        .with_url(format!("{CHROME_ORIGIN}index.html"))
        .with_bounds(Rect { position: LogicalPosition::new(0.0, 0.0).into(), size: LogicalSize::new(size.width, size.height).into() })
        .with_background_color((10, 17, 19, 255))
        .with_devtools(cfg!(debug_assertions))
        .with_initialization_script(boot)
        // the chrome never navigates away (a link or file dropped on it would otherwise replace the whole interface)
        .with_navigation_handler(|u| u.starts_with(CHROME_ORIGIN))
        .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
        .with_ipc_handler(move |req| {
            let _ = chrome_proxy.send_event(Ev::Chrome(req.body().to_string()));
        });
    #[cfg(not(target_os = "linux"))]
    let chrome = builder.build_as_child(&window).expect("webview");
    #[cfg(target_os = "linux")]
    let chrome = {
        use wry::WebViewBuilderExtUnix;
        builder.build_gtk(&fixed).expect("webview")
    };

    let mut b = Browser {
        window,
        #[cfg(target_os = "linux")]
        fixed,
        ctx,
        proxy,
        chrome,
        pages: HashMap::new(),
        urls: HashMap::new(),
        shown: Vec::new(),
        overlay: false,
        want_source: Vec::new(),
        normal: place.map(|(p, _)| p).filter(|p| !p.x.is_nan()),
        secondary,
        dl_dir: Rc::new(RefCell::new(os::downloads_dir())),
        dl_pending: Vec::new(),
        dl_next: 0,
        #[cfg(target_os = "linux")]
        dl_hooked: false,
    };
    b.note_place();

    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                b.save_place();
                *flow = ControlFlow::Exit;
            }
            Event::WindowEvent { event: WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }, .. } => {
                let _ = b.chrome.set_bounds(b.full_rect());
                b.note_place();
                b.push_state();
            }
            Event::WindowEvent { event: WindowEvent::Moved(_), .. } => b.note_place(),
            Event::UserEvent(Ev::Chrome(body)) => b.on_chrome(&body, flow),
            Event::UserEvent(Ev::Page(id, m)) => b.on_page(id, m),
            Event::UserEvent(Ev::Update(mut v)) => {
                v["t"] = json!("update");
                b.tell(v);
            }
            Event::UserEvent(Ev::Suggest(n, q, list)) => b.tell(json!({ "t": "suggest", "n": n, "q": q, "list": list })),
            _ => {}
        }
    });
}
