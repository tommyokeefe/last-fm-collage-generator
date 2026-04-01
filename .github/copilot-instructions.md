# Copilot Instructions

## What This App Does

Browser-only React SPA that generates album cover collages from a user's Last.fm listening history. It fetches scrobble data client-side, ranks albums by play count or approximate listening time, renders a collage preview, and exports it as a PNG. Album artwork and track durations are supplemented from MusicBrainz when Last.fm data is missing. Settings and album overrides persist to `localStorage`.

## Commands

```bash
npm run dev           # Start dev server (http://localhost:5173)
npm run build         # Production build → dist/
npm run typecheck     # TypeScript check (tsc -b)
npm run lint          # ESLint check
npm run test:unit     # Vitest unit tests (one-shot)
npm run test:unit:watch  # Vitest in watch mode
npm run test:e2e      # Cypress e2e (spins up Vite preview server first)
npm run test:e2e:open # Open Cypress interactive runner
npm test              # All tests (unit + e2e)
```

**Run a single unit test file:**
```bash
npm run test:unit -- src/lib/lastfm.test.ts
```

**Run a single unit test by name:**
```bash
npm run test:unit -- --reporter=verbose -t "test name pattern"
```

## Architecture

### File Layout
```
src/
├── App.tsx          # Monolithic main component (~2200 lines); all UI state lives here
├── types.ts         # All TypeScript interfaces and types
├── index.css        # Tailwind directives + custom CSS variables + dark mode
├── lib/
│   ├── lastfm.ts    # Last.fm/MusicBrainz API calls, scrobble aggregation, ranking
│   └── collage.ts   # Canvas-based PNG rendering logic
└── test/setup.ts    # Vitest/jsdom setup; mocks localStorage
```

### Component Structure

`App.tsx` is a single monolithic component. Sub-components (`StatusBanner`, `FetchProgress`, `PreviewGrid`, `AlbumEditModal`, `ExportPreview`, etc.) are defined as functions **inside** the file but **outside** the main `App` function. All shared state lives in `App` via `useState`/`useRef`/`useMemo`.

### Data Flow

```
Form input → handleGenerate()
  → fetchRecentTracks()       [Last.fm: user.getrecenttracks, paginated]
  → aggregateAlbums()         [dedup scrobbles into ranked album list]
  → applyCachedArtwork()      [restore localStorage-cached images]
  → hydrateApproximateListeningTimes()  [if listening-time mode; fetches track durations]
  → sortAlbums()
  → generatedResult + generatedResultCache
  → PreviewGrid / ExportPreview / MissingDataPanel
```

Exports go through `renderExportBlob()` in `lib/collage.ts` which draws to an HTML5 Canvas.

### State Management

Pure React hooks — no Redux, Zustand, or Context. Key state buckets in `App`:
- `settings` — user config, synced to `localStorage`
- `generatedResult` — current collage output
- `generatedResultCache` — keyed cache for quick mode-switching without re-fetching
- `renderedAlbums` — derived visible slice (limited by grid size)
- Loading flags: `isBusy`, `isLoadingAlbumTracks`, `isRefreshingAlbumArtwork`, etc.
- `editingAlbum` / `albumEditDraft` — album edit modal state
- `exportPreviewBlob` / `exportPreviewUrl` — PNG preview state

### External APIs

| Service | Methods Used | Purpose |
|---|---|---|
| Last.fm (`ws.audioscrobbler.com`) | `user.getrecenttracks`, `track.getInfo`, `album.getInfo` | Scrobble history, track durations, artwork |
| MusicBrainz (`musicbrainz.org`) | Recording/release lookups | Fallback for missing durations and artwork |

API key is read from `VITE_LASTFM_API_KEY` (set in `.env.local`). No backend — everything runs in the browser.

### Styling

Tailwind CSS with a custom preset from `@tommyokeefe/theme`. Theme CSS variables (`--theme-surface`, `--theme-foreground`, etc.) are defined in `index.css`. Dark mode via `:root.dark`. Long Tailwind class strings are extracted into module-level constants (e.g., `panelClass`, `buttonClass`) rather than inlined.

## Key Conventions

### Naming
- Event handlers: `handleXxx` (e.g., `handleGenerate`, `handleAlbumHide`)
- Builders/getters/formatters: `buildXxx`, `getXxx`, `formatXxx`, `parseXxx`
- Operations with try/catch: `tryXxx`
- Booleans: `isXxx`, `hasXxx`, `canXxx`, `showXxx`
- localStorage keys: module-level string constants (e.g., `SETTINGS_KEY`)

### TypeScript
- `import type { ... }` enforced by ESLint for type-only imports
- All shared types defined in `src/types.ts` — add new interfaces there
- Utility/pure functions go at module level, not inside the component

### Tests
- Unit tests colocated: `*.test.ts` / `*.test.tsx` next to source files
- Vitest globals enabled — no need to import `describe`/`it`/`expect`
- Cypress e2e tests intercept Last.fm API requests with `cy.intercept()` and use mock fixtures; base URL is the Vite preview server (`http://127.0.0.1:4173`)
