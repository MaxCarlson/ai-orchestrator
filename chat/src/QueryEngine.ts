import { queryLoop } from './query.js'
import { getConfig } from './commands/config.js'
import { parseSlashCommand, CommandRegistry } from './commands/index.js'
import { HelpCommand } from './commands/help.js'
import { ClearCommand } from './commands/clear.js'
import { ConfigCommand } from './commands/config.js'
import { SessionCommand } from './commands/session.js'
import { MemoryCommand } from './commands/memory.js'
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
  }

  async* submit(input: string, abortSignal: AbortSignal): AsyncGenerator<EngineEvent> {
    const parsed = parseSlashCommand(input)

    if (parsed) {
      let compactRequested = false
      const result = await this.commandRegistry.dispatch(parsed.name, parsed.args, {
        clearMessages: () => { this.messages = [] },
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

    for await (const event of queryLoop(this.messages, this.tools, {
      model: cfg.model,
      maxTurns: cfg.maxTurns,
      systemPrompt: cfg.systemPrompt,
      abortSignal,
      workingDir: this.workingDir,
    })) {
      yield event
    }

    if (this.currentSessionId) {
      await this.sessionStore.appendMessages(this.currentSessionId, [userMsg])
      yield { type: 'session_saved', sessionId: this.currentSessionId }
    }
  }
}
