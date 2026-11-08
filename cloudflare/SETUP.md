# Cloudflare Pages + D1 setup (Free plan only)

This file is a checklist for the DeanMusic project. It must not be applied to GENMERCH.

## Before starting

- Use the existing Cloudflare account only if you want; create a separate Pages project named `deanmusic`.
- Stay on the Free plan.
- Do not enable Workers Paid, R2, paid add-ons, or add a payment method for DeanMusic.
- Confirm the D1 database name is `deanmusic-db` and belongs to the DeanMusic app before running any command.

## 1. Connect the website

1. Open Cloudflare Dashboard > Workers & Pages.
2. Choose Create application > Pages > Connect to Git.
3. Select the GitHub repository `jelsonroqueza/DeanMusic`.
4. Select production branch `main`.
5. Set framework preset to Vite.
6. Build command: `npm run build`.
7. Build output directory: `dist`.
8. Deploy. Do not connect the Pages project to any GENMERCH repository.

## 2. Create a separate D1 database

1. In Cloudflare Dashboard > Storage & databases > D1 SQL Database, create `deanmusic-db`.
2. Copy its Database ID.
3. Open this repository's `wrangler.toml`.
4. Replace `REPLACE_WITH_DEANMUSIC_D1_DATABASE_ID` with the new ID.
5. Commit that change to GitHub.

Do not use a database ID from GENMERCH or another project.

## 3. Add server-side environment variables

In the DeanMusic Pages project, open Settings > Variables and Secrets. Configure these for Production and Preview:

- `BETTER_AUTH_SECRET`: encrypted secret, at least 32 random characters. Generate a new random value and keep it private.
- `APP_ORIGIN`: the exact origin of this Pages website, for example `https://deanmusic.pages.dev`.
- `ADMIN_EMAILS`: plain variable containing the comma-separated email allowlist for DeanMusic administrators. The API compares the signed-in session email server-side.

Never put these values in a `VITE_` variable, GitHub file, frontend code, or chat. Never share the Better Auth secret.

## 4. Configure the first administrator

`ADMIN_EMAILS` is defined as a plain server-side variable under `[env.production.vars]` in `wrangler.toml`. It contains the exact approved administrator email address(es), separated by commas. This is not a `VITE_` frontend variable or a secret. Preview builds use the production `APP_ORIGIN` only for safe session handling and set `ADMIN_ACCESS_DISABLED = "true"`, so admin endpoints remain unavailable there. Keep Preview read-only until it has separate staging D1 and media-storage bindings. The existing `admins` D1 table remains supported for additional database-managed administrators in Production.

## 5. Apply the D1 migration

From a terminal inside this repository:

```bash
npm install
npx wrangler login
npx wrangler d1 migrations apply deanmusic-db --remote
```

Wrangler reads the single migration from `cloudflare/migrations` as configured in `wrangler.toml`. Review the target database name before confirming. The migration creates Better Auth core tables, the music catalog, user-owned playlist/like tables, indexes, and one demo track.

## 6. Verify

After the next deployment, check:

1. Open `https://<your-pages-domain>/api/health`; expect JSON with `ok: true`.
2. Open the homepage and confirm the public demo catalog is visible.
3. Create a test account.
4. Sign out and sign in again.
5. Like and unlike the demo track.
6. Create a playlist.
7. Create a second test account and confirm it cannot see the first account's private playlists or liked songs.

If one check fails, stop and inspect the deployment logs and D1 migration state. Do not change GENMERCH or upgrade the Cloudflare plan to work around errors.

## Current limitations

- The player currently plays an original browser-generated synth demo, not a third-party recording.
- The initial beta does not include an admin upload interface or a commercial music catalog.
- Public launch of any uploaded music requires documented streaming/distribution rights.
- R2 and Google Drive public streaming integration are not part of the strict $0 setup.
