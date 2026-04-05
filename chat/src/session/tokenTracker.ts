export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  turns: number
}

let _usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turns: 0 }

export function recordTokenUsage(input: number, output: number, cacheRead = 0): void {
  _usage = {
    inputTokens: _usage.inputTokens + input,
    outputTokens: _usage.outputTokens + output,
    cacheReadTokens: _usage.cacheReadTokens + cacheRead,
    turns: _usage.turns + 1,
  }
}

export function getTokenUsage(): TokenUsage { return { ..._usage } }

export function resetTokenUsage(): void {
  _usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turns: 0 }
}
