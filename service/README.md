# SOC optional service

The repository root is the embeddable library. This directory owns the gateway,
worker and legacy runtime dependencies; it is not a separate agent kit.

From the repository root (Node >=22.18):

```sh
pnpm install --frozen-lockfile
pnpm build:service
cd service
pnpm install --prod --frozen-lockfile
pnpm start
# Or: pnpm worker
```

Place service environment settings in `service/.env`, or pass them through the
process environment. Existing root development commands still run TypeScript
with development dependencies. Docker uses this compiled service distribution.
A deployment consists of this package.json, its lockfile, and `dist/` (including
resources and SQL migrations). Redis/PostgreSQL credentials remain application
configuration. The core library does not install these services.
