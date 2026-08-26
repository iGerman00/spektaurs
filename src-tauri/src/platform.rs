use directories::ProjectDirs;
use std::path::PathBuf;

/// Platform-specific initialisation (no-op on most platforms, kept for parity with spek-platform.cc)
pub fn init() {
    // On macOS original does TransformProcessType to foreground
    // No equivalent needed in Tauri/Rust
}

pub fn config_path(app_name: &str) -> PathBuf {
    // Mirroring spek_platform_config_path logic:
    // Windows: GetUserConfigDir + app_name + preferences
    // Unix: XDG_CONFIG_HOME or ~/.config + app_name + preferences
    // We use directories crate which already handles XDG correctly

    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            let mut p = PathBuf::from(xdg);
            p.push(app_name);
            p.push("preferences");
            return p;
        }
    }

    if let Some(proj) = ProjectDirs::from("", "", app_name) {
        let mut p = proj.config_dir().to_path_buf();
        // ProjectDirs on linux gives ~/.config/<app_name> ; on windows gives AppData/Roaming/...
        // Ensure we return file path ending with "preferences"
        if p.ends_with(app_name) {
            p.push("preferences");
        } else {
            p.push(app_name);
            p.push("preferences");
        }
        p
    } else {
        // Fallback to home dir
        let home = dirs_next();
        let mut p = home.unwrap_or_else(|| PathBuf::from("."));
        p.push(".config");
        p.push(app_name);
        p.push("preferences");
        p
    }
}

fn dirs_next() -> Option<PathBuf> {
    #[allow(deprecated)]
    std::env::home_dir()
}

pub fn can_change_language() -> bool {
    // Original: false on OS_UNIX, true otherwise
    // On Linux we disable, on Windows/macOS allow
    #[cfg(target_os = "linux")]
    return false;
    #[cfg(not(target_os = "linux"))]
    return true;
}

pub fn font_scale() -> f64 {
    #[cfg(target_os = "macos")]
    return 1.3;
    #[cfg(not(target_os = "macos"))]
    return 1.0;
}
