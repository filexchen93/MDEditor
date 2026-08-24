use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::UNIX_EPOCH,
};

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub enum SaveError {
    Conflict,
    Io(io::Error),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SaveStage {
    TemporaryCreated,
    DataWritten,
    DataSynced,
    BeforeReplace,
    AfterReplace,
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Conflict => write!(
                formatter,
                "文件已被其他程序修改；为避免覆盖外部更改，本次保存已取消"
            ),
            Self::Io(error) => write!(formatter, "文件写入失败：{error}"),
        }
    }
}

impl From<io::Error> for SaveError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

fn modified_nanos(metadata: &fs::Metadata) -> io::Result<u128> {
    Ok(metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos())
}

fn content_hash(bytes: &[u8]) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;

    bytes.iter().fold(OFFSET_BASIS, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(PRIME)
    })
}

fn fingerprint(metadata: &fs::Metadata, bytes: &[u8]) -> io::Result<String> {
    Ok(format!(
        "{}:{}:{:016x}",
        metadata.len(),
        modified_nanos(metadata)?,
        content_hash(bytes)
    ))
}

pub fn read_document(path: &Path) -> io::Result<(Vec<u8>, String)> {
    let metadata_before = fs::metadata(path)?;
    let bytes = fs::read(path)?;
    let metadata_after = fs::metadata(path)?;

    if metadata_before.len() != metadata_after.len()
        || modified_nanos(&metadata_before)? != modified_nanos(&metadata_after)?
    {
        return Err(io::Error::other("文件在读取过程中发生变化，请重试"));
    }

    let disk_fingerprint = fingerprint(&metadata_after, &bytes)?;
    Ok((bytes, disk_fingerprint))
}

fn current_fingerprint(path: &Path) -> Result<Option<String>, SaveError> {
    match read_document(path) {
        Ok((_, fingerprint)) => Ok(Some(fingerprint)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn ensure_expected_state(path: &Path, expected: Option<&str>) -> Result<(), SaveError> {
    let current = current_fingerprint(path)?;
    if current.as_deref() == expected {
        Ok(())
    } else {
        Err(SaveError::Conflict)
    }
}

fn temporary_path(target: &Path) -> io::Result<PathBuf> {
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "目标文件没有父目录"))?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("document");
    let sequence = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);

    Ok(parent.join(format!(
        ".{name}.mdeditor-{}-{sequence}.tmp",
        std::process::id()
    )))
}

