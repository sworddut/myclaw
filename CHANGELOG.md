# Changelog

## v0.2.0 - 2026-02-16

### Added
- Event-loop runtime with explicit message roles: `system/user/assistant/tool`.
- In-memory session store with turn-based APIs (`createAgentSession`, `runAgentTurn`, `closeAgentSession`).
- Interactive `chat` command backed by the same runtime loop.
- Sliding-context strategy: system prompt + latest 20 messages per model request.

### Changed
- Removed SQLite-native dependency path for now; session state is memory-held.
- Tool results now flow back as `tool` role messages in runtime state.
- Kept sensitive shell approvals and existing mutation safety rules.

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
