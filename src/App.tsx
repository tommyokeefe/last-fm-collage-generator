import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { renderExportBlob } from "./lib/collage";
import {
  aggregateAlbums,
  buildTimeRange,
  fetchRecentTracks,
  formatMetric,
  hydrateApproximateListeningTimes,
  sortAlbums,
} from "./lib/lastfm";
import type {
  AlbumEntry,
  GridSize,
  PreviewGridStyle,
  RankingMode,
  Settings,
  StatusState,
  SummaryState,
  TimeRangeValue,
} from "./types";

const SETTINGS_KEY = "lastfm-collage-settings";
const TIME_RANGE_OPTIONS: ReadonlyArray<{ value: TimeRangeValue; label: string }> = [
  { value: "7d", label: "Last 7 days" },
  { value: "1m", label: "Last 30 days" },
  { value: "3m", label: "Last 90 days" },
  { value: "6m", label: "Last 180 days" },
  { value: "12m", label: "Last 365 days" },
  { value: "overall", label: "Overall" },
];
const GRID_OPTIONS: ReadonlyArray<GridSize> = ["3x3", "4x4", "5x5", "6x6"];
const DEFAULT_SETTINGS: Settings = {
  username: "",
  timeRange: "1m",
  gridSize: "4x4",
  rankingMode: "plays",
};

