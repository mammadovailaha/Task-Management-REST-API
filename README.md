# Task Management REST API

A backend-only REST API for managing personal projects and tasks. Built with Node.js, Express 5, PostgreSQL, JWT, bcrypt, and Zod. It demonstrates relational database design, authentication, ownership checks, CRUD, filtering, pagination, validation, and consistent error handling.

## Requirements and setup

- Node.js 22 or later and npm
- PostgreSQL (or Docker Compose to run the supplied PostgreSQL 17 service)

```sh
npm ci
cp .env.example .env
docker compose up -d db
npm run db:migrate
npm start
```

On PowerShell, use `Copy-Item .env.example .env` instead of `cp`. If you already have PostgreSQL, create an empty database and update `DATABASE_URL`; Docker is optional. Wait for the database to be healthy before migrating. Migrations are transactional, serialized with an advisory lock, and recorded in `schema_migrations`, so rerunning them is safe. The server checks connectivity before listening. `/health` also checks the database.

Set `JWT_SECRET` to a strong random secret (at least 32 characters). For example, generate one with `node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"`. The Compose credentials are for local development. Replace credentials for deployed environments. Never commit `.env`.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection URL (required) |
| `JWT_SECRET` | Token signing secret (required, minimum 32 characters) |
| `JWT_EXPIRES_IN` | Token lifetime, e.g. `1h`, `30m` (default `1h`) |
| `PORT` | HTTP port (default `3000`) |
| `NODE_ENV` | `development`, `test`, or `production` |

Use `npm run dev` for watch mode. Use `npm test` for integration tests. By default, tests run the real SQL schema and queries using PGlite, an embedded PostgreSQL engine, without external database credentials. Set `TEST_DATABASE_URL` to an empty, disposable PostgreSQL database to run the same suite through the real PostgreSQL driver; the suite creates tables and leaves test data behind. Never use your application database for tests. The GitHub Actions workflow runs the suite against PostgreSQL 17. To verify your application's database, run the migration, start the server, and request `/health`.

## API

Base URL: `http://localhost:3000`. All `/api` endpoints except registration and login require `Authorization: Bearer <access_token>`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/health` | Database health |
| POST | `/api/auth/register` | Register and receive a token |
| POST | `/api/auth/login` | Login and receive a token |
| GET | `/api/auth/me` | Current user's public profile |
| POST | `/api/projects` | Create a project |
| GET | `/api/projects` | List owned projects, with `page` and `limit` |
| GET | `/api/projects/:id` | Project details and task count |
| PATCH | `/api/projects/:id` | Update name/description |
| DELETE | `/api/projects/:id` | Delete project and its tasks |
| POST | `/api/projects/:id/tasks` | Create a task |
| GET | `/api/tasks` | List owned-project tasks with filters/pagination |
| GET | `/api/tasks/:id` | Task details, project name and assignee name |
| PATCH | `/api/tasks/:id` | Update editable task fields |
| DELETE | `/api/tasks/:id` | Delete a task |

### Authentication example

```sh
curl -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alice","email":"alice@example.com","password":"a-long-password"}'
```

```json
{
  "success": true,
  "data": {
    "user": { "id": 1, "name": "Alice", "email": "alice@example.com", "created_at": "2026-10-11T12:00:00.000Z" },
    "access_token": "<JWT>"
  }
}
```

Login accepts `email` and `password`. Email is normalized to lowercase. Passwords must be 8–72 characters and at most 72 UTF-8 bytes, and are hashed with bcrypt cost 12. JWTs use HS256 with issuer/audience checks and expire after the configured lifetime. There is no refresh-token or logout/revocation endpoint; clients discard tokens on logout. Registration/login are limited to 30 requests per IP per 15 minutes.

### Projects and tasks

```sh
curl -X POST http://localhost:3000/api/projects \
  -H 'Authorization: Bearer <JWT>' -H 'Content-Type: application/json' \
  -d '{"name":"Portfolio","description":"Backend projects"}'

curl -X POST http://localhost:3000/api/projects/1/tasks \
  -H 'Authorization: Bearer <JWT>' -H 'Content-Type: application/json' \
  -d '{"title":"Write tests","priority":"HIGH","due_date":"2026-12-01"}'

curl -X PATCH http://localhost:3000/api/tasks/1 \
  -H 'Authorization: Bearer <JWT>' -H 'Content-Type: application/json' \
  -d '{"status":"IN_PROGRESS"}'

curl 'http://localhost:3000/api/tasks?status=IN_PROGRESS&priority=HIGH&project_id=1&page=1&limit=20' \
  -H 'Authorization: Bearer <JWT>'
```

Task creation requires `title`. Optional fields: `description`, `status` (`TODO`, `IN_PROGRESS`, `DONE`), `priority` (`LOW`, `MEDIUM`, `HIGH`), `due_date` (`YYYY-MM-DD` or null), and `assigned_user_id` (existing user ID or null). Defaults are empty description, TODO status, MEDIUM priority, and no due date/assignee. PATCH accepts these same fields; use null to clear the due date or assignee. Status can change between any valid statuses. Project PATCH accepts `name`/`description`. Empty updates and unknown fields are rejected. Resource IDs and assignee IDs are positive integers.

Lists are ordered by descending ID. `page` starts at 1, `limit` defaults to 20 and is capped at 100. Task filters combine with AND. Responses include `meta: { page, limit, total, total_pages }`; pages past the end return an empty array. Success uses `{ "success": true, "data": ... }`, with 201 for creation and 200 for reads, updates, and deletes.

```json
{
  "success": false,
  "error": {
    "message": "Validation failed",
    "details": [{ "field": "status", "message": "Invalid enum value. Expected 'TODO' | 'IN_PROGRESS' | 'DONE', received 'INVALID'" }]
  }
}
```

Errors use 400 for invalid input, 401 for missing/invalid authentication or incorrect credentials, 403 for another user's resource, 404 for missing resources, 409 for duplicate emails, 413 for oversized bodies, 429 for authentication rate limits, and 500 for unexpected failures. Internal errors are logged on the server and sanitized for clients. Password hashes never appear in responses. SQL values are parameterized; editable field names are allowlisted by strict validation.

## Relationships and access rules

`users` → `projects.owner_id` → `tasks.project_id`; `tasks.assigned_user_id` optionally references `users`. Foreign keys enforce integrity, emails are unique, and database checks enforce task statuses/priorities. Projects/tasks have creation/update timestamps; API updates refresh `updated_at`.

Only the project owner can read or manage a project and its tasks. Assigning a task records responsibility and does **not** grant project access. An owner may assign any existing user by ID; there is no user directory or collaborative membership feature. Project deletion cascades to tasks. User deletion at database level cascades owned projects and clears assignments in other projects. The API does not provide user deletion.

## Project layout

```text
src/app.js         Routes, authentication, authorization, error handling
src/validation.js  Strict request schemas
src/config.js      Environment validation
src/db.js          PostgreSQL pool
src/server.js      Startup and graceful shutdown
db/001_initial.sql Relational schema
scripts/migrate.js Repeatable migration runner
test/api.test.js   HTTP integration and relational tests
```

The test suite covers registration/login, token protection, ownership on read/write/delete, CRUD, statuses, filters, pagination, validation, cascades, assignment cleanup, password protection, and sanitized database failures. The application is an appropriate starting point for a portfolio; production deployment should configure HTTPS, managed secrets, database backups, and infrastructure-specific networking.
