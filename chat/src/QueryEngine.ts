import { spawnSync } from 'child_process'
import { queryLoop } from './query.js'
import { queryLoopOpenAI } from './backends/openai_compat.js'
import { ensureLmStudio } from './backends/lmstudio.js'
import { getConfig } from './commands/config.js'
import { detectProject } from './project/detector.js'
import { setProjectContext, buildProjectSystemPromptAddition } from './project/context.js'
import { parseSlashCommand, CommandRegistry } from './commands/index.js'
import { HelpCommand } from './commands/help.js'
import { ClearCommand } from './commands/clear.js'
import { ConfigCommand } from './commands/config.js'
import { SessionCommand } from './commands/session.js'
import { MemoryCommand } from './commands/memory.js'
import { ModelCommand } from './commands/model.js'
import { ContextCommand } from './commands/context_cmd.js'
import { CostCommand } from './commands/cost.js'
import { CompactCommand } from './commands/compact.js'
import { ProjectCommand } from './commands/project_cmd.js'
import { EmbeddingsCommand } from './commands/embeddings.js'
import { ToolsCommand } from './commands/tools_cmd.js'
import { resetTokenUsage } from './session/tokenTracker.js'
import { SessionStore } from './session/store.js'
import { BashTool } from './tools/BashTool.js'
import { FileReadTool } from './tools/FileReadTool.js'
import { FileEditTool } from './tools/FileEditTool.js'
import { GlobTool } from './tools/GlobTool.js'
import { GrepTool } from './tools/GrepTool.js'
import { WebFetchTool } from './tools/WebFetchTool.js'
import type { Message, StreamEvent } from './types/message.js'
import type { Tool } from './types/tool.js'
import { homedir, platform } from 'os'
import { join } from 'path'

function buildEnvBlock(workingDir: string, model: string): string {
  const date = new Date().toISOString().split('T')[0]
  const shell = process.env['SHELL'] ?? 'unknown'
  const os = platform()

  let gitBranch = ''
  let gitStatus = ''
  try {
    const branchResult = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workingDir, encoding: 'utf8' })
    if (branchResult.status === 0) gitBranch = branchResult.stdout.trim()

    const statusResult = spawnSync('git', ['status', '--short'], { cwd: workingDir, encoding: 'utf8' })
    if (statusResult.status === 0) {
      const lines = statusResult.stdout.trim().split('\n').filter(Boolean)
      gitStatus = lines.slice(0, 20).join('\n') + (lines.length > 20 ? `\n... (${lines.length - 20} more)` : '')
    }
  } catch { /* not a git repo or git not installed */ }

  const lines = [
    '\n\n## Environment',
    `Working directory: ${workingDir}`,
    `Platform: ${os}`,
    `Shell: ${shell}`,
    `Model: ${model}`,
    `Date: ${date}`,
  ]
  if (gitBranch) lines.push(`Git branch: ${gitBranch}`)
  if (gitStatus) lines.push(`Git status:\n${gitStatus}`)

  return lines.join('\n')
}

export type EngineEvent =
  | StreamEvent
  | { type: 'command_output'; text: string }
  | { type: 'command_clear' }
  | { type: 'status'; text: string }       // transient info (LM Studio startup, etc.)
  | { type: 'session_saved'; sessionId: string }

export class QueryEngine {
  private messages: Message[] = []
  private readonly tools: Tool[]
  private readonly commandRegistry: CommandRegistry
  private readonly sessionStore: SessionStore
  private currentSessionId: string | null = null
  readonly workingDir: string

  constructor(workingDir = process.cwd()) {
    this.workingDir = workingDir
    this.tools = [
      new BashTool(),
      new FileReadTool(),
      new FileEditTool(),
      new GlobTool(),
      new GrepTool(),
      new WebFetchTool(),
    ]
    this.commandRegistry = new CommandRegistry()
    this.sessionStore = new SessionStore(join(homedir(), '.ai-orchestrator', 'sessions'))
    this._registerCommands()
  }

  private _registerCommands(): void {
    this.commandRegistry.register(new HelpCommand(this.commandRegistry))
    this.commandRegistry.register(new ClearCommand())
    this.commandRegistry.register(new ConfigCommand())
    this.commandRegistry.register(new SessionCommand())
    this.commandRegistry.register(new MemoryCommand())
    this.commandRegistry.register(new ModelCommand())
    this.commandRegistry.register(new ContextCommand())
    this.commandRegistry.register(new CostCommand())
    this.commandRegistry.register(new CompactCommand())
    this.commandRegistry.register(new ProjectCommand())
    this.commandRegistry.register(new EmbeddingsCommand())
    this.commandRegistry.register(new ToolsCommand())
  }

  async* initialize(): AsyncGenerator<EngineEvent> {
    const info = await detectProject(this.workingDir)
    if (info) {
      setProjectContext({ info })
    }

    // Auto-start LM Studio server and pre-load local model at startup
    const cfg = getConfig()
    if (!cfg.model.startsWith('claude-')) {
      for await (const status of ensureLmStudio(cfg.model, cfg.localUrl)) {
        yield { type: 'status', text: status }
      }
    }
  }

  async* submit(input: string, abortSignal: AbortSignal): AsyncGenerator<EngineEvent> {
    const parsed = parseSlashCommand(input)

    if (parsed) {
      let compactRequested = false
      const result = await this.commandRegistry.dispatch(parsed.name, parsed.args, {
        clearMessages: () => { this.messages = []; resetTokenUsage() },
        getMessages: () => this.messages,
        workingDir: this.workingDir,
        requestCompact: () => { compactRequested = true },
      })

      if (result.type === 'clear') {
        this.messages = []
        yield { type: 'command_clear' }
        return
      }

      if (result.type === 'output') {
        yield { type: 'command_output', text: result.text }
        return
      }

      return
    }

    // Regular message
    if (!this.currentSessionId) {
      this.currentSessionId = await this.sessionStore.create(input.slice(0, 60))
    }

    const userMsg: Message = { role: 'user', content: input }
    this.messages.push(userMsg)

    const cfg = getConfig()
    const { model, maxTurns, systemPrompt, localUrl } = cfg
    const projectAddition = buildProjectSystemPromptAddition()
    const envBlock = buildEnvBlock(this.workingDir, model)
    const fullSystemPrompt = systemPrompt + projectAddition + envBlock

    const isLocal = !model.startsWith('claude-')

    // Enable extended thinking for Anthropic models that support it (opus-4, sonnet-4+)
    const thinkingEnabled = !isLocal && /claude-(opus|sonnet)-[4-9]/.test(model)

    const loop = isLocal
      ? queryLoopOpenAI(this.messages, this.tools, { model, maxTurns, systemPrompt: fullSystemPrompt, abortSignal, workingDir: this.workingDir, localUrl })
      : queryLoop(this.messages, this.tools, { model, maxTurns, systemPrompt: fullSystemPrompt, abortSignal, workingDir: this.workingDir, thinkingEnabled })

    for await (const event of loop) {
      yield event
    }

    if (this.currentSessionId) {
      await this.sessionStore.appendMessages(this.currentSessionId, [userMsg])
      yield { type: 'session_saved', sessionId: this.currentSessionId }
    }
  }
}
