import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const execFileAsync = promisify(execFile)

// ── WSL2 host detection ───────────────────────────────────────────────────────

/**
 * Detects the Windows host IP from WSL2.
 * In WSL2 the host is reachable at the default gateway (from `ip route`),
 * NOT at the DNS nameserver in /etc/resolv.conf.
 * Returns null if not running in WSL2 or detection fails.
 */
export function getWsl2HostIp(): string | null {
  try {
    if (!existsSync('/proc/version')) return null
    const version = readFileSync('/proc/version', 'utf-8')
    if (!version.toLowerCase().includes('microsoft')) return null

    // Parse default gateway from /proc/net/route (hex values)
    const route = readFileSync('/proc/net/route', 'utf-8')
    for (const line of route.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols[1] === '00000000' && cols[7] === '00000000') {
        // Default route — gateway is col[2] in little-endian hex
        const hex = cols[2]
        if (!hex || hex.length !== 8) continue
        const ip = [
          parseInt(hex.slice(6, 8), 16),
          parseInt(hex.slice(4, 6), 16),
          parseInt(hex.slice(2, 4), 16),
          parseInt(hex.slice(0, 2), 16),
        ].join('.')
        return ip
      }
    }
  } catch { /* ignore */ }
  return null
}

/**
 * Returns the default LM Studio URL, using the Windows host IP in WSL2
 * so the WSL2 process can reach the Windows-side LM Studio server.
 */
export function defaultLmStudioUrl(): string {
  if (process.env['LM_STUDIO_URL']) return process.env['LM_STUDIO_URL']
  const hostIp = getWsl2HostIp()
  return hostIp ? `http://${hostIp}:1234/v1` : 'http://localhost:1234/v1'
}

// ── lms CLI discovery ─────────────────────────────────────────────────────────

export function findLmsCli(): string | null {
  // User-specified override
  if (process.env['LMS_PATH'] && existsSync(process.env['LMS_PATH'])) {
    return process.env['LMS_PATH']
  }
  // Linux native
  const linuxPath = join(homedir(), '.lmstudio', 'bin', 'lms')
  if (existsSync(linuxPath)) return linuxPath

  // WSL2: scan /mnt/c/Users/<user>/.lmstudio/bin/lms.exe
  const usersDir = '/mnt/c/Users'
  if (existsSync(usersDir)) {
    try {
      for (const user of readdirSync(usersDir)) {
        const p = join(usersDir, user, '.lmstudio', 'bin', 'lms.exe')
        if (existsSync(p)) return p
      }
    } catch { /* ignore */ }
  }
  return null
}

// ── Server helpers ────────────────────────────────────────────────────────────

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

function modelMatches(loaded: string[], model: string): boolean {
  return loaded.some(id => id === model || id.includes(model) || model.includes(id))
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Ensures LM Studio server is running and the requested model is loaded.
 * Yields status strings for display; call at TUI startup or before first query.
 * Returns true if ready, false on unrecoverable failure.
 */
export async function* ensureLmStudio(
  model: string,
  localUrl: string,
): AsyncGenerator<string, boolean> {
  const lms = findLmsCli()

  // 1. Server already up?
  if (await isServerReachable(localUrl)) {
    const loaded = await getLoadedModels(localUrl)
    if (modelMatches(loaded, model)) return true

    // Server up, model not loaded
    if (!lms) {
      yield `LM Studio is running but "${model}" is not loaded.\nLoad it manually in LM Studio, or set LMS_PATH to enable auto-load.`
      return false
    }
    yield `Loading "${model}"…`
    await runLms(lms, ['load', model, '--identifier', model, '--gpu', 'max', '-y'])
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000))
      if (modelMatches(await getLoadedModels(localUrl), model)) {
        yield `"${model}" loaded and ready.`
        return true
      }
    }
    yield `Timed out waiting for "${model}" to load.`
    return false
  }

  // 2. Server not running — start it
  if (!lms) {
    yield `LM Studio server not running at ${localUrl}.\n\nFix: Open LM Studio → Local Server → Start Server (port 1234)\nOr set LMS_PATH to enable auto-start.`
    return false
  }

  yield 'Starting LM Studio server…'
  // --bind 0.0.0.0 makes it reachable from WSL2
  execFile(lms, ['server', 'start', '--bind', '0.0.0.0'], { timeout: 15_000 }, () => {})

  // Wait up to 15s for server
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000))
    if (await isServerReachable(localUrl)) break
  }
  if (!await isServerReachable(localUrl)) {
    yield 'LM Studio server failed to start. Try starting it manually.'
    return false
  }
  yield 'LM Studio server started.'

  // 3. Load model
  const loaded = await getLoadedModels(localUrl)
  if (modelMatches(loaded, model)) return true

  yield `Loading "${model}"…`
  await runLms(lms, ['load', model, '--identifier', model, '--gpu', 'max', '-y'])
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000))
    if (modelMatches(await getLoadedModels(localUrl), model)) {
      yield `"${model}" ready.`
      return true
    }
  }
  yield `Timed out waiting for "${model}". It may still be loading — try again in a moment.`
  return false
}
