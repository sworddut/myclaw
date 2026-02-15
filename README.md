# myclaw

A CLI coding agent scaffold (TypeScript + oclif).

## Tech stack

- Node.js 20+
- TypeScript
- oclif
- execa (tool execution)
- cosmiconfig + dotenv (config)
- zod (schema)
- better-sqlite3 (storage, reserved for next step)
- vitest (tests)

## Quick start

```bash
npm install
npm run build
cp .env.example .env
# fill OPENAI_API_KEY in .env
# optional: set model in env
# OPENAI_MODEL=gpt-4o-mini
# optional: for openai-compatible third-party endpoint
# OPENAI_BASE_URL=https://your-endpoint/v1
node ./bin/run.js init -f
```

`OPENAI_BASE_URL` and `.myclawrc.json` `baseURL` both support OpenAI-compatible providers.
Model priority: `.myclawrc.json` `model` > `OPENAI_MODEL` > `gpt-4o-mini`.

## Commands

```bash
# Show resolved config
node ./bin/run.js config

# One-shot task
node ./bin/run.js run "implement hello world"

# Hide step logs and print only final answer
node ./bin/run.js run --quiet "implement hello world"

# Show raw model responses for each step (debug)
node ./bin/run.js run --verboseModel "implement hello world"

# Disable interactive approval prompts (sensitive commands auto-denied)
node ./bin/run.js run --nonInteractive "implement hello world"

# Init local config files
node ./bin/run.js init

# Scaffolded chat mode
node ./bin/run.js chat
```

File mutation safety rules:
- Existing files must be `read_file` before `write_file`/`apply_patch`.
- New file creation is blocked by default. Use `write_file` with `allowCreate=true` only when explicitly needed.
- Destructive shell commands (for example `rm`, `rmdir`, `unlink`, `del`, `git reset --hard`, `git clean`) are treated as sensitive.
- Sensitive shell commands require interactive approval (`WAITING FOR USER INPUT`), otherwise they are denied.
- Multiple reads are allowed in one step.
- Only one mutation (`write_file` or `apply_patch`) is allowed per step.

## Project structure

```txt
bin/                # CLI entrypoints (prod/dev)
src/commands/       # CLI commands
src/core/           # agent orchestration
src/providers/      # LLM provider abstraction
src/tools/          # executable tools
src/config/         # config loader + schema
test/               # tests
```

## Known Limitations (v0.1-alpha)

- Tool-calling protocol is JSON-in-text parsing, not native function-calling.
- No persistent conversation/session memory yet.
- No git-aware safety flow (branching, checkpoint, rollback) yet.
- Network/API retries and timeout policies are still basic.
- Permission model is coarse-grained; no per-tool policy profile yet.

## TODO

- Add interactive `chat` mode with persistent SQLite session history.
- Add per-step command timeout/retry/backoff controls in config.
- Add git checkpoint + rollback command before mutation steps.
- Add path allowlist/denylist policy with per-tool enforcement.
- Add native tool/function-calling mode when provider supports it.
- Add E2E regression tests for multi-file debug scenarios.
