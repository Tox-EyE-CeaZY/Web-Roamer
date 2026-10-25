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

- **Tabs** in the title bar: drag to reorder, middle-click to close, right-click for more, Ctrl+Shift+T brings a closed one back.
  Tabs are reopened next time (Settings can turn that off).
- **Address bar** that takes an address or a search, with suggestions from your bookmarks and history.
  Six search engines to choose from (DuckDuckGo by default).
- **Back, forward, reload / stop, home**, plus the mouse's back/forward buttons.
- **Bookmarks**: the star (Ctrl+D), a bookmarks bar (Ctrl+Shift+B), and a page to search, edit and reorder them.
- **History** grouped by day, searchable, with clearing for the last hour / day / week / everything.
- **Downloads** saved to your Downloads folder (or one you choose), with a list to open them or show them in the folder.
- **Find in page** (Ctrl+F), **zoom** per tab (Ctrl + / − / 0), **full screen** (F11), **developer tools** (F12), print.
- A **start page** with a big search box, your bookmarks as tiles and where you've been lately.
- **Look**: Night / Paper / Violet themes, an accent colour slider, the contour map and film grain toggles, framed or edge-to-edge pages.

Links that want a new window open as a tab. Web addresses given on the command line open as tabs.

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

## Known limits (first version)

- Menus and the address suggestions hide the page while they are open (a page is a native view drawn above the interface).
- Back/forward buttons are always enabled on web pages; the web view doesn't say whether there is history to go to.
- No private windows, extensions, password manager or download progress yet.
- On Linux, downloads are named after their URL rather than the name the site suggests.
