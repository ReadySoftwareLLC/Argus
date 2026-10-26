# Vendoring with `argus sync`

A consuming repo carries its own copy of `argus/` so sessions work offline and a change upstream never lands unreviewed. `argus.lock` records exactly what was copied.

## Commands
| Command | Effect |
| --- | --- |
| `argus sync --from <git url or checkout> [--ref <tag, branch or sha>]` | First sync, or move to another version. Run from the consuming repo root |
| `argus sync` | Update from the source recorded in `argus.lock` |
| `argus sync --dry-run` | Change nothing. Exit 1 when an update is pending or a conflict exists. Use in CI to catch a stale copy |
| `argus sync --verify` | Offline. Compare the vendored files with `argus.lock`. Exit 1 when any file was edited or is missing |
| `argus sync --force` | Overwrite locally edited files and delete edited files removed upstream |

Options: `--dest <dir>` (default `argus`), `--lock <file>` (default `argus.lock`), `--base <dir>` (default the current directory). Sync never reads `argus.config.json`, so it works before the config exists.

## Rules
- A file is updated only if it still matches the lock. A file edited since the last sync is a **conflict**: it is left alone, listed, and the command exits 1. The lock keeps its old hash, so the next sync reports it again.
- Files removed upstream are deleted when untouched, and kept (as an `orphan`) when edited.
- Files you add next to vendored ones are never touched.
- Without an `argus.lock`, any file that differs from the source is a conflict. Sync does not guess whether it was edited.
- `commit` in the lock is read from git, or `null` when the source is not a git checkout. It is never filled in by guess. `version` comes from `argus/VERSION`.
- Symlinks are skipped.

## Customize without editing
Put overrides in the `template_dir` named in `argus.config.json`. Repo facts and policies belong in the config, not in vendored files.

## Notes
- Prefer a git URL as the source. A local path is recorded as given and differs per machine.
- `--ref` accepts a tag, branch or commit sha. Pin a tag for repeatable syncs.
