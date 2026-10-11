import { readConfig } from './config.js';
import { createDatabase } from './db.js';
import { createApp } from './app.js';

const config = readConfig();
const db = createDatabase(config.DATABASE_URL);
db.on('error', error => console.error('Unexpected database pool error:', error.message));
await db.query('SELECT 1');
const server = createApp({ db, config }).listen(config.PORT, () => console.log(`Task Management REST API listening on port ${config.PORT}`));
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  const timeout = setTimeout(() => process.exit(1), 10000).unref();
  server.close(async () => { await db.end(); clearTimeout(timeout); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
