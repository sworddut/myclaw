import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('execa', () => ({
  execa: vi.fn(),
}))

import {execa} from 'execa'
import {runCodeReview, clearDetectionCache} from '../src/tools/code-review.js'

const execaMock = vi.mocked(execa)

describe('runCodeReview', () => {
  beforeEach(() => {
    execaMock.mockReset()
    clearDetectionCache()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns null when review is disabled', async () => {
    const result = await runCodeReview('app.py', '/workspace', {enabled: false})
    expect(result).toBeNull()
    expect(execaMock).not.toHaveBeenCalled()
  })

  it('returns null for unsupported file extensions with no project lint', async () => {
    const result = await runCodeReview('data.csv', '/nonexistent-workspace')
    expect(result).toBeNull()
  })

  it('uses custom tool from config when provided', async () => {
    execaMock.mockResolvedValue({stdout: '', stderr: '', exitCode: 0} as never)

    const result = await runCodeReview('lib.py', '/workspace', {
      enabled: true,
      tools: {'.py': 'mypy --strict'},
    })
    expect(result).toBeNull()
    expect(execaMock).toHaveBeenCalledWith(
      'mypy --strict lib.py',
      expect.objectContaining({cwd: '/workspace'}),
    )
  })

  it('returns ReviewResult on lint failure', async () => {
    execaMock.mockResolvedValue({
      stdout: 'app.py:1:1: E302 expected 2 blank lines',
      stderr: '',
      exitCode: 1,
    } as never)

    const result = await runCodeReview('app.py', '/workspace', {
      enabled: true,
      tools: {'.py': 'ruff check --no-fix'},
    })
    expect(result).not.toBeNull()
    expect(result!.file).toBe('app.py')
    expect(result!.linter).toBe('ruff')
    expect(result!.output).toContain('E302')
  })

  it('returns null when linter passes (exit 0)', async () => {
    execaMock.mockResolvedValue({stdout: '', stderr: '', exitCode: 0} as never)

    const result = await runCodeReview('app.ts', '/workspace', {
      enabled: true,
      tools: {'.ts': 'npx eslint'},
    })
    expect(result).toBeNull()
  })

  it('returns null when linter binary is not found', async () => {
    execaMock.mockRejectedValue(new Error('ENOENT'))

    const result = await runCodeReview('app.py', '/workspace', {
      enabled: true,
      tools: {'.py': 'ruff check --no-fix'},
    })
    expect(result).toBeNull()
  })

  it('returns null when exit code > 0 but output is empty', async () => {
    execaMock.mockResolvedValue({stdout: '', stderr: '', exitCode: 2} as never)

    const result = await runCodeReview('app.py', '/workspace', {
      enabled: true,
      tools: {'.py': 'ruff check --no-fix'},
    })
    expect(result).toBeNull()
  })

  it('auto-detects npm run lint from package.json in workspace', async () => {
    execaMock.mockResolvedValue({stdout: '', stderr: '', exitCode: 0} as never)

    const result = await runCodeReview('src/index.ts', process.cwd())
    expect(result).toBeNull()
    expect(execaMock).toHaveBeenCalledWith(
      'npm run lint',
      expect.objectContaining({cwd: process.cwd()}),
    )
  })

  it('auto-detected lint failure returns ReviewResult', async () => {
    execaMock.mockResolvedValue({
      stdout: 'src/bad.ts(3,1): error TS2304: Cannot find name "foo".',
      stderr: '',
      exitCode: 1,
    } as never)

    const result = await runCodeReview('src/bad.ts', process.cwd())
    expect(result).not.toBeNull()
    expect(result!.file).toBe('src/bad.ts')
    expect(result!.linter).toBe('tsc')
    expect(result!.output).toContain('TS2304')
  })
})
