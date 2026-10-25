# Web Roamer

A small, stylish web browser in the look of [Board Roamer](https://github.com/Tox-EyE-CeaZY/Board-Roamer): the same
chamfered ticket-stub shapes, skewed route chips, hard offset shadows, contour-map background and the **WEB/ROAMER**
title in the title bar.

## Get it

Grab the file for your computer from the [latest release](https://github.com/Tox-EyE-CeaZY/Web-Roamer/releases/latest):

| System | File |
| --- | --- |
| Windows 10/11 (most laptops) | `web-roamer-windows-x64.exe` |
| Windows on ARM | `web-roamer-windows-arm64.exe` |
| macOS (Apple silicon / Intel) | `WebRoamer-macos-arm64.zip` / `WebRoamer-macos-x64.zip` |
| Linux | `web-roamer-linux-x64` (needs `libwebkit2gtk-4.1`) |

It is a single file with nothing to install. Windows uses the Edge WebView2 runtime that ships with Windows 10 and 11.
Because the exe isn't code-signed, SmartScreen may warn the first time: **More info → Run anyway**.

## What it does

- **Tabs** in the title bar: drag to reorder, middle-click to close, pin, mute (a speaker shows which tab is playing
  sound), right-click for more, Ctrl+Shift+T brings a closed one back, Ctrl+Shift+A (or the ⌄ button) searches them.
  Tabs and groups are reopened next time.
- **Tab groups** with a name and a colour, collapsible. **Smart groups** notice tabs that belong together (they came
  out of the same search, they're on one site, or they're all shops / videos / dev docs…) and offer to group them
  (or just do it, in Settings → Tabs & groups). Pages opened from a grouped tab join it, and a new search about a
  group's subject is offered to that group. *Organize tabs* groups everything at once.
- **Desktop**: the pages of one group side by side in one window (up to six), with a draggable divider; drag a page's
  header onto another to swap them. The toolbar's desktop button, or right-click a tab → *Show beside this tab*.
- **Address bar** that takes an address or a search, completes addresses you've been to, suggests from your open
  tabs, bookmarks, history and the search engine, and Ctrl+Enter turns `example` into `www.example.com`.
  Six search engines or your own, each with a **keyword** (`e6 wolf`, `w rust`, `yt lofi`); sites with a search of
  their own are added as you visit them, and scrolling over the address bar flips through the engines. The lock opens
  the site's info: connection, zoom, history, its look.
- **Image boards** (e621, e926, Danbooru, Gelbooru, Safebooru, Derpibooru): a search typed in the address bar opens in
  [Board Roamer](https://github.com/Tox-EyE-CeaZY/Board-Roamer) (needs Board Roamer 1.10), and board pages get an
  *Open in Board Roamer* button.
- **Bookmarks**: the star (Ctrl+D), a bookmarks bar, a manager to search, edit and reorder, import and export as the
  HTML file every browser reads.
- **History as a trail**: your visits drawn as journeys along a path (a search and the pages that followed it), which
  you can open again as a tab group; the plain list is one click away. Searchable, per-site removal; **Clear browsing data** (Ctrl+Shift+Del) for history,
  downloads, cookies and cache.
- **Downloads** saved to your Downloads folder (or one you choose), with a list to open them or show them in the folder.
- **Find in page** with a match count, **zoom** remembered per site, **full screen** (and videos' full screen fills the
  window), **view source** (Ctrl+U), translate, print, **developer tools**, new windows (Ctrl+N).
- Ctrl+click or middle-click opens links in a background tab; hovering a link shows where it goes.
- A **start page** whose search box glides up into the address bar when you start typing, and shows instant answers
  (DuckDuckGo's summaries) and sums while you do. New tabs can open it, a blank page, your home page or any address.
- A **start page** with a big search box, your bookmarks (or most visited sites) as tiles, your groups and where
  you've been lately, all adjustable.
- **Settings** in sections with a search box; **Look**: Night / Paper / Violet / System themes, an accent colour
  slider, the contour map and film grain toggles, framed or edge-to-edge pages.
- **Updates itself**: it checks GitHub for a new release, downloads it in the background, checks it against the
  release's checksums and only needs a restart (Windows and Linux; on macOS it opens the release page).
- **Site looks**: websites can describe how Web Roamer should look while you're on them, with the
  [Site Theming SDK](docs/SITE-THEMING.md): colours, shapes, the site's own tab shape and style, type. The tab wears
  the look even in the background, and the rest of the browser takes it by spreading out from the tab. You decide
  whether sites may (never / ask / always, per site). A prompt for building it into a site builder is in
  [docs/FLAVION-PROMPT.md](docs/FLAVION-PROMPT.md).
  Try [docs/theme-demo.html](docs/theme-demo.html).

Web addresses given on the command line open as tabs. The window opens where you left it.

## How it's built

Same stack as Board Roamer: Rust with [tao](https://github.com/tauri-apps/tao) for the window and
[wry](https://github.com/tauri-apps/wry) for web views (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux).

- `src/main.rs`: the window, one native web view for the browser's own interface (served from `ui/` through the
  `roamer://` scheme) and one native web view per open web page, laid over the page area. It reports titles, addresses,
  favicons, downloads and new-window requests back to the interface.
- `ui/`: the interface (title bar, tabs, toolbar, start / history / bookmarks / downloads / settings pages). Bookmarks,
  history and settings live in its local storage inside the app's profile folder.
- `ui/js/native.js` fakes the native side with iframes, so the interface also opens in a normal browser
  (`python3 -m http.server -d ui`) for working on the design.
- `tools/make_icon.py` draws the icon (`assets/`).

Build it yourself with `cargo build --release` (on Linux first install `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev`).
Every push to main builds every platform and publishes the downloads as the release for the version in `Cargo.toml`;
bump that version to start a new release.

## To do

- **Linux on Electron.** Web Roamer draws pages with the system's own web view (WebView2 on Windows, WKWebView on Mac,
  WebKitGTK on Linux). WebKitGTK is the weak one: pages can't be hidden without being drawn again, downloads take their
  name from the address, and it is slow to start. Moving the Linux build to Electron is planned, not started.

## Known limits

- Menus and the address suggestions hide the page while they are open (a page is a native view drawn above the interface).
- Back/forward buttons are always enabled on web pages; the web view doesn't say whether there is history to go to.
- No private windows, extensions, password manager or download progress yet.
- A second window shares bookmarks, history and settings with the first, but only the first window's tabs are reopened.
- On Linux, downloads are named after their URL rather than the name the site suggests.
