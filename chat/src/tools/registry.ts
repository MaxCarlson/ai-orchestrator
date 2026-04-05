import type { Tool } from '../types/tool.js'

const toolMap = new Map<string, Tool>()

export function registerTool(tool: Tool): void {
  toolMap.set(tool.definition().name, tool)
}

export function findToolByName(name: string): Tool | undefined {
  return toolMap.get(name)
}

export function getAllTools(): Tool[] {
  return [...toolMap.values()]
}

export function getToolDefinitions() {
  return getAllTools().map(t => t.definition())
}
