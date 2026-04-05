import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Message } from '../types/message.js'

export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: Message[]
}

export class SessionStore {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
  }

  async create(title: string): Promise<string> {
    const id = randomUUID()
    const session: Session = {
      id,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    }
    writeFileSync(this.path(id), JSON.stringify(session, null, 2), 'utf-8')
    return id
  }

  async appendMessages(id: string, messages: Message[]): Promise<void> {
    const session = await this.load(id)
    if (!session) throw new Error(`Session not found: ${id}`)
    session.messages.push(...messages)
    session.updatedAt = Date.now()
    writeFileSync(this.path(id), JSON.stringify(session, null, 2), 'utf-8')
  }

  async load(id: string): Promise<Session | null> {
    const p = this.path(id)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf-8')) as Session
  }

  async list(): Promise<Pick<Session, 'id' | 'title' | 'createdAt' | 'updatedAt'>[]> {
    if (!existsSync(this.dir)) return []
    const files = readdirSync(this.dir).filter(f => f.endsWith('.json'))
    const sessions = files.map(f => {
      const raw = readFileSync(join(this.dir, f), 'utf-8')
      const { id, title, createdAt, updatedAt } = JSON.parse(raw) as Session
      return { id, title, createdAt, updatedAt }
    })
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`)
  }
}
