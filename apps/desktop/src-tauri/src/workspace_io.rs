use std::{
    fs,
    fs::OpenOptions,
    io,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};

use crate::file_io::{atomic_save, read_document};

pub(crate) const MAX_WORKSPACE_DEPTH: usize = 64;
pub(crate) const MAX_WORKSPACE_ENTRIES: usize = 20_000;
pub(crate) const MAX_WORKSPACE_DOCUMENT_BYTES: u64 = 32 * 1024 * 1024;
pub(crate) const MAX_WORKSPACE_SEARCH_BYTES: u64 = 4 * 1024 * 1024;
pub(crate) const MAX_WORKSPACE_SEARCH_MATCHES: usize = 5_000;
pub(crate) const MAX_WORKSPACE_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const MAX_WORKSPACE_IMAGE_PREVIEW_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) const MAX_WORKSPACE_IMAGE_ISSUES: usize = 2_000;
const WORKSPACE_SEARCH_BATCH_SIZE: usize = 50;
const MARKDOWN_EXTENSIONS: [&str; 4] = ["md", "markdown", "mdown", "mkd"];
const IMAGE_EXTENSIONS: [&str; 6] = ["avif", "gif", "jpeg", "jpg", "png", "webp"];

pub(crate) fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
        .is_some_and(|extension| MARKDOWN_EXTENSIONS.contains(&extension))
}

