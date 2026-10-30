#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, State};
#[cfg(target_os = "macos")]
use tauri::RunEvent;

/// Files handed to the app by the OS (double-click on `.blockml`, "open with").
#[derive(Default)]
struct PendingFiles(Mutex<Vec<String>>);

/// Generation counter for the single active file watcher thread.
#[derive(Default)]
struct Watcher(Arc<AtomicU64>);

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let result = std::fs::read_to_string(&path);
    #[cfg(debug_assertions)]
    eprintln!(
        "[blockml] read {path} -> {}",
        if result.is_ok() { "ok" } else { "error" }
    );
    result.map_err(|error| error.to_string())
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|error| error.to_string())
}

#[tauri::command]
fn write_binary(path: String, base64_data: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.as_bytes())
        .map_err(|error| error.to_string())?;
    std::fs::write(&path, bytes).map_err(|error| error.to_string())
}

#[tauri::command]
fn take_pending_paths(state: State<PendingFiles>) -> Vec<String> {
    let mut guard = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    std::mem::take(&mut *guard)
}

/// Poll the file's mtime in a background thread; the previous watcher stops when
/// a new file is opened. Content equality is checked on the frontend, so our own
/// writes do not cause reload loops.
#[tauri::command]
fn watch_file(app: tauri::AppHandle, watcher: State<Watcher>, path: String) {
    let generation = watcher.0.fetch_add(1, Ordering::SeqCst) + 1;
    let counter = Arc::clone(&watcher.0);
    std::thread::spawn(move || {
        let stamp = |target: &str| std::fs::metadata(target).ok().and_then(|m| m.modified().ok());
        let mut last = stamp(&path);
        loop {
            std::thread::sleep(Duration::from_millis(600));
            if counter.load(Ordering::SeqCst) != generation {
                return;
            }
            let current = stamp(&path);
            if current.is_some() && current != last {
                last = current;
                let _ = app.emit("blockml://file-changed", path.clone());
            }
        }
    });
}

fn install_menu(app: &tauri::App) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(app, "open", "打开…", true, Some("CmdOrCtrl+O"))?;
    let save_item = MenuItem::with_id(app, "save", "保存", true, Some("CmdOrCtrl+S"))?;
    let save_as_item = MenuItem::with_id(app, "save-as", "另存为…", true, Some("CmdOrCtrl+Shift+S"))?;
    let export_html = MenuItem::with_id(app, "export-html", "导出 HTML…", true, None::<&str>)?;
    let export_svg = MenuItem::with_id(app, "export-svg", "导出 SVG…", true, None::<&str>)?;
    let export_png = MenuItem::with_id(app, "export-png", "导出 PNG…", true, None::<&str>)?;
    let fit_item = MenuItem::with_id(app, "fit", "适应窗口", true, Some("CmdOrCtrl+0"))?;

    let file_menu = Submenu::with_items(
        app,
        "文件",
        true,
        &[
            &open_item,
            &save_item,
            &save_as_item,
            &PredefinedMenuItem::separator(app)?,
            &export_html,
            &export_svg,
            &export_png,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let view_menu = Submenu::with_items(app, "视图", true, &[&fit_item])?;
    let app_menu = Submenu::with_items(
        app,
        "BlockML",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let menu = Menu::with_items(app, &[&app_menu, &file_menu, &view_menu])?;
    app.set_menu(menu)?;
    Ok(())
}

fn initial_paths() -> Vec<String> {
    // On Windows/Linux a file association launch arrives as a plain argument;
    // macOS uses RunEvent::Opened instead (handled below).
    std::env::args()
        .skip(1)
        .filter(|arg| arg.to_ascii_lowercase().ends_with(".blockml"))
        .map(|arg| {
            std::fs::canonicalize(&arg)
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or(arg)
        })
        .collect()
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(PendingFiles(Mutex::new(initial_paths())))
        .manage(Watcher::default())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            write_binary,
            take_pending_paths,
            watch_file
        ])
        .setup(|app| {
            install_menu(app)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("blockml://menu", event.id().as_ref().to_string());
        })
        .build(tauri::generate_context!())
        .expect("failed to build BlockML");

    app.run(|handle, event| {
        #[cfg(target_os = "macos")]
        handle_opened(handle, event);
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (handle, event);
        }
    });
}

#[cfg(target_os = "macos")]
fn handle_opened(handle: &tauri::AppHandle, event: RunEvent) {
    if let RunEvent::Opened { urls } = event {
        let paths: Vec<String> = urls
            .iter()
            .filter_map(|url| url.to_file_path().ok())
            .filter(|path| {
                path.extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("blockml"))
            })
            .map(|path| path.to_string_lossy().to_string())
            .collect();
        let Some(first) = paths.first().cloned() else {
            return;
        };
        if let Some(state) = handle.try_state::<PendingFiles>() {
            if let Ok(mut pending) = state.0.lock() {
                pending.extend(paths.iter().cloned());
            }
        }
        let _ = handle.emit("blockml://open-path", first);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("blockml-{}-{}", std::process::id(), name));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    #[test]
    fn text_files_round_trip() {
        let dir = scratch("text");
        let path = dir.join("diagram.blockml");
        let target = path.to_string_lossy().to_string();
        let contents = "diagram {\n  title: \"t\"\n}\n".to_string();
        write_file(target.clone(), contents.clone()).expect("write");
        assert_eq!(read_file(target).expect("read"), contents);
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn binary_writes_decode_base64() {
        let dir = scratch("binary");
        let path = dir.join("export.png");
        let target = path.to_string_lossy().to_string();
        let payload = b"not-a-real-png";
        write_binary(
            target.clone(),
            base64::engine::general_purpose::STANDARD.encode(payload),
        )
        .expect("write binary");
        assert_eq!(std::fs::read(&path).expect("read binary"), payload);
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn initial_paths_ignores_non_blockml_args() {
        // Only `.blockml` arguments from the OS are candidates; everything else is dropped.
        assert!(initial_paths().iter().all(|path| path.to_ascii_lowercase().ends_with(".blockml")));
    }
}
