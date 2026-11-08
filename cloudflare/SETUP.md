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

Never put these values in a `VITE_` variable, GitHub file, frontend code, or chat. Never share the Better Auth secret.

## 4. Administrator provisioning

Admin privileges are granted only to an authenticated account whose user ID is explicitly present in the DeanMusic D1 `admins` table. Do not use an email allowlist while email verification is disabled. The first administrator can be provisioned once using the short-lived activation flow in the account Profile page. The token hash, approved email, and expiry are configured only in Production variables; the plain one-time token is not stored in the repository. Production explicitly re-declares the DeanMusic D1 (`DB`) and KV (`MEDIA`) bindings because named Cloudflare environments do not inherit top-level bindings. Preview builds set `ADMIN_ACCESS_DISABLED = "true"` and intentionally have no D1, KV, or R2 bindings until separate staging resources exist; keep Preview read-only and do not point it at production data. The API can use an optional `MEDIA_R2` binding when a dedicated production bucket is provisioned; until then it falls back to the existing KV namespace.

## 5. Apply the D1 migrations

From a terminal inside this repository:

```bash
npm install
npx wrangler login
npx wrangler d1 migrations apply deanmusic-db --remote
```

Wrangler reads all versioned SQL migrations from `cloudflare/migrations` as configured in `wrangler.toml`. Review the target database name before confirming. This applies the base schema (`0001_init.sql`) and the Admin Centre schema (`0002_public_albums_admin.sql`) in order. The first valid owner activation also has a narrowly scoped schema-recovery step if migration `0002` was missed.

## 6. Optional R2 media storage (requires separate billing approval)

R2 is not enabled by this repository's current configuration. Do not create a bucket, add a payment method, or add this binding without Dean's separate approval of the paid R2 setup.

After approval and creation of the dedicated Standard bucket named `deanmusic-media`, add this to the production environment section of `wrangler.toml`:

```toml
[[env.production.r2_buckets]]
binding = "MEDIA_R2"
bucket_name = "deanmusic-media"
```

Do not add an R2 binding under Preview. The DeanMusic API enforces an application-level 80 GB warning and 100 GB upload ceiling. That is not a Cloudflare billing cap: R2 request operations and usage outside the DeanMusic application can still incur charges. Cloudflare budget alerts are notifications and do not stop usage automatically.

## 7. Verify

After the next deployment, check:

1. Open `https://<your-pages-domain>/api/health`; expect JSON with `ok: true`.
2. Open the homepage and confirm the public demo catalog is visible.
3. Create a test account.
4. Sign out and sign in again.
5. Like and unlike the demo track.
6. Create a playlist.
7. Create a second test account and confirm it cannot see the first account's private playlists or liked songs.
8. In Admin Centre, upload one audio file and a 15-second HD 9:16 MP4/WebM Canvas video; verify it stays synchronized with playback, pauses with the song, and loops.
9. Test a multi-file audio batch and confirm each successful track appears in the selected album.

If one check fails, stop and inspect the deployment logs and D1 migration state. Do not change GENMERCH or upgrade the Cloudflare plan to work around errors.

## Current limitations

- The player currently plays an original browser-generated synth demo, not a third-party recording.
- Admin Centre code is available in Production; admin access remains locked until the first administrator is securely provisioned. The first valid activation can recover missing Admin Centre schema after validating the owner account and one-time token.
- Public launch of any uploaded music requires documented streaming/distribution rights.
- R2 and Google Drive public streaming integration are not part of the strict $0 setup.
