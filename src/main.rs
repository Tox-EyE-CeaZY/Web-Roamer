#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod os;

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

/// Runs in every page (main frame only): forwards the browser's shortcuts and mouse back/forward, reports the favicon and
/// in-page (pushState) navigations. A page can post these itself, so the native side treats them as hints only.
const PAGE_JS: &str = r#"(() => {
  if (window.top !== window || window.__roamer) return;
  window.__roamer = 1;
  const post = (m) => { try { window.ipc.postMessage(m); } catch (_) {} };
  const KEYS = new Set(['c+t','c+w','cs+t','c+tab','cs+tab','c+l','a+d','c+r','cs+r','c+d','c+h','c+j','cs+b','c+f','c+=','c++','c+-','c+0',
    'c+1','c+2','c+3','c+4','c+5','c+6','c+7','c+8','c+9','a+arrowleft','a+arrowright','c+pageup','c+pagedown','c+,','cs+delete',
    '+f5','+f6','+f11','+f12','c+f5','c+n']);
  addEventListener('keydown', (e) => {
    const k = ((e.ctrlKey || e.metaKey) ? 'c' : '') + (e.shiftKey ? 's' : '') + (e.altKey ? 'a' : '') + '+' + (e.key || '').toLowerCase();
    if (KEYS.has(k)) { e.preventDefault(); e.stopImmediatePropagation(); post('key:' + k); }
  }, true);
  addEventListener('mouseup', (e) => { if (e.button === 3) history.back(); else if (e.button === 4) history.forward(); });
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
    /// the tab whose page is on screen (None: the chrome draws this tab itself, e.g. the start page)
    shown: Option<u32>,
    /// a menu or panel of the chrome is open over the page area, so pages are hidden
    overlay: bool,
    /// where pages go, in logical pixels, as measured by the chrome
    area: (f64, f64, f64, f64),
    dl_dir: Rc<RefCell<PathBuf>>,
    dl_pending: Vec<(u64, String)>,
    dl_next: u64,
    #[cfg(target_os = "linux")]
    dl_hooked: bool,
}

impl Browser {
    fn tell(&self, v: Value) {
        let _ = self.chrome.evaluate_script(&format!("window.__rr&&window.__rr({v})"));
    }

    fn full_rect(&self) -> Rect {
        let s = self.window.inner_size().to_logical::<f64>(self.window.scale_factor());
        Rect { position: LogicalPosition::new(0.0, 0.0).into(), size: LogicalSize::new(s.width, s.height).into() }
    }

    fn page_rect(&self) -> Rect {
        let (x, y, w, h) = self.area;
        Rect { position: LogicalPosition::new(x, y).into(), size: LogicalSize::new(w.max(1.0), h.max(1.0)).into() }
    }

    fn push_state(&self) {
        self.tell(json!({ "t": "wstate", "max": self.window.is_maximized(), "fs": self.window.fullscreen().is_some() }));
    }

    fn sync_visibility(&self) {
        for (id, wv) in &self.pages {
            let _ = wv.set_visible(!self.overlay && self.shown == Some(*id));
        }
    }

