#![allow(dead_code, unused_variables, unused_imports, unused_mut)]

mod audio;
mod commands;
mod fft;
mod palette;
mod pipeline;
mod platform;
mod preferences;
mod utils;

use platform::init as platform_init;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    platform_init();
    // Initialize logger
    let _ = env_logger::try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_preferences,
            commands::set_check_update,
            commands::set_language,
            commands::get_check_update,
            commands::get_language,
            commands::get_config_path,
            commands::get_default_settings,
            commands::set_default_settings,
            commands::analyze_audio,
            commands::cancel_pipeline,
            commands::get_audio_info,
            commands::check_version,
            commands::get_available_languages,
            commands::palette_color,
            commands::get_app_info,
            commands::get_cli_args
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
