import { appendFileSync } from 'fs'

/**
 * Structured debug logger. Writes a human-readable session log to a file.
 * All methods are no-ops when path is null (logging disabled).
 */
export class Logger {
  private readonly filePath: string | null
  private thinkBuf    = ''
  private thinkStartMs = 0

  constructor(filePath: string | null) {
    this.filePath = filePath
    if (filePath !== null) {
      this.write(`\n${'═'.repeat(72)}\n`)
      this.write(`Session: ${new Date().toISOString()}\n`)
      this.write(`${'═'.repeat(72)}\n\n`)
    }
  }

  get enabled(): boolean { return this.filePath !== null }

  private ts(): string {
    return new Date().toISOString().slice(11, 23)   // HH:MM:SS.mmm
  }

  private write(text: string): void {
    if (!this.filePath) return
    try { appendFileSync(this.filePath, text, 'utf8') } catch { /* ignore */ }
  }

  /** Full system prompt (sent once per request). */
  systemPrompt(model: string, workingDir: string, prompt: string): void {
    this.write(`[${this.ts()}] SYSTEM PROMPT  model=${model}  cwd=${workingDir}\n`)
    this.write('─'.repeat(72) + '\n')
    this.write(prompt + '\n')
    this.write('─'.repeat(72) + '\n\n')
  }

  /** User message text. */
  userMessage(content: string): void {
    this.write(`[${this.ts()}] USER ▶\n${content}\n\n`)
  }

  /** Begin accumulating thinking text. */
  onThinkingStart(): void {
    this.thinkBuf    = ''
    this.thinkStartMs = Date.now()
  }

  /** Accumulate a thinking delta. */
  onThinkingDelta(text: string): void {
    this.thinkBuf += text
  }

  /** Flush accumulated thinking to log. */
  onThinkingEnd(): void {
    if (!this.thinkBuf) return
    const elapsed = ((Date.now() - this.thinkStartMs) / 1000).toFixed(1)
    this.write(`[${this.ts()}] ⟳ THINKING  (${elapsed}s, ${this.thinkBuf.length} chars)\n`)
    this.write('┄'.repeat(72) + '\n')
    this.write(this.thinkBuf + '\n')
    this.write('┄'.repeat(72) + '\n\n')
    this.thinkBuf = ''
  }

  /** Log a tool call with its full input (after streaming is complete). */
  toolCall(id: string, name: string, inputJson: string): void {
    this.write(`[${this.ts()}] 🔧 TOOL CALL  name=${name}  id=${id.slice(0, 12)}\n`)
    try {
      this.write(JSON.stringify(JSON.parse(inputJson || '{}'), null, 2))
    } catch {
      this.write(inputJson || '{}')
    }
    this.write('\n\n')
  }

  /** Log the result of a tool call. */
  toolResult(id: string, name: string, result: string, isError: boolean): void {
    const status = isError ? 'ERROR' : 'OK'
    this.write(`[${this.ts()}] 🔧 TOOL RESULT  name=${name}  [${status}]\n`)
    const truncated = result.length > 4000
      ? result.slice(0, 4000) + '\n[... truncated]'
      : result
    this.write(truncated + '\n\n')
  }

  /** Final assistant text response. */
  assistantMessage(content: string): void {
    this.write(`[${this.ts()}] ASSISTANT ◀\n${content}\n\n`)
  }
}
