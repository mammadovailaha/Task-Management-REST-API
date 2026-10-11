import { z } from 'zod';

export const id = z.coerce.number().int().positive().max(2147483647);
const text = (max) => z.string().trim().min(1).max(max);
export const register = z.object({ name: text(100), email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(8).max(72).refine(v => Buffer.byteLength(v, 'utf8') <= 72, 'Password must be at most 72 bytes') }).strict();
export const login = register.pick({ email: true, password: true });
export const project = z.object({ name: text(200), description: z.string().max(10000).optional() }).strict();
export const task = z.object({
  title: text(200), description: z.string().max(10000).optional(),
  status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(v); return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === v; }, 'Invalid calendar date').nullable().optional(),
  assigned_user_id: id.nullable().optional(),
}).strict();
export const patch = schema => schema.partial().refine(v => Object.keys(v).length > 0, 'Provide at least one field');
export const pagination = z.object({ page: id.default(1), limit: z.coerce.number().int().min(1).max(100).default(20) });
export const filters = pagination.extend({ status: task.shape.status, priority: task.shape.priority, project_id: id.optional() }).strict();
export function parse(schema, value) { return schema.parse(value); }
