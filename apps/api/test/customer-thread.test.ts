import { describe, expect, it } from 'vitest';
import { migratedDatabase } from './helpers/sqlite-d1';

describe('CustomerThreadDO message persistence', () => {
  it('upserts assistant replies against the partial external_id index', () => {
    const sqlite = migratedDatabase();
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external_id
        ON messages(external_id) WHERE external_id IS NOT NULL;
    `);

    sqlite.prepare(`
      INSERT INTO messages (external_id, role, content, model)
      VALUES (?1, 'assistant', ?2, ?3)
      ON CONFLICT DO UPDATE SET
        content = excluded.content, model = excluded.model
    `).run('event-1:assistant', 'first reply', 'model-a');

    sqlite.prepare(`
      INSERT INTO messages (external_id, role, content, model)
      VALUES (?1, 'assistant', ?2, ?3)
      ON CONFLICT DO UPDATE SET
        content = excluded.content, model = excluded.model
    `).run('event-1:assistant', 'updated reply', 'model-b');

    const row = sqlite.prepare(
      'SELECT external_id, role, content, model FROM messages WHERE external_id = ?1',
    ).get('event-1:assistant') as {
      external_id: string;
      role: string;
      content: string;
      model: string;
    };

    expect(row).toEqual({
      external_id: 'event-1:assistant',
      role: 'assistant',
      content: 'updated reply',
      model: 'model-b',
    });
  });
});