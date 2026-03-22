# Last.fm Collage Generator

A browser-only React + TypeScript single page app for generating album-cover collages from Last.fm listening history.

## MVP scope

- Fetches listening history directly from Last.fm from the browser
- Supports ranking albums by play count
- Supports approximate listening-time ranking by combining scrobble counts with track duration metadata
- Renders a collage preview in the browser
- Exports the generated collage as a PNG
- Persists the most recent generator settings in local storage
- Targets static deployment, including a Vercel-hosted subdomain

## Configuration

1. Copy `.env.example` to `.env.local`.
2. Set `VITE_LASTFM_API_KEY` to your shared client-side Last.fm API key.

```bash
VITE_LASTFM_API_KEY=your-lastfm-api-key
```

This key is intentionally client-side for the MVP, so treat it as a public application key rather than a secret.

## Running locally

Install dependencies and start the Vite dev server:

```bash
npm install
npm run dev
```

Then open the local URL Vite prints, usually `http://localhost:5173`.

## Quality checks

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run test:e2e
```

Or run the combined test workflow with:

```bash
npm test
```

## Production build

```bash
npm run build
```

The static output is written to `dist/`.

## Deploying to Vercel

- Keep the project as a static site
- Add `VITE_LASTFM_API_KEY` in Vercel project environment variables
- Point your Vercel project to this repository root
- Use the default Vite build command: `npm run build`
- Use the default output directory: `dist`
- Attach the deployed project to the subdomain you want to use

## Notes

- Approximate listening-time mode can undercount when track duration metadata is unavailable from Last.fm.
- Large time ranges can require many Last.fm API calls and may take longer to generate.
- Unit and component tests use Vitest + React Testing Library.
- End-to-end tests use Cypress against mocked Last.fm responses.
- The app uses React + TypeScript with Vite so future feature work is easier to organize while still deploying cleanly as a static Vercel site.
