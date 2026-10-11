import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ZodError } from 'zod';
import * as v from './validation.js';

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const publicUser = 'id, name, email, created_at';
const ok = (res, data, status = 200, meta) => res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
const metadata = (page, limit, total) => ({ page, limit, total: Number(total), total_pages: Math.ceil(Number(total) / limit) });

export function createApp({ db, config, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, handler: (_req, res) => res.status(429).json({ success: false, error: { message: 'Too many authentication attempts. Try again later.' } }) });
  const token = user => jwt.sign({}, config.JWT_SECRET, { subject: String(user.id), expiresIn: config.JWT_EXPIRES_IN, algorithm: 'HS256', issuer: 'task-management-api', audience: 'task-management-client' });
  async function authenticate(req, _res, next) {
    const header = req.headers.authorization;
    if (!header?.match(/^Bearer \S+$/)) throw new ApiError(401, 'A Bearer access token is required');
    let payload;
    try { payload = jwt.verify(header.slice(7), config.JWT_SECRET, { algorithms: ['HS256'], issuer: 'task-management-api', audience: 'task-management-client' }); }
    catch { throw new ApiError(401, 'Invalid or expired access token'); }
    const parsed = v.id.safeParse(payload.sub);
    if (!parsed.success) throw new ApiError(401, 'Invalid access token');
    const result = await db.query(`SELECT ${publicUser} FROM users WHERE id=$1`, [parsed.data]);
    if (!result.rows.length) throw new ApiError(401, 'User no longer exists');
    req.user = result.rows[0];
    next();
  }
  async function ownedProject(projectId, userId) {
    const result = await db.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (!result.rows.length) throw new ApiError(404, 'Project not found');
    if (result.rows[0].owner_id !== userId) throw new ApiError(403, 'You do not have access to this project');
    return result.rows[0];
  }
  async function ownedTask(taskId, userId) {
    const result = await db.query(`SELECT t.*, p.owner_id, p.name AS project_name, u.name AS assignee_name FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN users u ON u.id=t.assigned_user_id WHERE t.id=$1`, [taskId]);
    if (!result.rows.length) throw new ApiError(404, 'Task not found');
    if (result.rows[0].owner_id !== userId) throw new ApiError(403, 'You do not have access to this task');
    const { owner_id, ...task } = result.rows[0];
    return task;
  }
  async function validateAssignee(value) {
    if (value != null && !(await db.query('SELECT id FROM users WHERE id=$1', [value])).rows.length) throw new ApiError(400, 'Assigned user does not exist');
  }
  async function update(table, resourceId, body) {
    const entries = Object.entries(body);
    const assignments = entries.map(([key], i) => `${key}=$${i + 1}`).join(', ');
    const result = await db.query(`UPDATE ${table} SET ${assignments}, updated_at=now() WHERE id=$${entries.length + 1} RETURNING *`, [...entries.map(([, value]) => value), resourceId]);
    if (!result.rows.length) throw new ApiError(404, 'Resource not found');
    return result.rows[0];
  }
  app.get('/health', async (_req, res) => { await db.query('SELECT 1'); ok(res, { status: 'ok' }); });
  app.post('/api/auth/register', authLimiter, async (req, res) => {
    const body = v.parse(v.register, req.body);
    const hash = await bcrypt.hash(body.password, 12);
    const result = await db.query(`INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING ${publicUser}`, [body.name, body.email, hash]);
    ok(res, { user: result.rows[0], access_token: token(result.rows[0]) }, 201);
  });
  app.post('/api/auth/login', authLimiter, async (req, res) => {
    const body = v.parse(v.login, req.body);
    const result = await db.query('SELECT * FROM users WHERE email=$1', [body.email]);
    const user = result.rows[0];
    if (!user || !await bcrypt.compare(body.password, user.password_hash)) throw new ApiError(401, 'Invalid email or password');
    const { password_hash, ...safeUser } = user;
    ok(res, { user: safeUser, access_token: token(user) });
  });
  app.use('/api', authenticate);
  app.get('/api/auth/me', (req, res) => ok(res, req.user));
  app.post('/api/projects', async (req, res) => {
    const body = v.parse(v.project, req.body);
    const result = await db.query('INSERT INTO projects(name,description,owner_id) VALUES($1,$2,$3) RETURNING *', [body.name, body.description ?? '', req.user.id]);
    ok(res, result.rows[0], 201);
  });
  app.get('/api/projects', async (req, res) => {
    const { page, limit } = v.parse(v.pagination.strict(), req.query);
    const count = await db.query('SELECT count(*) FROM projects WHERE owner_id=$1', [req.user.id]);
    const result = await db.query('SELECT * FROM projects WHERE owner_id=$1 ORDER BY id DESC LIMIT $2 OFFSET $3', [req.user.id, limit, (page - 1) * limit]);
    ok(res, result.rows, 200, metadata(page, limit, count.rows[0].count));
  });
  app.get('/api/projects/:id', async (req, res) => {
    const project = await ownedProject(v.parse(v.id, req.params.id), req.user.id);
    const count = await db.query('SELECT count(*) FROM tasks WHERE project_id=$1', [project.id]);
    ok(res, { ...project, task_count: Number(count.rows[0].count) });
  });
  app.patch('/api/projects/:id', async (req, res) => {
    const body = v.parse(v.patch(v.project), req.body);
    const project = await ownedProject(v.parse(v.id, req.params.id), req.user.id);
    ok(res, await update('projects', project.id, body));
  });
  app.delete('/api/projects/:id', async (req, res) => {
    const project = await ownedProject(v.parse(v.id, req.params.id), req.user.id);
    await db.query('DELETE FROM projects WHERE id=$1', [project.id]);
    ok(res, { id: project.id, deleted: true });
  });
  app.post('/api/projects/:id/tasks', async (req, res) => {
    const body = v.parse(v.task, req.body);
    const project = await ownedProject(v.parse(v.id, req.params.id), req.user.id);
    await validateAssignee(body.assigned_user_id);
    const result = await db.query('INSERT INTO tasks(title,description,status,priority,due_date,project_id,assigned_user_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [body.title, body.description ?? '', body.status ?? 'TODO', body.priority ?? 'MEDIUM', body.due_date ?? null, project.id, body.assigned_user_id ?? null]);
    ok(res, result.rows[0], 201);
  });
  app.get('/api/tasks', async (req, res) => {
    const { page, limit, ...filters } = v.parse(v.filters, req.query);
    if (filters.project_id) await ownedProject(filters.project_id, req.user.id);
    const values = [req.user.id];
    const conditions = ['p.owner_id=$1'];
    for (const [key, value] of Object.entries(filters)) { values.push(value); conditions.push(`t.${key}=$${values.length}`); }
    const from = `FROM tasks t JOIN projects p ON p.id=t.project_id WHERE ${conditions.join(' AND ')}`;
    const count = await db.query(`SELECT count(*) ${from}`, values);
    const result = await db.query(`SELECT t.*, p.name AS project_name ${from} ORDER BY t.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, (page - 1) * limit]);
    ok(res, result.rows, 200, metadata(page, limit, count.rows[0].count));
  });
  app.get('/api/tasks/:id', async (req, res) => ok(res, await ownedTask(v.parse(v.id, req.params.id), req.user.id)));
  app.patch('/api/tasks/:id', async (req, res) => {
    const body = v.parse(v.patch(v.task), req.body);
    const task = await ownedTask(v.parse(v.id, req.params.id), req.user.id);
    await validateAssignee(body.assigned_user_id);
    ok(res, await update('tasks', task.id, body));
  });
  app.delete('/api/tasks/:id', async (req, res) => {
    const task = await ownedTask(v.parse(v.id, req.params.id), req.user.id);
    await db.query('DELETE FROM tasks WHERE id=$1', [task.id]);
    ok(res, { id: task.id, deleted: true });
  });
  app.use((_req, _res, next) => next(new ApiError(404, 'Endpoint not found')));
  app.use((error, _req, res, _next) => {
    let status = error.status || 500;
    let message = status < 500 ? error.message : 'An unexpected server error occurred';
    let details;
    if (error instanceof ZodError) { status = 400; message = 'Validation failed'; details = error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })); }
    else if (error.code === '23505') { status = 409; message = 'Email is already registered'; }
    else if (error.code === '23503') { status = 400; message = 'Referenced project or user no longer exists'; }
    else if (error.type === 'entity.parse.failed') { status = 400; message = 'Invalid JSON body'; }
    else if (error.type === 'entity.too.large') { status = 413; message = 'Request body is too large'; }
    if (status >= 500) logger.error(error);
    res.status(status).json({ success: false, error: { message, ...(details ? { details } : {}) } });
  });
  return app;
}
