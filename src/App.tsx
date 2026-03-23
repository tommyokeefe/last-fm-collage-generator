import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { renderExportBlob } from "./lib/collage";
import {
  aggregateAlbums,
  applyCachedArtwork,
  applyCachedDurations,
  buildLastFmAlbumUrl,
  buildMusicBrainzTrackUrl,
  buildTimeRange,
  fetchMissingArtworkFromMusicBrainz,
  fetchMissingDurationsFromMusicBrainz,
  fetchRecentTracks,
  formatMetric,
  getMissingArtworkEntries,
  getMissingDurationEntries,
  getRecentTracksResumeState,
  hydrateApproximateListeningTimes,
  refreshAlbumArtwork,
  saveAlbumOverride,
  saveAlbumArtworkOverride,
  saveTrackDurationOverride,
  sortAlbums,
} from "./lib/lastfm";
import type {
  AlbumEntry,
  ExportRenderOptions,
  FetchProgressState,
  GridSize,
  MissingArtworkEntry,
  MissingDurationEntry,
  PreviewGridStyle,
  RankingMode,
  Settings,
  StatusState,
  SummaryState,
  TimeRangeValue,
} from "./types";

const SETTINGS_KEY = "lastfm-collage-settings";
type PreviewMode = "config" | "export" | "missing-durations" | "missing-artwork";
const TIME_RANGE_OPTIONS: ReadonlyArray<{ value: TimeRangeValue; label: string }> = [
  { value: "7d", label: "Last 7 days" },
  { value: "1m", label: "Last 30 days" },
  { value: "3m", label: "Last 90 days" },
  { value: "6m", label: "Last 180 days" },
  { value: "12m", label: "Last 365 days" },
  { value: "overall", label: "Overall" },
];
const GRID_OPTIONS: ReadonlyArray<GridSize> = [
  "3x3",
  "4x4",
  "5x5",
  "6x6",
  "7x7",
  "8x8",
  "9x9",
  "10x10",
];
const DEFAULT_SETTINGS: Settings = {
  username: "",
  timeRange: "1m",
  gridSize: "4x4",
  rankingMode: "plays",
  showAlbumInfo: true,
  showMetric: true,
};

interface GeneratedResultState {
  query: {
    username: string;
    timeRange: TimeRangeValue;
    rankingMode: RankingMode;
  };
  albums: AlbumEntry[];
}

