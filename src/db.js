import pg from 'pg';

export function createDatabase(connectionString) {
  return new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
}
