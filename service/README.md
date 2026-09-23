# SOC optional service

The repository root is the embeddable library. This directory owns the gateway,
worker and legacy runtime dependencies; it is not a separate agent kit.

From the repository root (Node >=22.18):

```sh
pnpm install --frozen-lockfile
pnpm build:service
cd service
pnpm install --prod --frozen-lockfile
pnpm db:migrate
pnpm start
# Or: pnpm worker
```

Place service environment settings in `service/.env`, or pass them through the
process environment. Existing root development commands still run TypeScript
with development dependencies. Docker uses this compiled service distribution.
A deployment consists of this package.json, its lockfile, and `dist/` (including
resources and SQL migrations). Redis/PostgreSQL credentials remain application
configuration. The core library does not install these services.

## Current operations

See the repository-local [service API](../docs/service-api.ko.md) for request formats,
queue behavior, errors and deployment boundaries, and [development status](../docs/development-status.ko.md)
for implemented features and validation scope.

Upgrade all gateways to the same admission implementation so both POST routes share
the tenant row lock. No new database migration is required for the September 22 admission fix.
A stored job whose queue delivery fails returns 503; retry with the same signal ID or
`options.dedupKey` as documented. SOC policy-document RAG is not connected.

The September 23 workflow update requires gateway migration `003-workflow-deliveries.sql`.
Stop old gateways/workers, run `pnpm db:migrate`, then start the updated processes.
Do not mix old workers with the new versioned state transitions. See
[workflow recovery](../docs/workflow-recovery.ko.md) for delivery and recovery limits.
