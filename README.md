# Universal Integration Engine

A reusable, multi-tenant integration platform for secure API connectivity, webhook processing, and reliable background job execution.

The platform provides common building blocks for tenant isolation, credential management, webhook intake, idempotent processing, background job execution, retries, recovery, and synchronization logging.

BigCommerce is currently the concrete provider connector implementation. The architecture is designed to support additional providers without coupling shared infrastructure to one business system.

## Architecture
```text
External Webhook
    |
    v
Webhook Intake
    |
    v
Signature Verification
    |
    v
Webhook Identity and Idempotency
    |
    v
PostgreSQL
    - Webhook Events
    - Idempotency Records
    - Outbox Events
    - Sync Logs
    |
    v
Outbox Dispatcher
    |
    v
Redis / BullMQ
    |
    v
Queue Worker
    |
    v
Handler Registry
    |
    v
Provider Connector
    |
    v
External API
```

## Technology Stack

- Node.js
- TypeScript (strict mode)
- Next.js
- PostgreSQL
- Prisma
- BullMQ
- Redis
- Zod
- Axios
- Pino

## Core Capabilities

### Multi-Tenant Infrastructure

- Tenant-scoped integration configuration.
- Tenant and integration ownership validation.
- Tenant-specific credential storage.
- Encrypted credentials at rest.
- Legacy integration reference support.

### Authentication

Supported authentication strategies:

- NONE
- API_KEY
- BASIC
- BEARER
- OAUTH2

The authentication layer uses a strategy registry. OAuth2 provider configuration is controlled by the application.

### Webhook Processing

- BigCommerce webhook signature verification.
- Request body size limits.
- Webhook identity validation.
- Idempotency protection.
- Lease-based processing ownership.
- Duplicate event protection.
- Database-backed webhook state transitions.

### Background Processing

- BullMQ-based asynchronous processing.
- Configurable retry attempts and exponential backoff.
- Worker concurrency configuration.
- Outbox-based job dispatch.
- Recovery of eligible expired jobs.
- Stale-worker completion protection.
- Persistent synchronization logs.

### Provider Connector Layer

The shared API client provides authentication integration, retry handling for supported transient failures, Retry-After support, network error handling, safe retry restrictions for HTTP methods, and idempotency-key support for retryable POST requests.

The current BigCommerce connector includes product retrieval and inventory update operations.

The BigCommerce product webhook handler is currently an example implementation. Full product transformation and destination synchronization are not yet implemented.

## Current Scope and Limitations

This repository provides reusable integration infrastructure and a concrete BigCommerce connector example.

It is not a complete, ready-to-deploy implementation for every provider or business workflow.

Additional work may be required for each integration, including provider-specific authentication and API operations, payload mapping and transformation, destination-system synchronization, business-specific validation, and operational monitoring.

## License

This project is licensed under the MIT License. See LICENSE.

## Author

Cris Vincent R. Castro

## Local Development Setup

### Requirements

- Node.js 24
- PostgreSQL and Redis, or Docker with Docker Compose
- npm

### 1. Install Dependencies

    npm.cmd ci

### 2. Configure Environment Variables

Copy the example file:

    if (-not (Test-Path .env)) { Copy-Item .env.example .env } else { Write-Host ".env already exists; leaving it unchanged." }

Set the required values in `.env`:

- `DATABASE_URL`
- `REDIS_URL`
- `CREDENTIAL_ENCRYPTION_KEY`
- `POSTGRES_PASSWORD`

Generate a 32-byte encryption key encoded as 64 hexadecimal characters:

    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

### 3. Start PostgreSQL and Redis

From the repository root:

    docker compose -f deploy/docker-compose.yml up -d

The Compose configuration starts PostgreSQL and Redis only. It does not start the application or workers.

### 4. Generate Prisma Client

    npx.cmd prisma generate

Check migration status before applying migrations:

    npx.cmd prisma migrate status

Review pending migration SQL and confirm the target database before applying any migration.

### 5. Start Application and Workers

Start the Next.js development server:

    npm.cmd run dev

Start the main queue worker:

    npm.cmd run dev:worker

Start the recovery worker:

    npm.cmd run dev:recovery

Start the outbox worker:

    npm.cmd run dev:outbox

These processes can run in separate terminal windows.

## Technical Case Study

For a deeper look at the architecture, engineering challenges, implementation scope, and testing approach, see the [Universal Integration Engine Technical Case Study](docs/CASE_STUDY.md).
