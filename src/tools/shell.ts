import {execa} from 'execa'
import {createWriteStream} from 'node:fs'
import {mkdir} from 'node:fs/promises'
import {dirname} from 'node:path'

function resolveShell(): string | true {
  if (process.env.SHELL?.trim()) return process.env.SHELL
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe'
  return true
}

export type RunShellResult = {
  exitCode: number
  stdout: string
  stderr: string
  aborted: boolean
  interactivePromptDetected?: boolean
  logPath?: string
}

type RunShellOptions = {
  signal?: AbortSignal
  logPath?: string
  onStreamChunk?: (stream: 'stdout' | 'stderr', chunk: string) => void
}

export async function runShell(
  command: string,
  cwd = process.cwd(),
  options: RunShellOptions = {}
): Promise<RunShellResult> {
  let logStream: ReturnType<typeof createWriteStream> | null = null
  let abortHandler: (() => void) | null = null
  let abortedByUser = false
  let interactivePromptDetected = false
  if (options.logPath) {
    await mkdir(dirname(options.logPath), {recursive: true})
    logStream = createWriteStream(options.logPath, {flags: 'w', encoding: 'utf8'})
  }

  try {
    if (options.signal?.aborted) {
      abortedByUser = true
      return {exitCode: 130, stdout: '', stderr: '', aborted: true, logPath: options.logPath}
    }

    const child = execa(command, {
      cwd,
      reject: false,
      shell: resolveShell(),
      cancelSignal: options.signal,
      detached: process.platform !== 'win32'
    })

    abortHandler = () => {
      abortedByUser = true
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      if (process.platform !== 'win32' && typeof child.pid === 'number') {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // ignore
        }
      }
    }
    options.signal?.addEventListener('abort', abortHandler, {once: true})

    const onStdout = (buf: Buffer | string) => {
      const chunk = String(buf)
      if (
        /Would you like to use React Compiler\?/i.test(chunk) ||
        /Would you like to use [^?]+\?/i.test(chunk)
      ) {
        interactivePromptDetected = true
        abortHandler?.()
      }
      options.onStreamChunk?.('stdout', chunk)
      logStream?.write(chunk)
    }
    const onStderr = (buf: Buffer | string) => {
      const chunk = String(buf)
      options.onStreamChunk?.('stderr', chunk)
      logStream?.write(chunk)
    }

    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)

    const {stdout, stderr, exitCode} = await child
    if (abortedByUser || interactivePromptDetected) {
      return {
        exitCode: 130,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        aborted: true,
        interactivePromptDetected,
        logPath: options.logPath
      }
    }
    return {exitCode: exitCode ?? 1, stdout: stdout ?? '', stderr: stderr ?? '', aborted: false, logPath: options.logPath}
  } catch (error) {
    const err = error as {isCanceled?: boolean; message?: string}
    if (err?.isCanceled || /abort|cancell?ed/i.test(err?.message ?? '')) {
      return {
        exitCode: 130,
        stdout: '',
        stderr: '',
        aborted: true,
        interactivePromptDetected,
        logPath: options.logPath
      }
    }
    throw error
  } finally {
    if (abortHandler) {
      options.signal?.removeEventListener('abort', abortHandler)
    }
    await new Promise<void>((resolve) => {
      if (!logStream) return resolve()
      logStream.end(() => resolve())
    })
  }
}
