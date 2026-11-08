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
7. Apply the single migration `cloudflare/migrations/0001_init.sql` to that D1 database.
8. In Pages > Settings > Variables and Secrets, set:
   - encrypted secret `BETTER_AUTH_SECRET` (generate a random secret of at least 32 characters)
   - plain variable `APP_ORIGIN` (the exact deployed `https://<project>.pages.dev` origin)
   - optional plain variable `ADMIN_EMAILS` (comma-separated admin email allowlist)
9. Redeploy. Test `/api/health`, registration, login, logout, liking a track, and playlist creation.

## D1 setup commands

```bash
npx wrangler login
npx wrangler d1 create deanmusic-db
# Copy the newly created DeanMusic database ID into wrangler.toml.
npx wrangler d1 execute deanmusic-db --remote --file=cloudflare/migrations/0001_init.sql
```

Run the migration only after confirming the target D1 database name and ID belong to DeanMusic. Never paste credentials or secret values into commits, issues, prompts, or public chat.