interface AlbumEditDraft {
  album: string;
  artist: string;
  imageUrl: string;
}

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
  const [generatedResult, setGeneratedResult] = useState<GeneratedResultState | null>(null);
  const [editingAlbum, setEditingAlbum] = useState<AlbumEntry | null>(null);
  const [albumEditDraft, setAlbumEditDraft] = useState<AlbumEditDraft | null>(null);
  const [isRefreshingAlbumArtwork, setIsRefreshingAlbumArtwork] = useState(false);
  const [missingArtwork, setMissingArtwork] = useState<MissingArtworkEntry[]>([]);
  const [missingDurations, setMissingDurations] = useState<MissingDurationEntry[]>([]);
  const [imageOverrides, setImageOverrides] = useState<Record<string, string>>({});
  const [durationOverrides, setDurationOverrides] = useState<Record<string, string>>({});
  const [exportPreviewBlob, setExportPreviewBlob] = useState<Blob | null>(null);
  const [exportPreviewUrl, setExportPreviewUrl] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("config");
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
  const trimmedUsername = settings.username.trim();
  const exportRenderOptions = useMemo(
    () => ({
      showAlbumInfo: settings.showAlbumInfo,
      showMetric: settings.showMetric,
    }),
    [settings.showAlbumInfo, settings.showMetric],
  );
  const generatedQuery = useMemo(
    () => ({
      username: trimmedUsername,
      timeRange: settings.timeRange,
      rankingMode: settings.rankingMode,
    }),
    [settings.rankingMode, settings.timeRange, trimmedUsername],
  );

  useEffect(() => {
    if (!generatedResult || !matchesGeneratedQuery(generatedResult, generatedQuery)) {
      return;
    }

    const nextRenderedAlbums = generatedResult.albums.slice(0, rows * columns);
    setRenderedAlbums(nextRenderedAlbums);
    setResultsCopy(
      buildResultsCopy(generatedQuery.username, generatedQuery.rankingMode, nextRenderedAlbums.length),
    );
  }, [columns, generatedQuery, generatedResult, rows]);

  useEffect(() => {
    if (previewMode === "missing-durations" &&
      (settings.rankingMode !== "listening-time" || missingDurations.length === 0)) {
      setPreviewMode("config");
      return;
    }

    if (previewMode === "missing-artwork" && missingArtwork.length === 0) {
      setPreviewMode("config");
    }
  }, [missingArtwork.length, missingDurations.length, previewMode, settings.rankingMode]);

  useEffect(() => {
    let cancelled = false;

    async function syncExactPreview() {
      if (renderedAlbums.length === 0) {
        setNextExportPreview(null);
        return;
      }

      const previewBlob = await tryRenderExportPreview(
        renderedAlbums,
        rows,
        columns,
        settings.rankingMode,
        exportRenderOptions,
      );

      if (!cancelled) {
        setNextExportPreview(previewBlob);
      }
    }

    void syncExactPreview();

    return () => {
      cancelled = true;
    };
  }, [
    columns,
    exportRenderOptions,
    renderedAlbums,
    rows,
    settings.rankingMode,
  ]);

  useEffect(() => {
    return () => {
      if (exportPreviewUrl) {
        window.URL.revokeObjectURL(exportPreviewUrl);
      }
    };
  }, [exportPreviewUrl]);

  const canExport = !isBusy && renderedAlbums.length > 0;

  async function handleGenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const apiKey = getApiKey();
    if (!apiKey) {
      setGeneratedResult(null);
      setMissingArtwork([]);
      setMissingDurations([]);
      setStatus({
        tone: "error",
        message:
          "Missing Last.fm API key. Set VITE_LASTFM_API_KEY before generating a collage.",
      });
      return;
    }

    if (!trimmedUsername) {
      setGeneratedResult(null);
      setMissingArtwork([]);
      setMissingDurations([]);
      setStatus({
        tone: "error",
        message: "Enter a Last.fm username to continue.",
      });
      return;
    }

    const timeRange = buildTimeRange(settings.timeRange);
    const isListeningTimeMode = settings.rankingMode === "listening-time";

    setIsBusy(true);
    setStatus({
      tone: "info",
      message: isListeningTimeMode
        ? "Step 1 of 2: Fetching listening history from Last.fm..."
        : "Fetching listening history from Last.fm...",
    });

    try {
      const recentTracks = await fetchRecentTracks(
        trimmedUsername,
        timeRange,
        apiKey,
        (message) =>
          setStatus((current) => ({
            tone: "info",
            message: isListeningTimeMode ? `Step 1 of 2: ${message}` : message,
            progress: current.progress,
          })),
        (progress) =>
          setStatus({
            tone: "info",
            message: isListeningTimeMode
              ? `Step 1 of 2: Fetching listening history from Last.fm... page ${progress.completed} of ${progress.total}`
              : `Fetching listening history from Last.fm... page ${progress.completed} of ${progress.total}`,
            progress,
          }),
      );
      const aggregated = aggregateAlbums(recentTracks.items);
      applyCachedArtwork(aggregated);

      if (aggregated.length === 0) {
        setGeneratedResult(null);
        setMissingArtwork([]);
        setMissingDurations([]);
        setRenderedAlbums([]);
        setNextExportPreview(null);
        setSummary(null);
        setResultsCopy("No collage generated yet.");
        setStatus({
          tone: "error",
          message: "No album scrobbles were found for that username and time range.",
        });
        return;
      }

      const nextMissingArtwork = getMissingArtworkEntries(aggregated);
      let nextMissingDurations: MissingDurationEntry[] = [];
      if (isListeningTimeMode) {
        setStatus({
          tone: "info",
          message: "Step 2 of 2: Fetching track durations from Last.fm...",
        });
        const listeningTimeResult = await hydrateApproximateListeningTimes(
          aggregated,
          apiKey,
          (message) =>
            setStatus((current) => ({
              tone: "info",
              message: `Step 2 of 2: ${message}`,
              progress: current.progress,
            })),
          (progress) =>
            setStatus({
              tone: "info",
              message: `Step 2 of 2: Fetching track durations from Last.fm... ${progress.completed} of ${progress.total}`,
              progress,
            }),
        );
        nextMissingDurations = listeningTimeResult.missingDurations;
      }

      const sorted = sortAlbums(aggregated, settings.rankingMode);
      const nextRenderedAlbums = sorted.slice(0, rows * columns);

      setGeneratedResult({
        query: {
          username: trimmedUsername,
          timeRange: settings.timeRange,
          rankingMode: settings.rankingMode,
        },
        albums: sorted,
      });
      setMissingArtwork(nextMissingArtwork);
      setMissingDurations(nextMissingDurations);
      setImageOverrides({});
      setDurationOverrides({});
      setRenderedAlbums(nextRenderedAlbums);
      setSummary({
        scrobbles: recentTracks.items.length,
        albums: aggregated.length,
        pages: recentTracks.pagesFetched,
        durationGaps: nextMissingDurations.length,
      });
      setResultsCopy(buildResultsCopy(trimmedUsername, settings.rankingMode, nextRenderedAlbums.length));
      setStatus({
        tone: "success",
        message: "Collage generated successfully.",
      });
    } catch (error) {
      console.error(error);
      setGeneratedResult(null);
      setMissingArtwork([]);
      setMissingDurations([]);
      const resumeState = getRecentTracksResumeState(trimmedUsername, timeRange);
      const baseMessage = error instanceof Error ? error.message : "Something went wrong.";
      setRenderedAlbums([]);
      setNextExportPreview(null);
      setSummary(null);
      setResultsCopy("Your collage will appear here after generation.");
      setStatus({
        tone: "error",
        message: resumeState
          ? `${baseMessage} Retry Generate to resume from page ${resumeState.nextPage} of ${resumeState.totalPages}.`
          : baseMessage,
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
      const blob =
        exportPreviewBlob ??
        (await renderExportBlob(
          renderedAlbums,
          rows,
          columns,
          settings.rankingMode,
          exportRenderOptions,
        ));
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

  async function handleMissingDurationFallbackFetch() {
    if (!generatedResult || missingDurations.length === 0) {
      return;
    }

    setIsBusy(true);
    setStatus({
      tone: "info",
      message: "Trying MusicBrainz for missing track durations...",
    });

    try {
      const fallbackResult = await fetchMissingDurationsFromMusicBrainz(
        missingDurations,
        (message) =>
          setStatus((current) => ({
            tone: "info",
            message,
            progress: current.progress,
          })),
        (progress) =>
          setStatus({
            tone: "info",
            message: `Trying MusicBrainz for missing track durations... ${progress.completed} of ${progress.total}`,
            progress,
          }),
      );
      const nextAlbums = [...generatedResult.albums];
      applyCachedDurations(nextAlbums);
      const nextSortedAlbums = sortAlbums(nextAlbums, generatedResult.query.rankingMode);
      const nextMissingDurations = getMissingDurationEntries(nextSortedAlbums);
      const nextRenderedAlbums = nextSortedAlbums.slice(0, rows * columns);

      setGeneratedResult({
        ...generatedResult,
        albums: nextSortedAlbums,
      });
      setMissingDurations(nextMissingDurations);
      setRenderedAlbums(nextRenderedAlbums);
      setSummary((current) =>
        current
          ? {
              ...current,
              durationGaps: nextMissingDurations.length,
            }
          : current,
      );
      setStatus({
        tone: fallbackResult.resolvedCount > 0 ? "success" : "info",
        message:
          fallbackResult.resolvedCount > 0
            ? `MusicBrainz resolved ${fallbackResult.resolvedCount} missing duration${fallbackResult.resolvedCount === 1 ? "" : "s"}.`
            : "MusicBrainz did not resolve any additional missing durations.",
      });
    } catch (error) {
      console.error(error);
      setStatus({
        tone: "error",
        message: error instanceof Error ? error.message : "MusicBrainz lookup failed.",
      });
    } finally {
      setIsBusy(false);
    }
  }

  async function handleMissingArtworkFallbackFetch() {
    if (!generatedResult || missingArtwork.length === 0) {
      return;
    }

    setIsBusy(true);
    setStatus({
      tone: "info",
      message: "Trying MusicBrainz for missing album artwork...",
    });

    try {
      const fallbackResult = await fetchMissingArtworkFromMusicBrainz(
        missingArtwork,
        (message) =>
          setStatus((current) => ({
            tone: "info",
            message,
            progress: current.progress,
          })),
        (progress) =>
          setStatus({
            tone: "info",
            message: `Trying MusicBrainz for missing album artwork... ${progress.completed} of ${progress.total}`,
            progress,
          }),
      );
      const nextAlbums = [...generatedResult.albums];
      applyCachedArtwork(nextAlbums);
      const nextSortedAlbums = sortAlbums(nextAlbums, generatedResult.query.rankingMode);
      const nextMissingArtwork = getMissingArtworkEntries(nextSortedAlbums);
      const nextRenderedAlbums = nextSortedAlbums.slice(0, rows * columns);

      setGeneratedResult({
        ...generatedResult,
        albums: nextSortedAlbums,
      });
      setMissingArtwork(nextMissingArtwork);
      setRenderedAlbums(nextRenderedAlbums);
      setStatus({
        tone: fallbackResult.resolvedCount > 0 ? "success" : "info",
        message:
          fallbackResult.resolvedCount > 0
            ? `MusicBrainz resolved ${fallbackResult.resolvedCount} missing cover${fallbackResult.resolvedCount === 1 ? "" : "s"}.`
            : "MusicBrainz did not resolve any additional missing album artwork.",
      });
    } catch (error) {
      console.error(error);
      setStatus({
        tone: "error",
        message: error instanceof Error ? error.message : "MusicBrainz artwork lookup failed.",
      });
    } finally {
      setIsBusy(false);
    }
  }

  function handleDurationOverrideSave(track: MissingDurationEntry) {
    const rawValue = durationOverrides[track.trackKey]?.trim() ?? "";
    const seconds = Number(rawValue);
    if (!rawValue || !Number.isFinite(seconds) || seconds <= 0) {
      setStatus({
        tone: "error",
        message: `Enter a valid duration in seconds for ${track.name}.`,
      });
      return;
    }

    if (!generatedResult) {
      return;
    }

    saveTrackDurationOverride(track, seconds * 1000);
    const nextAlbums = [...generatedResult.albums];
    applyCachedDurations(nextAlbums);
    const nextSortedAlbums = sortAlbums(nextAlbums, generatedResult.query.rankingMode);
    const nextMissingDurations = getMissingDurationEntries(nextSortedAlbums);

    setGeneratedResult({
      ...generatedResult,
      albums: nextSortedAlbums,
    });
    setMissingDurations(nextMissingDurations);
    setDurationOverrides((current) => {
      const next = { ...current };
      delete next[track.trackKey];
      return next;
    });
    setSummary((current) =>
      current
        ? {
            ...current,
            durationGaps: nextMissingDurations.length,
          }
        : current,
    );
    setStatus({
      tone: "success",
      message: `Saved a local duration override for ${track.name}.`,
    });
  }

  function handleArtworkOverrideSave(album: MissingArtworkEntry) {
    const rawValue = imageOverrides[album.albumKey]?.trim() ?? "";
    if (!rawValue) {
      setStatus({
        tone: "error",
        message: `Enter a valid image URL for ${album.album}.`,
      });
      return;
    }

    try {
      const parsedUrl = new URL(rawValue);
      if (!/^https?:$/.test(parsedUrl.protocol)) {
        throw new Error("Unsupported protocol");
      }
    } catch {
      setStatus({
        tone: "error",
        message: `Enter a valid image URL for ${album.album}.`,
      });
      return;
    }

    if (!generatedResult) {
      return;
    }

    saveAlbumArtworkOverride(album, rawValue);
    const nextAlbums = [...generatedResult.albums];
    applyCachedArtwork(nextAlbums);
    const nextSortedAlbums = sortAlbums(nextAlbums, generatedResult.query.rankingMode);
    const nextMissingArtwork = getMissingArtworkEntries(nextSortedAlbums);

    setGeneratedResult({
      ...generatedResult,
      albums: nextSortedAlbums,
    });
    setMissingArtwork(nextMissingArtwork);
    setImageOverrides((current) => {
      const next = { ...current };
      delete next[album.albumKey];
      return next;
    });
    setRenderedAlbums(nextSortedAlbums.slice(0, rows * columns));
    setStatus({
      tone: "success",
      message: `Saved a local artwork override for ${album.album}.`,
    });
  }

  function handleAlbumEditOpen(album: AlbumEntry) {
    setEditingAlbum(album);
    setAlbumEditDraft({
      album: album.album,
      artist: album.artist,
      imageUrl: album.imageUrl,
    });
  }

  function handleAlbumEditClose() {
    setEditingAlbum(null);
    setAlbumEditDraft(null);
    setIsRefreshingAlbumArtwork(false);
  }

  function validateAlbumEditDraft(): AlbumEditDraft | null {
    if (!albumEditDraft) {
      return null;
    }

    const trimmedDraft = {
      album: albumEditDraft.album.trim(),
      artist: albumEditDraft.artist.trim(),
      imageUrl: albumEditDraft.imageUrl.trim(),
    };

    if (!trimmedDraft.album || !trimmedDraft.artist) {
      setStatus({
        tone: "error",
        message: "Enter both an album title and an artist label.",
      });
      return null;
    }

    if (trimmedDraft.imageUrl) {
      try {
        const parsedUrl = new URL(trimmedDraft.imageUrl);
        if (!/^https?:$/.test(parsedUrl.protocol)) {
          throw new Error("Unsupported protocol");
        }
      } catch {
        setStatus({
          tone: "error",
          message: `Enter a valid image URL for ${trimmedDraft.album}.`,
        });
        return null;
      }
    }

    return trimmedDraft;
  }

  function applyAlbumEditDraft(trimmedDraft: AlbumEditDraft) {
    if (!generatedResult || !editingAlbum || !albumEditDraft) {
      return;
    }

    const nextSortedAlbums = generatedResult.albums.map((candidate) =>
      candidate === editingAlbum
        ? {
            ...candidate,
            album: trimmedDraft.album,
            artist: trimmedDraft.artist,
            artistNames: new Set([trimmedDraft.artist]),
            imageUrl: trimmedDraft.imageUrl,
          }
        : candidate,
    );
    const nextMissingArtwork = getMissingArtworkEntries(nextSortedAlbums);
    const nextMissingDurations = getMissingDurationEntries(nextSortedAlbums);
    const nextRenderedAlbums = nextSortedAlbums.slice(0, rows * columns);

    setGeneratedResult({
      ...generatedResult,
      albums: nextSortedAlbums,
    });
    setMissingArtwork(nextMissingArtwork);
    setMissingDurations(nextMissingDurations);
    setRenderedAlbums(nextRenderedAlbums);
    setResultsCopy(
      nextRenderedAlbums.length > 0
        ? buildResultsCopy(trimmedUsername, settings.rankingMode, nextRenderedAlbums.length)
        : "No albums remain in the collage.",
    );
    setSummary((current) =>
      current
        ? {
            ...current,
            albums: nextSortedAlbums.length,
            durationGaps: nextMissingDurations.length,
          }
        : current,
    );
    setStatus({
      tone: "success",
      message: `Saved edits for ${trimmedDraft.album}.`,
    });
    handleAlbumEditClose();
  }

  function handleAlbumEditSave() {
    const trimmedDraft = validateAlbumEditDraft();
    if (!trimmedDraft) {
      return;
    }

    applyAlbumEditDraft(trimmedDraft);
  }

  function handleAlbumEditCacheSave() {
    const trimmedDraft = validateAlbumEditDraft();
    if (!trimmedDraft || !editingAlbum) {
      return;
    }

    saveAlbumOverride(editingAlbum, trimmedDraft);
    applyAlbumEditDraft(trimmedDraft);
  }

  async function handleAlbumArtworkRefresh() {
    const apiKey = getApiKey();
    if (!editingAlbum || !apiKey) {
      return;
    }

    setIsRefreshingAlbumArtwork(true);
    try {
      const refreshedImageUrl = await refreshAlbumArtwork(editingAlbum, apiKey);
      if (!refreshedImageUrl) {
        setStatus({
          tone: "info",
          message: `No refreshed artwork was found for ${editingAlbum.album}.`,
        });
        return;
      }

      setAlbumEditDraft((current) =>
        current
          ? {
              ...current,
              imageUrl: refreshedImageUrl,
            }
          : current,
      );
      setStatus({
        tone: "success",
        message: `Refreshed artwork for ${editingAlbum.album}.`,
      });
    } catch (error) {
      console.error(error);
      setStatus({
        tone: "error",
        message: error instanceof Error ? error.message : "Artwork refresh failed.",
      });
    } finally {
      setIsRefreshingAlbumArtwork(false);
    }
  }

  function setNextExportPreview(nextBlob: Blob | null) {
    setExportPreviewBlob(nextBlob);
    setExportPreviewUrl((currentUrl) => {
      if (currentUrl) {
        window.URL.revokeObjectURL(currentUrl);
      }

      return nextBlob ? window.URL.createObjectURL(nextBlob) : null;
    });
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

            <fieldset className="mode-fieldset">
              <legend>True PNG preview and export</legend>
              <label className="checkbox-option">
                <input
                  type="checkbox"
                  checked={settings.showAlbumInfo}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      showAlbumInfo: event.target.checked,
                    }))
                  }
                  disabled={isBusy}
                />
                <span>Show album and artist text</span>
              </label>
              <label className="checkbox-option">
                <input
                  type="checkbox"
                  checked={settings.showMetric}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      showMetric: event.target.checked,
                    }))
                  }
                  disabled={isBusy}
                />
                <span>Show play count or listening time</span>
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
            <div className="preview-mode-toggle" role="tablist" aria-label="Preview modes">
              <button
                type="button"
                className={previewMode === "config" ? "is-active" : ""}
                onClick={() => setPreviewMode("config")}
                aria-pressed={previewMode === "config"}
              >
                Configuration view
              </button>
              <button
                type="button"
                className={previewMode === "export" ? "is-active" : ""}
                onClick={() => setPreviewMode("export")}
                aria-pressed={previewMode === "export"}
              >
                True PNG preview
              </button>
              {missingArtwork.length > 0 ? (
                <button
                  type="button"
                  className={previewMode === "missing-artwork" ? "is-active" : ""}
                  onClick={() => setPreviewMode("missing-artwork")}
                  aria-pressed={previewMode === "missing-artwork"}
                >
                  Missing artwork ({missingArtwork.length})
                </button>
              ) : null}
              {settings.rankingMode === "listening-time" && missingDurations.length > 0 ? (
                <button
                  type="button"
                  className={previewMode === "missing-durations" ? "is-active" : ""}
                  onClick={() => setPreviewMode("missing-durations")}
                  aria-pressed={previewMode === "missing-durations"}
                >
                  Missing durations ({missingDurations.length})
                </button>
              ) : null}
            </div>
          </div>

          {previewMode === "config" ? (
            <PreviewGrid
              albums={renderedAlbums}
              columns={columns}
              onEdit={handleAlbumEditOpen}
              rankingMode={settings.rankingMode}
              showDurationWarnings={settings.rankingMode === "listening-time"}
            />
          ) : previewMode === "missing-artwork" ? (
            <MissingArtworkPanel
              items={missingArtwork}
              imageOverrides={imageOverrides}
              isFetchingFallback={isBusy}
              onImageChange={(albumKey, value) =>
                setImageOverrides((current) => ({
                  ...current,
                  [albumKey]: value,
                }))
              }
              onFetchFallback={() => void handleMissingArtworkFallbackFetch()}
              onSave={handleArtworkOverrideSave}
            />
          ) : previewMode === "missing-durations" ? (
            <MissingDurationPanel
              items={missingDurations}
              durationOverrides={durationOverrides}
              isFetchingFallback={isBusy}
              onDurationChange={(trackKey, value) =>
                setDurationOverrides((current) => ({
                  ...current,
                  [trackKey]: value,
                }))
              }
              onFetchFallback={() => void handleMissingDurationFallbackFetch()}
              onSave={handleDurationOverrideSave}
            />
          ) : (
            <ExportPreview
              exportPreviewUrl={exportPreviewUrl}
              hasAlbums={renderedAlbums.length > 0}
              username={settings.username.trim()}
            />
          )}
        </section>
      </main>
      {editingAlbum && albumEditDraft ? (
        <AlbumEditModal
          draft={albumEditDraft}
          album={editingAlbum}
          isRefreshingArtwork={isRefreshingAlbumArtwork}
          onChange={(key, value) =>
            setAlbumEditDraft((current) =>
              current
                ? {
                    ...current,
                    [key]: value,
                  }
                : current,
            )
          }
          onClose={handleAlbumEditClose}
          onRefreshArtwork={() => void handleAlbumArtworkRefresh()}
          onSaveToCache={handleAlbumEditCacheSave}
          onSave={handleAlbumEditSave}
        />
      ) : null}
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

  return (
    <div className={className}>
      <div className="status-message">{status.message}</div>
      {status.progress ? <FetchProgress progress={status.progress} /> : null}
    </div>
  );
}

