import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const execFileAsync = promisify(execFile)

// Common locations for lms CLI on WSL2 (Windows-side) and native Linux
const LMS_CANDIDATES = [
  process.env['LMS_PATH'],                                              // user override
  join(homedir(), '.lmstudio', 'bin', 'lms'),                          // Linux native
  '/mnt/c/Users/' + (process.env['WINDOWS_USER'] ?? process.env['USER']) + '/.lmstudio/bin/lms.exe',
  // fallback: scan /mnt/c/Users/*/
]

export function findLmsCli(): string | null {
  for (const candidate of LMS_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate
  }
  // Try scanning Windows users dir for lms.exe
  try {
    const usersDir = '/mnt/c/Users'
    if (existsSync(usersDir)) {
      const { readdirSync } = require('fs') as typeof import('fs')
      for (const user of readdirSync(usersDir)) {
        const p = join(usersDir, user, '.lmstudio', 'bin', 'lms.exe')
        if (existsSync(p)) return p
      }
    }
  } catch { /* ignore */ }
  return null
}

async function runLms(lms: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(lms, args, { timeout: 30_000 }).catch(err => ({
    stdout: (err as { stdout?: string }).stdout ?? '',
    stderr: (err as { stderr?: string }).stderr ?? '',
  }))
}

/** Returns true if the LM Studio HTTP server is reachable. */
export async function isServerReachable(url: string): Promise<boolean> {
  return fetch(`${url}/models`, { signal: AbortSignal.timeout(2000) })
    .then(r => r.ok)
    .catch(() => false)
}

/** Returns the list of model identifiers currently loaded in LM Studio. */
export async function getLoadedModels(url: string): Promise<string[]> {
  try {
    const res = await fetch(`${url}/models`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return []
    const json = await res.json() as { data?: { id: string }[] }
    return (json.data ?? []).map(m => m.id)
  } catch {
    return []
  }
}

/**
 * Ensures LM Studio server is running and the requested model is loaded.
 * Yields status messages as strings for display in the TUI.
 * Returns true if ready, false if it failed.
 */
export async function* ensureLmStudio(
  model: string,
  localUrl: string,
): AsyncGenerator<string, boolean> {
  const lms = findLmsCli()

  // 1. Check if server is already up
  if (await isServerReachable(localUrl)) {
    // Server is up — check if model is loaded
    const loaded = await getLoadedModels(localUrl)
    if (loaded.some(id => id === model || id.includes(model))) {
      return true // already good
    }
    // Server up but model not loaded — load it
    if (!lms) {
      yield `LM Studio server is running but model "${model}" is not loaded.\nInstall lms CLI or load it manually in LM Studio.`
      return false
    }
    yield `Loading model "${model}"…`
    const { stderr } = await runLms(lms, ['load', model, '--identifier', model, '--gpu', 'max', '-y'])
    if (stderr && !stderr.includes('already loaded')) {
      yield `Load warning: ${stderr.trim()}`
    }
    // Wait up to 60s for model to appear
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000))
      const loaded2 = await getLoadedModels(localUrl)
      if (loaded2.some(id => id === model || id.includes(model))) {
        yield `Model "${model}" loaded.`
        return true
      }
    }
    yield `Timed out waiting for model "${model}" to load.`
    return false
  }

  // 2. Server not running — start it
  if (!lms) {
    yield `LM Studio server is not running at ${localUrl}.\n\nTo fix:\n  1. Open LM Studio (Windows app)\n  2. Load a model (e.g. "${model}")\n  3. Local Server → Start Server (port 1234)\n\nOr: add lms CLI to PATH / set LMS_PATH env var for auto-start.`
    return false
  }

  yield 'Starting LM Studio server…'
  // Start server in background (fire and forget — lms server start exits after starting)
  execFile(lms, ['server', 'start'], { timeout: 10_000 }, () => {})

  // Wait for server to become reachable (up to 15s)
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000))
    if (await isServerReachable(localUrl)) break
  }
  if (!await isServerReachable(localUrl)) {
    yield `LM Studio server did not start. Try starting it manually.`
    return false
  }
  yield 'LM Studio server started.'

  // 3. Load the model
  const loaded = await getLoadedModels(localUrl)
  if (loaded.some(id => id === model || id.includes(model))) {
    return true
  }

  yield `Loading model "${model}"…`
  const { stderr } = await runLms(lms, ['load', model, '--identifier', model, '--gpu', 'max', '-y'])
  if (stderr && !stderr.includes('already loaded')) {
    yield `Load warning: ${stderr.trim()}`
  }

  // Wait up to 60s for model to appear in /v1/models
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000))
    const loaded2 = await getLoadedModels(localUrl)
    if (loaded2.some(id => id === model || id.includes(model))) {
      yield `Model "${model}" ready.`
      return true
    }
  }

  yield `Timed out waiting for model "${model}". It may still be loading — try again in a moment.`
  return false
}
