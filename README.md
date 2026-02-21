# myclaw

A CLI coding agent scaffold (TypeScript + oclif).

See `QUICK_START.md` for a 5-minute setup guide.

## Tech stack

- Node.js 20+
- TypeScript
- oclif
- execa (tool execution)
- cosmiconfig + dotenv (config)
- zod (schema)
- in-memory session store (v0.2.0 baseline)
- vitest (tests)

## Quick start

Install from npm:

```bash
npm i -g @sworddut/myclaw
myclaw init
# then fill credentials in ~/.myclaw/.env (or $MYCLAW_HOME/.env)
```

Run:

```bash
myclaw chat
# or
myclaw run "implement hello world"
```

## Local development

```bash
npm install
npm run build
node ./bin/run.js init -f
# then fill credentials in ~/.myclaw/.env (or $MYCLAW_HOME/.env)
```

`OPENAI_BASE_URL` and `.myclawrc.json` `baseURL` both support OpenAI-compatible providers.
Model priority: `OPENAI_MODEL` > `.myclawrc.json` `model` > `gpt-4o-mini`.
Runtime priority: env vars > `.myclawrc.json` `runtime` > defaults.

## Global Home Directory

- Default home: `~/.myclaw`
- Override with env: `MYCLAW_HOME=/custom/path`
- Global env file: `~/.myclaw/.env`
- Memory file: `~/.myclaw/memory.md`
- User profile memory: `~/.myclaw/user-profile.json`
  - Stores one stable cross-session profile and updates only on high-value signals.
- Session logs: `~/.myclaw/sessions/<session-id>.jsonl`
- Metrics logs: `~/.myclaw/metrics/<session-id>.jsonl`

Example `.myclawrc.json` runtime block:

```json
{
  "runtime": {
    "modelTimeoutMs": 45000,
    "modelRetryCount": 1,
    "maxSteps": 8,
    "contextWindowSize": 20,
    "checks": {
      "eslint": {
        "enabled": true
      }
    }
  }
}
```

You can also disable async ESLint soft-gate by env:

```bash
MYCLAW_ESLINT_CHECK_ENABLED=false
```

Create your global env:

```bash
cp ~/.myclaw/.env.example ~/.myclaw/.env
# edit ~/.myclaw/.env
```

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

# Show per-event timing debug data
node ./bin/run.js run --debug "implement hello world"

# Disable interactive approval prompts (sensitive commands auto-denied)
node ./bin/run.js run --nonInteractive "implement hello world"

# Interactive chat mode
node ./bin/run.js chat

# Resume latest session for current workspace
node ./bin/run.js chat --resume latest

# Runtime diagnostics
node ./bin/run.js doctor
node ./bin/run.js doctor --json

# Init local config files
node ./bin/run.js init
```

## Message Model

- Roles: `system`, `user`, `assistant`, `tool`
- Runtime: event-loop turn processing with tool execution feedback
- Context policy: system prompt + sliding window of recent 20 messages

Chat slash commands:
- `/help`
- `/exit` / `/quit`
- `/clear`
- `/history [n]`
- `/config`
- `/sessions [n]`
- `/use <id|index|latest>`

File mutation safety rules:
- Existing files must be `read_file` before `write_file`/`apply_patch`.
- New file creation is blocked by default. Use `write_file` with `allowCreate=true` only when explicitly needed.
- Destructive shell commands (for example `rm`, `rmdir`, `unlink`, `del`, `git reset --hard`, `git clean`) are treated as sensitive.
- Sensitive shell commands require interactive approval (`WAITING FOR USER INPUT`), otherwise they are denied.
- File discovery is supported with `search_workspace` before `read_file`.
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

## Roadmap

Current strategy: **feature first, optimization after baseline capability is complete**.

### High Priority (current)

- Done: one-step async code review/check pipeline (soft-gate).
  - `write_completed` event triggers background checks.
  - JS syntax check: `node --check`
  - Python syntax check: `python3 -m py_compile`
  - Optional ESLint check (enabled only when `eslint.config.*` exists).
  - Failed checks are injected as `tool_result` to drive model self-fix.
- Done: cross-session stable user profile memory.
  - Stored at `~/.myclaw/user-profile.json` as one stable profile (continuous update).
  - Injected into system context as concise preference/environment hints.
  - Updated only on high-value signals (not every turn).
- Next in high priority:
  - Add error fingerprint dedupe + max-injection cap for soft-gate.
  - Add explicit user controls (`/profile show|set|unset|reset`).

### Medium Priority

- Add MCP support for external tool ecosystems.
- Add skill support for reusable task workflows and domain capabilities.

### Long-term

- Add SQL-backed persistence for sessions/memory indexing and replay analytics.
- Upgrade oscillation governance from observation to active intervention policies.

## Release Automation

GitHub Actions workflows are included:
- `.github/workflows/ci.yml`: build + test on push/PR
- `.github/workflows/release.yml`: publish npm + create GitHub Release on `v*` tags

Required repository secret:
- `NPM_TOKEN`: npm granular access token with publish permission for `@sworddut/myclaw`

Release command sequence:

```bash
npm version patch
git push origin main --follow-tags
```
