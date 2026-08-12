# edge-launcher

A single launcher page for everything running on the EdgeStudios Coolify VPS.

It reads the app list from the Coolify API rather than a hand-kept list, so
**giving a resource an FQDN in Coolify is all it takes to make it appear.**
Nothing to edit here when you deploy something new.

## How it stays current

- The server re-polls Coolify every `REFRESH_MS` (default 60s).
- The browser re-polls the server every 30s, and again whenever you refocus
  the tab — so a page left open overnight is current the moment you look at it.
- If Coolify is unreachable, the last known-good list keeps being served and is
  marked **stale** instead of going blank.

Resources with no FQDN — workers, managed Postgres, and the like — are left
off, since there is nothing to launch.

## Page

Tiles grouped by Coolify project, each with a status dot (green running,
amber degraded, red stopped) and the app's own favicon. Type to filter;
`/` jumps to the search box, `Enter` opens the first hit, `Esc` clears.

## Configuration

Copy `.env.example`. The only required value is `COOLIFY_TOKEN` — mint it in
the Coolify UI under **Profile → API Tokens**; a read-only token is enough.

`PASSCODE` is optional but recommended. This page is an index of every internal
service, and the `*.edgestudios.co.za` wildcard means any hostname resolves
publicly — so without a passcode the list is readable by anyone who finds the
URL. The Coolify token itself is only ever used server-side and is never sent
to the browser.

## Deploying on Coolify

1. **New Resource → Public/Private Repository**, point it at this repo,
   build pack **Dockerfile**.
2. Set the environment variables from `.env.example`.
3. Set the domain to `https://launch.edgestudios.co.za` (any hostname on the
   zone works — the wildcard means **no DNS record is needed**; Traefik routes
   by Host header and Coolify issues the certificate).
4. Deploy.

Port 3000 is exposed; `/healthz` returns the app count and staleness for
Coolify's health check.

## Running it directly

```sh
COOLIFY_TOKEN=... node server.js
```

Node 20+. No dependencies — the server uses only built-ins, so there is no
`npm install` step and nothing in the image but the runtime and two files.

## Upgrade path

The platform's stated principle is SSO through Pocket-ID. The passcode gate is
deliberately the smaller, self-contained option; swapping it for a Pocket-ID
OIDC client is the natural next step if this page becomes something more than
a personal bookmark.