function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [status, setStatus] = useState<StatusState>({
    tone: getApiKey() ? "success" : "info",
    message: getApiKey()
      ? "Ready to generate a collage."
      : "Add VITE_LASTFM_API_KEY to your environment to start.",
  });
  const [isBusy, setIsBusy] = useState(false);
  const [summary, setSummary] = useState<SummaryState | null>(null);
  const [renderedAlbums, setRenderedAlbums] = useState<AlbumEntry[]>([]);
  const [resultsCopy, setResultsCopy] = useState(
    "Your collage will appear here after generation.",
  );

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  const { rows, columns } = useMemo(
    () => parseGridSize(settings.gridSize),
    [settings.gridSize],
  );

  const canExport = !isBusy && renderedAlbums.length > 0;

  async function handleGenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const apiKey = getApiKey();
    if (!apiKey) {
      setStatus({
        tone: "error",
        message:
          "Missing Last.fm API key. Set VITE_LASTFM_API_KEY before generating a collage.",
      });
      return;
    }

    if (!settings.username.trim()) {
      setStatus({
        tone: "error",
        message: "Enter a Last.fm username to continue.",
      });
      return;
    }

    setIsBusy(true);
    setStatus({
      tone: "info",
      message: "Fetching listening history from Last.fm...",
    });

    try {
      const timeRange = buildTimeRange(settings.timeRange);
      const recentTracks = await fetchRecentTracks(
        settings.username.trim(),
        timeRange,
        apiKey,
        (message) => setStatus({ tone: "info", message }),
      );
      const aggregated = aggregateAlbums(recentTracks.items);

      if (aggregated.length === 0) {
        setRenderedAlbums([]);
        setSummary(null);
        setResultsCopy("No collage generated yet.");
        setStatus({
          tone: "error",
          message: "No album scrobbles were found for that username and time range.",
        });
        return;
      }

      let durationGaps = 0;
      if (settings.rankingMode === "listening-time") {
        durationGaps = await hydrateApproximateListeningTimes(
          aggregated,
          apiKey,
          (message) => setStatus({ tone: "info", message }),
        );
      }

      const sorted = sortAlbums(aggregated, settings.rankingMode);
      const nextRenderedAlbums = sorted.slice(0, rows * columns);

      setRenderedAlbums(nextRenderedAlbums);
      setSummary({
        scrobbles: recentTracks.items.length,
        albums: aggregated.length,
        pages: recentTracks.pagesFetched,
        durationGaps,
      });
      setResultsCopy(
        `Showing the top ${nextRenderedAlbums.length} albums for ${settings.username.trim()}, ${
          settings.rankingMode === "plays"
            ? "ranked by album plays."
            : "ranked by approximate listening time."
        }`,
      );
      setStatus({
        tone: "success",
        message: "Collage generated successfully.",
      });
    } catch (error) {
      console.error(error);
      setRenderedAlbums([]);
      setSummary(null);
      setResultsCopy("Your collage will appear here after generation.");
      setStatus({
        tone: "error",
        message: error instanceof Error ? error.message : "Something went wrong.",
      });
    } finally {
      setIsBusy(false);
    }
  }

  async function handleExport() {
    if (!canExport) {
      return;
    }

    setIsBusy(true);
    setStatus({ tone: "info", message: "Rendering PNG export..." });

    try {
      const blob = await renderExportBlob(
        renderedAlbums,
        rows,
        columns,
        settings.rankingMode,
      );
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `${settings.username.trim() || "lastfm-user"}-${rows}x${columns}-${settings.rankingMode}.png`;
      link.click();
      window.URL.revokeObjectURL(objectUrl);
      setStatus({ tone: "success", message: "Export complete." });
    } catch (error) {
      console.error(error);
      setStatus({
        tone: "error",
        message: error instanceof Error ? error.message : "PNG export failed.",
      });
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="page-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">React + Vite + TypeScript</p>
          <h1>Last.fm Collage Generator</h1>
          <p className="hero-copy">
            Generate album-cover collages directly in the browser from your
            Last.fm listening history.
          </p>
        </div>
        <div className="hero-card">
          <p className="hero-card-label">Deployment target</p>
          <p>Static site for a Vercel-hosted subdomain</p>
        </div>
      </header>

      <main className="layout">
        <section className="panel controls-panel">
          <h2>Generate a collage</h2>
          <form className="controls-form" onSubmit={(event) => void handleGenerate(event)}>
            <label>
              <span>Last.fm username</span>
              <input
                type="text"
                autoComplete="username"
                placeholder="Enter a Last.fm username"
                value={settings.username}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    username: event.target.value,
                  }))
                }
                disabled={isBusy}
                required
              />
            </label>

            <label>
              <span>Time range</span>
              <select
                value={settings.timeRange}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    timeRange: event.target.value as TimeRangeValue,
                  }))
                }
                disabled={isBusy}
              >
                {TIME_RANGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Grid size</span>
              <select
                value={settings.gridSize}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    gridSize: event.target.value as GridSize,
                  }))
                }
                disabled={isBusy}
              >
                {GRID_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option.replace("x", " x ")}
                  </option>
                ))}
              </select>
            </label>

            <fieldset className="mode-fieldset">
              <legend>Album ranking mode</legend>
              <label className="radio-option">
                <input
                  type="radio"
                  name="rankingMode"
                  value="plays"
                  checked={settings.rankingMode === "plays"}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      rankingMode: event.target.value as RankingMode,
                    }))
                  }
                  disabled={isBusy}
                />
                <span>Most plays per album</span>
              </label>
              <label className="radio-option">
                <input
                  type="radio"
                  name="rankingMode"
                  value="listening-time"
                  checked={settings.rankingMode === "listening-time"}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      rankingMode: event.target.value as RankingMode,
                    }))
                  }
                  disabled={isBusy}
                />
                <span>Approximate listening time per album</span>
              </label>
            </fieldset>

            <div className="button-row">
              <button type="submit" disabled={isBusy}>
                {isBusy ? "Generating..." : "Generate collage"}
              </button>
              <button type="button" onClick={() => void handleExport()} disabled={!canExport}>
                Export PNG
              </button>
            </div>
          </form>

          <StatusBanner status={status} />
          <SummaryPanel summary={summary} />
        </section>

        <section className="panel results-panel">
          <div className="results-header">
            <div>
              <h2>Preview</h2>
              <p className="results-copy">{resultsCopy}</p>
            </div>
          </div>

          <PreviewGrid
            albums={renderedAlbums}
            columns={columns}
            rankingMode={settings.rankingMode}
          />
        </section>
      </main>
    </div>
  );
}

