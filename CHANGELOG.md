# Changelog

## v0.3.0 - 2026-02-17

### Added
- In-process EventBus (`core/event-bus`) to decouple runtime execution from observability.
- `SessionLogSubscriber` to persist session events/messages/summaries into `~/.myclaw/sessions/<session-id>.jsonl`.
- `MetricsSubscriber` to persist runtime metrics into `~/.myclaw/metrics/<session-id>.jsonl`.
- Oscillation observation event (`oscillation_observe`) with repeat/novelty/no-mutation indicators.
- Engineering retrospective doc: `docs/RETROSPECTIVE_2026-02.md`.

### Changed
- Provider interface now supports native tool calling response shape (`text + toolCalls`).
- OpenAI provider now uses SDK-native tools API first, with text JSON parsing as fallback.
- Tool response compatibility improved for OpenAI-compatible gateways (tool `name` + `tool_call_id`).
- Empty model response handling improved with retry + safe fallback message.
- Runtime events are now emitted through bus subscribers instead of inline monitoring logic.
- System prompt refined to reduce repeated exploration and avoid tool usage for casual chat/greetings.

## v0.2.1 - 2026-02-16

### Changed
- Shell execution now selects runtime shell dynamically (`$SHELL`, Windows `ComSpec`, or system default) instead of hardcoding `zsh`.
- `run_shell` now includes `exit_code` even when command output is empty.

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
