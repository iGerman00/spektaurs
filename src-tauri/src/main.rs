#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    spek_tauri_lib::run()
}
