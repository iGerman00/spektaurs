#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // ── Wayland / WebKit compatibility fixes (must run before any GTK init) ──
    // KDE Plasma Wayland + WebKitGTK (Tauri) hits "Error 71 (Protocol error) dispatching to
    // Wayland display" due to dmabuf/compositing. These env vars are the upstream workaround
    // and are safe to set early; they are respected by WebKitGTK 2.40+.
    // Only set if user hasn't overridden them explicitly.
    if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }
    if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    // If both Wayland and XWayland are available, prefer XWayland for WebKit stability
    // on KDE with klassy. User can override by setting GDK_BACKEND themselves.
    if std::env::var("GDK_BACKEND").is_err()
        && std::env::var("WAYLAND_DISPLAY").is_ok()
        && std::env::var("DISPLAY").is_ok()
    {
        // XWayland is available — use it. Native Wayland WebKit still has protocol
        // errors with NVIDIA + KWin on EndeavourOS. This matches what many Tauri apps do.
        std::env::set_var("GDK_BACKEND", "x11");
    }
    // Theme fix: klassy-dark index.theme lists places/64 but has no [places/64] section,
    // causing "Gtk-WARNING … has no size field" on every startup. Prefer breeze-dark
    // if klassy-dark is the current icon theme and is broken. Respect explicit override.
    if std::env::var("GTK_ICON_THEME").is_err() {
        let broken_theme = std::path::Path::new("/usr/share/icons/klassy-dark/index.theme");
        if broken_theme.exists() {
            if let Ok(content) = std::fs::read_to_string(broken_theme) {
                if content.contains("places/64") && !content.contains("[places/64]") {
                    std::env::set_var("GTK_ICON_THEME", "breeze-dark");
                }
            }
        }
    }

    // ── CLI handling before Tauri init (mirrors spek.cc) ──
    let args: Vec<String> = std::env::args().collect();
    let mut help = false;
    let mut version = false;
    for a in args.iter().skip(1) {
        match a.as_str() {
            "-h" | "--help" => help = true,
            "-V" | "--version" => version = true,
            _ => {}
        }
    }
    if help {
        println!("Usage: spek [FILE]");
        println!("  -h, --help     Show this help message");
        println!("  -V, --version  Display the version and exit");
        println!();
        println!("Spek version {}", env!("CARGO_PKG_VERSION"));
        std::process::exit(0);
    }
    if version {
        println!("Spek version {}", env!("CARGO_PKG_VERSION"));
        std::process::exit(0);
    }

    spek_tauri_lib::run()
}
