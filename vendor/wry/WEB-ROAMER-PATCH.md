This is wry 0.53.5 (MIT or Apache-2.0, https://github.com/tauri-apps/wry) with one change: a message from a page whose address
is not a valid `http::Uri` (file:///..., data:, blob:) no longer panics in the IPC handler
(`src/webview2/mod.rs`, `src/webkitgtk/mod.rs`). Drop this folder and the `[patch.crates-io]` entry once wry fixes it.
