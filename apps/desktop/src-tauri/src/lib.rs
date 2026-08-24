mod file_io;

use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::file_io::{atomic_save, read_document};

const RECOVERY_DIRECTORY: &str = "recovery";
const RECOVERY_FILE: &str = "active.json";
const STATE_DIRECTORY: &str = "state";
const RECENT_FILE: &str = "recent.json";
const RECENT_LIMIT: usize = 10;

#[derive(Default)]
struct AuthorizedPaths(Mutex<HashSet<PathBuf>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenDocumentResponse {
    path: String,
    bytes: Vec<u8>,
    disk_fingerprint: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveDocumentRequest {
    path: String,
    bytes: Vec<u8>,
    expected_fingerprint: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveDocumentAsRequest {
    bytes: Vec<u8>,
    suggested_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedDocumentResponse {
    path: String,
    disk_fingerprint: String,
}

fn normalize_existing_path(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|error| format!("无法解析文件路径：{error}"))
}

fn normalize_destination_path(path: &Path) -> Result<PathBuf, String> {
    let file_name = path
        .file_name()
        .ok_or_else(|| "目标路径缺少文件名".to_owned())?;
    let parent = path
        .parent()
        .ok_or_else(|| "目标路径缺少父目录".to_owned())?;
    let parent = fs::canonicalize(parent).map_err(|error| format!("无法解析目标目录：{error}"))?;
    Ok(parent.join(file_name))
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn app_data_file(app: &AppHandle, directory: &str, file: &str) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|root| root.join(directory).join(file))
        .map_err(|error| format!("无法定位应用数据目录：{error}"))
}

fn read_recent_documents(app: &AppHandle) -> Result<Vec<String>, String> {
    let path = app_data_file(app, STATE_DIRECTORY, RECENT_FILE)?;
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("读取最近文件失败：{error}")),
    };

    serde_json::from_slice::<Vec<String>>(&bytes)
        .map(|paths| paths.into_iter().take(RECENT_LIMIT).collect())
        .map_err(|error| format!("最近文件记录无效：{error}"))
}

fn remember_recent_document(app: &AppHandle, path: &Path) -> Result<(), String> {
    let displayed = display_path(path);
    let mut recent = read_recent_documents(app).unwrap_or_default();
    recent.retain(|candidate| candidate != &displayed);
    recent.insert(0, displayed);
    recent.truncate(RECENT_LIMIT);

    let state_path = app_data_file(app, STATE_DIRECTORY, RECENT_FILE)?;
    let parent = state_path
        .parent()
        .ok_or_else(|| "最近文件记录路径缺少父目录".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建状态目录失败：{error}"))?;
    let bytes =
        serde_json::to_vec(&recent).map_err(|error| format!("序列化最近文件失败：{error}"))?;
    let expected_fingerprint = match read_document(&state_path) {
        Ok((_, fingerprint)) => Some(fingerprint),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("检查最近文件记录失败：{error}")),
    };

    atomic_save(&state_path, &bytes, expected_fingerprint.as_deref())
        .map(|_| ())
        .map_err(|error| format!("写入最近文件失败：{error}"))
}

fn authorize(state: &State<'_, AuthorizedPaths>, path: PathBuf) -> Result<(), String> {
    state
        .0
        .lock()
        .map_err(|_| "文件授权状态不可用".to_owned())?
        .insert(path);
    Ok(())
}

fn is_authorized(state: &State<'_, AuthorizedPaths>, path: &Path) -> Result<bool, String> {
    Ok(state
        .0
        .lock()
        .map_err(|_| "文件授权状态不可用".to_owned())?
        .contains(path))
}

#[tauri::command]
async fn open_document(
    app: AppHandle,
    authorized_paths: State<'_, AuthorizedPaths>,
) -> Result<Option<OpenDocumentResponse>, String> {
    let selected = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown", "mdown", "mkd"])
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };

    let selected = selected
        .into_path()
        .map_err(|_| "当前只支持打开本地文件".to_owned())?;
    let path = normalize_existing_path(&selected)?;
    let (bytes, disk_fingerprint) =
        read_document(&path).map_err(|error| format!("读取文件失败：{error}"))?;
    authorize(&authorized_paths, path.clone())?;
    let _ = remember_recent_document(&app, &path);

    Ok(Some(OpenDocumentResponse {
        path: display_path(&path),
        bytes,
        disk_fingerprint,
    }))
}

