import { readFile } from 'node:fs/promises';
import { readConfig } from '../src/config.js';
import { createDatabase } from '../src/db.js';

const pool = createDatabase(readConfig().DATABASE_URL);
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(817234)');
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const applied = await client.query('SELECT version FROM schema_migrations WHERE version = $1', ['001_initial']);
  if (!applied.rows.length) {
    await client.query(await readFile(new URL('../db/001_initial.sql', import.meta.url), 'utf8'));
    await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', ['001_initial']);
  }
  await client.query('COMMIT');
  console.log('Database migrations are up to date.');
} catch (error) {
  await client.query('ROLLBACK');
  console.error('Migration failed:', error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
