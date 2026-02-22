import {execa} from 'execa'
import {readFile, access} from 'node:fs/promises'
import {extname, join} from 'node:path'
import type {ReviewConfig} from '../core/session-store.js'

export type {ReviewConfig}

export type ReviewResult = {
  file: string
  linter: string
  output: string
}

const PER_FILE_LINTERS: Record<string, string> = {
  '.py': 'ruff check --no-fix',
  '.js': 'npx eslint',
  '.ts': 'npx eslint',
  '.jsx': 'npx eslint',
  '.tsx': 'npx eslint',
}

const ESLINT_CONFIG_PATTERNS = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  '.eslintrc.json',
  '.eslintrc.js',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  '.eslintrc',
]

const RUFF_CONFIG_PATTERNS = [
  'ruff.toml',
  '.ruff.toml',
]

function resolveShell(): string | true {
  if (process.env.SHELL?.trim()) return process.env.SHELL
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe'
  return true
}

async function fileExistsQuiet(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

type DetectedLint = {
  command: string
  linter: string
  perFile: boolean
}

const detectionCache = new Map<string, DetectedLint | null>()

/**
 * Auto-detect lint infrastructure in the workspace.
 *
 * Priority:
 * 1. package.json scripts.lint  (project-level, e.g. "tsc --noEmit")
 * 2. eslint config file exists  (per-file "npx eslint <file>")
 * 3. ruff/pyproject.toml exists (per-file "ruff check <file>")
 */
async function detectLintSetup(workspace: string): Promise<DetectedLint | null> {
  if (detectionCache.has(workspace)) return detectionCache.get(workspace)!

  // 1. Check package.json scripts.lint
  try {
    const pkgPath = join(workspace, 'package.json')
    const raw = await readFile(pkgPath, 'utf8')
    const pkg = JSON.parse(raw) as {scripts?: Record<string, string>}
    if (pkg.scripts?.lint) {
      const result: DetectedLint = {
        command: 'npm run lint',
        linter: pkg.scripts.lint.split(/\s+/)[0],
        perFile: false,
      }
      detectionCache.set(workspace, result)
      return result
    }
  } catch { /* no package.json or invalid */ }

  // 2. Check eslint config
  for (const pattern of ESLINT_CONFIG_PATTERNS) {
    if (await fileExistsQuiet(join(workspace, pattern))) {
      const result: DetectedLint = {command: 'npx eslint', linter: 'eslint', perFile: true}
      detectionCache.set(workspace, result)
      return result
    }
  }

  // 3. Check ruff / pyproject.toml
  for (const pattern of [...RUFF_CONFIG_PATTERNS, 'pyproject.toml']) {
    if (await fileExistsQuiet(join(workspace, pattern))) {
      const result: DetectedLint = {command: 'ruff check --no-fix', linter: 'ruff', perFile: true}
      detectionCache.set(workspace, result)
      return result
    }
  }

  detectionCache.set(workspace, null)
  return null
}

function linterForFile(file: string, tools?: Record<string, string>): string | undefined {
  const ext = extname(file).toLowerCase()
  if (tools?.[ext]) return tools[ext]
  return PER_FILE_LINTERS[ext]
}

async function runJsSyntaxCheck(filePath: string, workspace: string): Promise<ReviewResult | null> {
  const ext = extname(filePath).toLowerCase()
  if (!['.js', '.mjs', '.cjs'].includes(ext)) return null

  try {
    const {stdout, stderr, exitCode} = await execa('node', ['--check', filePath], {
      cwd: workspace,
      reject: false,
    })
    if (exitCode === 0) return null
    const output = [stdout, stderr].filter(Boolean).join('\n').trim()
    return {
      file: filePath,
      linter: 'node_syntax',
      output: output || 'node --check failed'
    }
  } catch {
    return null
  }
}

/**
 * Run lint on `filePath` asynchronously.
 *
 * Resolution order:
 * 1. User-configured per-extension tool (config.tools)
 * 2. Auto-detected project lint (package.json scripts.lint, config files)
 * 3. Built-in per-file linter defaults
 *
 * Returns `null` when the file passes (or no linter applies / binary missing).
 * Returns a `ReviewResult` only on lint failure.
 */
export async function runCodeReview(
  filePath: string,
  workspace: string,
  config?: ReviewConfig
): Promise<ReviewResult | null> {
  if (config && !config.enabled) return null

  // Always run lightweight syntax checks first to avoid false "pass" when lint infra is missing.
  const jsSyntaxFail = await runJsSyntaxCheck(filePath, workspace)
  if (jsSyntaxFail) return jsSyntaxFail

  // 1. User-configured per-extension override
  const ext = extname(filePath).toLowerCase()
  const userTool = config?.tools?.[ext]
  if (userTool) {
    return runLintCommand(`${userTool} ${filePath}`, filePath, userTool.split(/\s+/)[0], workspace)
  }

  // 2. Auto-detect project lint setup
  const detected = await detectLintSetup(workspace)
  if (detected) {
    const fullCommand = detected.perFile ? `${detected.command} ${filePath}` : detected.command
    return runLintCommand(fullCommand, filePath, detected.linter, workspace)
  }

  // 3. Built-in per-file defaults
  const defaultCmd = linterForFile(filePath)
  if (defaultCmd) {
    return runLintCommand(`${defaultCmd} ${filePath}`, filePath, defaultCmd.split(/\s+/)[0], workspace)
  }

  return null
}

async function runLintCommand(
  fullCommand: string,
  filePath: string,
  linter: string,
  workspace: string,
): Promise<ReviewResult | null> {
  try {
    const {stdout, stderr, exitCode} = await execa(fullCommand, {
      cwd: workspace,
      reject: false,
      shell: resolveShell(),
    })

    if (exitCode === 0) return null

    const output = [stdout, stderr].filter(Boolean).join('\n').trim()
    if (!output) return null

    return {file: filePath, linter, output}
  } catch {
    return null
  }
}

/** Exported for testing. */
export function clearDetectionCache(): void {
  detectionCache.clear()
}
