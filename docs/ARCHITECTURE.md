# DeanMusic architecture and trust boundaries

## Runtime
The browser loads static files and audio from Cloudflare Pages. Requests under /api are handled by Pages Functions in functions/api/[[path]].ts. The function receives the D1 binding and creates Better Auth with a server-only encrypted secret.

## Identity and ownership
- Better Auth manages account, password hash, and session records in D1.
- The browser sends session cookies; it never receives a database connection or database secret.
- Private API endpoints validate the session server-side and derive user.id from the validated session.
- Playlist and likes operations are constrained by the authenticated user ID.
- Admin track listing checks a server-side ADMIN_EMAILS allowlist.

## Media delivery
- The initial beta contains one short original instrumental sample under public/audio.
- Each bundled Pages asset must stay under the current Pages file-size limit.
- Google Drive is a private archive/backup, not a public streaming endpoint.
- Cloudflare R2 is excluded until Dean explicitly approves a billing-enabled setup.
- Only music with public streaming/distribution rights may be published.

## Free-tier behavior
The app must not upgrade itself or activate billing. If Cloudflare free limits are reached, requests may fail; show recoverable errors and keep billing disabled.

## GENMERCH isolation
DeanMusic has its own GitHub repository, Cloudflare Pages project, D1 database, configuration, environment variables, and deployment. It must never read or write GENMERCH source, Supabase projects, data, secrets, domains, or deployments.
