import type { SlashCommand, CommandContext, CommandResult } from '../types/command.js'
import { getTokenUsage } from '../session/tokenTracker.js'

const INPUT_PRICE_PER_M = 3.0
const OUTPUT_PRICE_PER_M = 15.0
const CACHE_READ_PRICE_PER_M = 0.30

export class CostCommand implements SlashCommand {
  name = 'cost'
  description = 'Show estimated token usage and cost for this session'

  async execute(_args: string, _ctx: CommandContext): Promise<CommandResult> {
    const usage = getTokenUsage()
    const inputCost = (usage.inputTokens / 1_000_000) * INPUT_PRICE_PER_M
    const outputCost = (usage.outputTokens / 1_000_000) * OUTPUT_PRICE_PER_M
    const cacheCost = (usage.cacheReadTokens / 1_000_000) * CACHE_READ_PRICE_PER_M

    return {
      type: 'output',
      text: [
        '=== Token Usage ===',
        `  Input:      ${usage.inputTokens.toLocaleString()}`,
        `  Output:     ${usage.outputTokens.toLocaleString()}`,
        `  Cache read: ${usage.cacheReadTokens.toLocaleString()}`,
        `  Turns:      ${usage.turns}`,
        '',
        '=== Estimated Cost (claude-sonnet-4-6) ===',
        `  Input:      $${inputCost.toFixed(4)}`,
        `  Output:     $${outputCost.toFixed(4)}`,
        `  Cache:      $${cacheCost.toFixed(4)}`,
        `  Total:      $${(inputCost + outputCost + cacheCost).toFixed(4)}`,
      ].join('\n'),
    }
  }
}
