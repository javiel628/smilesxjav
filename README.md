# 亗 JAVIEL MD 亗 — Multi-user Session & Deployment Platform

**Developer:** JAVIEL × SMILE MODZ  
**Copyright:** © 2026

This project uses `bot/` as the original bot foundation from `Queen-plug-main.zip`. Its existing `index.js`, `command.js`, `config.js`, `plugins/`, `lib/`, `data/`, and other source files are retained. The integration changes the global MEGA `SESSION_ID` startup path into a per-deployment Baileys auth directory and gives each deployment its own copied bot workspace so mutable plugin data does not collide between users.

## What is implemented

- Email/password registration and login with bcrypt password hashes and signed HttpOnly, SameSite=Strict cookies.
- Real Baileys pairing-code flow using the Baileys dependency already present in the source project.
- International phone validation using `libphonenumber-js` (including Kenyan `+254` numbers).
- Random opaque `JAVIEL-...` session references; the reference is not the WhatsApp credential.
- AES-256-GCM encrypted authentication snapshots in PostgreSQL. Raw auth files are never returned by the API.
- Owner-scoped session and deployment APIs, rate limits, validation, safe error responses and log redaction.
- One isolated worker process and one private bot workspace per deployment. The original bot plugins and libraries are copied unchanged into that workspace at worker startup.
- Deployment status, restart, stop, delete, logs, and session revocation endpoints.
- Mobile-first dashboard with overview, pairing, deployment, bot list, logs, docs and support pages.
- Render Blueprint and PostgreSQL schema.

## Important deployment model

The current process supervisor runs worker child processes on the same Render web-service instance as the API. Use **one always-on paid Render instance** for this release. Do not scale the web service horizontally: each replica would have its own in-memory worker supervisor and could start duplicate workers. If horizontal scaling is needed later, move worker lifecycle to a distributed queue/worker service and use leases/heartbeats in PostgreSQL.

Authentication snapshots are encrypted in PostgreSQL. During a worker's lifetime, Baileys needs a private plaintext auth directory; it is created with restrictive permissions in the worker's temporary directory, is never exposed to the frontend, is snapshotted back to encrypted storage, and is removed on worker exit. Use a trusted host and restrict shell/instance access.

## Local setup

Requirements: Node.js 20+, PostgreSQL 14+.

1. Create a PostgreSQL database and apply `platform/db/schema.sql` (the app also runs the schema migration at startup).
2. Copy `platform/.env.example` to `platform/.env`.
3. Set `DATABASE_URL`, `JWT_SECRET`, and `SESSION_ENCRYPTION_KEY`.
4. Generate secrets:

   ```bash
   openssl rand -base64 32   # SESSION_ENCRYPTION_KEY (exactly 32 decoded bytes)
   openssl rand -hex 32      # JWT_SECRET
   ```

5. Install dependencies from the repository root:

   ```bash
   npm install
   npm run check
   npm start
   ```

6. Open `http://localhost:10000`, create an account, generate a pairing code, and complete linking in WhatsApp → Linked devices → Link a device → Link with phone number.
7. Copy the Session ID shown after the connection is saved. Paste it into Deployment to start your own worker.

`platform/.env.example` assumes the platform is started from the repository root with `node platform/src/server.js`. `BOT_ROOT=../bot` is resolved relative to the platform source directory. If you change the directory structure, update it accordingly.

## Render deployment

1. Push this repository to a private GitHub repository. Do not commit `.env`, auth folders, credentials, database dumps or logs.
2. In Render, create a Blueprint from `render.yaml`.
3. Set `SESSION_ENCRYPTION_KEY` in the Render service environment to the output of `openssl rand -base64 32` (generate it once and keep a secure backup; changing it makes existing encrypted sessions unreadable).
4. Set `PUBLIC_BASE_URL` to the deployed service URL.
5. Wait for the web service and PostgreSQL database to become healthy.
6. Keep the service at one instance and on an always-on paid plan. Free instances that sleep are unsuitable for 24/7 bot operation.
7. Create a platform account and test a fresh WhatsApp pairing before moving production users.

The blueprint creates a PostgreSQL database and a paid web service. The platform does not claim to call the Render API to create a new Render service for every user. Instead, each user's bot runs as an isolated process under the platform worker supervisor. This is a real deployment runtime, but it is not per-user Render service provisioning.

## API overview

All routes below except health and auth are authenticated by the HttpOnly session cookie.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Sign in |
| POST | `/api/auth/logout` | Clear auth cookie |
| GET | `/api/auth/me` | Current account |
| POST | `/api/pairings` | Start real Baileys pairing |
| GET | `/api/pairings/:id` | Pairing status/code/session reference |
| GET | `/api/sessions` | List own saved sessions |
| POST | `/api/sessions/:id/revoke` | Stop associated deployment and revoke credentials |
| POST | `/api/deployments` | Deploy using owned Session ID |
| GET | `/api/deployments` | List own deployments |
| GET | `/api/deployments/:id` | Deployment status |
| GET | `/api/deployments/:id/logs` | Own deployment logs |
| POST | `/api/deployments/:id/restart` | Restart |
| POST | `/api/deployments/:id/stop` | Stop |
| DELETE | `/api/deployments/:id` | Delete deployment and logs |
| GET | `/api/health` | Health check |

## Source preservation and identity notes

- The existing command and plugin source files are retained. The bot engine now requires `AUTH_DIR` and refuses to fall back to the former global `SESSION_ID`/MEGA mechanism.
- `OWNER_NUMBER` is assigned per worker from the linked WhatsApp account, so owner-only checks are scoped to that instance.
- A number of legacy plugin messages still contain POPKID/QUEEN branding or source-project references. Those text strings have not been mass-rewritten because doing so blindly could damage command behavior or attribution. Review them individually before public release.
- The source archive itself contains old branding, links and hardcoded numbers in plugin files. Check those before shipping. The old Kango pairing site is not used as a credential backend; its MEGA-based storage implementation is deliberately not integrated.
- The original Baileys package is pinned to the source archive's `@fizzxydev/baileys-pro` 8.5.12 alias. Pairing and deployment must be integration-tested against the exact installed package version before production. Do not casually update Baileys without testing auth compatibility.

## Testing checklist before real users

The repository has syntax checks, but this environment has not installed npm dependencies or connected to a real WhatsApp account/PostgreSQL/Render service. Therefore this package is **not represented as production-certified or end-to-end tested**. Before launch, test:

- Register/login and cookie security over HTTPS.
- Invalid and valid E.164 phone numbers.
- Real pairing code generation and linking with a test WhatsApp account.
- Session snapshot encryption, restore after API restart, and wrong-key failure.
- Two simultaneous users pairing and deploying separate accounts.
- Worker restart, stop, unexpected exit, log access ownership and session revocation.
- All original commands and plugins, especially any plugin that writes files outside its working directory.
- Memory/CPU limits, WhatsApp disconnection handling and long-running worker stability.
- Verify no auth JSON, pairing codes, tokens or encryption keys appear in logs or public paths.

## Security responsibilities

Only link accounts you own or are authorized to administer. Keep Render access, PostgreSQL credentials, `JWT_SECRET`, and `SESSION_ENCRYPTION_KEY` private. Back up the encryption key separately. If the encryption key is lost, stored authentication snapshots cannot be decrypted. Revoke the linked device from WhatsApp as well as revoking the platform session when disconnecting an account.