interface StatusBannerProps {
  status: StatusState;
}

function StatusBanner({ status }: StatusBannerProps) {
  const className = [
    "status-banner",
    status.tone === "error" ? "is-error" : "",
    status.tone === "success" ? "is-success" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return <div className={className}>{status.message}</div>;
}

interface SummaryPanelProps {
  summary: SummaryState | null;
}

function SummaryPanel({ summary }: SummaryPanelProps) {
  if (!summary) {
    return null;
  }

  return (
    <dl className="summary-list">
      <div>
        <dt>Scrobbles</dt>
        <dd>{summary.scrobbles.toLocaleString()}</dd>
      </div>
      <div>
        <dt>Albums found</dt>
        <dd>{summary.albums.toLocaleString()}</dd>
      </div>
      <div>
        <dt>Pages fetched</dt>
        <dd>{summary.pages.toLocaleString()}</dd>
      </div>
      <div>
        <dt>Duration gaps</dt>
        <dd>{summary.durationGaps.toLocaleString()}</dd>
      </div>
    </dl>
  );
}

interface PreviewGridProps {
  albums: AlbumEntry[];
  columns: number;
  rankingMode: RankingMode;
}

function PreviewGrid({ albums, columns, rankingMode }: PreviewGridProps) {
  const style: PreviewGridStyle = {
    "--columns": columns,
  };

  if (albums.length === 0) {
    return (
      <div className="preview-grid" style={style}>
        <div className="empty-state">
          <p>No collage generated yet.</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="preview-grid"
      style={style}
      aria-live="polite"
      aria-label="Generated collage preview"
    >
      {albums.map((album, index) => (
        <article
          key={`${album.artist}-${album.album}-${index}`}
          className={`album-tile ${album.imageUrl ? "" : "is-placeholder"}`}
        >
          <div className="tile-rank">#{index + 1}</div>
          {album.imageUrl ? (
            <img src={album.imageUrl} alt={`${album.album} by ${album.artist}`} />
          ) : (
            <div className="placeholder-copy">
              <strong>{album.album}</strong>
              <span>{album.artist}</span>
            </div>
          )}
          <div className="tile-meta">
            <strong>{album.album}</strong>
            <span>{album.artist}</span>
            <div className="tile-metric">{formatMetric(album, rankingMode)}</div>
          </div>
        </article>
      ))}
    </div>
  );
}

function parseGridSize(value: GridSize): { rows: number; columns: number } {
  const [rawRows, rawColumns] = value.split("x").map(Number);
  const rows = typeof rawRows === "number" && Number.isFinite(rawRows) ? rawRows : 4;
  const columns =
    typeof rawColumns === "number" && Number.isFinite(rawColumns) ? rawColumns : 4;
  return { rows, columns };
}

function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return DEFAULT_SETTINGS;
    }

    const parsed = JSON.parse(raw) as Partial<Settings> | null;
    if (!parsed || typeof parsed !== "object") {
      return DEFAULT_SETTINGS;
    }

    const timeRange = TIME_RANGE_OPTIONS.some((option) => option.value === parsed.timeRange)
      ? (parsed.timeRange as TimeRangeValue)
      : DEFAULT_SETTINGS.timeRange;

    return {
      username: typeof parsed.username === "string" ? parsed.username : DEFAULT_SETTINGS.username,
      timeRange,
      gridSize: GRID_OPTIONS.includes(parsed.gridSize as GridSize)
        ? (parsed.gridSize as GridSize)
        : DEFAULT_SETTINGS.gridSize,
      rankingMode: parsed.rankingMode === "listening-time" ? "listening-time" : "plays",
    };
  } catch (error) {
    console.warn("Could not restore saved settings", error);
    return DEFAULT_SETTINGS;
  }
}

function getApiKey(): string {
  const value: unknown = import.meta.env.VITE_LASTFM_API_KEY;
  return typeof value === "string" ? value.trim() : "";
}

export default App;