    fn make_page(&mut self, id: u32, url: &str) -> Option<WebView> {
        let rect = self.page_rect();
        let sender = |p: EventLoopProxy<Ev>| {
            move |m: Msg| {
                let _ = p.send_event(Ev::Page(id, m));
            }
        };
        let (s_ipc, s_load, s_title) = (sender(self.proxy.clone()), sender(self.proxy.clone()), sender(self.proxy.clone()));
        let popup = Mutex::new(self.proxy.clone());
        let builder = WebViewBuilder::new_with_web_context(&mut self.ctx)
            .with_url(url)
            .with_bounds(rect)
            .with_visible(false)
            .with_devtools(true)
            .with_initialization_script(PAGE_JS)
            .with_ipc_handler(move |r| s_ipc(Msg::Ipc(r.body().clone())))
            .with_on_page_load_handler(move |e, u| s_load(Msg::Loading(matches!(e, PageLoadEvent::Started), u)))
            .with_document_title_changed_handler(move |t| s_title(Msg::Title(t)))
            .with_new_window_req_handler(move |u, _| {
                // links that want a new window (target=_blank, middle click, window.open) open as a tab instead
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

    fn page(&self, v: &Value) -> Option<&WebView> {
        self.pages.get(&(v["id"].as_u64()? as u32))
    }

    /// A message from the chrome (ui/js/native.js).
    fn on_chrome(&mut self, body: &str, flow: &mut ControlFlow) {
        let Ok(v) = serde_json::from_str::<Value>(body) else { return };
        let id = v["id"].as_u64().map(|i| i as u32);
        let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
        match s("t").as_str() {
            "ready" => {
                self.tell(json!({ "t": "init", "plat": os::os_name(), "version": VERSION, "downloads": os::downloads_dir() }));
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
                    if self.shown == Some(id) {
                        self.shown = None;
                    }
                }
            }
            "show" => {
                self.shown = id;
                self.sync_visibility();
                if v["focus"].as_bool() == Some(true) {
                    match id.and_then(|i| self.pages.get(&i)) {
                        Some(wv) => {
                            let _ = wv.focus();
                        }
                        None => {
                            let _ = self.chrome.focus();
                        }
                    }
                }
            }
            "overlay" => {
                self.overlay = v["on"].as_bool().unwrap_or(false);
                self.sync_visibility();
                if self.overlay {
                    let _ = self.chrome.focus();
                }
            }
            "area" => {
                let n = |k: &str| v[k].as_f64().unwrap_or(0.0);
                self.area = (n("x"), n("y"), n("w"), n("h"));
                let r = self.page_rect();
                for wv in self.pages.values() {
                    let _ = wv.set_bounds(r);
                }
            }
            "focus" => {
                if let Some(wv) = self.page(&v) {
                    let _ = wv.focus();
                }
            }
            "focuschrome" => {
                let _ = self.chrome.focus();
            }
            t @ ("back" | "fwd" | "stop" | "reload" | "hardreload" | "zoom" | "find" | "devtools" | "print") => {
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
                    _ => {
                        let q = serde_json::to_string(&s("q")).unwrap_or_default();
                        let back = v["back"].as_bool().unwrap_or(false);
                        let (p, tab) = (Mutex::new(self.proxy.clone()), id.unwrap_or(0));
                        // a new search starts from the top instead of from the last match
                        let reset = if v["fresh"].as_bool() == Some(true) { "window.getSelection().removeAllRanges();" } else { "" };
                        wv.evaluate_script_with_callback(&format!("{reset}window.find({q},false,{back},true)"), move |r| {
                            if let Ok(p) = p.lock() {
                                let _ = p.send_event(Ev::Page(tab, Msg::Ipc(format!("found:{r}"))));
                            }
                        })
                    }
                };
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
                    "close" => *flow = ControlFlow::Exit,
                    "drag" => {
                        if self.window.fullscreen().is_none() {
                            let _ = self.window.drag_window();
                        }
                    }
                    "fs" => {
                        let on = self.window.fullscreen().is_none();
                        self.window.set_fullscreen(on.then_some(Fullscreen::Borderless(None)));
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
            Msg::Loading(started, url) => self.tell(json!({ "t": "tab", "id": id, "loading": started, "url": url })),
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
                    if let Some(u) = self.pages.get(&id).and_then(|w| w.url().ok()) {
                        self.tell(json!({ "t": "tab", "id": id, "url": u }));
                    }
                } else if let Some(r) = s.strip_prefix("found:") {
                    self.tell(json!({ "t": "found", "id": id, "ok": r.trim() == "true" }));
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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version") {
        println!("Web Roamer {VERSION}");
        return;
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
    // Windows and Linux get our own title bar (ui/js/chrome.js); macOS keeps its traffic lights over a see-through bar.
    #[allow(unused_mut)]
    let mut wb = WindowBuilder::new()
        .with_title("Web Roamer")
        .with_window_icon(icon)
        .with_decorations(cfg!(target_os = "macos"))
        .with_inner_size(tao::dpi::LogicalSize::new(1440.0, 900.0))
        .with_min_inner_size(tao::dpi::LogicalSize::new(640.0, 420.0));
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
    let boot = format!("window.__plat='{}';window.__start={};", os::os_name(), json!(start));
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
        shown: None,
        overlay: false,
        area: (0.0, 0.0, 1.0, 1.0),
        dl_dir: Rc::new(RefCell::new(os::downloads_dir())),
        dl_pending: Vec::new(),
        dl_next: 0,
        #[cfg(target_os = "linux")]
        dl_hooked: false,
    };

    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => *flow = ControlFlow::Exit,
            Event::WindowEvent { event: WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }, .. } => {
                let _ = b.chrome.set_bounds(b.full_rect());
                b.push_state();
            }
            Event::UserEvent(Ev::Chrome(body)) => b.on_chrome(&body, flow),
            Event::UserEvent(Ev::Page(id, m)) => b.on_page(id, m),
            _ => {}
        }
    });
}