#[tauri::command]
async fn list_recent_documents(app: AppHandle) -> Result<Vec<String>, String> {
    read_recent_documents(&app)
}

#[tauri::command]
async fn open_recent_document(
    app: AppHandle,
    authorized_paths: State<'_, AuthorizedPaths>,
    path: String,
) -> Result<OpenDocumentResponse, String> {
    if !read_recent_documents(&app)?
        .iter()
        .any(|recent| recent == &path)
    {
        return Err("拒绝打开不在最近文件记录中的路径".to_owned());
    }

    let path = normalize_existing_path(Path::new(&path))?;
    let (bytes, disk_fingerprint) =
        read_document(&path).map_err(|error| format!("读取文件失败：{error}"))?;
    authorize(&authorized_paths, path.clone())?;
    let _ = remember_recent_document(&app, &path);

    Ok(OpenDocumentResponse {
        path: display_path(&path),
        bytes,
        disk_fingerprint,
    })
}

#[tauri::command]
async fn save_document(
    app: AppHandle,
    authorized_paths: State<'_, AuthorizedPaths>,
    request: SaveDocumentRequest,
) -> Result<SavedDocumentResponse, String> {
    let path = normalize_existing_path(Path::new(&request.path))?;
    if !is_authorized(&authorized_paths, &path)? {
        return Err("拒绝写入未经文件选择器授权的路径".to_owned());
    }

    let disk_fingerprint = atomic_save(&path, &request.bytes, Some(&request.expected_fingerprint))
        .map_err(|error| error.to_string())?;
    let _ = remember_recent_document(&app, &path);

    Ok(SavedDocumentResponse {
        path: display_path(&path),
        disk_fingerprint,
    })
}

#[tauri::command]
async fn save_document_as(
    app: AppHandle,
    authorized_paths: State<'_, AuthorizedPaths>,
    request: SaveDocumentAsRequest,
) -> Result<Option<SavedDocumentResponse>, String> {
    let selected = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown", "mdown", "mkd"])
        .set_file_name(&request.suggested_name)
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };

    let selected = selected
        .into_path()
        .map_err(|_| "当前只支持保存到本地文件".to_owned())?;
    let path = normalize_destination_path(&selected)?;
    let expected_fingerprint = match read_document(&path) {
        Ok((_, fingerprint)) => Some(fingerprint),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("检查目标文件失败：{error}")),
    };
    let disk_fingerprint = atomic_save(&path, &request.bytes, expected_fingerprint.as_deref())
        .map_err(|error| error.to_string())?;
    let path = normalize_existing_path(&path)?;
    authorize(&authorized_paths, path.clone())?;
    let _ = remember_recent_document(&app, &path);

    Ok(Some(SavedDocumentResponse {
        path: display_path(&path),
        disk_fingerprint,
    }))
}

fn recovery_path(app: &AppHandle) -> Result<PathBuf, String> {
    app_data_file(app, RECOVERY_DIRECTORY, RECOVERY_FILE)
}

#[tauri::command]
async fn load_recovery_snapshot(app: AppHandle) -> Result<Option<Vec<u8>>, String> {
    let path = recovery_path(&app)?;
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取恢复稿失败：{error}")),
    }
}

#[tauri::command]
async fn save_recovery_snapshot(app: AppHandle, bytes: Vec<u8>) -> Result<(), String> {
    let path = recovery_path(&app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "恢复稿路径缺少父目录".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建恢复目录失败：{error}"))?;

    let expected_fingerprint = match read_document(&path) {
        Ok((_, fingerprint)) => Some(fingerprint),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("检查现有恢复稿失败：{error}")),
    };

    atomic_save(&path, &bytes, expected_fingerprint.as_deref())
        .map(|_| ())
        .map_err(|error| format!("写入恢复稿失败：{error}"))
}

#[tauri::command]
async fn clear_recovery_snapshot(app: AppHandle) -> Result<(), String> {
    let path = recovery_path(&app)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除恢复稿失败：{error}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AuthorizedPaths::default())
        .invoke_handler(tauri::generate_handler![
            open_document,
            open_recent_document,
            list_recent_documents,
            save_document,
            save_document_as,
            load_recovery_snapshot,
            save_recovery_snapshot,
            clear_recovery_snapshot
        ])
        .run(tauri::generate_context!())
        .expect("error while running MDEditor");
}
