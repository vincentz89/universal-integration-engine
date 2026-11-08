# Universal Integration Engine
## Technical Portfolio Case Study

**Role:** Backend / Full-Stack Developer

**Focus:** Multi-tenant architecture, API integration, authentication, webhook reliability, and asynchronous processing.

## 1. Project Overview

Universal Integration Engine is a reusable integration platform designed to provide shared infrastructure for connecting external business systems.

Instead of implementing authentication, credential handling, webhook processing, retries, and background execution separately for every provider, the platform centralizes these capabilities into reusable components.

BigCommerce is the first concrete provider connector implemented in the project.

## 2. System Architecture

The platform separates shared integration infrastructure from provider-specific connector implementations.

The processing flow is: external webhook → request validation → identity and idempotency checks → PostgreSQL → transactional outbox → Redis/BullMQ → background worker → handler registry → provider connector → external API.

Recovery workers and retry mechanisms handle eligible interrupted or failed processing. PostgreSQL maintains durable processing state and synchronization records.

## 3. Engineering Challenges and Solutions

### Multi-Tenant Credential Isolation

**Challenge:** Multiple business accounts must use the same integration infrastructure without exposing credentials across tenants.

**Implementation:** Tenant-scoped integration configuration, ownership validation, and AES-256-GCM credential encryption at rest. Credential access is handled through shared services rather than provider-specific credential storage.

### Authentication Strategy

**Challenge:** Different providers require different authentication mechanisms.

**Implementation:** A strategy-based authentication framework supports NONE, API_KEY, BASIC, BEARER, and OAUTH2. Authentication execution is separated from provider API operations.

### OAuth2 Token Coordination

**Challenge:** Concurrent requests can trigger overlapping token refresh operations.

**Implementation:** Token coordination and refresh locking help prevent competing refresh operations for the same integration.

### Webhook Idempotency

**Challenge:** Providers may deliver duplicate events, and concurrent requests may attempt to process the same event.

**Implementation:** Webhook identity validation, integration-aware idempotency scopes, database-backed processing state, and lease-based ownership controls protect event processing.

### Reliable Background Processing

**Challenge:** Queue dispatch and worker execution can be interrupted by failures or process restarts.

**Implementation:** A transactional outbox, retry policies, recovery dispatching, and stale-worker completion protection improve processing reliability.

## 4. Testing and Validation

The project includes automated tests for security, authentication, tenant isolation, API retries, and webhook processing.

The database-free CI test suite contains 18 test files. The suite was executed locally with all 18 passing.

Additional infrastructure-dependent test scripts cover queue load, concurrent webhook processing, idempotency, outbox dispatch, recovery, stale-worker completion, and tenant isolation.

These additional scripts are maintained separately because they require database and/or Redis infrastructure.

## 5. Current Implementation Scope

### Implemented

- Reusable multi-tenant integration infrastructure.
- Encrypted tenant credential storage.
- Five authentication strategies, including OAuth2.
- OAuth2 token coordination and refresh locking.
- BigCommerce webhook intake and signature verification.
- Webhook identity and idempotency controls.
- Transactional outbox and BullMQ background processing.
- Retry, recovery, and stale-worker protection.
- BigCommerce product retrieval and inventory update operations.

### Not Yet Implemented

- Complete product transformation and mapping workflow.
- End-to-end destination-system synchronization.
- Complete business workflows for additional providers.
- Production deployment and operational monitoring across environments.

The platform establishes reusable integration infrastructure. Each additional provider and business workflow still requires its own API operations, payload mapping, validation, and destination-specific implementation.

## 6. Technology Stack

- Node.js 24 and TypeScript
- Next.js
- PostgreSQL and Prisma
- Redis and BullMQ
- Axios and Zod
- Pino structured logging

## 7. Project Summary

This project demonstrates the design and implementation of reusable backend integration infrastructure, with particular focus on multi-tenant security, authentication extensibility, webhook idempotency, and reliable asynchronous processing.

The BigCommerce connector serves as the first concrete provider implementation and a foundation for future integrations.