interface FetchProgressProps {
  progress: FetchProgressState;
}

function FetchProgress({ progress }: FetchProgressProps) {
  return (
    <div className="status-progress">
      <div className="status-progress-meta">
        <span>
          {progress.unitLabel} {progress.completed} of {progress.total}
        </span>
        <span>
          {progress.completed === 0 && progress.total > 0
            ? "ETA calculating..."
            : `ETA ${formatEta(progress.estimatedRemainingMs)}`}
        </span>
      </div>
      <progress value={progress.completed} max={progress.total}>
        {progress.completed} of {progress.total}
      </progress>
    </div>
  );
}

interface SummaryPanelProps {
  summary: SummaryState | null;
}

interface AlbumEditModalProps {
  album: AlbumEntry;
  draft: AlbumEditDraft;
  isRefreshingArtwork: boolean;
  onChange: (key: keyof AlbumEditDraft, value: string) => void;
  onClose: () => void;
  onRefreshArtwork: () => void;
  onSaveToCache: () => void;
  onSave: () => void;
}

function AlbumEditModal({
  album,
  draft,
  isRefreshingArtwork,
  onChange,
  onClose,
  onRefreshArtwork,
  onSaveToCache,
  onSave,
}: AlbumEditModalProps) {
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-shell" role="dialog" aria-modal="true" aria-label="Edit album metadata">
        <div className="modal-header">
          <div>
            <h2>Edit album</h2>
            <p className="results-copy">
              Update the current collage entry by changing its image, title, or artist label.
            </p>
          </div>
          <button type="button" className="modal-close-button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="album-edit-layout">
          <div className="album-edit-preview">
            {draft.imageUrl ? (
              <img src={draft.imageUrl} alt={`${draft.album} by ${draft.artist}`} />
            ) : (
              <div className="empty-state album-edit-placeholder">
                <p>No image set.</p>
              </div>
            )}
          </div>
          <div className="album-edit-fields">
            <label>
              <span>Album title</span>
              <input
                type="text"
                value={draft.album}
                onChange={(event) => onChange("album", event.target.value)}
              />
            </label>
            <label>
              <span>Artist label</span>
              <input
                type="text"
                value={draft.artist}
                onChange={(event) => onChange("artist", event.target.value)}
              />
            </label>
            <label>
              <span>Image URL</span>
              <input
                type="url"
                placeholder="https://example.com/cover.jpg"
                value={draft.imageUrl}
                onChange={(event) => onChange("imageUrl", event.target.value)}
              />
            </label>
            <div className="album-edit-actions">
              <a
                className="secondary-link"
                href={buildLastFmAlbumUrl({
                  artist: album.sourceArtist,
                  album: album.sourceAlbum,
                })}
                target="_blank"
                rel="noreferrer"
              >
                Update artwork on Last.fm
              </a>
              <button type="button" onClick={onRefreshArtwork} disabled={isRefreshingArtwork}>
                {isRefreshingArtwork ? "Refreshing image..." : "Refresh image"}
              </button>
            </div>
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={onSaveToCache}>
            Add changes to local cache
          </button>
          <button type="button" onClick={onSave}>
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

interface MissingArtworkPanelProps {
  items: MissingArtworkEntry[];
  imageOverrides: Record<string, string>;
  isFetchingFallback: boolean;
  onImageChange: (albumKey: string, value: string) => void;
  onFetchFallback: () => void;
  onSave: (album: MissingArtworkEntry) => void;
}

function MissingArtworkPanel({
  items,
  imageOverrides,
  isFetchingFallback,
  onImageChange,
  onFetchFallback,
  onSave,
}: MissingArtworkPanelProps) {
  if (items.length === 0) {
    return (
      <div className="empty-state missing-artwork-empty">
        <p>No missing artwork remains.</p>
      </div>
    );
  }

  return (
    <div className="missing-artwork-panel">
      <p className="results-copy">
        These albums are missing cover art from Last.fm. You can try fetching album artwork from
        MusicBrainz and the Cover Art Archive without regenerating the collage.
      </p>
      <div className="missing-artwork-toolbar">
        <button type="button" onClick={onFetchFallback} disabled={isFetchingFallback}>
          {isFetchingFallback ? "Trying MusicBrainz..." : "Try fetching artwork from MusicBrainz"}
        </button>
      </div>
      <div className="missing-artwork-list">
        {items.map((album) => (
          <article key={album.albumKey} className="missing-artwork-item">
            <div className="missing-artwork-copy">
              <strong>{album.album}</strong>
              <span>{album.artist}</span>
            </div>
            <div className="missing-artwork-actions">
              <a
                className="secondary-link"
                href={buildLastFmAlbumUrl(album)}
                target="_blank"
                rel="noreferrer"
              >
                Update artwork on Last.fm
              </a>
              <label className="image-override-field">
                <span>Local image URL</span>
                <input
                  type="url"
                  placeholder="https://example.com/cover.jpg"
                  value={imageOverrides[album.albumKey] ?? ""}
                  onChange={(event) => onImageChange(album.albumKey, event.target.value)}
                />
              </label>
              <button type="button" onClick={() => onSave(album)}>
                Save local override
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

interface MissingDurationPanelProps {
  items: MissingDurationEntry[];
  durationOverrides: Record<string, string>;
  isFetchingFallback: boolean;
  onDurationChange: (trackKey: string, value: string) => void;
  onFetchFallback: () => void;
  onSave: (track: MissingDurationEntry) => void;
}

function MissingDurationPanel({
  items,
  durationOverrides,
  isFetchingFallback,
  onDurationChange,
  onFetchFallback,
  onSave,
}: MissingDurationPanelProps) {
  if (items.length === 0) {
    return (
      <div className="empty-state missing-duration-empty">
        <p>No missing durations remain.</p>
      </div>
    );
  }

  return (
    <div className="missing-duration-panel">
      <p className="results-copy">
        These tracks are missing duration metadata. You can open the track page on Last.fm to fix
        it globally, or save a local override in seconds for this browser.
      </p>
      <div className="missing-duration-toolbar">
        <button type="button" onClick={onFetchFallback} disabled={isFetchingFallback}>
          {isFetchingFallback ? "Trying MusicBrainz..." : "Try fetching from MusicBrainz"}
        </button>
      </div>
      <div className="missing-duration-list">
        {items.map((track) => (
          <article key={track.trackKey} className="missing-duration-item">
            <div className="missing-duration-copy">
              <strong>{track.name}</strong>
              <span>
                {track.artist} - {track.album}
              </span>
            </div>
            <div className="missing-duration-actions">
              <a
                className="secondary-link"
                href={buildMusicBrainzTrackUrl(track)}
                target="_blank"
                rel="noreferrer"
              >
                Update on MusicBrainz
              </a>
              <label className="duration-override-field">
                <span>Local duration (sec)</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={durationOverrides[track.trackKey] ?? ""}
                  onChange={(event) => onDurationChange(track.trackKey, event.target.value)}
                />
              </label>
              <button type="button" onClick={() => onSave(track)}>
                Save local override
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
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
  onEdit: (album: AlbumEntry) => void;
  rankingMode: RankingMode;
  showDurationWarnings: boolean;
}

function PreviewGrid({
  albums,
  columns,
  onEdit,
  rankingMode,
  showDurationWarnings,
}: PreviewGridProps) {
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
      {albums.map((album, index) => {
        const hasMissingArtwork = getMissingArtworkEntries([album]).length > 0;
        const hasMissingDurations =
          showDurationWarnings && getMissingDurationEntries([album]).length > 0;
        const hasWarning = hasMissingArtwork || hasMissingDurations;
        const warningClassName =
          hasMissingArtwork && hasMissingDurations
            ? "has-critical-warning"
            : hasMissingArtwork || hasMissingDurations
              ? "has-warning"
              : "";

        return (
          <button
            type="button"
            key={`${album.artist}-${album.album}-${index}`}
            className={`album-tile album-tile-button ${album.imageUrl ? "" : "is-placeholder"} ${warningClassName}`.trim()}
            onClick={() => onEdit(album)}
            aria-label={`Edit ${album.album} by ${album.artist}`}
          >
            {hasWarning ? <span className="tile-warning-icon" aria-hidden="true">!</span> : null}
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
          </button>
        );
      })}
    </div>
  );
}

interface ExportPreviewProps {
  exportPreviewUrl: string | null;
  hasAlbums: boolean;
  username: string;
}

function ExportPreview({ exportPreviewUrl, hasAlbums, username }: ExportPreviewProps) {
  if (!hasAlbums) {
    return (
      <div className="empty-state export-preview-empty">
        <p>No collage generated yet.</p>
      </div>
    );
  }

  if (!exportPreviewUrl) {
    return (
      <div className="empty-state export-preview-empty">
        <p>The exact PNG preview is not available yet.</p>
      </div>
    );
  }

  return (
    <div className="export-preview-shell">
      <img
        className="export-preview-image"
        src={exportPreviewUrl}
        alt={
          username
            ? `Exact PNG preview for ${username}`
            : "Exact PNG preview"
        }
      />
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
      showAlbumInfo:
        typeof parsed.showAlbumInfo === "boolean"
          ? parsed.showAlbumInfo
          : DEFAULT_SETTINGS.showAlbumInfo,
      showMetric:
        typeof parsed.showMetric === "boolean"
          ? parsed.showMetric
          : DEFAULT_SETTINGS.showMetric,
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

function matchesGeneratedQuery(
  generatedResult: GeneratedResultState,
  query: GeneratedResultState["query"],
): boolean {
  return (
    generatedResult.query.username === query.username &&
    generatedResult.query.timeRange === query.timeRange &&
    generatedResult.query.rankingMode === query.rankingMode
  );
}

function buildResultsCopy(
  username: string,
  rankingMode: RankingMode,
  albumCount: number,
): string {
  return `Showing the top ${albumCount} albums for ${username}, ${
    rankingMode === "plays"
      ? "ranked by album plays."
      : "ranked by approximate listening time."
  }`;
}

function formatEta(milliseconds: number): string {
  const totalSeconds = Math.max(Math.round(milliseconds / 1000), 0);
  if (totalSeconds < 60) {
    return totalSeconds <= 1 ? "about 1 sec" : `about ${totalSeconds} sec`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `about ${minutes} min` : `about ${minutes} min ${seconds} sec`;
}

async function tryRenderExportPreview(
  albums: AlbumEntry[],
  rows: number,
  columns: number,
  rankingMode: RankingMode,
  options: ExportRenderOptions,
): Promise<Blob | null> {
  if (albums.length === 0) {
    return null;
  }

  try {
    return await renderExportBlob(albums, rows, columns, rankingMode, options);
  } catch (error) {
    console.error("Could not render exact PNG preview", error);
    return null;
  }
}

export default App;