fn create_temporary_file(target: &Path) -> io::Result<(PathBuf, File)> {
    for _ in 0..100 {
        let temporary = temporary_path(target)?;
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
        {
            Ok(file) => return Ok((temporary, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "无法分配唯一的临时文件名",
    ))
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };

    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    fs::rename(source, target)
}

#[cfg(unix)]
fn sync_parent_directory(target: &Path) -> io::Result<()> {
    if let Some(parent) = target.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn sync_parent_directory(_target: &Path) -> io::Result<()> {
    Ok(())
}

pub fn atomic_save(
    target: &Path,
    bytes: &[u8],
    expected_fingerprint: Option<&str>,
) -> Result<String, SaveError> {
    atomic_save_with_hook(target, bytes, expected_fingerprint, |_| Ok(()))
}

fn atomic_save_with_hook<F>(
    target: &Path,
    bytes: &[u8],
    expected_fingerprint: Option<&str>,
    mut hook: F,
) -> Result<String, SaveError>
where
    F: FnMut(SaveStage) -> io::Result<()>,
{
    ensure_expected_state(target, expected_fingerprint)?;

    let existing_permissions = fs::metadata(target)
        .ok()
        .map(|metadata| metadata.permissions());
    let (temporary, mut file) = create_temporary_file(target)?;

    let preparation = (|| -> Result<(), SaveError> {
        hook(SaveStage::TemporaryCreated)?;
        file.write_all(bytes)?;
        hook(SaveStage::DataWritten)?;
        file.sync_all()?;
        hook(SaveStage::DataSynced)?;

        if let Some(permissions) = existing_permissions {
            fs::set_permissions(&temporary, permissions)?;
        }

        Ok(())
    })();
    drop(file);

    if let Err(error) = preparation {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }

    let replacement = (|| -> Result<(), SaveError> {
        // Recheck after the potentially slow write so a concurrent external edit
        // is not silently overwritten at the final rename boundary.
        ensure_expected_state(target, expected_fingerprint)?;
        hook(SaveStage::BeforeReplace)?;
        replace_file(&temporary, target)?;
        hook(SaveStage::AfterReplace)?;
        sync_parent_directory(target)?;
        Ok(())
    })();

    if let Err(error) = replacement {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }

    let (saved_bytes, saved_fingerprint) = read_document(target)?;
    if saved_bytes != bytes {
        return Err(SaveError::Io(io::Error::other("保存后校验失败")));
    }

    Ok(saved_fingerprint)
}

#[cfg(test)]
mod tests {
    use super::{atomic_save, atomic_save_with_hook, read_document, SaveError, SaveStage};
    use std::{fs, io, path::PathBuf, time::SystemTime};

    fn test_directory(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("mdeditor-{name}-{}-{unique}", std::process::id()))
    }

    #[test]
    fn saves_and_returns_a_new_fingerprint() {
        let directory = test_directory("save");
        fs::create_dir_all(&directory).expect("create test directory");
        let target = directory.join("note.md");

        let fingerprint = atomic_save(&target, b"first\n", None).expect("initial save");
        let next = atomic_save(&target, b"second\n", Some(&fingerprint)).expect("second save");

        assert_ne!(fingerprint, next);
        assert_eq!(fs::read(&target).expect("read target"), b"second\n");
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn refuses_to_overwrite_external_changes() {
        let directory = test_directory("conflict");
        fs::create_dir_all(&directory).expect("create test directory");
        let target = directory.join("note.md");
        fs::write(&target, b"original").expect("seed target");
        let (_, fingerprint) = read_document(&target).expect("fingerprint target");
        fs::write(&target, b"external").expect("write external change");

        let error = atomic_save(&target, b"editor", Some(&fingerprint))
            .expect_err("save must detect the conflict");

        assert!(matches!(error, SaveError::Conflict));
        assert_eq!(fs::read(&target).expect("read target"), b"external");
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn injected_failures_never_leave_partial_target_content() {
        let stages = [
            SaveStage::TemporaryCreated,
            SaveStage::DataWritten,
            SaveStage::DataSynced,
            SaveStage::BeforeReplace,
            SaveStage::AfterReplace,
        ];

        for stage in stages {
            let directory = test_directory(&format!("fault-{stage:?}"));
            fs::create_dir_all(&directory).expect("create test directory");
            let target = directory.join("note.md");
            fs::write(&target, b"original-content\n").expect("seed target");
            let (_, fingerprint) = read_document(&target).expect("fingerprint target");

            let error = atomic_save_with_hook(
                &target,
                b"complete-new-content\n",
                Some(&fingerprint),
                |current| {
                    if current == stage {
                        Err(io::Error::other("injected failure"))
                    } else {
                        Ok(())
                    }
                },
            )
            .expect_err("injected save must fail");

            assert!(matches!(error, SaveError::Io(_)));
            let target_bytes = fs::read(&target).expect("read target after failure");
            if stage == SaveStage::AfterReplace {
                assert_eq!(target_bytes, b"complete-new-content\n");
            } else {
                assert_eq!(target_bytes, b"original-content\n");
            }

            let leftovers = fs::read_dir(&directory)
                .expect("read test directory")
                .filter_map(Result::ok)
                .filter(|entry| entry.path() != target)
                .count();
            assert_eq!(leftovers, 0, "temporary file leaked at {stage:?}");
            fs::remove_dir_all(directory).expect("remove test directory");
        }
    }
}
