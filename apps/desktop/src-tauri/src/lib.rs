mod file_io;
mod workspace_io;

use std::{
    collections::{HashMap, HashSet},
    ffi::OsStr,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use notify::RecommendedWatcher;

use crate::file_io::{atomic_save, read_document};
use crate::workspace_io::{
    consolidate_workspace_images as consolidate_workspace_images_on_disk,
    copy_workspace_entry as copy_workspace_entry_on_disk, copy_workspace_image_and_rewrite,
    create_workspace_directory as create_workspace_directory_entry,
    create_workspace_document as create_workspace_document_entry, enumerate_workspace,
    import_workspace_image as import_workspace_image_on_disk,
    import_workspace_image_bytes as import_workspace_image_bytes_on_disk,
    inspect_workspace_image_references as inspect_workspace_image_references_on_disk,
    inspect_workspace_images as inspect_workspace_images_on_disk,
    move_workspace_document_and_rewrite, move_workspace_entry as move_workspace_entry_on_disk,
    move_workspace_image_and_rewrite,
    preview_workspace_document_move as preview_workspace_document_move_on_disk,
    preview_workspace_image_consolidation as preview_workspace_image_consolidation_on_disk,
    preview_workspace_image_move as preview_workspace_image_move_on_disk,
    resolve_workspace_document_link, resolve_workspace_entry, resolve_workspace_file,
    resolve_workspace_image_link, search_workspace, validate_workspace_document, watch_workspace,
    WorkspaceDocumentMovePreview, WorkspaceEntry, WorkspaceImageConsolidationPreview,
    WorkspaceImageInspection, WorkspaceImageMovePreview, WorkspaceImageReference,
    WorkspaceImageReferenceInspection, WorkspaceSearchCompletion, WorkspaceSearchMatch,
    WorkspaceSearchOptions, MAX_WORKSPACE_ENTRIES, MAX_WORKSPACE_IMAGE_PREVIEW_BYTES,
};

const RECOVERY_DIRECTORY: &str = "recovery";
const RECOVERY_FILE: &str = "active.json";
const STATE_DIRECTORY: &str = "state";
const RECENT_FILE: &str = "recent.json";
const RECENT_LIMIT: usize = 10;
const PANDOC_INSTALL_URL: &str = "https://pandoc.org/installing.html";
const MAXIMUM_PANDOC_HTML_BYTES: usize = 160 * 1024 * 1024;
const MAXIMUM_DOCX_BYTES: usize = 256 * 1024 * 1024;

#[derive(Default)]
struct AuthorizedPaths(Mutex<HashSet<PathBuf>>);

#[derive(Default)]
struct DroppedImages(Mutex<HashSet<PathBuf>>);

struct StartupPaths(Mutex<Vec<PathBuf>>);

#[derive(Default)]
struct AuthorizedRoots(Mutex<HashSet<PathBuf>>);

#[derive(Default)]
struct ActiveWorkspaceWatcher(Mutex<Option<RecommendedWatcher>>);

#[derive(Default)]
struct ActiveWorkspaceSearches(Mutex<HashMap<String, (PathBuf, Arc<AtomicBool>)>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenDocumentResponse {
    path: String,
    bytes: Vec<u8>,
    disk_fingerprint: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum ExternalDocumentEvent {
    Opened { document: OpenDocumentResponse },
    Error { path: String, message: String },
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportHtmlRequest {
    bytes: Vec<u8>,
    suggested_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportImageRequest {
    bytes: Vec<u8>,
    suggested_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportDocxRequest {
    bytes: Vec<u8>,
    suggested_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PandocStatus {
    available: bool,
    version: Option<String>,
    install_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedDocumentResponse {
    path: String,
    disk_fingerprint: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenWorkspaceResponse {
    root: String,
    name: String,
    entries: Vec<WorkspaceEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenWorkspaceLinkResponse {
    document: OpenDocumentResponse,
    relative_path: String,
    fragment: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedWorkspaceImageResponse {
    relative_path: String,
    markdown_path: String,
    suggested_alt: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceImagePreviewResponse {
    data_url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceChangedEvent {
    root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRelocation {
    from_path: String,
    to_path: String,
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum WorkspaceSearchEvent {
    Batch {
        request_id: String,
        matches: Vec<WorkspaceSearchMatch>,
    },
    Complete {
        request_id: String,
        truncated: bool,
    },
    Cancelled {
        request_id: String,
    },
    Error {
        request_id: String,
        message: String,
    },
}

fn cancel_workspace_searches(
    searches: &State<'_, ActiveWorkspaceSearches>,
    root: Option<&Path>,
) -> Result<(), String> {
    let mut searches = searches
        .0
        .lock()
        .map_err(|_| "工作区搜索状态不可用".to_owned())?;
    for (search_root, cancelled) in searches.values() {
        if root.is_none_or(|root| search_root == root) {
            cancelled.store(true, Ordering::Relaxed);
        }
    }
    searches.retain(|_, (search_root, _)| root.is_some_and(|root| search_root != root));
    Ok(())
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

#[cfg(feature = "test-data-override")]
fn test_data_file(root: &Path, directory: &str, file: &str) -> Result<PathBuf, String> {
    if !root.is_absolute() {
        return Err("原生测试数据目录必须使用绝对路径".to_owned());
    }
    Ok(root.join(directory).join(file))
}

fn app_data_file(app: &AppHandle, directory: &str, file: &str) -> Result<PathBuf, String> {
    #[cfg(feature = "test-data-override")]
    if let Some(root) = std::env::var_os("MDEDITOR_NATIVE_TEST_DATA") {
        let root = PathBuf::from(root);
        return test_data_file(&root, directory, file);
    }

    app.path()
        .app_data_dir()
        .map(|root| root.join(directory).join(file))
        .map_err(|error| format!("无法定位应用数据目录：{error}"))
}

#[cfg(all(test, feature = "test-data-override"))]
mod test_data_override_tests {
    use super::{test_data_file, RECENT_FILE, STATE_DIRECTORY};
    use std::path::Path;

    #[test]
    fn keeps_state_files_beneath_an_absolute_override_root() {
        let root = std::env::temp_dir().join("mdeditor-isolated-data");
        let resolved = test_data_file(&root, STATE_DIRECTORY, RECENT_FILE)
            .expect("absolute test root should be accepted");

        assert_eq!(resolved, root.join(STATE_DIRECTORY).join(RECENT_FILE));
        assert!(resolved.starts_with(root));
    }

    #[test]
    fn rejects_relative_override_roots() {
        let error = test_data_file(Path::new("relative-data"), STATE_DIRECTORY, RECENT_FILE)
            .expect_err("relative test root should be rejected");

        assert_eq!(error, "原生测试数据目录必须使用绝对路径");
    }
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

fn write_recent_documents(app: &AppHandle, recent: &[String]) -> Result<(), String> {
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

fn remember_recent_document(app: &AppHandle, path: &Path) -> Result<(), String> {
    let displayed = display_path(path);
    let mut recent = read_recent_documents(app).unwrap_or_default();
    recent.retain(|candidate| candidate != &displayed);
    recent.insert(0, displayed);
    recent.truncate(RECENT_LIMIT);
    write_recent_documents(app, &recent)
}

fn relocate_recent_documents(app: &AppHandle, source: &Path, destination: &Path) {
    let Ok(mut recent) = read_recent_documents(app) else {
        return;
    };
    let mut changed = false;
    for candidate in &mut recent {
        let path = Path::new(candidate);
        if path == source || path.starts_with(source) {
            let suffix = path.strip_prefix(source).unwrap_or(Path::new(""));
            *candidate = display_path(&destination.join(suffix));
            changed = true;
        }
    }
    if changed {
        let mut seen = HashSet::new();
        recent.retain(|path| seen.insert(path.clone()));
        recent.truncate(RECENT_LIMIT);
        let _ = write_recent_documents(app, &recent);
    }
}

fn remove_recent_documents(app: &AppHandle, source: &Path) {
    let Ok(mut recent) = read_recent_documents(app) else {
        return;
    };
    let previous_len = recent.len();
    recent.retain(|candidate| {
        let path = Path::new(candidate);
        path != source && !path.starts_with(source)
    });
    if recent.len() != previous_len {
        let _ = write_recent_documents(app, &recent);
    }
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

fn authorized_image_document(
    authorized_paths: &State<'_, AuthorizedPaths>,
    document_path: &str,
) -> Result<(PathBuf, String), String> {
    let document = normalize_existing_path(Path::new(document_path))?;
    if !is_authorized(authorized_paths, &document)? {
        return Err("拒绝为未授权的文档访问本地图片".to_owned());
    }
    validate_workspace_document(&document)?;
    let root = document
        .parent()
        .ok_or_else(|| "文档缺少所在目录".to_owned())?
        .to_path_buf();
    let name = document
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| "文档文件名无效".to_owned())?
        .to_owned();
    Ok((root, name))
}

fn resolve_scoped_image_link(
    root: &Path,
    source_relative_path: &str,
    target: &str,
) -> Result<(PathBuf, &'static str), String> {
    if !Path::new(target).is_absolute() {
        return resolve_workspace_image_link(root, source_relative_path, target);
    }
    let image = normalize_existing_path(Path::new(target))?;
    let relative = image
        .strip_prefix(root)
        .map_err(|_| "拒绝读取当前文档目录或授权工作区外的图片".to_owned())?;
    let encoded = relative
        .components()
        .map(|component| {
            component
                .as_os_str()
                .to_str()
                .map(|part| urlencoding::encode(part).into_owned())
                .ok_or_else(|| "图片路径包含无法解析的字符".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?
        .join("/");
    resolve_workspace_image_link(root, source_relative_path, &encoded)
}

fn is_authorized_root(state: &State<'_, AuthorizedRoots>, root: &Path) -> Result<bool, String> {
    Ok(state
        .0
        .lock()
        .map_err(|_| "工作区授权状态不可用".to_owned())?
        .contains(root))
}

fn relocate_authorized_paths(
    paths: &mut HashSet<PathBuf>,
    source: &Path,
    destination: &Path,
) -> Vec<WorkspaceRelocation> {
    let affected = paths
        .iter()
        .filter(|path| path.as_path() == source || path.starts_with(source))
        .cloned()
        .collect::<Vec<_>>();
    let mut relocations = Vec::with_capacity(affected.len());
    for old_path in affected {
        let suffix = old_path.strip_prefix(source).unwrap_or(Path::new(""));
        let new_path = destination.join(suffix);
        paths.remove(&old_path);
        paths.insert(new_path.clone());
        relocations.push(WorkspaceRelocation {
            from_path: display_path(&old_path),
            to_path: display_path(&new_path),
        });
    }
    relocations
}

fn contains_authorized_path(paths: &HashSet<PathBuf>, source: &Path) -> bool {
    paths
        .iter()
        .any(|path| path.as_path() == source || path.starts_with(source))
}

fn create_workspace_watcher(app: AppHandle, root: &Path) -> Result<RecommendedWatcher, String> {
    let event_root = display_path(root);
    watch_workspace(root, move || {
        let _ = app.emit(
            "workspace-changed",
            WorkspaceChangedEvent {
                root: event_root.clone(),
            },
        );
    })
}

fn workspace_response(root: &Path) -> Result<OpenWorkspaceResponse, String> {
    let name = root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| display_path(root));
    Ok(OpenWorkspaceResponse {
        root: display_path(root),
        name,
        entries: enumerate_workspace(root, MAX_WORKSPACE_ENTRIES)?,
    })
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

fn open_external_document(app: &AppHandle, selected: &Path) -> ExternalDocumentEvent {
    let result = (|| {
        let path = normalize_existing_path(selected)?;
        validate_workspace_document(&path)?;
        let (bytes, disk_fingerprint) =
            read_document(&path).map_err(|error| format!("读取文件失败：{error}"))?;
        validate_workspace_document(&path)?;
        authorize(&app.state::<AuthorizedPaths>(), path.clone())?;
        let _ = remember_recent_document(app, &path);
        Ok::<_, String>(OpenDocumentResponse {
            path: display_path(&path),
            bytes,
            disk_fingerprint,
        })
    })();
    match result {
        Ok(document) => ExternalDocumentEvent::Opened { document },
        Err(message) => ExternalDocumentEvent::Error {
            path: display_path(selected),
            message,
        },
    }
}

#[tauri::command]
async fn open_startup_documents(
    app: AppHandle,
    startup_paths: State<'_, StartupPaths>,
) -> Result<Vec<ExternalDocumentEvent>, String> {
    let paths = std::mem::take(
        &mut *startup_paths
            .0
            .lock()
            .map_err(|_| "启动文件列表不可用".to_owned())?,
    );
    let mut seen = HashSet::new();
    Ok(paths
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .map(|path| open_external_document(&app, &path))
        .collect())
}

fn pick_workspace_path(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    // Native WebDriver cannot operate the OS folder picker. This override is
    // absent from normal builds; the selected path still passes the same
    // canonicalization and authorization checks as a picker result.
    #[cfg(feature = "webdriver")]
    if let Some(path) = std::env::var_os("MDEDITOR_NATIVE_WORKSPACE_ROOT") {
        return Ok(Some(PathBuf::from(path)));
    }

    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|selected| {
            selected
                .into_path()
                .map_err(|_| "当前只支持打开本地文件夹".to_owned())
        })
        .transpose()
}

fn pick_image_path(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    // Native WebDriver cannot operate the OS picker. This override is absent
    // from normal builds; the selected file still passes image validation.
    #[cfg(feature = "webdriver")]
    if let Some(path) = std::env::var_os("MDEDITOR_NATIVE_IMAGE_PATH") {
        return Ok(Some(PathBuf::from(path)));
    }

    app.dialog()
        .file()
        .add_filter("图片", &["avif", "gif", "jpeg", "jpg", "png", "webp"])
        .blocking_pick_file()
        .map(|selected| {
            selected
                .into_path()
                .map_err(|_| "当前只支持导入本地图片".to_owned())
        })
        .transpose()
}

#[tauri::command]
async fn open_workspace(
    app: AppHandle,
    authorized_roots: State<'_, AuthorizedRoots>,
    active_watcher: State<'_, ActiveWorkspaceWatcher>,
    active_searches: State<'_, ActiveWorkspaceSearches>,
) -> Result<Option<OpenWorkspaceResponse>, String> {
    let selected = pick_workspace_path(&app)?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let root = normalize_existing_path(&selected)?;
    if !root.is_dir() {
        return Err("选择的工作区不是文件夹".to_owned());
    }
    let response = workspace_response(&root)?;
    let watcher = create_workspace_watcher(app, &root)?;
    cancel_workspace_searches(&active_searches, None)?;
    let mut roots = authorized_roots
        .0
        .lock()
        .map_err(|_| "工作区授权状态不可用".to_owned())?;
    let mut active_watcher = active_watcher
        .0
        .lock()
        .map_err(|_| "工作区监听状态不可用".to_owned())?;
    roots.clear();
    roots.insert(root);
    *active_watcher = Some(watcher);
    Ok(Some(response))
}

#[tauri::command]
async fn refresh_workspace(
    authorized_roots: State<'_, AuthorizedRoots>,
    root: String,
) -> Result<OpenWorkspaceResponse, String> {
    let root = normalize_existing_path(Path::new(&root))?;
    if !is_authorized_root(&authorized_roots, &root)? {
        return Err("拒绝枚举未经文件夹选择器授权的工作区".to_owned());
    }
    workspace_response(&root)
}

#[tauri::command]
async fn close_workspace(
    authorized_roots: State<'_, AuthorizedRoots>,
    active_watcher: State<'_, ActiveWorkspaceWatcher>,
    active_searches: State<'_, ActiveWorkspaceSearches>,
    root: String,
) -> Result<(), String> {
    // The selected root may have been renamed or removed externally. The UI
    // sends back the exact canonical path issued by `open_workspace`, so
    // revocation must not depend on that path still existing on disk.
    let root = PathBuf::from(root);
    let removed = authorized_roots
        .0
        .lock()
        .map_err(|_| "工作区授权状态不可用".to_owned())?
        .remove(&root);
    if removed {
        cancel_workspace_searches(&active_searches, Some(&root))?;
        active_watcher
            .0
            .lock()
            .map_err(|_| "工作区监听状态不可用".to_owned())?
            .take();
    }
    Ok(())
}

#[tauri::command]
async fn open_workspace_document(
    app: AppHandle,
    authorized_paths: State<'_, AuthorizedPaths>,
    authorized_roots: State<'_, AuthorizedRoots>,
    root: String,
    relative_path: String,
) -> Result<OpenDocumentResponse, String> {
    let root = normalize_existing_path(Path::new(&root))?;
    if !is_authorized_root(&authorized_roots, &root)? {
        return Err("拒绝访问未经文件夹选择器授权的工作区".to_owned());
    }
    let path = resolve_workspace_file(&root, &relative_path)?;
    validate_workspace_document(&path)?;
    let (bytes, disk_fingerprint) =
        read_document(&path).map_err(|error| format!("读取工作区文件失败：{error}"))?;
    authorize(&authorized_paths, path.clone())?;
    let _ = remember_recent_document(&app, &path);
    Ok(OpenDocumentResponse {
        path: display_path(&path),
        bytes,
        disk_fingerprint,
    })
}

#[tauri::command]
async fn open_workspace_link(
    app: AppHandle,
    authorized_paths: State<'_, AuthorizedPaths>,
    authorized_roots: State<'_, AuthorizedRoots>,
    root: String,
    source_relative_path: String,
    target: String,
) -> Result<OpenWorkspaceLinkResponse, String> {
    let root = normalize_existing_path(Path::new(&root))?;
    if !is_authorized_root(&authorized_roots, &root)? {
        return Err("拒绝访问未经文件夹选择器授权的工作区链接".to_owned());
    }
    let (path, relative_path, fragment) =
        resolve_workspace_document_link(&root, &source_relative_path, &target)?;
    let (bytes, disk_fingerprint) =
        read_document(&path).map_err(|error| format!("读取链接文档失败：{error}"))?;
    authorize(&authorized_paths, path.clone())?;
    let _ = remember_recent_document(&app, &path);
    Ok(OpenWorkspaceLinkResponse {
        document: OpenDocumentResponse {
            path: display_path(&path),
            bytes,
            disk_fingerprint,
        },
        relative_path,
        fragment,
    })
}

#[tauri::command]
async fn import_workspace_image(
    app: AppHandle,
    authorized_roots: State<'_, AuthorizedRoots>,
    root: String,
    source_relative_path: String,
) -> Result<Option<ImportedWorkspaceImageResponse>, String> {
    let root = normalize_existing_path(Path::new(&root))?;
    if !is_authorized_root(&authorized_roots, &root)? {
        return Err("拒绝向未经文件夹选择器授权的工作区导入图片".to_owned());
    }
    let selected = pick_image_path(&app)?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let (relative_path, markdown_path, suggested_alt) =
        import_workspace_image_on_disk(&root, &source_relative_path, &selected)?;
    Ok(Some(ImportedWorkspaceImageResponse {
        relative_path,
        markdown_path,
        suggested_alt,
    }))
}

#[tauri::command]
async fn import_workspace_image_data(
    authorized_roots: State<'_, AuthorizedRoots>,
    root: String,
    source_relative_path: String,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<ImportedWorkspaceImageResponse, String> {
    let root = normalize_existing_path(Path::new(&root))?;
    if !is_authorized_root(&authorized_roots, &root)? {
        return Err("拒绝向未经文件夹选择器授权的工作区导入图片数据".to_owned());
    }
    let (relative_path, markdown_path, suggested_alt) =
        import_workspace_image_bytes_on_disk(&root, &source_relative_path, &file_name, &bytes)?;
    Ok(ImportedWorkspaceImageResponse {
        relative_path,
        markdown_path,
        suggested_alt,
    })
}

#[tauri::command]
async fn read_workspace_image(
    authorized_roots: State<'_, AuthorizedRoots>,
    root: String,
    source_relative_path: String,
    target: String,
) -> Result<WorkspaceImagePreviewResponse, String> {
    let root = normalize_existing_path(Path::new(&root))?;
    if !is_authorized_root(&authorized_roots, &root)? {
        return Err("拒绝读取未经文件夹选择器授权的工作区图片".to_owned());
    }
    let (path, mime) = resolve_scoped_image_link(&root, &source_relative_path, &target)?;
    let file = fs::File::open(&path).map_err(|error| format!("打开本地图片失败：{error}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_WORKSPACE_IMAGE_PREVIEW_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取本地图片失败：{error}"))?;
    if bytes.len() as u64 > MAX_WORKSPACE_IMAGE_PREVIEW_BYTES {
        return Err("本地图片在读取期间超过预览大小上限".to_owned());
    }
    Ok(WorkspaceImagePreviewResponse {
        data_url: format!("data:{mime};base64,{}", BASE64_STANDARD.encode(bytes)),
    })
}

#[tauri::command]
async fn import_document_image(
    app: AppHandle,
    authorized_paths: State<'_, AuthorizedPaths>,
    document_path: String,
) -> Result<Option<ImportedWorkspaceImageResponse>, String> {
    let (root, source_relative_path) =
        authorized_image_document(&authorized_paths, &document_path)?;
    let selected = pick_image_path(&app)?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let (relative_path, markdown_path, suggested_alt) =
        import_workspace_image_on_disk(&root, &source_relative_path, &selected)?;
    Ok(Some(ImportedWorkspaceImageResponse {
        relative_path,
        markdown_path,
        suggested_alt,
    }))
}

#[tauri::command]
async fn import_document_image_data(
    authorized_paths: State<'_, AuthorizedPaths>,
    document_path: String,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<ImportedWorkspaceImageResponse, String> {
    let (root, source_relative_path) =
        authorized_image_document(&authorized_paths, &document_path)?;
    let (relative_path, markdown_path, suggested_alt) =
        import_workspace_image_bytes_on_disk(&root, &source_relative_path, &file_name, &bytes)?;
    Ok(ImportedWorkspaceImageResponse {
        relative_path,
        markdown_path,
        suggested_alt,
    })
}

#[tauri::command]
async fn import_dropped_document_image(
    authorized_paths: State<'_, AuthorizedPaths>,
    dropped_images: State<'_, DroppedImages>,
    document_path: String,
    dropped_path: String,
) -> Result<ImportedWorkspaceImageResponse, String> {
    let (root, source_relative_path) =
        authorized_image_document(&authorized_paths, &document_path)?;
    let selected = normalize_existing_path(Path::new(&dropped_path))?;
    if !dropped_images
        .0
        .lock()
        .map_err(|_| "拖放图片授权状态不可用".to_owned())?
        .remove(&selected)
    {
        return Err("图片未经系统拖放授权".to_owned());
    }
    let (relative_path, markdown_path, suggested_alt) =
        import_workspace_image_on_disk(&root, &source_relative_path, &selected)?;
    Ok(ImportedWorkspaceImageResponse {
        relative_path,
        markdown_path,
        suggested_alt,
    })
}

#[tauri::command]
async fn read_document_image(
    authorized_paths: State<'_, AuthorizedPaths>,
    document_path: String,
    target: String,
) -> Result<WorkspaceImagePreviewResponse, String> {
    let (root, source_relative_path) =
        authorized_image_document(&authorized_paths, &document_path)?;
    let (path, mime) = resolve_scoped_image_link(&root, &source_relative_path, &target)?;
    let file = fs::File::open(&path).map_err(|error| format!("打开本地图片失败：{error}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_WORKSPACE_IMAGE_PREVIEW_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取本地图片失败：{error}"))?;
    if bytes.len() as u64 > MAX_WORKSPACE_IMAGE_PREVIEW_BYTES {
        return Err("本地图片在读取期间超过预览大小上限".to_owned());
    }
    Ok(WorkspaceImagePreviewResponse {
        data_url: format!("data:{mime};base64,{}", BASE64_STANDARD.encode(bytes)),
    })
}

#[tauri::command]
async fn inspect_workspace_images(
    authorized_roots: State<'_, AuthorizedRoots>,
    root: String,
) -> Result<WorkspaceImageInspection, String> {
    let root = normalize_existing_path(Path::new(&root))?;
    if !is_authorized_root(&authorized_roots, &root)? {
        return Err("拒绝检查未经文件夹选择器授权的工作区图片引用".to_owned());
    }
    inspect_workspace_images_on_disk(&root)
}

#[tauri::command]
async fn inspect_workspace_image_references(
    authorized_roots: State<'_, AuthorizedRoots>,
    root: String,
    source_relative_path: String,
) -> Result<WorkspaceImageReferenceInspection, String> {
    let root = normalize_existing_path(Path::new(&root))?;
    if !is_authorized_root(&authorized_roots, &root)? {
        return Err("拒绝在未经文件夹选择器授权的工作区中扫描图片引用".to_owned());
    }
    inspect_workspace_image_references_on_disk(&root, &source_relative_path)
}

#[tauri::command]
async fn preview_workspace_image_move(
    authorized_roots: State<'_, AuthorizedRoots>,
    root: String,
    source_relative_path: String,
    destination_relative_path: String,
) -> Result<WorkspaceImageMovePreview, String> {
    let root = normalize_existing_path(Path::new(&root))?;
    if !is_authorized_root(&authorized_roots, &root)? {
        return Err("拒绝在未经文件夹选择器授权的工作区中预览图片移动".to_owned());
    }
    preview_workspace_image_move_on_disk(&root, &source_relative_path, &destination_relative_path)
}

#[tauri::command]
async fn move_workspace_image_with_references(
    authorized_paths: State<'_, AuthorizedPaths>,
    authorized_roots: State<'_, AuthorizedRoots>,
    root: String,
    source_relative_path: String,
    destination_relative_path: String,
) -> Result<Vec<String>, String> {
    let root = normalize_existing_path(Path::new(&root))?;
    if !is_authorized_root(&authorized_roots, &root)? {
        return Err("拒绝在未经文件夹选择器授权的工作区中移动图片".to_owned());
    }
    let paths = authorized_paths
        .0
        .lock()
        .map_err(|_| "文件授权状态不可用".to_owned())?;
    move_workspace_image_and_rewrite(
        &root,
        &source_relative_path,
        &destination_relative_path,
        |document| paths.contains(document),
    )
}

#[tauri::command]
async fn copy_workspace_image_with_references(
    authorized_paths: State<'_, AuthorizedPaths>,
    authorized_roots: State<'_, AuthorizedRoots>,
    root: String,
    source_relative_path: String,
    destination_relative_path: String,
) -> Result<Vec<String>, String> {
    let root = normalize_existing_path(Path::new(&root))?;
    if !is_authorized_root(&authorized_roots, &root)? {
        return Err("拒绝在未经文件夹选择器授权的工作区中复制图片并切换引用".to_owned());
    }
    let paths = authorized_paths
        .0
        .lock()
        .map_err(|_| "文件授权状态不可用".to_owned())?;
    copy_workspace_image_and_rewrite(
        &root,
        &source_relative_path,
        &destination_relative_path,
        |document| paths.contains(document),
    )
}

#[tauri::command]
async fn preview_workspace_image_consolidation(
    authorized_roots: State<'_, AuthorizedRoots>,
    root: String,
    destination_relative_path: String,
) -> Result<WorkspaceImageConsolidationPreview, String> {
    let root = normalize_existing_path(Path::new(&root))?;
    if !is_authorized_root(&authorized_roots, &root)? {
        return Err("拒绝在未经文件夹选择器授权的工作区中预览图片归拢".to_owned());
    }
    preview_workspace_image_consolidation_on_disk(&root, &destination_relative_path)
}

#[tauri::command]
async fn consolidate_workspace_images(
    authorized_paths: State<'_, AuthorizedPaths>,
    authorized_roots: State<'_, AuthorizedRoots>,
    root: String,
    destination_relative_path: String,
    expected_preview: WorkspaceImageConsolidationPreview,
) -> Result<Vec<String>, String> {
    let root = normalize_existing_path(Path::new(&root))?;
    if !is_authorized_root(&authorized_roots, &root)? {
        return Err("拒绝在未经文件夹选择器授权的工作区中归拢图片".to_owned());
    }
    let paths = authorized_paths
        .0
        .lock()
        .map_err(|_| "文件授权状态不可用".to_owned())?;
    consolidate_workspace_images_on_disk(
        &root,
        &destination_relative_path,
        &expected_preview,
        |document| paths.contains(document),
    )
}

#[tauri::command]
async fn preview_workspace_document_move(
    authorized_roots: State<'_, AuthorizedRoots>,
    root: String,
    source_relative_path: String,
    destination_relative_path: String,
) -> Result<WorkspaceDocumentMovePreview, String> {
    let root = normalize_existing_path(Path::new(&root))?;
    if !is_authorized_root(&authorized_roots, &root)? {
        return Err("拒绝在未经文件夹选择器授权的工作区中预览文档移动".to_owned());
    }
    preview_workspace_document_move_on_disk(
        &root,
        &source_relative_path,
        &destination_relative_path,
    )
}

#[tauri::command]
async fn move_workspace_document_with_links(
    app: AppHandle,
    authorized_paths: State<'_, AuthorizedPaths>,
    authorized_roots: State<'_, AuthorizedRoots>,
    root: String,
    source_relative_path: String,
    destination_relative_path: String,
) -> Result<Vec<String>, String> {
    let root = normalize_existing_path(Path::new(&root))?;
    if !is_authorized_root(&authorized_roots, &root)? {
        return Err("拒绝在未经文件夹选择器授权的工作区中移动文档".to_owned());
    }
    let paths = authorized_paths
        .0
        .lock()
        .map_err(|_| "文件授权状态不可用".to_owned())?;
    let (source, destination, changed_documents) = move_workspace_document_and_rewrite(
        &root,
        &source_relative_path,
        &destination_relative_path,
        |document| paths.contains(document),
    )?;
    drop(paths);
    relocate_recent_documents(&app, &source, &destination);
    Ok(changed_documents)
}

#[tauri::command]
async fn create_workspace_file(
    app: AppHandle,
    authorized_paths: State<'_, AuthorizedPaths>,
    authorized_roots: State<'_, AuthorizedRoots>,
    root: String,
    relative_path: String,
) -> Result<OpenDocumentResponse, String> {
    let root = normalize_existing_path(Path::new(&root))?;
    if !is_authorized_root(&authorized_roots, &root)? {
        return Err("拒绝在未经文件夹选择器授权的工作区中新建文档".to_owned());
    }
    let path = create_workspace_document_entry(&root, &relative_path)?;
    let created = (|| {
        let (bytes, disk_fingerprint) =
            read_document(&path).map_err(|error| format!("读取新建文档失败：{error}"))?;
        authorize(&authorized_paths, path.clone())?;
        Ok(OpenDocumentResponse {
            path: display_path(&path),
            bytes,
            disk_fingerprint,
        })
    })();
    if created.is_err() {
        let _ = fs::remove_file(&path);
    } else {
        let _ = remember_recent_document(&app, &path);
    }
    created
}

#[tauri::command]
async fn create_workspace_directory(
    authorized_roots: State<'_, AuthorizedRoots>,
    root: String,
    relative_path: String,
) -> Result<(), String> {
    let root = normalize_existing_path(Path::new(&root))?;
    if !is_authorized_root(&authorized_roots, &root)? {
        return Err("拒绝在未经文件夹选择器授权的工作区中新建文件夹".to_owned());
    }
    create_workspace_directory_entry(&root, &relative_path).map(|_| ())
}

#[tauri::command]
async fn move_workspace_entry(
    app: AppHandle,
    authorized_paths: State<'_, AuthorizedPaths>,
    authorized_roots: State<'_, AuthorizedRoots>,
    root: String,
    source_relative_path: String,
    destination_relative_path: String,
) -> Result<Vec<WorkspaceRelocation>, String> {
    let root = normalize_existing_path(Path::new(&root))?;
    if !is_authorized_root(&authorized_roots, &root)? {
        return Err("拒绝在未经文件夹选择器授权的工作区中移动条目".to_owned());
    }
    let mut paths = authorized_paths
        .0
        .lock()
        .map_err(|_| "文件授权状态不可用".to_owned())?;
    let (source, destination) =
        move_workspace_entry_on_disk(&root, &source_relative_path, &destination_relative_path)?;
    let relocations = relocate_authorized_paths(&mut paths, &source, &destination);
    drop(paths);
    relocate_recent_documents(&app, &source, &destination);
    Ok(relocations)
}

#[cfg(test)]
mod workspace_authorization_tests {
    use super::{
        contains_authorized_path, relocate_authorized_paths, resolve_scoped_image_link,
        WorkspaceSearchEvent,
    };
    use crate::workspace_io::WorkspaceSearchMatch;
    use std::{collections::HashSet, fs, path::PathBuf, time::SystemTime};

    #[test]
    fn resolves_absolute_images_only_inside_the_document_directory() {
        let fixture = std::env::temp_dir().join(format!(
            "mdeditor-absolute-image-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .expect("current time")
                .as_nanos()
        ));
        let root = fixture.join("文档");
        fs::create_dir_all(&root).expect("create document directory");
        fs::write(root.join("说明.md"), "# 图片").expect("write document");
        let inside = root.join("截图.png");
        fs::write(&inside, [1, 2, 3]).expect("write image");
        let outside = fixture.join("外部.png");
        fs::write(&outside, [1, 2, 3]).expect("write outside image");
        let root = fs::canonicalize(root).expect("canonicalize document directory");

        let (resolved, mime) = resolve_scoped_image_link(
            &root,
            "说明.md",
            inside.to_str().expect("image path is UTF-8"),
        )
        .expect("preview image beside document");
        assert_eq!(
            resolved,
            fs::canonicalize(inside).expect("canonicalize image")
        );
        assert_eq!(mime, "image/png");
        assert!(resolve_scoped_image_link(
            &root,
            "说明.md",
            outside.to_str().expect("outside path is UTF-8")
        )
        .is_err());
        fs::remove_dir_all(fixture).expect("remove image fixture");
    }

    #[test]
    fn relocates_only_authorized_documents_beneath_the_moved_entry() {
        let source = PathBuf::from("C:/workspace/docs");
        let destination = PathBuf::from("C:/workspace/archive");
        let nested = source.join("nested/note.md");
        let unrelated = PathBuf::from("C:/workspace/other.md");
        let mut paths = HashSet::from([nested.clone(), unrelated.clone()]);

        let relocations = relocate_authorized_paths(&mut paths, &source, &destination);

        assert_eq!(relocations.len(), 1);
        assert!(!paths.contains(&nested));
        assert!(paths.contains(&destination.join("nested/note.md")));
        assert!(paths.contains(&unrelated));
    }

    #[test]
    fn detects_only_authorized_documents_beneath_the_entry() {
        let source = PathBuf::from("C:/workspace/docs");
        let paths = HashSet::from([
            source.join("nested/note.md"),
            PathBuf::from("C:/workspace/other.md"),
        ]);

        assert!(contains_authorized_path(&paths, &source));
        assert!(!contains_authorized_path(
            &paths,
            PathBuf::from("C:/workspace/images").as_path(),
        ));
    }

    #[test]
    fn serializes_workspace_search_events_for_the_renderer_contract() {
        let value = serde_json::to_value(WorkspaceSearchEvent::Batch {
            request_id: "request-1".to_owned(),
            matches: vec![WorkspaceSearchMatch {
                relative_path: "文档/说明.md".to_owned(),
                line: 2,
                column: 3,
                preview: "命中".to_owned(),
            }],
        })
        .expect("serialize event");

        assert_eq!(value["kind"], "batch");
        assert_eq!(value["requestId"], "request-1");
        assert_eq!(value["matches"][0]["relativePath"], "文档/说明.md");
    }
}

#[tauri::command]
async fn copy_workspace_entry(
    authorized_roots: State<'_, AuthorizedRoots>,
    root: String,
    source_relative_path: String,
    destination_relative_path: String,
) -> Result<(), String> {
    let root = normalize_existing_path(Path::new(&root))?;
    if !is_authorized_root(&authorized_roots, &root)? {
        return Err("拒绝在未经文件夹选择器授权的工作区中复制条目".to_owned());
    }
    copy_workspace_entry_on_disk(&root, &source_relative_path, &destination_relative_path)
        .map(|_| ())
}

#[tauri::command]
async fn release_document_authorization(
    authorized_paths: State<'_, AuthorizedPaths>,
    path: String,
) -> Result<(), String> {
    let supplied = PathBuf::from(path);
    let normalized = normalize_existing_path(&supplied).unwrap_or(supplied);
    authorized_paths
        .0
        .lock()
        .map_err(|_| "文件授权状态不可用".to_owned())?
        .remove(&normalized);
    Ok(())
}

#[tauri::command]
async fn delete_workspace_entry(
    app: AppHandle,
    authorized_paths: State<'_, AuthorizedPaths>,
    authorized_roots: State<'_, AuthorizedRoots>,
    root: String,
    relative_path: String,
) -> Result<(), String> {
    let root = normalize_existing_path(Path::new(&root))?;
    if !is_authorized_root(&authorized_roots, &root)? {
        return Err("拒绝在未经文件夹选择器授权的工作区中删除条目".to_owned());
    }
    let source = resolve_workspace_entry(&root, &relative_path)?;
    let paths = authorized_paths
        .0
        .lock()
        .map_err(|_| "文件授权状态不可用".to_owned())?;
    if contains_authorized_path(&paths, &source) {
        return Err("条目仍有已打开文档，请先关闭相关标签页".to_owned());
    }
    trash::delete(&source).map_err(|error| format!("移到系统回收站失败：{error}"))?;
    drop(paths);
    remove_recent_documents(&app, &source);
    Ok(())
}

#[tauri::command]
async fn delete_workspace_image(
    app: AppHandle,
    authorized_paths: State<'_, AuthorizedPaths>,
    authorized_roots: State<'_, AuthorizedRoots>,
    root: String,
    relative_path: String,
    expected_references: Vec<WorkspaceImageReference>,
) -> Result<(), String> {
    let root = normalize_existing_path(Path::new(&root))?;
    if !is_authorized_root(&authorized_roots, &root)? {
        return Err("拒绝在未经文件夹选择器授权的工作区中删除图片".to_owned());
    }
    let inspection = inspect_workspace_image_references_on_disk(&root, &relative_path)?;
    if inspection.truncated {
        return Err("图片引用扫描达到安全上限，不会删除图片".to_owned());
    }
    if inspection.references != expected_references {
        return Err("图片引用在确认后发生变化，请重新预览后再删除".to_owned());
    }
    let source = resolve_workspace_file(&root, &relative_path)?;
    let paths = authorized_paths
        .0
        .lock()
        .map_err(|_| "文件授权状态不可用".to_owned())?;
    if contains_authorized_path(&paths, &source) {
        return Err("图片仍被已打开文件授权占用，无法删除".to_owned());
    }
    trash::delete(&source).map_err(|error| format!("移到系统回收站失败：{error}"))?;
    drop(paths);
    remove_recent_documents(&app, &source);
    Ok(())
}

#[tauri::command]
async fn start_workspace_search(
    app: AppHandle,
    authorized_roots: State<'_, AuthorizedRoots>,
    active_searches: State<'_, ActiveWorkspaceSearches>,
    root: String,
    request_id: String,
    query: String,
    options: WorkspaceSearchOptions,
) -> Result<(), String> {
    let root = normalize_existing_path(Path::new(&root))?;
    if !is_authorized_root(&authorized_roots, &root)? {
        return Err("拒绝搜索未经文件夹选择器授权的工作区".to_owned());
    }
    if request_id.is_empty() || request_id.len() > 128 {
        return Err("工作区搜索请求标识无效".to_owned());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Some((_, previous)) = active_searches
        .0
        .lock()
        .map_err(|_| "工作区搜索状态不可用".to_owned())?
        .insert(request_id.clone(), (root.clone(), cancelled.clone()))
    {
        previous.store(true, Ordering::Relaxed);
    }

    tauri::async_runtime::spawn_blocking(move || {
        let emit_app = app.clone();
        let emit_request = request_id.clone();
        let completion = search_workspace(&root, &query, options, &cancelled, move |matches| {
            emit_app
                .emit(
                    "workspace-search",
                    WorkspaceSearchEvent::Batch {
                        request_id: emit_request.clone(),
                        matches,
                    },
                )
                .map_err(|error| format!("发送工作区搜索结果失败：{error}"))
        });

        if let Ok(mut searches) = app.state::<ActiveWorkspaceSearches>().0.lock() {
            let is_current = searches
                .get(&request_id)
                .is_some_and(|(_, current)| Arc::ptr_eq(current, &cancelled));
            if is_current {
                searches.remove(&request_id);
            }
        }

        let event = match completion {
            Ok(WorkspaceSearchCompletion::Complete { truncated }) => {
                WorkspaceSearchEvent::Complete {
                    request_id,
                    truncated,
                }
            }
            Ok(WorkspaceSearchCompletion::Cancelled) => {
                WorkspaceSearchEvent::Cancelled { request_id }
            }
            Err(message) => WorkspaceSearchEvent::Error {
                request_id,
                message,
            },
        };
        let _ = app.emit("workspace-search", event);
    });
    Ok(())
}

#[tauri::command]
async fn cancel_workspace_search(
    active_searches: State<'_, ActiveWorkspaceSearches>,
    request_id: String,
) -> Result<(), String> {
    if let Some((_, cancelled)) = active_searches
        .0
        .lock()
        .map_err(|_| "工作区搜索状态不可用".to_owned())?
        .remove(&request_id)
    {
        cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
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

fn export_html_to_path(path: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    let path = normalize_destination_path(path)?;
    let expected_fingerprint = match read_document(&path) {
        Ok((_, fingerprint)) => Some(fingerprint),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("检查 HTML 导出目标失败：{error}")),
    };
    atomic_save(&path, bytes, expected_fingerprint.as_deref())
        .map_err(|error| format!("导出 HTML 失败：{error}"))?;
    normalize_existing_path(&path)
}

#[tauri::command]
async fn export_html(app: AppHandle, request: ExportHtmlRequest) -> Result<Option<String>, String> {
    let selected = app
        .dialog()
        .file()
        .add_filter("HTML", &["html", "htm"])
        .set_file_name(&request.suggested_name)
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };

    let selected = selected
        .into_path()
        .map_err(|_| "当前只支持导出到本地文件".to_owned())?;
    let path = export_html_to_path(&selected, &request.bytes)?;
    Ok(Some(display_path(&path)))
}

fn export_image_to_path(path: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    const MAXIMUM_PNG_BYTES: usize = 128 * 1024 * 1024;
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err("图片导出数据不是有效的 PNG".to_owned());
    }
    if bytes.len() > MAXIMUM_PNG_BYTES {
        return Err("图片导出数据超过 128 MiB 限制".to_owned());
    }
    let path = normalize_destination_path(path)?;
    let expected_fingerprint = match read_document(&path) {
        Ok((_, fingerprint)) => Some(fingerprint),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("检查 PNG 导出目标失败：{error}")),
    };
    atomic_save(&path, bytes, expected_fingerprint.as_deref())
        .map_err(|error| format!("导出 PNG 失败：{error}"))?;
    normalize_existing_path(&path)
}

#[tauri::command]
async fn export_image(
    app: AppHandle,
    request: ExportImageRequest,
) -> Result<Option<String>, String> {
    let selected = app
        .dialog()
        .file()
        .add_filter("PNG image", &["png"])
        .set_file_name(&request.suggested_name)
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };

    let selected = selected
        .into_path()
        .map_err(|_| "当前只支持导出到本地文件".to_owned())?;
    let path = export_image_to_path(&selected, &request.bytes)?;
    Ok(Some(display_path(&path)))
}

fn detect_pandoc_at(program: &OsStr) -> PandocStatus {
    let version = Command::new(program)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(|line| line.chars().take(200).collect::<String>())
        });
    PandocStatus {
        available: version.is_some(),
        version,
        install_url: PANDOC_INSTALL_URL.to_owned(),
    }
}

fn detect_pandoc() -> PandocStatus {
    detect_pandoc_at(OsStr::new("pandoc"))
}

fn validate_pandoc_html(bytes: &[u8], maximum_bytes: usize) -> Result<(), String> {
    if bytes.len() > maximum_bytes {
        return Err("DOCX 导出 HTML 超过 160 MiB 限制".to_owned());
    }
    let html = std::str::from_utf8(bytes).map_err(|_| "DOCX 导出 HTML 不是 UTF-8".to_owned())?;
    if !html.trim_start().starts_with("<!doctype html>") {
        return Err("DOCX 导出输入不是完整 HTML 文档".to_owned());
    }
    Ok(())
}

fn validate_docx_bytes(bytes: &[u8], maximum_bytes: usize) -> Result<(), String> {
    if bytes.len() > maximum_bytes {
        return Err("Pandoc 生成的 DOCX 超过 256 MiB 限制".to_owned());
    }
    if !bytes.starts_with(b"PK\x03\x04") {
        return Err("Pandoc 未生成有效的 DOCX 容器".to_owned());
    }
    Ok(())
}

fn convert_html_to_docx_at(program: &OsStr, html: &[u8]) -> Result<Vec<u8>, String> {
    validate_pandoc_html(html, MAXIMUM_PANDOC_HTML_BYTES)?;
    let directory = tempfile::Builder::new()
        .prefix("mdeditor-pandoc-")
        .tempdir()
        .map_err(|error| format!("无法创建 Pandoc 临时目录：{error}"))?;
    let input = directory.path().join("input.html");
    let output = directory.path().join("output.docx");
    fs::write(&input, html).map_err(|error| format!("无法写入 Pandoc 临时输入：{error}"))?;

    let result = Command::new(program)
        .arg("--sandbox")
        .arg("--from=html")
        .arg("--to=docx")
        .arg("--output")
        .arg(&output)
        .arg(&input)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                format!("未检测到 Pandoc，请先安装：{PANDOC_INSTALL_URL}")
            } else {
                format!("无法启动 Pandoc：{error}")
            }
        })?;
    if !result.status.success() {
        let details = String::from_utf8_lossy(&result.stderr)
            .trim()
            .chars()
            .take(2_000)
            .collect::<String>();
        return Err(if details.is_empty() {
            format!("Pandoc 转换失败（退出状态 {}）", result.status)
        } else {
            format!("Pandoc 转换失败：{details}")
        });
    }

    let metadata = fs::metadata(&output).map_err(|error| format!("读取 DOCX 结果失败：{error}"))?;
    if metadata.len() > MAXIMUM_DOCX_BYTES as u64 {
        return Err("Pandoc 生成的 DOCX 超过 256 MiB 限制".to_owned());
    }
    let bytes = fs::read(&output).map_err(|error| format!("读取 DOCX 结果失败：{error}"))?;
    validate_docx_bytes(&bytes, MAXIMUM_DOCX_BYTES)?;
    Ok(bytes)
}

fn export_docx_to_path(path: &Path, html: &[u8], program: &OsStr) -> Result<PathBuf, String> {
    let path = normalize_destination_path(path)?;
    let expected_fingerprint = match read_document(&path) {
        Ok((_, fingerprint)) => Some(fingerprint),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("检查 DOCX 导出目标失败：{error}")),
    };
    let bytes = convert_html_to_docx_at(program, html)?;
    atomic_save(&path, &bytes, expected_fingerprint.as_deref())
        .map_err(|error| format!("导出 DOCX 失败：{error}"))?;
    normalize_existing_path(&path)
}

#[tauri::command]
async fn get_pandoc_status() -> Result<PandocStatus, String> {
    tauri::async_runtime::spawn_blocking(detect_pandoc)
        .await
        .map_err(|error| format!("检测 Pandoc 失败：{error}"))
}

#[tauri::command]
async fn export_docx(app: AppHandle, request: ExportDocxRequest) -> Result<Option<String>, String> {
    if !detect_pandoc().available {
        return Err(format!("未检测到 Pandoc，请先安装：{PANDOC_INSTALL_URL}"));
    }
    let selected = app
        .dialog()
        .file()
        .add_filter("Word document", &["docx"])
        .set_file_name(&request.suggested_name)
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let selected = selected
        .into_path()
        .map_err(|_| "当前只支持导出到本地文件".to_owned())?;
    let path = tauri::async_runtime::spawn_blocking(move || {
        export_docx_to_path(&selected, &request.bytes, OsStr::new("pandoc"))
    })
    .await
    .map_err(|error| format!("等待 Pandoc 转换失败：{error}"))??;
    Ok(Some(display_path(&path)))
}

fn recovery_path(app: &AppHandle) -> Result<PathBuf, String> {
    app_data_file(app, RECOVERY_DIRECTORY, RECOVERY_FILE)
}

fn load_recovery_snapshot_from_path(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取恢复稿失败：{error}")),
    }
}

fn save_recovery_snapshot_to_path(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "恢复稿路径缺少父目录".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建恢复目录失败：{error}"))?;

    let expected_fingerprint = match read_document(path) {
        Ok((_, fingerprint)) => Some(fingerprint),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("检查现有恢复稿失败：{error}")),
    };

    atomic_save(path, bytes, expected_fingerprint.as_deref())
        .map(|_| ())
        .map_err(|error| format!("写入恢复稿失败：{error}"))
}

fn clear_recovery_snapshot_at_path(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除恢复稿失败：{error}")),
    }
}

#[tauri::command]
async fn load_recovery_snapshot(app: AppHandle) -> Result<Option<Vec<u8>>, String> {
    load_recovery_snapshot_from_path(&recovery_path(&app)?)
}

#[tauri::command]
async fn save_recovery_snapshot(app: AppHandle, bytes: Vec<u8>) -> Result<(), String> {
    save_recovery_snapshot_to_path(&recovery_path(&app)?, &bytes)
}

#[tauri::command]
async fn clear_recovery_snapshot(app: AppHandle) -> Result<(), String> {
    clear_recovery_snapshot_at_path(&recovery_path(&app)?)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let startup_paths = std::env::args_os()
        .skip(1)
        .filter(|argument| !argument.to_string_lossy().starts_with('-'))
        .map(PathBuf::from)
        .collect();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .manage(AuthorizedPaths::default())
        .manage(StartupPaths(Mutex::new(startup_paths)))
        .manage(AuthorizedRoots::default())
        .manage(ActiveWorkspaceWatcher::default())
        .manage(ActiveWorkspaceSearches::default())
        .manage(DroppedImages::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let app = window.app_handle().clone();
                let paths = paths.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    for path in paths {
                        let is_image = path
                            .extension()
                            .and_then(OsStr::to_str)
                            .map(|extension| {
                                matches!(
                                    extension.to_ascii_lowercase().as_str(),
                                    "avif" | "gif" | "jpeg" | "jpg" | "png" | "webp"
                                )
                            })
                            .unwrap_or(false);
                        if is_image {
                            if let Ok(path) = normalize_existing_path(&path) {
                                if let Ok(mut authorized) = app.state::<DroppedImages>().0.lock() {
                                    authorized.insert(path.clone());
                                }
                                let _ = app.emit("external-image-dropped", display_path(&path));
                            }
                            continue;
                        }
                        let opened = open_external_document(&app, &path);
                        let _ = app.emit("external-document-opened", opened);
                    }
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_document,
            open_startup_documents,
            open_workspace,
            refresh_workspace,
            close_workspace,
            open_workspace_document,
            open_workspace_link,
            import_workspace_image,
            import_workspace_image_data,
            read_workspace_image,
            import_document_image,
            import_document_image_data,
            import_dropped_document_image,
            read_document_image,
            inspect_workspace_images,
            inspect_workspace_image_references,
            preview_workspace_image_move,
            move_workspace_image_with_references,
            copy_workspace_image_with_references,
            preview_workspace_image_consolidation,
            consolidate_workspace_images,
            preview_workspace_document_move,
            move_workspace_document_with_links,
            create_workspace_file,
            create_workspace_directory,
            move_workspace_entry,
            copy_workspace_entry,
            delete_workspace_entry,
            delete_workspace_image,
            release_document_authorization,
            start_workspace_search,
            cancel_workspace_search,
            open_recent_document,
            list_recent_documents,
            save_document,
            save_document_as,
            export_html,
            export_image,
            get_pandoc_status,
            export_docx,
            load_recovery_snapshot,
            save_recovery_snapshot,
            clear_recovery_snapshot
        ])
        .run(tauri::generate_context!())
        .expect("error while running MDEditor");
}

#[cfg(test)]
mod export_tests {
    use super::{
        detect_pandoc_at, export_html_to_path, export_image_to_path, validate_docx_bytes,
        validate_pandoc_html,
    };
    use std::{ffi::OsStr, fs, time::SystemTime};

    #[test]
    fn exports_complete_html_bytes_and_replaces_an_existing_target() {
        let unique = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("mdeditor-export-{}-{unique}", std::process::id()));
        fs::create_dir_all(&directory).expect("create export test directory");
        let target = directory.join("示例 export.html");
        fs::write(&target, b"old").expect("seed export target");
        let html = "<!doctype html><title>示例</title>".as_bytes();

        let exported = export_html_to_path(&target, html).expect("export html");

        assert_eq!(
            exported,
            fs::canonicalize(&target).expect("canonical target")
        );
        assert_eq!(fs::read(&target).expect("read exported html"), html);
        fs::remove_dir_all(directory).expect("remove export test directory");
    }

    #[test]
    fn exports_only_bounded_png_bytes() {
        let unique = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "mdeditor-image-export-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("create image export directory");
        let target = directory.join("示例.png");
        let png = b"\x89PNG\r\n\x1a\nfixture";

        let exported = export_image_to_path(&target, png).expect("export png");
        assert_eq!(fs::read(&exported).expect("read png"), png);
        assert!(export_image_to_path(&target, b"not png").is_err());
        fs::remove_dir_all(directory).expect("remove image export directory");
    }

    #[test]
    fn reports_a_missing_optional_pandoc_without_affecting_startup() {
        let status = detect_pandoc_at(OsStr::new("mdeditor-pandoc-command-that-does-not-exist"));
        assert!(!status.available);
        assert!(status.version.is_none());
        assert_eq!(status.install_url, "https://pandoc.org/installing.html");
    }

    #[test]
    fn validates_bounded_html_and_docx_conversion_boundaries() {
        assert!(validate_pandoc_html(b"<!doctype html><p>safe</p>", 64).is_ok());
        assert!(validate_pandoc_html(b"not html", 64).is_err());
        assert!(validate_pandoc_html(b"<!doctype html>", 8).is_err());
        assert!(validate_docx_bytes(b"PK\x03\x04docx", 16).is_ok());
        assert!(validate_docx_bytes(b"not docx", 16).is_err());
        assert!(validate_docx_bytes(b"PK\x03\x04docx", 7).is_err());
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::{
        clear_recovery_snapshot_at_path, load_recovery_snapshot_from_path,
        save_recovery_snapshot_to_path,
    };
    use std::{fs, path::PathBuf, time::SystemTime};

    fn test_directory() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("mdeditor-recovery-{}-{unique}", std::process::id()))
    }

    #[test]
    fn recovery_snapshot_round_trips_replaces_and_clears_exact_bytes() {
        let directory = test_directory();
        let target = directory.join("nested").join("active.json");
        let first = br#"{"version":2,"tabs":[{"markdown":"draft\r\n"}]}"#;
        let second = "{\"version\":2,\"tabs\":[{\"markdown\":\"中文🙂\\n\"}]}".as_bytes();

        assert_eq!(
            load_recovery_snapshot_from_path(&target).expect("load missing snapshot"),
            None
        );
        clear_recovery_snapshot_at_path(&target).expect("clear missing snapshot");

        save_recovery_snapshot_to_path(&target, first).expect("save first snapshot");
        assert_eq!(
            load_recovery_snapshot_from_path(&target).expect("load first snapshot"),
            Some(first.to_vec())
        );

        save_recovery_snapshot_to_path(&target, second).expect("replace snapshot");
        assert_eq!(
            load_recovery_snapshot_from_path(&target).expect("load replaced snapshot"),
            Some(second.to_vec())
        );
        assert_eq!(
            fs::read_dir(target.parent().expect("snapshot parent"))
                .expect("read snapshot directory")
                .count(),
            1,
            "atomic replacement must not leak a temporary file"
        );

        clear_recovery_snapshot_at_path(&target).expect("clear snapshot");
        assert_eq!(
            load_recovery_snapshot_from_path(&target).expect("load cleared snapshot"),
            None
        );
        fs::remove_dir_all(directory).expect("remove recovery test directory");
    }
}
