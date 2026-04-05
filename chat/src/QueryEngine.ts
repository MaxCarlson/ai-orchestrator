import { queryLoop } from './query.js'
import { queryLoopOpenAI } from './backends/openai_compat.js'
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
import { homedir } from 'os'
import { join } from 'path'

export type EngineEvent =
  | StreamEvent
  | { type: 'command_output'; text: string }
  | { type: 'command_clear' }
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

  async initialize(): Promise<void> {
    const info = await detectProject(this.workingDir)
    if (info) {
      setProjectContext({ info })
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

    const loop = model.startsWith('claude-')
      ? queryLoop(this.messages, this.tools, { model, maxTurns, systemPrompt: systemPrompt + projectAddition, abortSignal, workingDir: this.workingDir })
      : queryLoopOpenAI(this.messages, this.tools, { model, maxTurns, systemPrompt: systemPrompt + projectAddition, abortSignal, workingDir: this.workingDir, localUrl })

    for await (const event of loop) {
      yield event
    }

    if (this.currentSessionId) {
      await this.sessionStore.appendMessages(this.currentSessionId, [userMsg])
      yield { type: 'session_saved', sessionId: this.currentSessionId }
    }
  }
}