pub(crate) fn is_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
        .is_some_and(|extension| IMAGE_EXTENSIONS.contains(&extension))
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceSearchOptions {
    pub(crate) case_sensitive: bool,
    pub(crate) whole_word: bool,
    pub(crate) regular_expression: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceSearchMatch {
    pub(crate) relative_path: String,
    pub(crate) line: usize,
    pub(crate) column: usize,
    pub(crate) preview: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceImageIssue {
    pub(crate) document_relative_path: String,
    pub(crate) line: usize,
    pub(crate) column: usize,
    pub(crate) target: String,
    pub(crate) reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceImageInspection {
    pub(crate) issues: Vec<WorkspaceImageIssue>,
    pub(crate) truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceImageReferenceUpdate {
    pub(crate) document_relative_path: String,
    pub(crate) line: usize,
    pub(crate) column: usize,
    pub(crate) from_target: String,
    pub(crate) to_target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceImageMovePreview {
    pub(crate) updates: Vec<WorkspaceImageReferenceUpdate>,
    pub(crate) truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceImageConsolidationCopy {
    pub(crate) source_relative_path: String,
    pub(crate) destination_relative_path: String,
    pub(crate) reference_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceImageConsolidationPreview {
    pub(crate) copies: Vec<WorkspaceImageConsolidationCopy>,
    pub(crate) updates: Vec<WorkspaceImageReferenceUpdate>,
    pub(crate) truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceImageReference {
    pub(crate) document_relative_path: String,
    pub(crate) line: usize,
    pub(crate) column: usize,
    pub(crate) target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceImageReferenceInspection {
    pub(crate) references: Vec<WorkspaceImageReference>,
    pub(crate) truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceDocumentLinkUpdate {
    pub(crate) document_relative_path: String,
    pub(crate) line: usize,
    pub(crate) column: usize,
    pub(crate) from_target: String,
    pub(crate) to_target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceDocumentMovePreview {
    pub(crate) updates: Vec<WorkspaceDocumentLinkUpdate>,
    pub(crate) truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MarkdownInlineTarget {
    start: usize,
    end: usize,
    target: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkspaceSearchCompletion {
    Complete { truncated: bool },
    Cancelled,
}

fn is_word_character(character: Option<char>) -> bool {
    character.is_some_and(|character| character.is_alphanumeric() || character == '_')
}

fn is_whole_word(line: &str, start: usize, end: usize) -> bool {
    !is_word_character(line[..start].chars().next_back())
        && !is_word_character(line[end..].chars().next())
}

fn search_preview(line: &str, match_start: usize) -> String {
    const CONTEXT_BEFORE: usize = 80;
    const MAX_PREVIEW_CHARS: usize = 240;
    let match_character = line[..match_start].chars().count();
    let start = match_character.saturating_sub(CONTEXT_BEFORE);
    let mut preview = line
        .chars()
        .skip(start)
        .take(MAX_PREVIEW_CHARS)
        .collect::<String>();
    if start > 0 {
        preview.insert(0, '…');
    }
    if line.chars().count() > start + MAX_PREVIEW_CHARS {
        preview.push('…');
    }
    preview
}

fn build_search_regex(query: &str, options: WorkspaceSearchOptions) -> Result<Regex, String> {
    if query.is_empty() {
        return Err("搜索内容不能为空".to_owned());
    }
    if query.chars().count() > 512 {
        return Err("搜索内容超过安全上限（512 个字符）".to_owned());
    }
    let pattern = if options.regular_expression {
        query.to_owned()
    } else {
        regex::escape(query)
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!options.case_sensitive)
        .unicode(true)
        .size_limit(2 * 1024 * 1024)
        .build()
        .map_err(|error| format!("正则表达式无效：{error}"))
}

struct WorkspaceSearcher<'a, F>
where
    F: FnMut(Vec<WorkspaceSearchMatch>) -> Result<(), String>,
{
    root: &'a Path,
    expression: Regex,
    options: WorkspaceSearchOptions,
    cancelled: &'a AtomicBool,
    emit_batch: F,
    batch: Vec<WorkspaceSearchMatch>,
    entry_count: usize,
    match_count: usize,
}

impl<F> WorkspaceSearcher<'_, F>
where
    F: FnMut(Vec<WorkspaceSearchMatch>) -> Result<(), String>,
{
    fn flush(&mut self) -> Result<(), String> {
        if !self.batch.is_empty() {
            (self.emit_batch)(std::mem::take(&mut self.batch))?;
        }
        Ok(())
    }

    fn search_file(
        &mut self,
        path: &Path,
        relative_path: &str,
    ) -> Result<Option<WorkspaceSearchCompletion>, String> {
        let Ok(file) = fs::File::open(path) else {
            return Ok(None);
        };
        let mut bytes = Vec::new();
        if file
            .take(MAX_WORKSPACE_SEARCH_BYTES + 1)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() as u64 > MAX_WORKSPACE_SEARCH_BYTES
            || bytes.contains(&0)
        {
            return Ok(None);
        }
        let Ok(text) = std::str::from_utf8(&bytes) else {
            return Ok(None);
        };
        let expression = self.expression.clone();
        for (line_index, raw_line) in text.split('\n').enumerate() {
            if self.cancelled.load(Ordering::Relaxed) {
                return Ok(Some(WorkspaceSearchCompletion::Cancelled));
            }
            let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
            for found in expression.find_iter(line) {
                if self.cancelled.load(Ordering::Relaxed) {
                    return Ok(Some(WorkspaceSearchCompletion::Cancelled));
                }
                if self.options.whole_word && !is_whole_word(line, found.start(), found.end()) {
                    continue;
                }
                self.batch.push(WorkspaceSearchMatch {
                    relative_path: relative_path.to_owned(),
                    line: line_index + 1,
                    column: line[..found.start()].encode_utf16().count() + 1,
                    preview: search_preview(line, found.start()),
                });
                self.match_count += 1;
                if self.batch.len() == WORKSPACE_SEARCH_BATCH_SIZE {
                    self.flush()?;
                }
                if self.match_count >= MAX_WORKSPACE_SEARCH_MATCHES {
                    self.flush()?;
                    return Ok(Some(WorkspaceSearchCompletion::Complete {
                        truncated: true,
                    }));
                }
            }
        }
        Ok(None)
    }

    fn search_directory(
        &mut self,
        directory: &Path,
        depth: usize,
    ) -> Result<Option<WorkspaceSearchCompletion>, String> {
        if depth > MAX_WORKSPACE_DEPTH {
            return Err(format!(
                "工作区目录深度超过安全上限（{MAX_WORKSPACE_DEPTH}）"
            ));
        }
        let mut children = fs::read_dir(directory)
            .map_err(|error| format!("读取工作区目录失败：{error}"))?
            .collect::<Result<Vec<_>, io::Error>>()
            .map_err(|error| format!("读取工作区条目失败：{error}"))?;
        children.sort_by(|left, right| {
            left.file_name()
                .to_string_lossy()
                .to_lowercase()
                .cmp(&right.file_name().to_string_lossy().to_lowercase())
                .then_with(|| left.file_name().cmp(&right.file_name()))
        });

        for child in children {
            if self.cancelled.load(Ordering::Relaxed) {
                return Ok(Some(WorkspaceSearchCompletion::Cancelled));
            }
            let path = child.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("读取工作区条目元数据失败：{error}"))?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if self.entry_count >= MAX_WORKSPACE_ENTRIES {
                return Err(format!("工作区条目超过安全上限（{MAX_WORKSPACE_ENTRIES}）"));
            }
            self.entry_count += 1;
            if metadata.is_dir() {
                if let Some(completion) = self.search_directory(&path, depth + 1)? {
                    return Ok(Some(completion));
                }
            } else if metadata.is_file()
                && metadata.len() <= MAX_WORKSPACE_SEARCH_BYTES
                && is_markdown_path(&path)
            {
                let relative_path = relative_display_path(self.root, &path)?;
                let Ok(resolved) = resolve_workspace_file(self.root, &relative_path) else {
                    continue;
                };
                if let Some(completion) = self.search_file(&resolved, &relative_path)? {
                    return Ok(Some(completion));
                }
            }
        }
        Ok(None)
    }
}

pub(crate) fn search_workspace<F>(
    root: &Path,
    query: &str,
    options: WorkspaceSearchOptions,
    cancelled: &AtomicBool,
    emit_batch: F,
) -> Result<WorkspaceSearchCompletion, String>
where
    F: FnMut(Vec<WorkspaceSearchMatch>) -> Result<(), String>,
{
    if cancelled.load(Ordering::Relaxed) {
        return Ok(WorkspaceSearchCompletion::Cancelled);
    }
    let mut searcher = WorkspaceSearcher {
        root,
        expression: build_search_regex(query, options)?,
        options,
        cancelled,
        emit_batch,
        batch: Vec::with_capacity(WORKSPACE_SEARCH_BATCH_SIZE),
        entry_count: 0,
        match_count: 0,
    };
    if let Some(completion) = searcher.search_directory(root, 0)? {
        return Ok(completion);
    }
    searcher.flush()?;
    Ok(WorkspaceSearchCompletion::Complete { truncated: false })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceEntry {
    pub(crate) relative_path: String,
    pub(crate) name: String,
    pub(crate) kind: WorkspaceEntryKind,
    pub(crate) bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WorkspaceEntryKind {
    Directory,
    File,
}

fn relative_display_path(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "工作区条目不在授权根目录内".to_owned())?;
    let parts = relative
        .components()
        .map(|component| match component {
            Component::Normal(part) => part
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| "工作区路径包含无效 Unicode".to_owned()),
            _ => Err("工作区条目包含无效路径组件".to_owned()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(parts.join("/"))
}

fn push_entry(
    entries: &mut Vec<WorkspaceEntry>,
    entry: WorkspaceEntry,
    limit: usize,
) -> Result<(), String> {
    if entries.len() >= limit {
        return Err(format!("工作区条目超过安全上限（{limit}）"));
    }
    entries.push(entry);
    Ok(())
}

fn enumerate_directory(
    root: &Path,
    directory: &Path,
    depth: usize,
    limit: usize,
    entries: &mut Vec<WorkspaceEntry>,
) -> Result<(), String> {
    if depth > MAX_WORKSPACE_DEPTH {
        return Err(format!(
            "工作区目录深度超过安全上限（{MAX_WORKSPACE_DEPTH}）"
        ));
    }

    let mut children = fs::read_dir(directory)
        .map_err(|error| format!("读取工作区目录失败：{error}"))?
        .collect::<Result<Vec<_>, io::Error>>()
        .map_err(|error| format!("读取工作区条目失败：{error}"))?;
    children.sort_by(|left, right| {
        left.file_name()
            .to_string_lossy()
            .to_lowercase()
            .cmp(&right.file_name().to_string_lossy().to_lowercase())
            .then_with(|| left.file_name().cmp(&right.file_name()))
    });

    for child in children {
        let path = child.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("读取工作区条目元数据失败：{error}"))?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        let name = child
            .file_name()
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| "工作区路径包含无效 Unicode".to_owned())?;
        let relative_path = relative_display_path(root, &path)?;
        if metadata.is_dir() {
            push_entry(
                entries,
                WorkspaceEntry {
                    relative_path,
                    name,
                    kind: WorkspaceEntryKind::Directory,
                    bytes: None,
                },
                limit,
            )?;
            enumerate_directory(root, &path, depth + 1, limit, entries)?;
        } else if metadata.is_file() {
            push_entry(
                entries,
                WorkspaceEntry {
                    relative_path,
                    name,
                    kind: WorkspaceEntryKind::File,
                    bytes: Some(metadata.len()),
                },
                limit,
            )?;
        }
    }
    Ok(())
}

pub(crate) fn enumerate_workspace(
    root: &Path,
    limit: usize,
) -> Result<Vec<WorkspaceEntry>, String> {
    if limit == 0 {
        return Err("工作区条目上限必须大于零".to_owned());
    }
    let mut entries = Vec::new();
    enumerate_directory(root, root, 0, limit, &mut entries)?;
    Ok(entries)
}

pub(crate) fn resolve_workspace_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let canonical = resolve_workspace_entry(root, relative)?;
    if !canonical.is_file() {
        return Err("工作区路径不是可打开的文件".to_owned());
    }
    Ok(canonical)
}

fn resolve_workspace_link_target(
    root: &Path,
    source_relative_path: &str,
    target: &str,
) -> Result<(PathBuf, String, Option<String>), String> {
    let _ = resolve_workspace_file(root, source_relative_path)?;
    if target.is_empty()
        || target.starts_with('/')
        || target.starts_with('\\')
        || target.contains('?')
    {
        return Err("本地 Markdown 链接目标无效".to_owned());
    }
    let (raw_path, fragment) = target
        .split_once('#')
        .map_or((target, None), |(path, fragment)| {
            (path, Some(fragment.to_owned()))
        });
    let mut parts = source_relative_path
        .split('/')
        .map(str::to_owned)
        .collect::<Vec<_>>();
    parts.pop();
    if raw_path.is_empty() {
        parts = source_relative_path.split('/').map(str::to_owned).collect();
    } else {
        for raw_part in raw_path.split('/') {
            let part = urlencoding::decode(raw_part)
                .map_err(|_| "本地 Markdown 链接包含无效百分号编码".to_owned())?;
            if part.is_empty() || part.contains('/') || part.contains('\\') {
                return Err("本地 Markdown 链接包含无效路径组件".to_owned());
            }
            match part.as_ref() {
                "." => {}
                ".." => {
                    if parts.pop().is_none() {
                        return Err("拒绝打开授权工作区外的链接".to_owned());
                    }
                }
                _ => parts.push(part.into_owned()),
            }
        }
    }
    let relative_path = parts.join("/");
    let path = resolve_workspace_file(root, &relative_path)?;
    Ok((path, relative_path, fragment))
}

pub(crate) fn resolve_workspace_document_link(
    root: &Path,
    source_relative_path: &str,
    target: &str,
) -> Result<(PathBuf, String, Option<String>), String> {
    let (path, relative_path, fragment) =
        resolve_workspace_link_target(root, source_relative_path, target)?;
    validate_workspace_document(&path)?;
    Ok((path, relative_path, fragment))
}

pub(crate) fn resolve_workspace_image_link(
    root: &Path,
    source_relative_path: &str,
    target: &str,
) -> Result<(PathBuf, &'static str), String> {
    let (path, _, fragment) = resolve_workspace_link_target(root, source_relative_path, target)?;
    if fragment.is_some() || !is_image_path(&path) {
        return Err("本地图片引用必须指向受支持的图片文件".to_owned());
    }
    let bytes = fs::metadata(&path)
        .map_err(|error| format!("读取本地图片元数据失败：{error}"))?
        .len();
    if bytes > MAX_WORKSPACE_IMAGE_PREVIEW_BYTES {
        return Err(format!(
            "本地图片超过预览大小上限（{} MiB）",
            MAX_WORKSPACE_IMAGE_PREVIEW_BYTES / 1024 / 1024
        ));
    }
    let mime = match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("avif") => "image/avif",
        Some("gif") => "image/gif",
        Some("jpeg" | "jpg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        _ => return Err("本地图片类型不受支持".to_owned()),
    };
    Ok((path, mime))
}

fn markdown_inline_targets(line: &str, images_only: bool) -> Vec<MarkdownInlineTarget> {
    let bytes = line.as_bytes();
    let mut code_spans = Vec::new();
    let mut code_cursor = 0;
    while code_cursor < bytes.len() {
        let Some(relative_open) = line[code_cursor..].find('`') else {
            break;
        };
        let open = code_cursor + relative_open;
        let delimiter_length = bytes[open..]
            .iter()
            .take_while(|byte| **byte == b'`')
            .count();
        let mut close = open + delimiter_length;
        let mut matched = None;
        while close < bytes.len() {
            let Some(relative_close) = line[close..].find('`') else {
                break;
            };
            close += relative_close;
            let close_length = bytes[close..]
                .iter()
                .take_while(|byte| **byte == b'`')
                .count();
            if close_length == delimiter_length {
                matched = Some(close + close_length);
                break;
            }
            close += close_length;
        }
        if let Some(end) = matched {
            code_spans.push((open, end));
            code_cursor = end;
        } else {
            code_cursor = open + delimiter_length;
        }
    }
    let mut targets = Vec::new();
    let mut cursor = 0;
    while cursor + 1 < bytes.len() {
        let pattern = if images_only { "![" } else { "[" };
        let Some(relative_start) = line[cursor..].find(pattern) else {
            break;
        };
        let syntax_start = cursor + relative_start;
        let bracket_start = syntax_start + usize::from(images_only);
        let escaped_syntax = line[..syntax_start]
            .bytes()
            .rev()
            .take_while(|byte| *byte == b'\\')
            .count()
            % 2
            == 1;
        if escaped_syntax
            || code_spans
                .iter()
                .any(|(start, end)| syntax_start >= *start && syntax_start < *end)
        {
            cursor = bracket_start + 1;
            continue;
        }
        let mut index = bracket_start + 1;
        let mut escaped = false;
        let mut bracket_depth = 0_usize;
        while index < bytes.len() {
            let byte = bytes[index];
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'[' {
                bracket_depth += 1;
            } else if byte == b']' {
                if bracket_depth > 0 {
                    bracket_depth -= 1;
                } else {
                    break;
                }
            }
            index += 1;
        }
        if index + 1 >= bytes.len() || bytes[index + 1] != b'(' {
            cursor = (bracket_start + 1).min(bytes.len());
            continue;
        }
        index += 2;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        let angle = index < bytes.len() && bytes[index] == b'<';
        if angle {
            index += 1;
        }
        let target_start = index;
        escaped = false;
        let mut target_end = index;
        while target_end < bytes.len() {
            let byte = bytes[target_end];
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if (angle && byte == b'>')
                || (!angle && (byte == b')' || byte.is_ascii_whitespace()))
            {
                break;
            }
            target_end += 1;
        }
        if target_end > target_start
            && ((!angle && target_end < bytes.len())
                || (angle && target_end < bytes.len() && bytes[target_end] == b'>'))
        {
            let target = line[target_start..target_end]
                .replace("\\(", "(")
                .replace("\\)", ")")
                .replace("\\ ", " ")
                .replace("\\\\", "\\");
            targets.push(MarkdownInlineTarget {
                start: target_start,
                end: target_end,
                target,
            });
        }
        cursor = target_end.saturating_add(1);
    }
    targets
}

fn markdown_image_targets(line: &str) -> Vec<MarkdownInlineTarget> {
    markdown_inline_targets(line, true)
}

fn markdown_link_targets(line: &str) -> Vec<MarkdownInlineTarget> {
    markdown_inline_targets(line, false)
}

fn fence_marker(line: &str) -> Option<(u8, usize)> {
    let trimmed = line.trim_start_matches(' ');
    if line.len().saturating_sub(trimmed.len()) > 3 {
        return None;
    }
    let marker = *trimmed.as_bytes().first()?;
    if marker != b'`' && marker != b'~' {
        return None;
    }
    let length = trimmed.bytes().take_while(|byte| *byte == marker).count();
    (length >= 3).then_some((marker, length))
}

pub(crate) fn inspect_workspace_images(root: &Path) -> Result<WorkspaceImageInspection, String> {
    let entries = enumerate_workspace(root, MAX_WORKSPACE_ENTRIES)?;
    let mut issues = Vec::new();
    for entry in entries {
        if entry.kind != WorkspaceEntryKind::File || !is_markdown_path(Path::new(&entry.name)) {
            continue;
        }
        let path = resolve_workspace_file(root, &entry.relative_path)?;
        let metadata =
            fs::metadata(&path).map_err(|error| format!("读取图片引用文档元数据失败：{error}"))?;
        if metadata.len() > MAX_WORKSPACE_SEARCH_BYTES {
            continue;
        }
        let file =
            fs::File::open(&path).map_err(|error| format!("打开图片引用文档失败：{error}"))?;
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take(MAX_WORKSPACE_SEARCH_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("读取图片引用文档失败：{error}"))?;
        if bytes.len() as u64 > MAX_WORKSPACE_SEARCH_BYTES || bytes.contains(&0) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&bytes) else {
            continue;
        };
        let mut fence: Option<(u8, usize)> = None;
        for (line_index, line) in text.lines().enumerate() {
            if let Some((marker, length)) = fence_marker(line) {
                if fence.is_some_and(|(open_marker, open_length)| {
                    marker == open_marker && length >= open_length
                }) {
                    fence = None;
                } else if fence.is_none() {
                    fence = Some((marker, length));
                }
                continue;
            }
            if fence.is_some() || line.starts_with("    ") || line.starts_with('\t') {
                continue;
            }
            for image_target in markdown_image_targets(line) {
                let MarkdownInlineTarget {
                    start: column_bytes,
                    target,
                    ..
                } = image_target;
                let protocol = target
                    .split_once(':')
                    .map(|(protocol, _)| protocol.to_ascii_lowercase());
                if matches!(protocol.as_deref(), Some("http" | "https" | "data")) {
                    continue;
                }
                if let Err(reason) =
                    resolve_workspace_image_link(root, &entry.relative_path, &target)
                {
                    issues.push(WorkspaceImageIssue {
                        document_relative_path: entry.relative_path.clone(),
                        line: line_index + 1,
                        column: line[..column_bytes].encode_utf16().count() + 1,
                        target,
                        reason,
                    });
                    if issues.len() >= MAX_WORKSPACE_IMAGE_ISSUES {
                        return Ok(WorkspaceImageInspection {
                            issues,
                            truncated: true,
                        });
                    }
                }
            }
        }
    }
    Ok(WorkspaceImageInspection {
        issues,
        truncated: false,
    })
}

#[derive(Debug)]
struct WorkspaceImageDocumentRewrite {
    path: PathBuf,
    relative_path: String,
    original: Vec<u8>,
    fingerprint: String,
    rewritten: Vec<u8>,
    updates: Vec<WorkspaceImageReferenceUpdate>,
}

fn workspace_image_relocation_paths(
    root: &Path,
    source_relative: &str,
    destination_relative: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let source = resolve_workspace_file(root, source_relative)?;
    if !is_image_path(&source) {
        return Err("只有受支持的图片文件可以执行引用感知操作".to_owned());
    }
    let destination = resolve_workspace_destination(root, destination_relative)?;
    if !is_image_path(&destination) {
        return Err("图片目标必须保留受支持的图片扩展名".to_owned());
    }
    if source
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        != destination
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
    {
        return Err("图片引用感知操作不能改变文件类型扩展名".to_owned());
    }
    Ok((source, destination))
}

fn collect_workspace_image_rewrites(
    root: &Path,
    source: &Path,
    destination: Option<&Path>,
) -> Result<(Vec<WorkspaceImageDocumentRewrite>, bool), String> {
    let entries = enumerate_workspace(root, MAX_WORKSPACE_ENTRIES)?;
    let mut documents = Vec::new();
    let mut update_count = 0_usize;
    for entry in entries {
        if entry.kind != WorkspaceEntryKind::File || !is_markdown_path(Path::new(&entry.name)) {
            continue;
        }
        let path = resolve_workspace_file(root, &entry.relative_path)?;
        let metadata =
            fs::metadata(&path).map_err(|error| format!("读取图片引用文档元数据失败：{error}"))?;
        if metadata.len() > MAX_WORKSPACE_SEARCH_BYTES {
            continue;
        }
        let (original, fingerprint) =
            read_document(&path).map_err(|error| format!("读取图片引用文档失败：{error}"))?;
        if original.contains(&0) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&original) else {
            continue;
        };
        let to_target = destination
            .map(|destination| markdown_relative_path(path.parent().unwrap_or(root), destination))
            .transpose()?
            .unwrap_or_default();
        let mut fence: Option<(u8, usize)> = None;
        let mut byte_offset = 0_usize;
        let mut edits = Vec::new();
        let mut updates = Vec::new();
        for (line_index, raw_line) in text.split_inclusive('\n').enumerate() {
            let line = raw_line
                .strip_suffix('\n')
                .unwrap_or(raw_line)
                .strip_suffix('\r')
                .unwrap_or_else(|| raw_line.strip_suffix('\n').unwrap_or(raw_line));
            if let Some((marker, length)) = fence_marker(line) {
                if fence.is_some_and(|(open_marker, open_length)| {
                    marker == open_marker && length >= open_length
                }) {
                    fence = None;
                } else if fence.is_none() {
                    fence = Some((marker, length));
                }
                byte_offset += raw_line.len();
                continue;
            }
            if fence.is_none() && !line.starts_with("    ") && !line.starts_with('\t') {
                for image_target in markdown_image_targets(line) {
                    let Ok((resolved, _, fragment)) = resolve_workspace_link_target(
                        root,
                        &entry.relative_path,
                        &image_target.target,
                    ) else {
                        continue;
                    };
                    if fragment.is_some() || !is_image_path(&resolved) || resolved != source {
                        continue;
                    }
                    update_count += 1;
                    if update_count > MAX_WORKSPACE_IMAGE_ISSUES {
                        return Ok((documents, true));
                    }
                    edits.push((
                        byte_offset + image_target.start,
                        byte_offset + image_target.end,
                    ));
                    updates.push(WorkspaceImageReferenceUpdate {
                        document_relative_path: entry.relative_path.clone(),
                        line: line_index + 1,
                        column: line[..image_target.start].encode_utf16().count() + 1,
                        from_target: image_target.target,
                        to_target: to_target.clone(),
                    });
                }
            }
            byte_offset += raw_line.len();
        }
        if edits.is_empty() {
            continue;
        }
        let mut rewritten = original.clone();
        if destination.is_some() {
            for (start, end) in edits.into_iter().rev() {
                rewritten.splice(start..end, to_target.bytes());
            }
        }
        documents.push(WorkspaceImageDocumentRewrite {
            path,
            relative_path: entry.relative_path,
            original,
            fingerprint,
            rewritten,
            updates,
        });
    }
    Ok((documents, false))
}

pub(crate) fn preview_workspace_image_move(
    root: &Path,
    source_relative: &str,
    destination_relative: &str,
) -> Result<WorkspaceImageMovePreview, String> {
    let (source, destination) =
        workspace_image_relocation_paths(root, source_relative, destination_relative)?;
    let (documents, truncated) =
        collect_workspace_image_rewrites(root, &source, Some(&destination))?;
    Ok(WorkspaceImageMovePreview {
        updates: documents
            .into_iter()
            .flat_map(|document| document.updates)
            .collect(),
        truncated,
    })
}

pub(crate) fn inspect_workspace_image_references(
    root: &Path,
    source_relative: &str,
) -> Result<WorkspaceImageReferenceInspection, String> {
    let source = resolve_workspace_file(root, source_relative)?;
    if !is_image_path(&source) {
        return Err("只有受支持的图片文件可以扫描引用".to_owned());
    }
    let (documents, truncated) = collect_workspace_image_rewrites(root, &source, None)?;
    Ok(WorkspaceImageReferenceInspection {
        references: documents
            .into_iter()
            .flat_map(|document| document.updates)
            .map(|update| WorkspaceImageReference {
                document_relative_path: update.document_relative_path,
                line: update.line,
                column: update.column,
                target: update.from_target,
            })
            .collect(),
        truncated,
    })
}

pub(crate) fn move_workspace_image_and_rewrite<F>(
    root: &Path,
    source_relative: &str,
    destination_relative: &str,
    mut is_document_open: F,
) -> Result<Vec<String>, String>
where
    F: FnMut(&Path) -> bool,
{
    let (source, destination) =
        workspace_image_relocation_paths(root, source_relative, destination_relative)?;
    let (documents, truncated) =
        collect_workspace_image_rewrites(root, &source, Some(&destination))?;
    if truncated {
        return Err(format!(
            "图片引用超过安全上限（{MAX_WORKSPACE_IMAGE_ISSUES}），不会移动或部分改写"
        ));
    }
    if let Some(document) = documents
        .iter()
        .find(|document| is_document_open(&document.path))
    {
        return Err(format!(
            "引用文档“{}”仍在标签页中打开；请先关闭后再移动图片",
            document.relative_path
        ));
    }
    fs::rename(&source, &destination).map_err(|error| format!("移动图片失败：{error}"))?;
    let mut saved = Vec::new();
    for (index, document) in documents.iter().enumerate() {
        match atomic_save(
            &document.path,
            &document.rewritten,
            Some(&document.fingerprint),
        ) {
            Ok(fingerprint) => saved.push((index, fingerprint)),
            Err(error) => {
                let mut rollback_errors = Vec::new();
                for (saved_index, saved_fingerprint) in saved.into_iter().rev() {
                    let saved_document = &documents[saved_index];
                    if let Err(rollback_error) = atomic_save(
                        &saved_document.path,
                        &saved_document.original,
                        Some(&saved_fingerprint),
                    ) {
                        rollback_errors.push(format!(
                            "{}：{}",
                            saved_document.relative_path, rollback_error
                        ));
                    }
                }
                if let Err(rollback_error) = fs::rename(&destination, &source) {
                    rollback_errors.push(format!("恢复原图片路径失败：{rollback_error}"));
                }
                if rollback_errors.is_empty() {
                    return Err(format!("更新图片引用失败，移动已回滚：{error}"));
                }
                return Err(format!(
                    "更新图片引用失败且回滚不完整：{error}；{}",
                    rollback_errors.join("；")
                ));
            }
        }
    }
    Ok(documents
        .into_iter()
        .map(|document| document.relative_path)
        .collect())
}

pub(crate) fn copy_workspace_image_and_rewrite<F>(
    root: &Path,
    source_relative: &str,
    destination_relative: &str,
    mut is_document_open: F,
) -> Result<Vec<String>, String>
where
    F: FnMut(&Path) -> bool,
{
    let (source, destination) =
        workspace_image_relocation_paths(root, source_relative, destination_relative)?;
    let (documents, truncated) =
        collect_workspace_image_rewrites(root, &source, Some(&destination))?;
    if truncated {
        return Err(format!(
            "图片引用超过安全上限（{MAX_WORKSPACE_IMAGE_ISSUES}），不会复制或部分改写"
        ));
    }
    if let Some(document) = documents
        .iter()
        .find(|document| is_document_open(&document.path))
    {
        return Err(format!(
            "引用文档“{}”仍在标签页中打开；请先关闭后再复制图片并切换引用",
            document.relative_path
        ));
    }
    copy_file_exclusive(&source, &destination)?;
    let mut saved = Vec::new();
    for (index, document) in documents.iter().enumerate() {
        match atomic_save(
            &document.path,
            &document.rewritten,
            Some(&document.fingerprint),
        ) {
            Ok(fingerprint) => saved.push((index, fingerprint)),
            Err(error) => {
                let mut rollback_errors = Vec::new();
                for (saved_index, saved_fingerprint) in saved.into_iter().rev() {
                    let saved_document = &documents[saved_index];
                    if let Err(rollback_error) = atomic_save(
                        &saved_document.path,
                        &saved_document.original,
                        Some(&saved_fingerprint),
                    ) {
                        rollback_errors.push(format!(
                            "{}：{}",
                            saved_document.relative_path, rollback_error
                        ));
                    }
                }
                if let Err(rollback_error) = fs::remove_file(&destination) {
                    rollback_errors.push(format!("删除新图片副本失败：{rollback_error}"));
                }
                if rollback_errors.is_empty() {
                    return Err(format!("更新图片引用失败，复制已回滚：{error}"));
                }
                return Err(format!(
                    "更新图片引用失败且回滚不完整：{error}；{}",
                    rollback_errors.join("；")
                ));
            }
        }
    }
    Ok(documents
        .into_iter()
        .map(|document| document.relative_path)
        .collect())
}

#[derive(Debug)]
struct WorkspaceImageConsolidationFile {
    source: PathBuf,
    destination: PathBuf,
    reference_count: usize,
}

#[derive(Debug)]
struct WorkspaceImageConsolidationPlan {
    destination_directory: PathBuf,
    create_destination_directory: bool,
    copies: Vec<WorkspaceImageConsolidationFile>,
    documents: Vec<WorkspaceImageDocumentRewrite>,
    preview: WorkspaceImageConsolidationPreview,
}

#[derive(Debug)]
struct WorkspaceImageOccurrence {
    source: PathBuf,
    start: usize,
    end: usize,
    line: usize,
    column: usize,
    target: String,
}

fn workspace_image_consolidation_directory(
    root: &Path,
    destination_relative: &str,
) -> Result<(PathBuf, bool), String> {
    let candidate = root.join(destination_relative);
    match fs::symlink_metadata(&candidate) {
        Ok(metadata) => {
            let destination = resolve_workspace_entry(root, destination_relative)?;
            if !metadata.is_dir() {
                return Err("图片归拢目标必须是文件夹".to_owned());
            }
            Ok((destination, false))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok((
            resolve_workspace_destination(root, destination_relative)?,
            true,
        )),
        Err(error) => Err(format!("读取图片归拢目标失败：{error}")),
    }
}

fn allocate_consolidation_destination(
    directory: &Path,
    source: &Path,
    planned: &[WorkspaceImageConsolidationFile],
) -> Result<PathBuf, String> {
    let (stem, extension) = image_name_parts(source)?;
    for suffix in 1..=10_000_u32 {
        let file_name = if suffix == 1 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem}-{suffix}.{extension}")
        };
        let candidate = directory.join(file_name);
        if !candidate.exists()
            && !planned.iter().any(|copy| {
                copy.destination.to_string_lossy().to_lowercase()
                    == candidate.to_string_lossy().to_lowercase()
            })
        {
            return Ok(candidate);
        }
    }
    Err("无法为归拢图片分配不冲突的文件名".to_owned())
}

fn collect_workspace_image_consolidation_plan(
    root: &Path,
    destination_relative: &str,
) -> Result<WorkspaceImageConsolidationPlan, String> {
    let (destination_directory, create_destination_directory) =
        workspace_image_consolidation_directory(root, destination_relative)?;
    let entries = enumerate_workspace(root, MAX_WORKSPACE_ENTRIES)?;
    let mut scanned_documents = Vec::new();
    let mut source_reference_counts: Vec<(PathBuf, usize)> = Vec::new();
    let mut update_count = 0_usize;
    let mut truncated = false;

    'documents: for entry in entries {
        if entry.kind != WorkspaceEntryKind::File || !is_markdown_path(Path::new(&entry.name)) {
            continue;
        }
        let path = resolve_workspace_file(root, &entry.relative_path)?;
        let metadata =
            fs::metadata(&path).map_err(|error| format!("读取图片归拢文档元数据失败：{error}"))?;
        if metadata.len() > MAX_WORKSPACE_SEARCH_BYTES {
            return Err(format!(
                "图片归拢文档“{}”超过扫描上限（{} 字节）",
                entry.relative_path, MAX_WORKSPACE_SEARCH_BYTES
            ));
        }
        let (original, fingerprint) =
            read_document(&path).map_err(|error| format!("读取图片归拢文档失败：{error}"))?;
        if original.contains(&0) {
            return Err(format!(
                "图片归拢文档“{}”包含二进制内容",
                entry.relative_path
            ));
        }
        let text = std::str::from_utf8(&original)
            .map_err(|_| format!("图片归拢文档“{}”不是有效的 UTF-8", entry.relative_path))?;
        let mut fence: Option<(u8, usize)> = None;
        let mut byte_offset = 0_usize;
        let mut occurrences = Vec::new();
        for (line_index, raw_line) in text.split_inclusive('\n').enumerate() {
            let without_newline = raw_line.strip_suffix('\n').unwrap_or(raw_line);
            let line = without_newline
                .strip_suffix('\r')
                .unwrap_or(without_newline);
            if let Some((marker, length)) = fence_marker(line) {
                if fence.is_some_and(|(open_marker, open_length)| {
                    marker == open_marker && length >= open_length
                }) {
                    fence = None;
                } else if fence.is_none() {
                    fence = Some((marker, length));
                }
                byte_offset += raw_line.len();
                continue;
            }
            if fence.is_none() && !line.starts_with("    ") && !line.starts_with('\t') {
                for target in markdown_image_targets(line) {
                    let Ok((resolved, _, fragment)) =
                        resolve_workspace_link_target(root, &entry.relative_path, &target.target)
                    else {
                        continue;
                    };
                    if fragment.is_some()
                        || !is_image_path(&resolved)
                        || resolved.starts_with(&destination_directory)
                    {
                        continue;
                    }
                    let source_metadata = fs::metadata(&resolved)
                        .map_err(|error| format!("读取归拢图片元数据失败：{error}"))?;
                    if source_metadata.len() > MAX_WORKSPACE_IMAGE_BYTES {
                        return Err(format!(
                            "归拢图片“{}”超过安全大小上限（{} MiB）",
                            relative_display_path(root, &resolved)?,
                            MAX_WORKSPACE_IMAGE_BYTES / 1024 / 1024
                        ));
                    }
                    update_count += 1;
                    if update_count > MAX_WORKSPACE_IMAGE_ISSUES {
                        truncated = true;
                        break 'documents;
                    }
                    if let Some((_, count)) = source_reference_counts
                        .iter_mut()
                        .find(|(source, _)| *source == resolved)
                    {
                        *count += 1;
                    } else {
                        source_reference_counts.push((resolved.clone(), 1));
                    }
                    occurrences.push(WorkspaceImageOccurrence {
                        source: resolved,
                        start: byte_offset + target.start,
                        end: byte_offset + target.end,
                        line: line_index + 1,
                        column: line[..target.start].encode_utf16().count() + 1,
                        target: target.target,
                    });
                }
            }
            byte_offset += raw_line.len();
        }
        scanned_documents.push((
            path,
            entry.relative_path,
            original,
            fingerprint,
            occurrences,
        ));
    }

    let mut copies = Vec::new();
    for (source, reference_count) in source_reference_counts {
        let destination =
            allocate_consolidation_destination(&destination_directory, &source, &copies)?;
        copies.push(WorkspaceImageConsolidationFile {
            source,
            destination,
            reference_count,
        });
    }
    let mut documents = Vec::new();
    let mut updates = Vec::new();
    for (path, relative_path, original, fingerprint, occurrences) in scanned_documents {
        let mut edits = Vec::new();
        let mut document_updates = Vec::new();
        for occurrence in occurrences {
            let copy = copies
                .iter()
                .find(|copy| copy.source == occurrence.source)
                .ok_or_else(|| "图片归拢计划缺少目标".to_owned())?;
            let to_target =
                markdown_relative_path(path.parent().unwrap_or(root), &copy.destination)?;
            edits.push((occurrence.start, occurrence.end, to_target.clone()));
            let update = WorkspaceImageReferenceUpdate {
                document_relative_path: relative_path.clone(),
                line: occurrence.line,
                column: occurrence.column,
                from_target: occurrence.target,
                to_target,
            };
            updates.push(update.clone());
            document_updates.push(update);
        }
        if edits.is_empty() {
            continue;
        }
        let mut rewritten = original.clone();
        for (start, end, replacement) in edits.into_iter().rev() {
            rewritten.splice(start..end, replacement.bytes());
        }
        documents.push(WorkspaceImageDocumentRewrite {
            path,
            relative_path,
            original,
            fingerprint,
            rewritten,
            updates: document_updates,
        });
    }
    let preview_copies = copies
        .iter()
        .map(|copy| {
            Ok(WorkspaceImageConsolidationCopy {
                source_relative_path: relative_display_path(root, &copy.source)?,
                destination_relative_path: relative_display_path(root, &copy.destination)?,
                reference_count: copy.reference_count,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(WorkspaceImageConsolidationPlan {
        destination_directory,
        create_destination_directory,
        copies,
        documents,
        preview: WorkspaceImageConsolidationPreview {
            copies: preview_copies,
            updates,
            truncated,
        },
    })
}

pub(crate) fn preview_workspace_image_consolidation(
    root: &Path,
    destination_relative: &str,
) -> Result<WorkspaceImageConsolidationPreview, String> {
    Ok(collect_workspace_image_consolidation_plan(root, destination_relative)?.preview)
}

pub(crate) fn consolidate_workspace_images<F>(
    root: &Path,
    destination_relative: &str,
    expected: &WorkspaceImageConsolidationPreview,
    mut is_document_open: F,
) -> Result<Vec<String>, String>
where
    F: FnMut(&Path) -> bool,
{
    let plan = collect_workspace_image_consolidation_plan(root, destination_relative)?;
    if plan.preview.truncated || &plan.preview != expected {
        return Err("图片归拢计划已经变化；请重新预览并确认".to_owned());
    }
    if let Some(document) = plan
        .documents
        .iter()
        .find(|document| is_document_open(&document.path))
    {
        return Err(format!(
            "引用文档“{}”仍在标签页中打开；请先关闭后再归拢图片",
            document.relative_path
        ));
    }
    if plan.create_destination_directory {
        fs::create_dir(&plan.destination_directory)
            .map_err(|error| format!("创建图片归拢目标目录失败：{error}"))?;
    }
    let mut copied: Vec<usize> = Vec::new();
    for (index, copy) in plan.copies.iter().enumerate() {
        if let Err(error) = copy_file_exclusive(&copy.source, &copy.destination) {
            for copied_index in copied.into_iter().rev() {
                let _ = fs::remove_file(&plan.copies[copied_index].destination);
            }
            if plan.create_destination_directory {
                let _ = fs::remove_dir(&plan.destination_directory);
            }
            return Err(format!("复制归拢图片失败：{error}"));
        }
        copied.push(index);
    }
    let mut saved = Vec::new();
    for (index, document) in plan.documents.iter().enumerate() {
        match atomic_save(
            &document.path,
            &document.rewritten,
            Some(&document.fingerprint),
        ) {
            Ok(fingerprint) => saved.push((index, fingerprint)),
            Err(error) => {
                let mut rollback_errors = Vec::new();
                for (saved_index, saved_fingerprint) in saved.into_iter().rev() {
                    let saved_document = &plan.documents[saved_index];
                    if let Err(rollback_error) = atomic_save(
                        &saved_document.path,
                        &saved_document.original,
                        Some(&saved_fingerprint),
                    ) {
                        rollback_errors.push(format!(
                            "{}：{}",
                            saved_document.relative_path, rollback_error
                        ));
                    }
                }
                for copied_index in copied.into_iter().rev() {
                    if let Err(rollback_error) =
                        fs::remove_file(&plan.copies[copied_index].destination)
                    {
                        rollback_errors.push(format!("删除归拢副本失败：{rollback_error}"));
                    }
                }
                if plan.create_destination_directory {
                    if let Err(rollback_error) = fs::remove_dir(&plan.destination_directory) {
                        rollback_errors.push(format!("删除归拢目标目录失败：{rollback_error}"));
                    }
                }
                if rollback_errors.is_empty() {
                    return Err(format!("更新归拢图片引用失败，操作已回滚：{error}"));
                }
                return Err(format!(
                    "更新归拢图片引用失败且回滚不完整：{error}；{}",
                    rollback_errors.join("；")
                ));
            }
        }
    }
    Ok(plan
        .documents
        .into_iter()
        .map(|document| document.relative_path)
        .collect())
}

#[derive(Debug)]
struct WorkspaceDocumentLinkRewrite {
    path: PathBuf,
    relative_path: String,
    original: Vec<u8>,
    fingerprint: String,
    rewritten: Vec<u8>,
    updates: Vec<WorkspaceDocumentLinkUpdate>,
}

fn link_target_with_fragment(path: String, fragment: Option<String>) -> String {
    fragment.map_or(path.clone(), |fragment| format!("{path}#{fragment}"))
}

fn has_uri_scheme(target: &str) -> bool {
    let Some((scheme, _)) = target.split_once(':') else {
        return false;
    };
    let mut characters = scheme.chars();
    characters
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic())
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')
        })
}

fn relocated_workspace_path(path: &Path, source: &Path, destination: &Path) -> Option<PathBuf> {
    path.strip_prefix(source).ok().map(|suffix| {
        if suffix.as_os_str().is_empty() {
            destination.to_path_buf()
        } else {
            destination.join(suffix)
        }
    })
}

fn collect_workspace_document_move_rewrites(
    root: &Path,
    source: &Path,
    destination: &Path,
) -> Result<(Vec<WorkspaceDocumentLinkRewrite>, bool), String> {
    let entries = enumerate_workspace(root, MAX_WORKSPACE_ENTRIES)?;
    let mut documents = Vec::new();
    let mut update_count = 0_usize;
    for entry in entries {
        if entry.kind != WorkspaceEntryKind::File || !is_markdown_path(Path::new(&entry.name)) {
            continue;
        }
        let path = resolve_workspace_file(root, &entry.relative_path)?;
        let metadata =
            fs::metadata(&path).map_err(|error| format!("读取链接文档元数据失败：{error}"))?;
        if metadata.len() > MAX_WORKSPACE_SEARCH_BYTES {
            return Err(format!(
                "链接文档“{}”超过扫描上限（{} 字节）；为避免断链，本次移动已取消",
                entry.relative_path, MAX_WORKSPACE_SEARCH_BYTES
            ));
        }
        let (original, fingerprint) =
            read_document(&path).map_err(|error| format!("读取链接文档失败：{error}"))?;
        if original.contains(&0) {
            return Err(format!(
                "链接文档“{}”包含二进制内容；为避免断链，本次移动已取消",
                entry.relative_path
            ));
        }
        let text = std::str::from_utf8(&original).map_err(|_| {
            format!(
                "链接文档“{}”不是有效的 UTF-8；为避免断链，本次移动已取消",
                entry.relative_path
            )
        })?;
        let mut fence: Option<(u8, usize)> = None;
        let mut byte_offset = 0_usize;
        let mut edits = Vec::new();
        let mut updates = Vec::new();
        for (line_index, raw_line) in text.split_inclusive('\n').enumerate() {
            let without_newline = raw_line.strip_suffix('\n').unwrap_or(raw_line);
            let line = without_newline
                .strip_suffix('\r')
                .unwrap_or(without_newline);
            if let Some((marker, length)) = fence_marker(line) {
                if fence.is_some_and(|(open_marker, open_length)| {
                    marker == open_marker && length >= open_length
                }) {
                    fence = None;
                } else if fence.is_none() {
                    fence = Some((marker, length));
                }
                byte_offset += raw_line.len();
                continue;
            }
            if fence.is_none() && !line.starts_with("    ") && !line.starts_with('\t') {
                for target in markdown_link_targets(line) {
                    if has_uri_scheme(&target.target) {
                        continue;
                    }
                    let Ok((resolved, _, fragment)) =
                        resolve_workspace_link_target(root, &entry.relative_path, &target.target)
                    else {
                        continue;
                    };
                    let raw_path = target
                        .target
                        .split_once('#')
                        .map_or(target.target.as_str(), |(path, _)| path);
                    if raw_path.is_empty()
                        || (!is_markdown_path(&resolved) && !is_image_path(&resolved))
                    {
                        continue;
                    }
                    let relocated_document = relocated_workspace_path(&path, source, destination);
                    let relocated_target = relocated_workspace_path(&resolved, source, destination);
                    if relocated_document.is_none() && relocated_target.is_none() {
                        continue;
                    }
                    let effective_document = relocated_document.as_deref().unwrap_or(&path);
                    let effective_target = relocated_target.as_deref().unwrap_or(&resolved);
                    let new_target = link_target_with_fragment(
                        markdown_relative_path(
                            effective_document.parent().unwrap_or(root),
                            effective_target,
                        )?,
                        fragment,
                    );
                    if new_target == target.target {
                        continue;
                    }
                    update_count += 1;
                    if update_count > MAX_WORKSPACE_IMAGE_ISSUES {
                        return Ok((documents, true));
                    }
                    edits.push((
                        byte_offset + target.start,
                        byte_offset + target.end,
                        new_target.clone(),
                    ));
                    updates.push(WorkspaceDocumentLinkUpdate {
                        document_relative_path: entry.relative_path.clone(),
                        line: line_index + 1,
                        column: line[..target.start].encode_utf16().count() + 1,
                        from_target: target.target,
                        to_target: new_target,
                    });
                }
            }
            byte_offset += raw_line.len();
        }
        if edits.is_empty() {
            continue;
        }
        let mut rewritten = original.clone();
        for (start, end, replacement) in edits.into_iter().rev() {
            rewritten.splice(start..end, replacement.bytes());
        }
        documents.push(WorkspaceDocumentLinkRewrite {
            path,
            relative_path: entry.relative_path,
            original,
            fingerprint,
            rewritten,
            updates,
        });
    }
    Ok((documents, false))
}

fn workspace_document_move_paths(
    root: &Path,
    source_relative: &str,
    destination_relative: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let source = resolve_workspace_entry(root, source_relative)?;
    if !source.is_dir() && (!source.is_file() || !is_markdown_path(&source)) {
        return Err("只有 Markdown 文档或文件夹可以执行引用感知移动".to_owned());
    }
    let destination = resolve_workspace_destination(root, destination_relative)?;
    if source.is_file() && !is_markdown_path(&destination) {
        return Err("Markdown 文档移动目标必须使用受支持的扩展名".to_owned());
    }
    if source.is_dir() && destination.starts_with(&source) {
        return Err("不能把文件夹移动到自身内部".to_owned());
    }
    Ok((source, destination))
}

pub(crate) fn preview_workspace_document_move(
    root: &Path,
    source_relative: &str,
    destination_relative: &str,
) -> Result<WorkspaceDocumentMovePreview, String> {
    let (source, destination) =
        workspace_document_move_paths(root, source_relative, destination_relative)?;
    let (documents, truncated) =
        collect_workspace_document_move_rewrites(root, &source, &destination)?;
    Ok(WorkspaceDocumentMovePreview {
        updates: documents
            .into_iter()
            .flat_map(|document| document.updates)
            .collect(),
        truncated,
    })
}

pub(crate) fn move_workspace_document_and_rewrite<F>(
    root: &Path,
    source_relative: &str,
    destination_relative: &str,
    mut is_document_open: F,
) -> Result<(PathBuf, PathBuf, Vec<String>), String>
where
    F: FnMut(&Path) -> bool,
{
    let (source, destination) =
        workspace_document_move_paths(root, source_relative, destination_relative)?;
    let (documents, truncated) =
        collect_workspace_document_move_rewrites(root, &source, &destination)?;
    if truncated {
        return Err(format!(
            "文档链接更新超过安全上限（{MAX_WORKSPACE_IMAGE_ISSUES}），不会移动或部分改写"
        ));
    }
    if let Some(document) = documents
        .iter()
        .find(|document| is_document_open(&document.path))
    {
        return Err(format!(
            "受影响文档“{}”仍在标签页中打开；请先关闭后再移动文档",
            document.relative_path
        ));
    }
    for entry in enumerate_workspace(root, MAX_WORKSPACE_ENTRIES)? {
        if entry.kind != WorkspaceEntryKind::File || !is_markdown_path(Path::new(&entry.name)) {
            continue;
        }
        let path = resolve_workspace_file(root, &entry.relative_path)?;
        if path.starts_with(&source) && is_document_open(&path) {
            return Err(format!(
                "待移动范围内的文档“{}”仍在标签页中打开；请先关闭后再移动",
                entry.relative_path
            ));
        }
    }
    fs::rename(&source, &destination).map_err(|error| format!("移动文档失败：{error}"))?;
    let mut saved = Vec::new();
    for (index, document) in documents.iter().enumerate() {
        let relocated_path = relocated_workspace_path(&document.path, &source, &destination);
        let target_path = relocated_path.as_deref().unwrap_or(&document.path);
        match atomic_save(
            target_path,
            &document.rewritten,
            Some(&document.fingerprint),
        ) {
            Ok(fingerprint) => saved.push((index, fingerprint)),
            Err(error) => {
                let mut rollback_errors = Vec::new();
                for (saved_index, saved_fingerprint) in saved.into_iter().rev() {
                    let saved_document = &documents[saved_index];
                    let relocated_path =
                        relocated_workspace_path(&saved_document.path, &source, &destination);
                    let saved_path = relocated_path.as_deref().unwrap_or(&saved_document.path);
                    if let Err(rollback_error) = atomic_save(
                        saved_path,
                        &saved_document.original,
                        Some(&saved_fingerprint),
                    ) {
                        rollback_errors.push(format!(
                            "{}：{}",
                            saved_document.relative_path, rollback_error
                        ));
                    }
                }
                if let Err(rollback_error) = fs::rename(&destination, &source) {
                    rollback_errors.push(format!("恢复原文档路径失败：{rollback_error}"));
                }
                if rollback_errors.is_empty() {
                    return Err(format!("更新文档链接失败，移动已回滚：{error}"));
                }
                return Err(format!(
                    "更新文档链接失败且回滚不完整：{error}；{}",
                    rollback_errors.join("；")
                ));
            }
        }
    }
    let changed_documents = documents
        .into_iter()
        .map(|document| {
            relocated_workspace_path(&document.path, &source, &destination)
                .map_or(Ok(document.relative_path), |path| {
                    relative_display_path(root, &path)
                })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok((source, destination, changed_documents))
}

pub(crate) fn resolve_workspace_entry(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let requested = Path::new(relative);
    if relative.is_empty() || requested.is_absolute() {
        return Err("工作区文件必须使用非空相对路径".to_owned());
    }

    let mut candidate = root.to_path_buf();
    for component in requested.components() {
        let Component::Normal(part) = component else {
            return Err("拒绝访问包含父级或特殊组件的工作区路径".to_owned());
        };
        candidate.push(part);
        let metadata = fs::symlink_metadata(&candidate)
            .map_err(|error| format!("无法读取工作区文件：{error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("拒绝通过符号链接访问工作区文件".to_owned());
        }
    }

    let canonical =
        fs::canonicalize(&candidate).map_err(|error| format!("无法解析工作区文件路径：{error}"))?;
    if !canonical.starts_with(root) {
        return Err("拒绝访问授权工作区外的文件".to_owned());
    }
    Ok(canonical)
}

pub(crate) fn resolve_workspace_destination(
    root: &Path,
    relative: &str,
) -> Result<PathBuf, String> {
    let requested = Path::new(relative);
    if relative.is_empty() || requested.is_absolute() {
        return Err("工作区目标必须使用非空相对路径".to_owned());
    }
    let components = requested
        .components()
        .map(|component| match component {
            Component::Normal(part) => Ok(part.to_owned()),
            _ => Err("拒绝使用包含父级或特殊组件的工作区目标路径".to_owned()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if components.is_empty() || components.len() > MAX_WORKSPACE_DEPTH {
        return Err(format!(
            "工作区目标目录深度必须在 1 到 {MAX_WORKSPACE_DEPTH} 之间"
        ));
    }

    let mut parent = root.to_path_buf();
    for component in &components[..components.len() - 1] {
        parent.push(component);
        let metadata = fs::symlink_metadata(&parent)
            .map_err(|error| format!("无法读取工作区目标父目录：{error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("拒绝通过符号链接创建工作区条目".to_owned());
        }
        if !metadata.is_dir() {
            return Err("工作区目标父路径不是文件夹".to_owned());
        }
    }
    let parent =
        fs::canonicalize(&parent).map_err(|error| format!("无法解析工作区目标父目录：{error}"))?;
    if !parent.starts_with(root) {
        return Err("拒绝在授权工作区外创建条目".to_owned());
    }
    let destination = parent.join(&components[components.len() - 1]);
    if destination
        .try_exists()
        .map_err(|error| format!("检查工作区目标失败：{error}"))?
    {
        return Err("工作区目标已存在，不会覆盖".to_owned());
    }
    Ok(destination)
}

pub(crate) fn create_workspace_document(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let destination = resolve_workspace_destination(root, relative)?;
    if !is_markdown_path(&destination) {
        return Err("新建文档必须使用 Markdown 扩展名".to_owned());
    }
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .map_err(|error| format!("新建 Markdown 文档失败：{error}"))?;
        file.write_all(&[])
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("持久化新建 Markdown 文档失败：{error}"))?;
        fs::canonicalize(&destination)
            .map_err(|error| format!("解析新建 Markdown 文档失败：{error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&destination);
    }
    result
}

pub(crate) fn create_workspace_directory(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let destination = resolve_workspace_destination(root, relative)?;
    let result = fs::create_dir(&destination)
        .map_err(|error| format!("新建工作区文件夹失败：{error}"))
        .and_then(|()| {
            fs::canonicalize(&destination)
                .map_err(|error| format!("解析新建工作区文件夹失败：{error}"))
        });
    if result.is_err() {
        let _ = fs::remove_dir(&destination);
    }
    result
}

pub(crate) fn move_workspace_entry(
    root: &Path,
    source_relative: &str,
    destination_relative: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let source = resolve_workspace_entry(root, source_relative)?;
    let destination = resolve_workspace_destination(root, destination_relative)?;
    if source.is_dir() && destination.starts_with(&source) {
        return Err("不能把文件夹移动到自身内部".to_owned());
    }
    fs::rename(&source, &destination).map_err(|error| format!("移动工作区条目失败：{error}"))?;
    let destination = fs::canonicalize(&destination)
        .map_err(|error| format!("解析移动后的工作区条目失败：{error}"))?;
    Ok((source, destination))
}

fn copy_file_exclusive(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata_before =
        fs::metadata(source).map_err(|error| format!("读取复制源文件元数据失败：{error}"))?;
    let modified_before = metadata_before.modified().ok();
    let mut source_file =
        fs::File::open(source).map_err(|error| format!("打开复制源文件失败：{error}"))?;
    let mut destination_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| format!("创建复制目标文件失败：{error}"))?;
    let result = (|| {
        let copied = io::copy(&mut source_file, &mut destination_file)
            .map_err(|error| format!("复制工作区文件失败：{error}"))?;
        destination_file
            .sync_all()
            .map_err(|error| format!("持久化复制目标文件失败：{error}"))?;
        let metadata_after = fs::metadata(source)
            .map_err(|error| format!("重新读取复制源文件元数据失败：{error}"))?;
        if copied != metadata_before.len()
            || metadata_after.len() != metadata_before.len()
            || metadata_after.modified().ok() != modified_before
        {
            return Err("复制期间源文件发生变化，已取消复制".to_owned());
        }
        fs::set_permissions(destination, metadata_before.permissions())
            .map_err(|error| format!("保留复制文件权限失败：{error}"))?;
        Ok(())
    })();
    drop(destination_file);
    if result.is_err() {
        let _ = fs::remove_file(destination);
    }
    result
}

fn copy_directory_recursive(
    source: &Path,
    destination: &Path,
    depth: usize,
    entries: &mut usize,
) -> Result<(), String> {
    if depth > MAX_WORKSPACE_DEPTH {
        return Err(format!("复制目录深度超过安全上限（{MAX_WORKSPACE_DEPTH}）"));
    }
    fs::create_dir(destination).map_err(|error| format!("创建复制目标目录失败：{error}"))?;
    for child in fs::read_dir(source).map_err(|error| format!("读取复制源目录失败：{error}"))?
    {
        let child = child.map_err(|error| format!("读取复制源条目失败：{error}"))?;
        *entries += 1;
        if *entries > MAX_WORKSPACE_ENTRIES {
            return Err(format!("复制条目超过安全上限（{MAX_WORKSPACE_ENTRIES}）"));
        }
        let source_child = child.path();
        let metadata = fs::symlink_metadata(&source_child)
            .map_err(|error| format!("读取复制源条目元数据失败：{error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("拒绝复制包含符号链接的目录".to_owned());
        }
        let destination_child = destination.join(child.file_name());
        if metadata.is_dir() {
            copy_directory_recursive(&source_child, &destination_child, depth + 1, entries)?;
        } else if metadata.is_file() {
            copy_file_exclusive(&source_child, &destination_child)?;
        }
    }
    let permissions = fs::metadata(source)
        .map_err(|error| format!("读取复制源目录权限失败：{error}"))?
        .permissions();
    fs::set_permissions(destination, permissions)
        .map_err(|error| format!("保留复制目录权限失败：{error}"))?;
    Ok(())
}

pub(crate) fn copy_workspace_entry(
    root: &Path,
    source_relative: &str,
    destination_relative: &str,
) -> Result<PathBuf, String> {
    let source = resolve_workspace_entry(root, source_relative)?;
    let destination = resolve_workspace_destination(root, destination_relative)?;
    if source.is_dir() && destination.starts_with(&source) {
        return Err("不能把文件夹复制到自身内部".to_owned());
    }
    let result = if source.is_dir() {
        let mut entries = 0;
        copy_directory_recursive(&source, &destination, 0, &mut entries)
    } else if source.is_file() {
        copy_file_exclusive(&source, &destination)
    } else {
        Err("工作区复制源不是普通文件或文件夹".to_owned())
    };
    if let Err(error) = result {
        if destination.is_dir() {
            let _ = fs::remove_dir_all(&destination);
        } else {
            let _ = fs::remove_file(&destination);
        }
        return Err(error);
    }
    fs::canonicalize(&destination).map_err(|error| format!("解析复制目标失败：{error}"))
}

fn markdown_relative_path(from_directory: &Path, target: &Path) -> Result<String, String> {
    let from = from_directory.components().collect::<Vec<_>>();
    let to = target.components().collect::<Vec<_>>();
    let shared = from
        .iter()
        .zip(&to)
        .take_while(|(left, right)| left == right)
        .count();
    if shared == 0 {
        return Err("无法为导入图片生成工作区内相对路径".to_owned());
    }
    let mut parts = vec!["..".to_owned(); from.len().saturating_sub(shared)];
    for component in &to[shared..] {
        let Component::Normal(component) = component else {
            return Err("导入图片目标包含无效路径组件".to_owned());
        };
        let component = component
            .to_str()
            .ok_or_else(|| "导入图片文件名必须是有效 Unicode".to_owned())?;
        parts.push(urlencoding::encode(component).into_owned());
    }
    Ok(parts.join("/"))
}

fn image_name_parts(path: &Path) -> Result<(String, String), String> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|extension| IMAGE_EXTENSIONS.contains(&extension.as_str()))
        .ok_or_else(|| "仅支持 AVIF、GIF、JPEG、PNG 和 WebP 图片".to_owned())?;
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .ok_or_else(|| "所选图片缺少有效文件名".to_owned())?;
    Ok((stem.to_owned(), extension))
}

fn ensure_assets_directory(root: &Path) -> Result<(PathBuf, bool), String> {
    let assets = root.join("assets");
    let created = match fs::symlink_metadata(&assets) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("工作区 assets 目录不能是符号链接".to_owned())
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Err("工作区 assets 路径已存在且不是文件夹".to_owned())
        }
        Ok(_) => false,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir(&assets).map_err(|error| format!("创建 assets 目录失败：{error}"))?;
            true
        }
        Err(error) => return Err(format!("读取 assets 目录失败：{error}")),
    };
    Ok((assets, created))
}

fn image_bytes_match_extension(bytes: &[u8], extension: &str) -> bool {
    match extension {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpeg" | "jpg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        "avif" => {
            bytes.len() >= 12
                && &bytes[4..8] == b"ftyp"
                && bytes[8..]
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .any(|brand| brand == b"avif" || brand == b"avis")
        }
        _ => false,
    }
}

pub(crate) fn import_workspace_image(
    root: &Path,
    source_relative_path: &str,
    selected: &Path,
) -> Result<(String, String, String), String> {
    let source_document = resolve_workspace_file(root, source_relative_path)?;
    validate_workspace_document(&source_document)?;

    let selected_metadata = fs::symlink_metadata(selected)
        .map_err(|error| format!("读取所选图片元数据失败：{error}"))?;
    if selected_metadata.file_type().is_symlink() || !selected_metadata.is_file() {
        return Err("所选图片必须是普通文件，不能是符号链接".to_owned());
    }
    if selected_metadata.len() > MAX_WORKSPACE_IMAGE_BYTES {
        return Err(format!(
            "所选图片超过安全大小上限（{} MiB）",
            MAX_WORKSPACE_IMAGE_BYTES / 1024 / 1024
        ));
    }
    let (stem, extension) = image_name_parts(selected)?;
    let mut header = [0_u8; 64];
    let header_length = fs::File::open(selected)
        .and_then(|mut file| file.read(&mut header))
        .map_err(|error| format!("读取所选图片头部失败：{error}"))?;
    if !image_bytes_match_extension(&header[..header_length], &extension) {
        return Err("所选图片内容与文件扩展名不匹配".to_owned());
    }
    let (assets, created_assets) = ensure_assets_directory(root)?;

    let modified_before = selected_metadata.modified().ok();
    let result = (|| {
        for suffix in 1..=10_000_u32 {
            let file_name = if suffix == 1 {
                format!("{stem}.{extension}")
            } else {
                format!("{stem}-{suffix}.{extension}")
            };
            let destination = assets.join(&file_name);
            let markdown_path =
                markdown_relative_path(source_document.parent().unwrap_or(root), &destination)?;
            let mut destination_file = match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)
            {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("创建图片目标文件失败：{error}")),
            };
            let copy_result = (|| {
                let source_file = fs::File::open(selected)
                    .map_err(|error| format!("打开所选图片失败：{error}"))?;
                let copied = io::copy(
                    &mut source_file.take(MAX_WORKSPACE_IMAGE_BYTES + 1),
                    &mut destination_file,
                )
                .map_err(|error| format!("复制图片失败：{error}"))?;
                if copied > MAX_WORKSPACE_IMAGE_BYTES {
                    return Err("复制期间图片超过安全大小上限".to_owned());
                }
                destination_file
                    .sync_all()
                    .map_err(|error| format!("持久化导入图片失败：{error}"))?;
                let metadata_after = fs::metadata(selected)
                    .map_err(|error| format!("重新读取所选图片元数据失败：{error}"))?;
                if copied != selected_metadata.len()
                    || metadata_after.len() != selected_metadata.len()
                    || metadata_after.modified().ok() != modified_before
                {
                    return Err("复制期间所选图片发生变化，已取消导入".to_owned());
                }
                Ok(())
            })();
            drop(destination_file);
            if let Err(error) = copy_result {
                let _ = fs::remove_file(&destination);
                return Err(error);
            }
            let relative_path = format!("assets/{file_name}");
            return Ok((relative_path, markdown_path, stem.to_owned()));
        }
        Err("assets 目录中同名图片过多，无法分配安全文件名".to_owned())
    })();
    if result.is_err() && created_assets {
        let _ = fs::remove_dir(&assets);
    }
    result
}

pub(crate) fn import_workspace_image_bytes(
    root: &Path,
    source_relative_path: &str,
    file_name: &str,
    bytes: &[u8],
) -> Result<(String, String, String), String> {
    let source_document = resolve_workspace_file(root, source_relative_path)?;
    validate_workspace_document(&source_document)?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_WORKSPACE_IMAGE_BYTES {
        return Err(format!(
            "图片数据必须在 1 字节到 {} MiB 之间",
            MAX_WORKSPACE_IMAGE_BYTES / 1024 / 1024
        ));
    }
    let requested = Path::new(file_name);
    if requested.components().count() != 1
        || !matches!(requested.components().next(), Some(Component::Normal(_)))
    {
        return Err("图片文件名不能包含目录或特殊路径组件".to_owned());
    }
    let (stem, extension) = image_name_parts(requested)?;
    if !image_bytes_match_extension(bytes, &extension) {
        return Err("图片内容与文件扩展名不匹配".to_owned());
    }
    let (assets, created_assets) = ensure_assets_directory(root)?;
    let result = (|| {
        for suffix in 1..=10_000_u32 {
            let file_name = if suffix == 1 {
                format!("{stem}.{extension}")
            } else {
                format!("{stem}-{suffix}.{extension}")
            };
            let destination = assets.join(&file_name);
            let markdown_path =
                markdown_relative_path(source_document.parent().unwrap_or(root), &destination)?;
            let mut destination_file = match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)
            {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("创建图片目标文件失败：{error}")),
            };
            let write_result = destination_file
                .write_all(bytes)
                .and_then(|()| destination_file.sync_all())
                .map_err(|error| format!("写入导入图片失败：{error}"));
            drop(destination_file);
            if let Err(error) = write_result {
                let _ = fs::remove_file(&destination);
                return Err(error);
            }
            return Ok((
                format!("assets/{file_name}"),
                markdown_path,
                stem.to_owned(),
            ));
        }
        Err("assets 目录中同名图片过多，无法分配安全文件名".to_owned())
    })();
    if result.is_err() && created_assets {
        let _ = fs::remove_dir(&assets);
    }
    result
}

pub(crate) fn validate_workspace_document(path: &Path) -> Result<(), String> {
    if !is_markdown_path(path) {
        return Err("当前只能在编辑器中打开 Markdown 文件".to_owned());
    }
    let bytes = fs::metadata(path)
        .map_err(|error| format!("读取工作区文件元数据失败：{error}"))?
        .len();
    if bytes > MAX_WORKSPACE_DOCUMENT_BYTES {
        return Err(format!(
            "工作区文档超过安全大小上限（{} MiB）",
            MAX_WORKSPACE_DOCUMENT_BYTES / 1024 / 1024
        ));
    }
    Ok(())
}

pub(crate) fn watch_workspace<F>(
    root: &Path,
    mut on_change: F,
) -> Result<RecommendedWatcher, String>
where
    F: FnMut() + Send + 'static,
{
    let mut watcher = RecommendedWatcher::new(
        move |result: notify::Result<notify::Event>| {
            if result.is_ok() {
                on_change();
            }
        },
        Config::default(),
    )
    .map_err(|error| format!("启动工作区文件监听失败：{error}"))?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|error| format!("监听工作区失败：{error}"))?;
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::{
        consolidate_workspace_images, copy_workspace_entry, copy_workspace_image_and_rewrite,
        create_workspace_directory, create_workspace_document, enumerate_workspace,
        import_workspace_image, import_workspace_image_bytes, inspect_workspace_image_references,
        inspect_workspace_images, markdown_image_targets, move_workspace_document_and_rewrite,
        move_workspace_entry, move_workspace_image_and_rewrite, preview_workspace_document_move,
        preview_workspace_image_consolidation, preview_workspace_image_move,
        resolve_workspace_destination, resolve_workspace_document_link, resolve_workspace_file,
        resolve_workspace_image_link, search_workspace, validate_workspace_document,
        watch_workspace, WorkspaceEntryKind, WorkspaceSearchCompletion, WorkspaceSearchOptions,
        MAX_WORKSPACE_IMAGE_PREVIEW_BYTES,
    };
    use std::{fs, path::PathBuf, sync::atomic::AtomicBool, time::SystemTime};

    fn test_directory(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "mdeditor-workspace-{name}-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn enumerates_a_sorted_unicode_tree_without_following_symlinks() {
        let directory = test_directory("enumerate");
        let nested = directory.join("中文 目录");
        fs::create_dir_all(&nested).expect("create nested directory");
        fs::write(directory.join("B.md"), b"b").expect("write B");
        fs::write(directory.join("a.md"), b"a").expect("write a");
        fs::write(nested.join("图片.png"), [1, 2, 3]).expect("write image");
        let root = fs::canonicalize(&directory).expect("canonical root");

        let entries = enumerate_workspace(&root, 20).expect("enumerate workspace");

        assert_eq!(
            entries
                .iter()
                .map(|entry| (entry.relative_path.clone(), entry.kind, entry.bytes))
                .collect::<Vec<_>>(),
            vec![
                ("a.md".to_owned(), WorkspaceEntryKind::File, Some(1)),
                ("B.md".to_owned(), WorkspaceEntryKind::File, Some(1)),
                ("中文 目录".to_owned(), WorkspaceEntryKind::Directory, None),
                (
                    "中文 目录/图片.png".to_owned(),
                    WorkspaceEntryKind::File,
                    Some(3)
                ),
            ]
        );
        fs::remove_dir_all(directory).expect("remove workspace fixture");
    }

    #[test]
    fn resolves_only_normal_files_below_the_authorized_root() {
        let directory = test_directory("resolve");
        let nested = directory.join("notes");
        fs::create_dir_all(&nested).expect("create nested directory");
        let note = nested.join("note.md");
        fs::write(&note, b"note").expect("write note");
        let root = fs::canonicalize(&directory).expect("canonical root");

        assert_eq!(
            resolve_workspace_file(&root, "notes/note.md").expect("resolve note"),
            fs::canonicalize(&note).expect("canonical note")
        );
        assert!(resolve_workspace_file(&root, "../outside.md").is_err());
        assert!(resolve_workspace_file(&root, ".").is_err());
        assert!(resolve_workspace_file(&root, &note.to_string_lossy()).is_err());
        assert!(resolve_workspace_file(&root, "notes").is_err());
        fs::remove_dir_all(directory).expect("remove workspace fixture");
    }

    #[test]
    fn resolves_percent_encoded_markdown_links_without_escaping_the_root() {
        let directory = test_directory("resolve-link");
        fs::create_dir_all(directory.join("docs/子目录")).expect("create nested directory");
        fs::write(directory.join("docs/当前.md"), b"current").expect("write source");
        fs::write(directory.join("docs/子目录/说明 文档.md"), b"linked").expect("write target");
        fs::write(directory.join("image.png"), [1, 2, 3]).expect("write image");
        let root = fs::canonicalize(&directory).expect("canonical root");

        let (_, relative, fragment) = resolve_workspace_document_link(
            &root,
            "docs/当前.md",
            "./子目录/说明%20文档.md#%E7%AB%A0%E8%8A%82",
        )
        .expect("resolve local link");
        assert_eq!(relative, "docs/子目录/说明 文档.md");
        assert_eq!(fragment.as_deref(), Some("%E7%AB%A0%E8%8A%82"));
        assert!(
            resolve_workspace_document_link(&root, "docs/当前.md", "../../outside.md").is_err()
        );
        assert!(
            resolve_workspace_document_link(&root, "docs/当前.md", "子目录%2F说明.md").is_err()
        );
        assert!(resolve_workspace_document_link(&root, "docs/当前.md", "../image.png").is_err());
        fs::remove_dir_all(directory).expect("remove link fixture");
    }

    #[test]
    fn imports_images_without_overwriting_and_returns_an_encoded_relative_link() {
        let directory = test_directory("import-image");
        let external = test_directory("import-image-source");
        fs::create_dir_all(directory.join("docs/中文")).expect("create document directory");
        fs::create_dir_all(&external).expect("create external directory");
        fs::write(directory.join("docs/中文/当前.md"), b"current").expect("write document");
        let selected = external.join("封面 (终稿).PNG");
        let png = b"\x89PNG\r\n\x1a\nfixture";
        fs::write(&selected, png).expect("write selected image");
        let root = fs::canonicalize(&directory).expect("canonical root");

        let first = import_workspace_image(&root, "docs/中文/当前.md", &selected)
            .expect("import first image");
        let second = import_workspace_image(&root, "docs/中文/当前.md", &selected)
            .expect("import colliding image");

        assert_eq!(first.0, "assets/封面 (终稿).png");
        assert_eq!(
            first.1,
            "../../assets/%E5%B0%81%E9%9D%A2%20%28%E7%BB%88%E7%A8%BF%29.png"
        );
        assert_eq!(first.2, "封面 (终稿)");
        assert_eq!(second.0, "assets/封面 (终稿)-2.png");
        assert_eq!(fs::read(root.join(&first.0)).expect("read import"), png);
        assert_eq!(fs::read(root.join(&second.0)).expect("read second"), png);

        fs::remove_dir_all(directory).expect("remove workspace fixture");
        fs::remove_dir_all(external).expect("remove source fixture");
    }

    #[test]
    fn resolves_only_bounded_images_relative_to_an_authorized_document() {
        let directory = test_directory("resolve-image");
        fs::create_dir_all(directory.join("docs")).expect("create document directory");
        fs::create_dir_all(directory.join("assets")).expect("create assets directory");
        fs::write(directory.join("docs/当前.md"), b"current").expect("write document");
        fs::write(directory.join("assets/封面 图.png"), [1, 2, 3]).expect("write image");
        fs::write(directory.join("assets/not-image.txt"), b"text").expect("write text");
        let oversized =
            fs::File::create(directory.join("assets/large.png")).expect("create oversized image");
        oversized
            .set_len(MAX_WORKSPACE_IMAGE_PREVIEW_BYTES + 1)
            .expect("size oversized image");
        let root = fs::canonicalize(&directory).expect("canonical root");

        let (image, mime) = resolve_workspace_image_link(
            &root,
            "docs/当前.md",
            "../assets/%E5%B0%81%E9%9D%A2%20%E5%9B%BE.png",
        )
        .expect("resolve image");
        assert_eq!(
            image,
            fs::canonicalize(root.join("assets/封面 图.png")).unwrap()
        );
        assert_eq!(mime, "image/png");
        assert!(
            resolve_workspace_image_link(&root, "docs/当前.md", "../assets/not-image.txt").is_err()
        );
        assert!(resolve_workspace_image_link(&root, "docs/当前.md", "../../outside.png").is_err());
        assert!(
            resolve_workspace_image_link(&root, "docs/当前.md", "../assets/large.png").is_err()
        );

        fs::remove_dir_all(directory).expect("remove image fixture");
    }

    #[test]
    fn imports_clipboard_image_bytes_and_rejects_spoofed_or_nested_names() {
        let directory = test_directory("import-image-bytes");
        fs::create_dir_all(directory.join("docs")).expect("create document directory");
        fs::write(directory.join("docs/current.md"), b"current").expect("write document");
        let root = fs::canonicalize(&directory).expect("canonical root");
        let png = b"\x89PNG\r\n\x1a\nclipboard";

        let imported = import_workspace_image_bytes(&root, "docs/current.md", "粘贴 图.PNG", png)
            .expect("import clipboard bytes");
        assert_eq!(imported.0, "assets/粘贴 图.png");
        assert_eq!(imported.1, "../assets/%E7%B2%98%E8%B4%B4%20%E5%9B%BE.png");
        assert_eq!(fs::read(root.join(&imported.0)).unwrap(), png);
        assert!(
            import_workspace_image_bytes(&root, "docs/current.md", "nested/image.png", png)
                .is_err()
        );
        assert!(import_workspace_image_bytes(
            &root,
            "docs/current.md",
            "spoofed.png",
            b"not a png"
        )
        .is_err());

        fs::remove_dir_all(directory).expect("remove clipboard fixture");
    }

    #[test]
    fn inspects_local_image_targets_without_treating_remote_or_fenced_text_as_files() {
        let directory = test_directory("inspect-images");
        fs::create_dir_all(directory.join("docs")).expect("create document directory");
        fs::create_dir_all(directory.join("assets")).expect("create assets directory");
        fs::write(directory.join("assets/ok.png"), [1, 2, 3]).expect("write image");
        fs::write(directory.join("assets/not.txt"), b"text").expect("write text");
        let markdown = concat!(
            "![ok](../assets/ok.png)\n",
            "中文 ![bad](../assets/missing%20图.png)\n",
            "![remote](https://example.com/image.png)\n",
            "`![inline](../assets/missing-inline.png)`\n",
            "\\![escaped](../assets/missing-escaped.png)\n",
            "```md\n",
            "![sample](../assets/missing-in-code.png)\n",
            "```\n",
            "![wrong](../assets/not.txt)\n",
        );
        fs::write(directory.join("docs/current.md"), markdown).expect("write markdown");
        let root = fs::canonicalize(&directory).expect("canonical root");

        let inspection = inspect_workspace_images(&root).expect("inspect images");
        assert!(!inspection.truncated);
        assert_eq!(inspection.issues.len(), 2);
        assert_eq!(
            inspection.issues[0].document_relative_path,
            "docs/current.md"
        );
        assert_eq!(inspection.issues[0].line, 2);
        assert_eq!(inspection.issues[0].column, 11);
        assert_eq!(inspection.issues[0].target, "../assets/missing%20图.png");
        assert_eq!(inspection.issues[1].line, 9);
        assert_eq!(inspection.issues[1].target, "../assets/not.txt");

        assert_eq!(
            markdown_image_targets("![escaped](<../assets/a b.png>) and ![paren](a\\(b\\).png)")
                .into_iter()
                .map(|target| (target.start, target.target))
                .collect::<Vec<_>>(),
            vec![
                (12, "../assets/a b.png".to_owned()),
                (45, "a(b).png".to_owned())
            ]
        );
        assert!(
            markdown_image_targets("`![code](missing.png)` \\![escaped](missing.png)").is_empty()
        );
        fs::remove_dir_all(directory).expect("remove inspection fixture");
    }

    #[test]
    fn previews_and_rewrites_references_when_moving_an_image() {
        let directory = test_directory("move-image-references");
        fs::create_dir_all(directory.join("docs/nested")).expect("create document directory");
        fs::create_dir_all(directory.join("assets/archive")).expect("create asset directory");
        fs::write(directory.join("assets/图 1.png"), [1, 2, 3]).expect("write image");
        fs::write(
            directory.join("docs/one.md"),
            "前缀 ![图](../assets/%E5%9B%BE%201.png) 后缀\r\n",
        )
        .expect("write first reference");
        fs::write(
            directory.join("docs/nested/two.md"),
            "![另一个](../../assets/%E5%9B%BE%201.png)\n",
        )
        .expect("write second reference");
        let root = fs::canonicalize(&directory).expect("canonical root");

        let references = inspect_workspace_image_references(&root, "assets/图 1.png")
            .expect("inspect exact image references");
        assert!(!references.truncated);
        assert_eq!(references.references.len(), 2);
        assert_eq!(
            references.references[0].document_relative_path,
            "docs/nested/two.md"
        );
        assert_eq!(
            references.references[1].target,
            "../assets/%E5%9B%BE%201.png"
        );

        let preview =
            preview_workspace_image_move(&root, "assets/图 1.png", "assets/archive/新图.png")
                .expect("preview image move");
        assert!(!preview.truncated);
        assert_eq!(preview.updates.len(), 2);
        assert_eq!(
            preview.updates[0].document_relative_path,
            "docs/nested/two.md"
        );
        assert_eq!(
            preview.updates[0].to_target,
            "../../assets/archive/%E6%96%B0%E5%9B%BE.png"
        );
        assert_eq!(preview.updates[1].document_relative_path, "docs/one.md");
        assert_eq!(preview.updates[1].line, 1);
        assert_eq!(preview.updates[1].column, 9);

        let open_error = move_workspace_image_and_rewrite(
            &root,
            "assets/图 1.png",
            "assets/archive/新图.png",
            |document| document.ends_with("one.md"),
        )
        .expect_err("open reference document should prevent mutation");
        assert!(open_error.contains("docs/one.md"));
        assert!(directory.join("assets/图 1.png").exists());
        assert!(!directory.join("assets/archive/新图.png").exists());

        let rewritten = move_workspace_image_and_rewrite(
            &root,
            "assets/图 1.png",
            "assets/archive/新图.png",
            |_| false,
        )
        .expect("move image and rewrite references");
        assert_eq!(rewritten, vec!["docs/nested/two.md", "docs/one.md"]);
        assert!(!directory.join("assets/图 1.png").exists());
        assert!(directory.join("assets/archive/新图.png").exists());
        assert_eq!(
            fs::read_to_string(directory.join("docs/one.md")).expect("read rewritten document"),
            "前缀 ![图](../assets/archive/%E6%96%B0%E5%9B%BE.png) 后缀\r\n"
        );
        assert_eq!(
            fs::read_to_string(directory.join("docs/nested/two.md"))
                .expect("read rewritten nested document"),
            "![另一个](../../assets/archive/%E6%96%B0%E5%9B%BE.png)\n"
        );

        fs::remove_dir_all(directory).expect("remove move image fixture");
    }

    #[test]
    fn copies_an_image_and_switches_existing_references() {
        let directory = test_directory("copy-image-references");
        fs::create_dir_all(directory.join("assets/archive")).expect("create asset directories");
        fs::create_dir_all(directory.join("docs")).expect("create docs directory");
        fs::write(directory.join("assets/source.png"), [1, 2, 3]).expect("write source image");
        fs::write(
            directory.join("docs/note.md"),
            "![source](../assets/source.png)\n",
        )
        .expect("write reference document");
        let root = fs::canonicalize(&directory).expect("canonical root");

        let changed = copy_workspace_image_and_rewrite(
            &root,
            "assets/source.png",
            "assets/archive/copied.png",
            |_| false,
        )
        .expect("copy image and switch references");

        assert_eq!(changed, vec!["docs/note.md"]);
        assert!(directory.join("assets/source.png").exists());
        assert_eq!(
            fs::read(directory.join("assets/archive/copied.png")).expect("read copied image"),
            [1, 2, 3]
        );
        assert_eq!(
            fs::read_to_string(directory.join("docs/note.md")).expect("read rewritten document"),
            "![source](../assets/archive/copied.png)\n"
        );
        fs::remove_dir_all(directory).expect("remove image copy fixture");
    }

    #[test]
    fn consolidates_referenced_images_with_stable_collision_names() {
        let directory = test_directory("consolidate-images");
        fs::create_dir_all(directory.join("docs")).expect("create docs directory");
        fs::create_dir_all(directory.join("one")).expect("create first image directory");
        fs::create_dir_all(directory.join("two")).expect("create second image directory");
        fs::create_dir_all(directory.join("assets")).expect("create assets directory");
        fs::write(directory.join("one/photo.png"), [1]).expect("write first image");
        fs::write(directory.join("two/photo.png"), [2]).expect("write second image");
        fs::write(directory.join("assets/photo.png"), [9]).expect("write collision image");
        fs::write(directory.join("assets/keep.png"), [3]).expect("write existing asset");
        fs::write(
            directory.join("docs/note.md"),
            concat!(
                "![one](../one/photo.png) ![again](../one/photo.png)\n",
                "![two](../two/photo.png) ![keep](../assets/keep.png)\n",
            ),
        )
        .expect("write image references");
        let root = fs::canonicalize(&directory).expect("canonical root");

        let preview =
            preview_workspace_image_consolidation(&root, "assets").expect("preview consolidation");
        assert!(!preview.truncated);
        assert_eq!(preview.copies.len(), 2);
        assert_eq!(preview.updates.len(), 3);
        assert_eq!(
            preview.copies[0].destination_relative_path,
            "assets/photo-2.png"
        );
        assert_eq!(preview.copies[0].reference_count, 2);
        assert_eq!(
            preview.copies[1].destination_relative_path,
            "assets/photo-3.png"
        );
        assert_eq!(preview.copies[1].reference_count, 1);

        let changed = consolidate_workspace_images(&root, "assets", &preview, |_| false)
            .expect("apply consolidation");

        assert_eq!(changed, vec!["docs/note.md"]);
        assert!(directory.join("one/photo.png").exists());
        assert!(directory.join("two/photo.png").exists());
        assert_eq!(fs::read(directory.join("assets/photo-2.png")).unwrap(), [1]);
        assert_eq!(fs::read(directory.join("assets/photo-3.png")).unwrap(), [2]);
        assert_eq!(
            fs::read_to_string(directory.join("docs/note.md")).unwrap(),
            concat!(
                "![one](../assets/photo-2.png) ![again](../assets/photo-2.png)\n",
                "![two](../assets/photo-3.png) ![keep](../assets/keep.png)\n",
            )
        );
        fs::remove_dir_all(directory).expect("remove consolidation fixture");
    }

    #[test]
    fn rolls_back_an_image_move_when_a_reference_document_changes() {
        let directory = test_directory("move-image-conflict");
        fs::create_dir_all(directory.join("docs")).expect("create docs directory");
        fs::create_dir_all(directory.join("assets/archive")).expect("create assets directory");
        fs::write(directory.join("assets/source.png"), [1, 2, 3]).expect("write image");
        let document = directory.join("docs/note.md");
        fs::write(&document, "![图](../assets/source.png)\n").expect("write reference");
        let root = fs::canonicalize(&directory).expect("canonical root");
        let mut injected = false;

        let error = move_workspace_image_and_rewrite(
            &root,
            "assets/source.png",
            "assets/archive/moved.png",
            |path| {
                if !injected {
                    fs::write(path, "外部版本\n").expect("inject external change");
                    injected = true;
                }
                false
            },
        )
        .expect_err("external change should prevent reference replacement");

        assert!(error.contains("移动已回滚"));
        assert!(directory.join("assets/source.png").exists());
        assert!(!directory.join("assets/archive/moved.png").exists());
        assert_eq!(
            fs::read_to_string(&document).expect("read external document"),
            "外部版本\n"
        );
        fs::remove_dir_all(directory).expect("remove conflict fixture");
    }

    #[test]
    fn previews_and_rewrites_inbound_and_outbound_links_for_a_document_move() {
        let directory = test_directory("move-document-links");
        fs::create_dir_all(directory.join("docs/guide")).expect("create guide directory");
        fs::create_dir_all(directory.join("archive")).expect("create archive directory");
        fs::create_dir_all(directory.join("assets")).expect("create assets directory");
        fs::write(directory.join("assets/pic.png"), [1, 2, 3]).expect("write image");
        fs::write(directory.join("docs/other.md"), "# Other\n").expect("write other document");
        fs::write(
            directory.join("docs/guide/start.md"),
            concat!(
                "[other](../other.md)\r\n",
                "![pic](../../assets/pic.png)\r\n",
                "[self](start.md#标题) [fragment](#标题)\r\n",
                "[remote](https://example.com/start.md)\r\n",
            ),
        )
        .expect("write moving document");
        fs::write(
            directory.join("docs/index.md"),
            "[start](guide/start.md#标题)\n",
        )
        .expect("write inbound link");
        let root = fs::canonicalize(&directory).expect("canonical root");

        let preview =
            preview_workspace_document_move(&root, "docs/guide/start.md", "archive/renamed.md")
                .expect("preview document move");
        assert!(!preview.truncated);
        assert_eq!(preview.updates.len(), 4);
        assert!(preview.updates.iter().any(|update| {
            update.document_relative_path == "docs/index.md"
                && update.from_target == "guide/start.md#标题"
                && update.to_target == "../archive/renamed.md#标题"
        }));

        let open_error = move_workspace_document_and_rewrite(
            &root,
            "docs/guide/start.md",
            "archive/renamed.md",
            |path| path.ends_with("start.md"),
        )
        .expect_err("open source document should prevent move");
        assert!(open_error.contains("仍在标签页中打开"));
        assert!(directory.join("docs/guide/start.md").exists());

        move_workspace_document_and_rewrite(
            &root,
            "docs/guide/start.md",
            "archive/renamed.md",
            |_| false,
        )
        .expect("move document and rewrite links");
        assert!(!directory.join("docs/guide/start.md").exists());
        assert_eq!(
            fs::read_to_string(directory.join("archive/renamed.md")).expect("read moved document"),
            concat!(
                "[other](../docs/other.md)\r\n",
                "![pic](../assets/pic.png)\r\n",
                "[self](renamed.md#标题) [fragment](#标题)\r\n",
                "[remote](https://example.com/start.md)\r\n",
            )
        );
        assert_eq!(
            fs::read_to_string(directory.join("docs/index.md")).expect("read inbound document"),
            "[start](../archive/renamed.md#标题)\n"
        );
        fs::remove_dir_all(directory).expect("remove document move fixture");
    }

    #[test]
    fn rewrites_links_across_a_moved_directory_tree() {
        let directory = test_directory("move-directory-links");
        fs::create_dir_all(directory.join("project/guide")).expect("create guide directory");
        fs::create_dir_all(directory.join("project/assets")).expect("create asset directory");
        fs::create_dir_all(directory.join("archive")).expect("create archive directory");
        fs::write(directory.join("project/assets/p.png"), [1, 2, 3]).expect("write image");
        fs::write(directory.join("outside.md"), "# Outside\n").expect("write outside document");
        fs::write(
            directory.join("project/guide/a.md"),
            "![internal](../assets/p.png) [outside](../../outside.md)\n",
        )
        .expect("write moved document");
        fs::write(
            directory.join("index.md"),
            "[guide](project/guide/a.md) ![asset](project/assets/p.png)\n",
        )
        .expect("write inbound references");
        let root = fs::canonicalize(&directory).expect("canonical root");

        let preview = preview_workspace_document_move(&root, "project", "archive/project")
            .expect("preview directory move");
        assert!(!preview.truncated);
        assert_eq!(preview.updates.len(), 3);
        assert!(!preview
            .updates
            .iter()
            .any(|update| update.from_target == "../assets/p.png"));

        move_workspace_document_and_rewrite(&root, "project", "archive/project", |_| false)
            .expect("move directory and rewrite links");
        assert!(!directory.join("project").exists());
        assert_eq!(
            fs::read_to_string(directory.join("archive/project/guide/a.md"))
                .expect("read moved guide"),
            "![internal](../assets/p.png) [outside](../../../outside.md)\n"
        );
        assert_eq!(
            fs::read_to_string(directory.join("index.md")).expect("read inbound references"),
            "[guide](archive/project/guide/a.md) ![asset](archive/project/assets/p.png)\n"
        );
        fs::remove_dir_all(directory).expect("remove directory move fixture");
    }

    #[test]
    fn rejects_document_moves_when_a_markdown_file_cannot_be_scanned() {
        let directory = test_directory("move-unscannable-links");
        fs::create_dir_all(&directory).expect("create directory");
        fs::write(directory.join("source.md"), "# Source\n").expect("write source");
        fs::write(directory.join("invalid.md"), [0xff, 0xfe]).expect("write invalid document");
        let root = fs::canonicalize(&directory).expect("canonical root");

        let error = preview_workspace_document_move(&root, "source.md", "renamed.md")
            .expect_err("invalid UTF-8 must stop a reference-aware move");

        assert!(error.contains("invalid.md"));
        assert!(error.contains("不是有效的 UTF-8"));
        assert!(directory.join("source.md").exists());
        assert!(!directory.join("renamed.md").exists());
        fs::remove_dir_all(directory).expect("remove unscannable fixture");
    }

    #[test]
    fn rejects_a_listing_that_exceeds_the_entry_limit() {
        let directory = test_directory("limit");
        fs::create_dir_all(&directory).expect("create directory");
        fs::write(directory.join("one.md"), b"1").expect("write one");
        fs::write(directory.join("two.md"), b"2").expect("write two");
        let root = fs::canonicalize(&directory).expect("canonical root");

        let error = enumerate_workspace(&root, 1).expect_err("limit should be enforced");

        assert_eq!(error, "工作区条目超过安全上限（1）");
        fs::remove_dir_all(directory).expect("remove workspace fixture");
    }

    #[test]
    fn accepts_markdown_documents_and_rejects_other_file_types() {
        let directory = test_directory("document-type");
        fs::create_dir_all(&directory).expect("create directory");
        let markdown = directory.join("说明.MD");
        let image = directory.join("image.png");
        fs::write(&markdown, b"# note").expect("write markdown");
        fs::write(&image, [1, 2, 3]).expect("write image");

        validate_workspace_document(&markdown).expect("accept Markdown extension");
        assert_eq!(
            validate_workspace_document(&image).expect_err("reject image"),
            "当前只能在编辑器中打开 Markdown 文件"
        );
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn creates_unicode_documents_and_directories_without_overwriting() {
        let directory = test_directory("create");
        fs::create_dir_all(directory.join("文档")).expect("create parent directory");
        let root = fs::canonicalize(&directory).expect("canonical root");

        let created_directory =
            create_workspace_directory(&root, "文档/新目录").expect("create nested directory");
        let created_document = create_workspace_document(&root, "文档/新目录/说明.MD")
            .expect("create nested document");

        assert!(created_directory.is_dir());
        assert_eq!(fs::read(&created_document).expect("read document"), b"");
        assert_eq!(
            create_workspace_document(&root, "文档/新目录/说明.MD")
                .expect_err("must not overwrite"),
            "工作区目标已存在，不会覆盖"
        );
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn rejects_unsafe_or_unsupported_creation_targets() {
        let directory = test_directory("create-reject");
        fs::create_dir_all(&directory).expect("create directory");
        let root = fs::canonicalize(&directory).expect("canonical root");

        assert!(resolve_workspace_destination(&root, "../escape.md").is_err());
        assert!(resolve_workspace_destination(&root, ".").is_err());
        assert!(resolve_workspace_destination(&root, "missing/note.md").is_err());
        assert_eq!(
            create_workspace_document(&root, "image.png").expect_err("reject non-Markdown"),
            "新建文档必须使用 Markdown 扩展名"
        );
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn moves_and_copies_files_and_directories_without_overwriting() {
        let directory = test_directory("move-copy");
        let source_directory = directory.join("源目录");
        fs::create_dir_all(&source_directory).expect("create source directory");
        fs::write(source_directory.join("说明.md"), "中文".as_bytes()).expect("write source");
        let root = fs::canonicalize(&directory).expect("canonical root");

        let (_, moved) =
            move_workspace_entry(&root, "源目录/说明.md", "移动后.md").expect("move document");
        assert_eq!(fs::read(&moved).expect("read moved"), "中文".as_bytes());

        let copied = copy_workspace_entry(&root, "移动后.md", "副本.md").expect("copy file");
        assert_eq!(fs::read(&copied).expect("read copy"), "中文".as_bytes());
        assert!(copy_workspace_entry(&root, "移动后.md", "副本.md").is_err());

        fs::write(source_directory.join("嵌套.md"), b"nested").expect("write nested");
        let copied_directory =
            copy_workspace_entry(&root, "源目录", "复制目录").expect("copy directory");
        assert_eq!(
            fs::read(copied_directory.join("嵌套.md")).expect("read nested copy"),
            b"nested"
        );
        assert!(copy_workspace_entry(&root, "源目录", "源目录/内部副本").is_err());
        assert!(move_workspace_entry(&root, "源目录", "源目录/内部移动").is_err());
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn searches_markdown_with_unicode_case_word_and_regex_options() {
        let directory = test_directory("search");
        fs::create_dir_all(directory.join("文档")).expect("create nested directory");
        fs::write(
            directory.join("文档/说明.md"),
            "Alpha alphabet\n中文 TARGET 中文\nfoo-42".as_bytes(),
        )
        .expect("write Markdown");
        fs::write(directory.join("ignored.txt"), b"TARGET").expect("write text file");
        fs::write(directory.join("binary.md"), b"TARGET\0hidden").expect("write binary file");
        let root = fs::canonicalize(&directory).expect("canonical root");
        let cancelled = AtomicBool::new(false);

        let mut matches = Vec::new();
        let completion = search_workspace(
            &root,
            "alpha",
            WorkspaceSearchOptions {
                case_sensitive: false,
                whole_word: true,
                regular_expression: false,
            },
            &cancelled,
            |batch| {
                matches.extend(batch);
                Ok(())
            },
        )
        .expect("search literal");
        assert_eq!(
            completion,
            WorkspaceSearchCompletion::Complete { truncated: false }
        );
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].relative_path, "文档/说明.md");
        assert_eq!((matches[0].line, matches[0].column), (1, 1));

        matches.clear();
        search_workspace(
            &root,
            r"foo-\d+",
            WorkspaceSearchOptions {
                case_sensitive: true,
                whole_word: false,
                regular_expression: true,
            },
            &cancelled,
            |batch| {
                matches.extend(batch);
                Ok(())
            },
        )
        .expect("search regex");
        assert_eq!((matches[0].line, matches[0].column), (3, 1));
        fs::remove_dir_all(directory).expect("remove search fixture");
    }

    #[test]
    fn cancels_workspace_search_during_streaming() {
        let directory = test_directory("search-cancel");
        fs::create_dir_all(&directory).expect("create directory");
        fs::write(directory.join("note.md"), "needle\n".repeat(60)).expect("write Markdown");
        let root = fs::canonicalize(&directory).expect("canonical root");
        let cancelled = AtomicBool::new(false);
        let mut emitted = 0;

        let completion = search_workspace(
            &root,
            "needle",
            WorkspaceSearchOptions {
                case_sensitive: true,
                whole_word: false,
                regular_expression: false,
            },
            &cancelled,
            |batch| {
                emitted += batch.len();
                cancelled.store(true, std::sync::atomic::Ordering::Relaxed);
                Ok(())
            },
        )
        .expect("cancel search");

        assert_eq!(completion, WorkspaceSearchCompletion::Cancelled);
        assert_eq!(emitted, 50);
        fs::remove_dir_all(directory).expect("remove search fixture");
    }

    #[test]
    fn reports_external_changes_from_a_recursive_watcher() {
        use std::{sync::mpsc, time::Duration};

        let directory = test_directory("watch");
        let nested = directory.join("嵌套");
        fs::create_dir_all(&nested).expect("create watched directory");
        let root = fs::canonicalize(&directory).expect("canonical root");
        let (sender, receiver) = mpsc::channel();
        let watcher = watch_workspace(&root, move || {
            let _ = sender.send(());
        })
        .expect("start recursive watcher");

        fs::write(nested.join("外部新增.md"), b"# changed").expect("write watched file");
        receiver
            .recv_timeout(Duration::from_secs(10))
            .expect("watcher should report the external write");

        drop(watcher);
        fs::remove_dir_all(directory).expect("remove watched fixture");
    }

    #[cfg(unix)]
    #[test]
    fn excludes_symlinks_and_rejects_opening_through_them() {
        use std::os::unix::fs::symlink;

        let directory = test_directory("symlink");
        let outside = test_directory("outside");
        fs::create_dir_all(&directory).expect("create workspace");
        fs::create_dir_all(&outside).expect("create outside");
        fs::write(outside.join("secret.md"), b"secret").expect("write outside file");
        symlink(outside.join("secret.md"), directory.join("linked.md")).expect("create symlink");
        symlink(&outside, directory.join("linked-directory")).expect("create directory symlink");
        let mixed = directory.join("mixed");
        fs::create_dir(&mixed).expect("create mixed directory");
        fs::write(mixed.join("normal.md"), b"normal").expect("write normal file");
        symlink(outside.join("secret.md"), mixed.join("linked.md")).expect("create nested symlink");
        let root = fs::canonicalize(&directory).expect("canonical root");

        assert!(enumerate_workspace(&root, 20)
            .expect("enumerate workspace")
            .iter()
            .all(|entry| !entry.relative_path.contains("linked")));
        assert!(resolve_workspace_file(&root, "linked.md").is_err());
        assert!(resolve_workspace_destination(&root, "linked-directory/new.md").is_err());
        assert!(copy_workspace_entry(&root, "mixed", "mixed-copy").is_err());
        assert!(!directory.join("mixed-copy").exists());
        fs::remove_dir_all(directory).expect("remove workspace");
        fs::remove_dir_all(outside).expect("remove outside");
    }
}
