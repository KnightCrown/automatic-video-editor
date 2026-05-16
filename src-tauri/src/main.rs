// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    ort::set_api(ort_tract::api());

    devotiontime_lib::run()
}
