# DeanMusic

DeanMusic is a responsive public music-discovery and streaming web application, starting with an original browser-generated demo sound.

## Free-tier stack

- React + TypeScript + Vite frontend
- Cloudflare Pages Free hosting
- Cloudflare Pages Functions / Workers Free API
- Cloudflare D1 Free database
- Better Auth email/password authentication
- GitHub source control
- Google Drive as a private master archive / backup only

Cloudflare R2 and Supabase are intentionally excluded from the strict zero-cost setup. The built-in beta demo sound is generated in the browser with the Web Audio API; the initial app does not download or re-host third-party songs.

## Initial beta features

- Responsive desktop and mobile interface
- Public catalog loaded from D1, with a local demo fallback
- Search and genre filtering
- Original browser-generated synth demo with play, pause, seek, volume, shuffle, and repeat controls
- Email/password sign-up, sign-in, sign-out, and session persistence through Better Auth
- User-owned playlists and liked songs stored in D1
- D1 schema with Better Auth tables, music tables, indexes, and demo catalog
- Server-side session checks, parameterized SQL, and owner-constrained playlist/likes queries

The first beta is a foundation, not a full Spotify replacement. Track uploads, a complete licensed audio catalog, admin music management, playlist editing/reordering, artist and album pages, and email verification are later milestones.

## Admin Centre preview

The first valid owner activation now performs an idempotent schema recovery for the Admin Centre tables and album columns if the production D1 database missed migration `0002`. This recovery runs only after the signed-in approved owner account and one-time activation token have both been validated. The CI workflow also validates every D1 migration in order, including the Admin Centre schema.

The Admin Centre is available in Production only to authenticated user IDs explicitly provisioned in the DeanMusic D1 `admins` table. Preview deployments deliberately disable admin authorization. First-admin provisioning uses a short-lived, single-use activation token bound to the approved email; the token must contain at least 32 cryptographically random bytes, and five incorrect attempts trigger a 15-minute per-account lockout. Its SHA-256 verifier is supplied only as an encrypted Production secret named `ADMIN_BOOTSTRAP_SHA256`; it must never be stored in `wrangler.toml`, GitHub, or frontend code. An email allowlist alone is not used because email verification is disabled. It supports album and artist metadata, cover art uploads, album publishing, sequential multi-file audio uploads, track detail editing, soundtrack deletion, and optional HD vertical 9:16 Canvas videos up to 15 seconds per track. Current file-size limits are 20 MB per audio file, 2 MB per cover image, and 25 MB per Canvas video. The API is R2-ready: it writes to the optional `MEDIA_R2` bucket when that binding exists, otherwise it safely falls back to the existing Cloudflare Workers KV namespace. The intended R2 app-level ceiling is 100 GB with an 80 GB warning, but R2 is not connected or billing-enabled until the bucket and production binding are separately provisioned. This application-level upload ceiling is not a Cloudflare billing cap; R2 operations and usage outside this app can still incur charges. Keep original master files in private Google Drive as a separate archive.

Use **Scan existing KV uploads** in the Admin Centre overview before relying on the KV usage meter. It imports metadata for older KV media files in batches; this scan does not move, edit, or delete stored objects. Canvas upload metadata is also checked server-side by reading the MP4/WebM container, not only from browser-supplied form values.

For a visual-only Admin Centre walkthrough, open the Cloudflare branch Preview URL with `?admin-preview=1`. This displays sample albums/tracks; uploads, publishing, editing, and deleting are disabled, and no catalog API is called by the demo panel.

## Media storage configuration

The optional production R2 binding is named `MEDIA_R2`. After the dedicated bucket `deanmusic-media` has been created and billing has been explicitly approved, add this binding under `[env.production]` in `wrangler.toml`:

```toml
[[env.production.r2_buckets]]
binding = "MEDIA_R2"
bucket_name = "deanmusic-media"
```

Do not add this binding before the bucket exists. Preview intentionally has no production D1, KV, or R2 resources. The 100 GB upload ceiling and 80 GB warning are enforced by the DeanMusic API using its media inventory metadata; they do not cap Cloudflare charges from other sources or R2 operations.

## Strict cost and safety rules

- Use free tiers only. Never enable a paid plan, metered add-on, paid Workers plan, or billing-dependent storage without Dean's explicit approval.
- Do not use Supabase for DeanMusic.
- Do not activate Cloudflare R2 during the strict $0 phase.
- Do not modify, connect to, or use any GENMERCH resource.
- Never commit secrets or private credentials.
- Only publish music Dean owns or has documented permission to distribute and stream.
- If a free quota is reached, fail gracefully instead of upgrading automatically.

## Local development

1. Install Node.js 22.12 or later.
2. Run `npm install`.
3. Run `npm run dev` for the frontend shell.
4. Run `npm run build` for the production bundle.
5. API features require the Cloudflare Pages Functions runtime and a configured D1 binding. Use `npm run cf:dev` after setting up D1 locally.

## Cloudflare setup — Free plan only

1. In Cloudflare Dashboard, open Workers & Pages.
2. Create a Pages project connected to `jelsonroqueza/DeanMusic`, production branch `main`.
3. Set build command to `npm run build` and output directory to `dist`.
4. Remain on Cloudflare Free. Do not select Workers Paid or activate R2.
5. Create a new, separate D1 database named `deanmusic-db`. Do not use a GENMERCH database.
6. Replace the placeholder `database_id` in `wrangler.toml` with this new DeanMusic D1 database ID.
7. Apply all pending migrations in order with `npx wrangler d1 migrations apply deanmusic-db --remote`. This applies the base schema (`0001_init.sql`) and the Admin Centre schema (`0002_public_albums_admin.sql`).
8. In Pages > Settings > Variables and Secrets, set:
   - encrypted secret `BETTER_AUTH_SECRET` (generate a random secret of at least 32 characters)
   - plain variable `APP_ORIGIN` (the exact deployed `https://<project>.pages.dev` origin)
   - Plain Production variables `ADMIN_BOOTSTRAP_EMAIL` and `ADMIN_BOOTSTRAP_EXPIRES_AT` are defined in `wrangler.toml`.
   - Encrypted Production secret `ADMIN_BOOTSTRAP_SHA256` must be added under Cloudflare Pages > Settings > Variables and Secrets. Never store it in `wrangler.toml`.
   - The previous verifier was committed publicly; generate a new 32-byte random activation token and verifier before first-admin activation. Do not reuse the old activation token.
9. Redeploy. Test `/api/health`, registration, login, logout, liking a track, and playlist creation.

## D1 setup commands

```bash
npx wrangler login
npx wrangler d1 create deanmusic-db
# Copy the newly created DeanMusic database ID into wrangler.toml.
npx wrangler d1 migrations apply deanmusic-db --remote
```

Run the migration only after confirming the target D1 database name and ID belong to DeanMusic. Never paste credentials or secret values into commits, issues, prompts, or public chat.
