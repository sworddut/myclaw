# Changelog

## v0.1.1 - 2026-02-16

### Added
- Global home directory support (`~/.myclaw` or `$MYCLAW_HOME`).
- Global environment loading from `~/.myclaw/.env` before local `.env`.
- Memory path defaults (`~/.myclaw/memory.md`) exposed in config.
- Interactive approval prompt for sensitive shell commands (`WAITING FOR USER INPUT`).

### Changed
- `init` now creates global home assets: `.env.example` and `memory.md`.
- Sensitive prompt styling updated with red warning markers.

## v0.1.0-alpha - 2026-02-16

### Added
- Initial CLI scaffold with `init`, `config`, `run`, and `chat` (scaffold).
- OpenAI-compatible provider integration via official `openai` SDK.
- Config support for `OPENAI_API_KEY`, `OPENAI_MODEL`, and `OPENAI_BASE_URL`.
- Tool execution loop with `read_file`, `write_file`, `apply_patch`, `list_files`, and `run_shell`.
- Runtime event logs for model/tool flow in `run` command.
- Multi-file debug sample scenario under `task/multi_debug`.

### Safety Rules
- Existing files must be read before mutation (`write_file` / `apply_patch`).
- New file creation is blocked by default; `allowCreate=true` is required.
- Only one mutation tool call is allowed per response.
- Multiple reads are allowed per response.

### Notes
- This is an alpha release for experimentation and learning workflows.
- Behavior can still vary by model/provider quality and endpoint stability.
