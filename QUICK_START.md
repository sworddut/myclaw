# Quick Start

This guide helps you install and run `@sworddut/myclaw` in a few minutes.

## 1) Install

```bash
npm i -g @sworddut/myclaw
```

Check install:

```bash
myclaw --help
```

## 2) Initialize

Run once in any directory:

```bash
myclaw init
```

This creates global home files (default):

- `~/.myclaw/.env.example`
- `~/.myclaw/memory.md`

You can override home with:

```bash
export MYCLAW_HOME=/your/custom/path
```

## 3) Configure API

Create your env file:

```bash
cp ~/.myclaw/.env.example ~/.myclaw/.env
```

Edit `~/.myclaw/.env`:

```bash
OPENAI_API_KEY=your_api_key
OPENAI_MODEL=gpt-4o-mini
OPENAI_BASE_URL=https://api.openai.com/v1
```

If you use an OpenAI-compatible provider, set `OPENAI_BASE_URL` to that endpoint.

## 4) Run Your First Task

Single task mode:

```bash
myclaw run "Read the current project and summarize key files"
```

Interactive mode:

```bash
myclaw chat
```

Type `/exit` to quit chat.

## 5) Useful Flags

```bash
# show model raw responses
myclaw run --verboseModel "..."

# hide logs, print final answer only
myclaw run --quiet "..."

# disable sensitive-command interactive approval
myclaw run --nonInteractive "..."
```

## 6) Safety Behavior (Important)

- Existing files must be `read_file` before `write_file`/`apply_patch`.
- New file creation requires `write_file` with `allowCreate=true`.
- Destructive shell commands are treated as sensitive and require approval.
- At most one mutation tool call per model step.

## 7) Verify Effective Config

```bash
myclaw config
```

## 8) Troubleshooting

### `npm` install/publish permission errors (`EPERM`)

```bash
sudo chown -R $(id -u):$(id -g) ~/.npm
```

### Registry/proxy issues

```bash
npm config delete proxy
npm config delete https-proxy
npm config delete noproxy
```

### Command not found after global install

Verify npm global bin is in `PATH`.

## 9) Local Development (for contributors)

```bash
git clone https://github.com/sworddut/myclaw.git
cd myclaw
npm install
npm run build
npm test
node ./bin/run.js run "hello"
```
