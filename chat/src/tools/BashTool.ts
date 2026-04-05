import { spawn } from 'child_process'
import type { Tool, ToolDefinition, ToolUseContext } from '../types/tool.js'

interface BashInput {
  command: string
}

interface BashToolOptions {
  timeoutMs?: number
}

// Commands starting with these prefixes are safe to run concurrently
const READONLY_PREFIXES = ['cat ', 'ls ', 'echo ', 'grep ', 'find ', 'head ', 'tail ', 'wc ', 'pwd', 'which ']

export class BashTool implements Tool {
  private readonly timeoutMs: number

  constructor(opts: BashToolOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  definition(): ToolDefinition {
    return {
      name: 'Bash',
      description: 'Execute a bash command and return the combined stdout/stderr output.',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to run' },
        },
        required: ['command'],
      },
    }
  }

  isConcurrencySafe(input: unknown): boolean {
    const { command } = input as BashInput
    return READONLY_PREFIXES.some(p => command.startsWith(p))
  }

  async execute(input: unknown, ctx: ToolUseContext): Promise<string> {
    const { command } = input as BashInput

    return new Promise((resolve) => {
      let output = ''
      let timedOut = false

      const child = spawn('bash', ['-c', command], {
        cwd: ctx.workingDir,
        env: process.env,
      })

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        resolve(`Command timed out after ${this.timeoutMs}ms`)
      }, this.timeoutMs)

      child.stdout.on('data', (d: Buffer) => { output += d.toString() })
      child.stderr.on('data', (d: Buffer) => { output += d.toString() })

      child.on('close', () => {
        if (!timedOut) {
          clearTimeout(timer)
          resolve(output || '(no output)')
        }
      })

      ctx.abortSignal.addEventListener('abort', () => {
        timedOut = true
        child.kill('SIGTERM')
        resolve('Command aborted')
      })
    })
  }
}
