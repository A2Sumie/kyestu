import { Database } from 'bun:sqlite'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { join } from 'path'
import type { Component } from '../core/types'

/**
 * bun:sqlite database with ordered SQL migrations.
 * The migration set is vendored from idol-bbq (prisma/migrations) so a kyestu
 * database stays byte-compatible with the production schema.
 */
export class KyestuDb {
  readonly db: Database

  constructor(path = ':memory:') {
    this.db = new Database(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
  }

  migrate(migrationsDir: string): string[] {
    this.db.exec(`CREATE TABLE IF NOT EXISTS "_kyestu_migrations" (
      "name" TEXT PRIMARY KEY,
      "applied_at" INTEGER NOT NULL
    )`)
    const applied = new Set(
      (this.db.query('SELECT name FROM "_kyestu_migrations"').all() as Array<{ name: string }>).map((r) => r.name),
    )
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
    const now = Date.now()
    const newlyApplied: string[] = []
    for (const file of files) {
      if (applied.has(file)) continue
      // prisma migrations carry explicit CREATE INDEX statements for auto-indexes
      // that SQLite creates itself from inline UNIQUE constraints; the
      // sqlite_autoindex_* prefix is reserved, so drop those (redundant) statements
      const sql = readFileSync(join(migrationsDir, file), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(CREATE\s+(UNIQUE\s+)?INDEX|DROP\s+INDEX)\s+"sqlite_autoindex_/.test(line))
        .join('\n')
      this.db.transaction(() => {
        this.db.exec(sql)
        this.db.query('INSERT INTO "_kyestu_migrations" (name, applied_at) VALUES (?, ?)').run(file, now)
      })()
      newlyApplied.push(file)
    }
    return newlyApplied
  }

  close(): void {
    this.db.close()
  }
}

export const defaultMigrationsDir = fileURLToPath(new URL('../../assets/migrations', import.meta.url))

export const dbComponent: Component<{ path?: string; migrations_dir?: string }> = {
  knownWithKeys: ['path', 'migrations_dir'],
  apply: (ctx, config) => {
    const db = new KyestuDb(config.path ?? ':memory:')
    db.migrate(config.migrations_dir ?? defaultMigrationsDir)
    ctx.expose(db)
    ctx.set('db', db)
    return () => db.close()
  },
}
