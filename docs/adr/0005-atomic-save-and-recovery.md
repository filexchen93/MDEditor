# 0005: Atomic save and recovery

- Status: Accepted
- Date: 2026-08-23

## Context

Directly truncating a target before writing can destroy a document on process termination, permission changes, full disks or hardware failure. External edits must not be overwritten silently.

## Decision

Before saving, compare a disk fingerprint. Write complete encoded bytes to a uniquely named temporary file in the target directory, flush it, preserve permissions where possible, then use the platform's atomic replacement primitive. Update the saved revision and fingerprint only after success. Recovery snapshots use the same discipline in the application-data directory and target at most two seconds of recent input loss.

Recovery format version 2 stores the ordered set of dirty workspace documents
and the active document ID in one atomic payload. Version 1 single-document
snapshots are migrated during parsing. Restored documents always receive new
untitled IDs and lose native path authorization, so each must pass through an
explicit Save As dialog before it can write to disk.

## Alternatives considered

- Truncate and write in place: rejected because interruption can leave an empty or partial file.
- Periodic direct autosave to the user file: rejected because it overwrites external edits and blurs explicit save state.
- Recovery files beside documents: rejected because it pollutes user directories and may leak content.

## Consequences

Native adapters need platform-specific replacement behavior and fault-injection tests. Cross-device moves are not part of save; Save As must create its temporary file beside the destination.

## Review conditions

Review if a target filesystem cannot provide the assumed replacement semantics or durability tests show a gap between flush and replacement.
