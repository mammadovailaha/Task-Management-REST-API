import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';

// TEST_DATABASE_URL must point to a disposable, empty database.
const pool = process.env.TEST_DATABASE_URL ? createDatabase(process.env.TEST_DATABASE_URL) : null;
const db = pool ? { query: (...args) => pool.query(...args), exec: sql => pool.query(sql), close: () => pool.end() } : new PGlite();
const config = { JWT_SECRET: 'test-secret-with-more-than-32-characters', JWT_EXPIRES_IN: '1h' };
const app = createApp({ db, config, logger: { error: () => {} } });
before(async () => { await db.exec(await readFile(new URL('../db/001_initial.sql', import.meta.url), 'utf8')); });
after(async () => { await db.close(); });

test('complete authenticated CRUD, ownership, validation and relational integrity', async () => {
  assert.equal((await request(app).get('/health')).status, 200);
  assert.equal((await request(app).get('/api/projects')).status, 401);
  assert.equal((await request(app).post('/api/auth/register').send({ name: '', email: 'bad', password: 'short' })).status, 400);
  async function register(email) {
    const response = await request(app).post('/api/auth/register').send({ name: 'Developer', email, password: 'secure-password' });
    assert.equal(response.status, 201);
    assert.equal(JSON.stringify(response.body).includes('password'), false);
    return response.body.data;
  }
  const alice = await register('alice@example.com');
  const bob = await register('bob@example.com');
  const auth = { Authorization: `Bearer ${alice.access_token}` };
  const other = { Authorization: `Bearer ${bob.access_token}` };
  assert.equal((await request(app).post('/api/auth/register').send({ name: 'Alice', email: 'ALICE@example.com', password: 'secure-password' })).status, 409);
  assert.equal((await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'wrong-password' })).status, 401);
  assert.equal((await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'secure-password' })).status, 200);
  assert.equal((await request(app).get('/api/auth/me').set(auth)).body.data.email, 'alice@example.com');
  assert.equal((await request(app).get('/api/auth/me').set('Authorization', 'Bearer garbage')).status, 401);
  const expired = jwt.sign({}, config.JWT_SECRET, { subject: String(alice.user.id), expiresIn: -1, issuer: 'task-management-api', audience: 'task-management-client' });
  assert.equal((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${expired}`)).status, 401);
  const stored = (await db.query('SELECT password_hash FROM users WHERE id=$1', [alice.user.id])).rows[0];
  assert.notEqual(stored.password_hash, 'secure-password');
  const projectResponse = await request(app).post('/api/projects').set(auth).send({ name: 'Portfolio' });
  assert.equal(projectResponse.status, 201);
  const projectId = projectResponse.body.data.id;
  assert.equal((await request(app).get('/api/projects').set(other)).body.data.length, 0);
  for (const method of ['get', 'patch', 'delete']) {
    const response = await request(app)[method](`/api/projects/${projectId}`).set(other).send(method === 'patch' ? { name: 'Stolen' } : undefined);
    assert.equal(response.status, 403);
  }
  assert.equal((await request(app).patch(`/api/projects/${projectId}`).set(auth).send({ name: 'Updated' })).body.data.name, 'Updated');
  assert.equal((await request(app).get('/api/projects/nope').set(auth)).status, 400);
  assert.equal((await request(app).get('/api/projects/999').set(auth)).status, 404);
  const taskPath = `/api/projects/${projectId}/tasks`;
  assert.equal((await request(app).post(taskPath).set(other).send({ title: 'Blocked' })).status, 403);
  for (const fields of [{ status: 'INVALID' }, { priority: 'URGENT' }, { due_date: '2026-02-30' }, { assigned_user_id: 999 }, { assigned_user_id: 0 }, { owner_id: bob.user.id }]) {
    assert.equal((await request(app).post(taskPath).set(auth).send({ title: 'Invalid', ...fields })).status, 400);
  }
  const taskResponse = await request(app).post(taskPath).set(auth).send({ title: 'Build API', priority: 'HIGH', due_date: '2026-12-01', assigned_user_id: bob.user.id });
  assert.equal(taskResponse.status, 201);
  const taskId = taskResponse.body.data.id;
  for (const method of ['get', 'patch', 'delete']) {
    assert.equal((await request(app)[method](`/api/tasks/${taskId}`).set(other).send(method === 'patch' ? { status: 'DONE' } : undefined)).status, 403);
  }
  assert.equal((await request(app).get('/api/tasks').set(other)).body.data.length, 0);
  for (const status of ['IN_PROGRESS', 'DONE']) assert.equal((await request(app).patch(`/api/tasks/${taskId}`).set(auth).send({ status })).body.data.status, status);
  assert.equal((await request(app).patch(`/api/tasks/${taskId}`).set(auth).send({})).status, 400);
  assert.equal((await request(app).get(`/api/tasks/${taskId}`).set(auth)).body.data.assignee_name, 'Developer');
  await request(app).post(taskPath).set(auth).send({ title: 'Second' });
  const filtered = await request(app).get(`/api/tasks?status=DONE&priority=HIGH&project_id=${projectId}&limit=1`).set(auth);
  assert.equal(filtered.body.meta.total, 1);
  assert.equal(filtered.body.data[0].id, taskId);
  const paged = await request(app).get('/api/tasks?limit=1&page=2').set(auth);
  assert.equal(paged.body.data.length, 1);
  assert.equal(paged.body.meta.total_pages, 2);
  assert.equal((await request(app).get('/api/tasks?limit=101').set(auth)).status, 400);
  assert.equal((await request(app).get(`/api/projects/${projectId}`).set(auth)).body.data.task_count, 2);
  await db.query('DELETE FROM users WHERE id=$1', [bob.user.id]);
  assert.equal((await request(app).get(`/api/tasks/${taskId}`).set(auth)).body.data.assigned_user_id, null);
  assert.equal((await request(app).delete(`/api/tasks/${taskId}`).set(auth)).status, 200);
  assert.equal((await request(app).get(`/api/tasks/${taskId}`).set(auth)).status, 404);
  assert.equal((await request(app).delete(`/api/projects/${projectId}`).set(auth)).status, 200);
  assert.equal(Number((await db.query('SELECT count(*) FROM tasks')).rows[0].count), 0);
  assert.equal((await request(app).post('/api/projects').set(auth).set('Content-Type', 'application/json').send('{')).status, 400);
});

test('database failures return sanitized consistent errors', async () => {
  const broken = createApp({ db: { query: async () => { throw new Error('secret database credentials'); } }, config, logger: { error: () => {} } });
  const response = await request(broken).get('/health');
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { success: false, error: { message: 'An unexpected server error occurred' } });
});
