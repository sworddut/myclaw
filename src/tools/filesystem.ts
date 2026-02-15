import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises'
import {dirname, resolve, sep} from 'node:path'
import {access, constants} from 'node:fs'

function assertInsideWorkspace(workspace: string, inputPath: string): string {
  const workspaceRoot = resolve(workspace)
  const fullPath = resolve(workspaceRoot, inputPath)
  const inWorkspace = fullPath === workspaceRoot || fullPath.startsWith(`${workspaceRoot}${sep}`)
  if (!inWorkspace) {
    throw new Error(`Path '${inputPath}' is outside workspace.`)
  }

  return fullPath
}

export function resolveWorkspacePath(workspace: string, path: string): string {
  return assertInsideWorkspace(workspace, path)
}

export async function fileExists(workspace: string, path: string): Promise<boolean> {
  const fullPath = assertInsideWorkspace(workspace, path)
  return new Promise((resolvePromise) => {
    access(fullPath, constants.F_OK, (error) => {
      resolvePromise(!error)
    })
  })
}

export async function readTextFile(workspace: string, path: string): Promise<string> {
  const fullPath = assertInsideWorkspace(workspace, path)
  return readFile(fullPath, 'utf8')
}

export async function writeTextFile(workspace: string, path: string, content: string): Promise<void> {
  const fullPath = assertInsideWorkspace(workspace, path)
  await mkdir(dirname(fullPath), {recursive: true})
  await writeFile(fullPath, content, 'utf8')
}

export async function listFiles(workspace: string, path = '.'): Promise<string[]> {
  const fullPath = assertInsideWorkspace(workspace, path)
  return readdir(fullPath)
}

export async function applyTextPatch(
  workspace: string,
  path: string,
  search: string,
  replace: string,
  replaceAll = false
): Promise<string> {
  if (!search) {
    throw new Error('apply_patch requires non-empty "search".')
  }

  const original = await readTextFile(workspace, path)
  if (!original.includes(search)) {
    throw new Error(`apply_patch could not find target text in ${path}.`)
  }

  const updated = replaceAll ? original.split(search).join(replace) : original.replace(search, replace)
  await writeTextFile(workspace, path, updated)
  return `Patched file: ${path}`
}
