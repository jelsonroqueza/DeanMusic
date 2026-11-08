# DeanMusic

DeanMusic is a responsive public music discovery and streaming web application.

## Free-tier stack

- React + TypeScript + Vite frontend
- Cloudflare Pages Free hosting
- Cloudflare Pages Functions / Workers Free API
- Cloudflare D1 Free database
- Better Auth email/password authentication
- GitHub source control
- Google Drive as a private master archive / backup only

Cloudflare R2 and Supabase are intentionally excluded from the strict zero-cost setup. The first beta uses one short original instrumental sample bundled as a static Pages asset. Static audio assets must remain within Cloudflare Pages' individual file-size limit.

## Initial beta features

- Responsive desktop and mobile music interface
- Search and genre filtering
- Original demo sample playback with seek, volume, shuffle, and repeat controls
- Email/password account creation, login, and logout through Better Auth
- User-owned playlists and liked songs stored in D1
- D1 schema with indexes and seeded demo catalog
- Server-side session checks and ownership-constrained database queries

The first beta is a foundation, not a full Spotify replacement. Playlist editing, queue editing, artist and album pages, admin music management, and a larger rights-cleared catalog are later milestones.

## Strict cost and safety rules

- Use free tiers only. Never enable a paid plan, metered add-on, or billing-dependent service without Dean's explicit approval.
- Do not use Supabase for DeanMusic.
- Do not activate Cloudflare R2 during the strict $0 phase.
- Do not modify, connect to, or use any GENMERCH resource.
- Never commit secrets or private credentials.
- Only publish music Dean owns or has permission to distribute and stream.
- If a free quota is reached, fail gracefully instead of upgrading automatically.

## Local development

1. Install Node.js 22 LTS or later.
2. Run npm install.
3. Run npm run dev for the frontend shell.
4. Run npm run build to check the production bundle.
5. API features require the Cloudflare Pages Functions runtime and a configured D1 binding.

## Cloudflare setup — Free plan only

1. Open Cloudflare Dashboard > Workers & Pages.
2. Create a Pages project connected to the GitHub repository jelsonroqueza/DeanMusic, production branch main.
3. Set build command to npm run build and output directory to dist.
4. Remain on Cloudflare Free. Do not activate Workers Paid or R2.
5. Create a separate D1 database named deanmusic-db. Do not use a GENMERCH database.
6. Replace the placeholder database_id in wrangler.toml with the new DeanMusic D1 ID.
7. Apply cloudflare/migrations/0001_init.sql to that D1 database.
8. In Pages > Settings > Variables and Secrets, add encrypted secret BETTER_AUTH_SECRET (at least 32 random characters), plain variable APP_ORIGIN (the exact pages.dev origin), and optionally ADMIN_EMAILS (comma-separated admin emails).
9. Redeploy and test /api/health, account registration, login, logout, liking a track, and playlist creation.

## D1 setup commands

    npx wrangler login
    npx wrangler d1 create deanmusic-db
    npx wrangler d1 execute deanmusic-db --remote --file=cloudflare/migrations/0001_init.sql

Run the migration only after confirming the target D1 database belongs to DeanMusic. Never paste credentials or secret values into commits, issues, or public chat.
