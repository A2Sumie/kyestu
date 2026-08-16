import { createHash } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join } from 'path'

export async function persistCard(card: Buffer): Promise<string> {
  const dir = fileURLToPath(new URL('../../cache/cards', import.meta.url))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${createHash('sha256').update(card).digest('hex')}.png`)
  writeFileSync(path, card)
  return path
}
