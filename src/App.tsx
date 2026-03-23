import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { renderExportBlob } from "./lib/collage";
import {
  aggregateAlbums,
  applyCachedArtwork,
  applyCachedDurations,
  buildLastFmAlbumUrl,
  buildMusicBrainzAlbumUrl,
  buildMusicBrainzTrackUrl,
  buildTimeRange,
  fetchRecentTracks,
  formatMetric,
  getAlbumTrackDurationEntries,
  getMissingArtworkEntries,
  getMissingDurationEntries,
  getRecentTracksResumeState,
  hydrateApproximateListeningTimes,
  refreshAlbumTrackDurationsFromMusicBrainz,
  refreshAlbumArtwork,
  saveAlbumOverride,
  saveTrackDurationOverride,
  sortAlbums,
} from "./lib/lastfm";
import type {
  AlbumEntry,
  AlbumTrackDurationEntry,
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
type PreviewMode = "config" | "export" | "missing-data";
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

interface CachedGeneratedResultState extends GeneratedResultState {
  missingArtwork: MissingArtworkEntry[];
  missingDurations: MissingDurationEntry[];
  summary: SummaryState | null;
}

interface AlbumEditDraft {
  album: string;
  artist: string;
  imageUrl: string;
}

type AlbumEditTab = "details" | "tracks";

interface AlbumTrackDraft extends AlbumTrackDurationEntry {
  durationInput: string;
}

interface MissingDataAlbumEntry {
  album: AlbumEntry;
  hasMissingArtwork: boolean;
  hasMissingDurations: boolean;
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
  const [generatedResultCache, setGeneratedResultCache] = useState<
    Record<string, CachedGeneratedResultState>
  >({});
  const [editingAlbum, setEditingAlbum] = useState<AlbumEntry | null>(null);
  const [albumEditDraft, setAlbumEditDraft] = useState<AlbumEditDraft | null>(null);
  const [albumEditTab, setAlbumEditTab] = useState<AlbumEditTab>("details");
  const [albumTrackDrafts, setAlbumTrackDrafts] = useState<AlbumTrackDraft[]>([]);
  const [isLoadingAlbumTracks, setIsLoadingAlbumTracks] = useState(false);
  const [isRefreshingAlbumTracks, setIsRefreshingAlbumTracks] = useState(false);
  const [isRefreshingAlbumArtwork, setIsRefreshingAlbumArtwork] = useState(false);
  const [missingArtwork, setMissingArtwork] = useState<MissingArtworkEntry[]>([]);
  const [missingDurations, setMissingDurations] = useState<MissingDurationEntry[]>([]);
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
  const missingDataAlbums = useMemo(
    () => buildMissingDataAlbums(generatedResult?.albums ?? [], missingArtwork, missingDurations),
    [generatedResult?.albums, missingArtwork, missingDurations],
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
    if (previewMode === "missing-data" && missingDataAlbums.length === 0) {
      setPreviewMode("config");
    }
  }, [missingDataAlbums.length, previewMode]);

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

  function syncGeneratedResultCache(nextState: CachedGeneratedResultState) {
    setGeneratedResultCache((current) => ({
      ...current,
      [buildGeneratedResultKey(nextState.query)]: nextState,
    }));
  }

  function applyGeneratedResultState(nextState: CachedGeneratedResultState) {
    const nextRenderedAlbums = nextState.albums.slice(0, rows * columns);
    setGeneratedResult({
      query: nextState.query,
      albums: nextState.albums,
    });
    setMissingArtwork(nextState.missingArtwork);
    setMissingDurations(nextState.missingDurations);
    setSummary(nextState.summary);
    setRenderedAlbums(nextRenderedAlbums);
    setResultsCopy(
      buildResultsCopy(nextState.query.username, nextState.query.rankingMode, nextRenderedAlbums.length),
    );
  }

  function clearGeneratedResultView(message: string) {
    setGeneratedResult(null);
    setMissingArtwork([]);
    setMissingDurations([]);
    setRenderedAlbums([]);
    setNextExportPreview(null);
    setSummary(null);
    setResultsCopy("Your collage will appear here after generation.");
    setPreviewMode("config");
    setStatus({
      tone: "info",
      message,
    });
  }

  function buildAlbumTrackDrafts(album: AlbumEntry): AlbumTrackDraft[] {
    return getAlbumTrackDurationEntries(album).map((track) => ({
      ...track,
      durationInput: formatTrackDurationInput(track.durationMs),
    }));
  }

  function syncEditingAlbumState(nextAlbums: AlbumEntry[]) {
    if (!editingAlbum) {
      return;
    }

    const nextEditingAlbum = nextAlbums.find((album) => album.sourceKey === editingAlbum.sourceKey);
    if (!nextEditingAlbum) {
      return;
    }

    setEditingAlbum(nextEditingAlbum);
    setAlbumTrackDrafts(buildAlbumTrackDrafts(nextEditingAlbum));
  }

  function syncGeneratedResultAfterDurationChange() {
    if (!generatedResult) {
      return;
    }

    const nextAlbums = [...generatedResult.albums];
    applyCachedDurations(nextAlbums);
    const nextSortedAlbums = sortAlbums(nextAlbums, generatedResult.query.rankingMode);
    const nextMissingDurations = getMissingDurationEntries(nextSortedAlbums);
    const nextRenderedAlbums = nextSortedAlbums.slice(0, rows * columns);
    const nextGeneratedResult = {
      ...generatedResult,
      albums: nextSortedAlbums,
    };
    const nextSummary = summary
      ? {
          ...summary,
          durationGaps: nextMissingDurations.length,
        }
      : summary;

    setGeneratedResult(nextGeneratedResult);
    setMissingDurations(nextMissingDurations);
    setRenderedAlbums(nextRenderedAlbums);
    setResultsCopy(
      buildResultsCopy(
        generatedResult.query.username,
        generatedResult.query.rankingMode,
        nextRenderedAlbums.length,
      ),
    );
    setSummary(nextSummary);
    syncGeneratedResultCache({
      ...nextGeneratedResult,
      missingArtwork,
      missingDurations: nextMissingDurations,
      summary: nextSummary,
    });
    syncEditingAlbumState(nextSortedAlbums);
  }

  async function ensureAlbumTrackDataLoaded() {
    const apiKey = getApiKey();
    if (!editingAlbum || !generatedResult || !apiKey) {
      return;
    }

    const currentTrackDrafts = buildAlbumTrackDrafts(editingAlbum);
    setAlbumTrackDrafts(currentTrackDrafts);
    if (!currentTrackDrafts.some((track) => track.checkedAt === 0)) {
      return;
    }

    setIsLoadingAlbumTracks(true);
    setStatus({
      tone: "info",
      message: `Fetching track durations for ${editingAlbum.album}...`,
    });

    try {
      await hydrateApproximateListeningTimes([editingAlbum], apiKey);
      syncGeneratedResultAfterDurationChange();
      setStatus({
        tone: "success",
        message: `Fetched track data for ${editingAlbum.album}.`,
      });
    } catch (error) {
      console.error(error);
      setStatus({
        tone: "error",
        message: error instanceof Error ? error.message : "Track data lookup failed.",
      });
    } finally {
      setIsLoadingAlbumTracks(false);
    }
  }

  async function handleAlbumEditTabChange(nextTab: AlbumEditTab) {
    setAlbumEditTab(nextTab);
    if (nextTab === "tracks") {
      await ensureAlbumTrackDataLoaded();
    }
  }

  async function handleAlbumTrackRefresh() {
    if (!editingAlbum || !generatedResult) {
      return;
    }

    setIsRefreshingAlbumTracks(true);
    setStatus({
      tone: "info",
      message: `Refreshing track data for ${editingAlbum.album} from MusicBrainz...`,
    });

    try {
      const result = await refreshAlbumTrackDurationsFromMusicBrainz(editingAlbum);
      syncGeneratedResultAfterDurationChange();
      setStatus({
        tone: result.resolvedCount > 0 ? "success" : "info",
        message:
          result.resolvedCount > 0
            ? `Refreshed track data for ${editingAlbum.album} from MusicBrainz.`
            : `MusicBrainz did not find additional track data for ${editingAlbum.album}.`,
      });
    } catch (error) {
      console.error(error);
      setStatus({
        tone: "error",
        message: error instanceof Error ? error.message : "MusicBrainz track refresh failed.",
      });
    } finally {
      setIsRefreshingAlbumTracks(false);
    }
  }

  function handleRankingModeChange(nextRankingMode: RankingMode) {
    if (nextRankingMode === settings.rankingMode) {
      return;
    }

    const nextQuery = {
      username: trimmedUsername,
      timeRange: settings.timeRange,
      rankingMode: nextRankingMode,
    };
    const cachedResult = generatedResultCache[buildGeneratedResultKey(nextQuery)];

    setSettings((current) => ({
      ...current,
      rankingMode: nextRankingMode,
    }));

    if (cachedResult) {
      applyGeneratedResultState(cachedResult);
      setStatus({
        tone: "success",
        message:
          nextRankingMode === "plays"
            ? "Showing the cached album-plays collage."
            : "Showing the cached approximate listening-time collage.",
      });
      return;
    }

    const hasGeneratedForSameRange = Object.values(generatedResultCache).some(
      (result) =>
        result.query.username === nextQuery.username && result.query.timeRange === nextQuery.timeRange,
    );

    if (!hasGeneratedForSameRange) {
      return;
    }

    clearGeneratedResultView(
      nextRankingMode === "listening-time"
        ? "Generate the collage in approximate listening time mode to view those rankings."
        : "Generate the collage in album plays mode to view those rankings.",
    );
  }

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

      const nextGeneratedResult = {
        query: {
          username: trimmedUsername,
          timeRange: settings.timeRange,
          rankingMode: settings.rankingMode,
        },
        albums: sorted,
      };
      const nextSummary = {
        scrobbles: recentTracks.items.length,
        albums: aggregated.length,
        pages: recentTracks.pagesFetched,
        durationGaps: nextMissingDurations.length,
      };
      setGeneratedResult(nextGeneratedResult);
      setMissingArtwork(nextMissingArtwork);
      setMissingDurations(nextMissingDurations);
      setRenderedAlbums(nextRenderedAlbums);
      setSummary(nextSummary);
      setResultsCopy(buildResultsCopy(trimmedUsername, settings.rankingMode, nextRenderedAlbums.length));
      syncGeneratedResultCache({
        ...nextGeneratedResult,
        missingArtwork: nextMissingArtwork,
        missingDurations: nextMissingDurations,
        summary: nextSummary,
      });
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

  function handleAlbumEditOpen(album: AlbumEntry) {
    setEditingAlbum(album);
    setAlbumEditDraft({
      album: album.album,
      artist: album.artist,
      imageUrl: album.imageUrl,
    });
    setAlbumEditTab("details");
    setAlbumTrackDrafts(buildAlbumTrackDrafts(album));
    setIsLoadingAlbumTracks(false);
    setIsRefreshingAlbumTracks(false);
  }

  function handleAlbumEditClose() {
    setEditingAlbum(null);
    setAlbumEditDraft(null);
    setAlbumEditTab("details");
    setAlbumTrackDrafts([]);
    setIsLoadingAlbumTracks(false);
    setIsRefreshingAlbumTracks(false);
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

    const nextGeneratedResult = {
      ...generatedResult,
      albums: nextSortedAlbums,
    };
    const nextSummary = summary
      ? {
          ...summary,
          albums: nextSortedAlbums.length,
          durationGaps: nextMissingDurations.length,
        }
      : summary;

    setGeneratedResult(nextGeneratedResult);
    setMissingArtwork(nextMissingArtwork);
    setMissingDurations(nextMissingDurations);
    setRenderedAlbums(nextRenderedAlbums);
    setResultsCopy(
      nextRenderedAlbums.length > 0
        ? buildResultsCopy(trimmedUsername, settings.rankingMode, nextRenderedAlbums.length)
        : "No albums remain in the collage.",
    );
    setSummary(nextSummary);
    syncGeneratedResultCache({
      ...nextGeneratedResult,
      missingArtwork: nextMissingArtwork,
      missingDurations: nextMissingDurations,
      summary: nextSummary,
    });
    setStatus({
      tone: "success",
      message: `Saved edits for ${trimmedDraft.album}.`,
    });
    handleAlbumEditClose();
  }

  function handleAlbumEditSave() {
    const trimmedDraft = validateAlbumEditDraft();
    if (!trimmedDraft || !editingAlbum) {
      return;
    }

    for (const track of albumTrackDrafts) {
      const parsedDuration = parseTrackDurationInput(track.durationInput);
      if (track.durationInput.trim() && parsedDuration === null) {
        setStatus({
          tone: "error",
          message: `Enter track durations in mm:ss format for ${track.name}.`,
        });
        return;
      }

      if (parsedDuration !== null) {
        saveTrackDurationOverride(track, parsedDuration);
      }
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
          <h1>Last.fm Collage Generator</h1>
          <p className="hero-copy">
            Last FM album cover collage generation based on play count or
            approximate listening time.
          </p>
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
                  onChange={(event) => handleRankingModeChange(event.target.value as RankingMode)}
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
                  onChange={(event) => handleRankingModeChange(event.target.value as RankingMode)}
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
              {missingDataAlbums.length > 0 ? (
                <button
                  type="button"
                  className={previewMode === "missing-data" ? "is-active" : ""}
                  onClick={() => setPreviewMode("missing-data")}
                  aria-pressed={previewMode === "missing-data"}
                >
                  Missing data ({missingDataAlbums.length})
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
          ) : previewMode === "missing-data" ? (
            <MissingDataPanel
              items={missingDataAlbums}
              onOpenAlbum={handleAlbumEditOpen}
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
          activeTab={albumEditTab}
          trackDrafts={albumTrackDrafts}
          isLoadingTracks={isLoadingAlbumTracks}
          isRefreshingArtwork={isRefreshingAlbumArtwork}
          isRefreshingTracks={isRefreshingAlbumTracks}
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
          onTrackDurationChange={(trackKey, value) =>
            setAlbumTrackDrafts((current) =>
              current.map((track) =>
                track.trackKey === trackKey
                  ? {
                      ...track,
                      durationInput: value,
                    }
                  : track,
              ),
            )
          }
          onClose={handleAlbumEditClose}
          onRefreshArtwork={() => void handleAlbumArtworkRefresh()}
          onRefreshTrackData={() => void handleAlbumTrackRefresh()}
          onTabChange={(nextTab) => void handleAlbumEditTabChange(nextTab)}
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
  activeTab: AlbumEditTab;
  draft: AlbumEditDraft;
  trackDrafts: AlbumTrackDraft[];
  isLoadingTracks: boolean;
  isRefreshingArtwork: boolean;
  isRefreshingTracks: boolean;
  onChange: (key: keyof AlbumEditDraft, value: string) => void;
  onTrackDurationChange: (trackKey: string, value: string) => void;
  onClose: () => void;
  onRefreshArtwork: () => void;
  onRefreshTrackData: () => void;
  onTabChange: (nextTab: AlbumEditTab) => void;
  onSave: () => void;
}

function AlbumEditModal({
  album,
  activeTab,
  draft,
  trackDrafts,
  isLoadingTracks,
  isRefreshingArtwork,
  isRefreshingTracks,
  onChange,
  onTrackDurationChange,
  onClose,
  onRefreshArtwork,
  onRefreshTrackData,
  onTabChange,
  onSave,
}: AlbumEditModalProps) {
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-shell" role="dialog" aria-modal="true" aria-label="Edit album information">
        <div className="modal-header">
          <div>
            <h2>Edit album information</h2>
            <p className="results-copy">
              Update the current collage entry by changing its image, title, artist label, or track durations.
            </p>
          </div>
          <button type="button" className="modal-close-button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="album-edit-tabs" role="tablist" aria-label="Album edit sections">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "details"}
            className={activeTab === "details" ? "is-active" : ""}
            onClick={() => onTabChange("details")}
          >
            Image and titles
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "tracks"}
            className={activeTab === "tracks" ? "is-active" : ""}
            onClick={() => onTabChange("tracks")}
          >
            Track information
          </button>
        </div>
        {activeTab === "details" ? (
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
        ) : (
          <div className="track-edit-panel">
            <div className="album-edit-actions">
              <a
                className="secondary-link"
                href={buildMusicBrainzAlbumUrl({
                  artist: album.sourceArtist,
                  album: album.sourceAlbum,
                })}
                target="_blank"
                rel="noreferrer"
              >
                Open album on MusicBrainz
              </a>
              <button type="button" onClick={onRefreshTrackData} disabled={isRefreshingTracks}>
                {isRefreshingTracks ? "Refreshing track data..." : "Refresh track data"}
              </button>
            </div>
            {isLoadingTracks ? (
              <div className="empty-state album-track-loading">
                <p>Loading track information...</p>
              </div>
            ) : (
              <div className="track-edit-list">
                {trackDrafts.map((track) => (
                  <div key={track.trackKey} className="track-edit-row">
                    <div className="track-edit-copy">
                      <strong>{track.name}</strong>
                      <span>{track.plays === 1 ? "1 play" : `${track.plays} plays`}</span>
                    </div>
                    <label className="track-duration-field">
                      <span>Duration</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        aria-label={`Duration for ${track.name}`}
                        placeholder="00:00"
                        value={track.durationInput}
                        onChange={(event) => onTrackDurationChange(track.trackKey, event.target.value)}
                      />
                    </label>
                    <a
                      className="secondary-link"
                      href={buildMusicBrainzTrackUrl(track)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Update on MusicBrainz
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={onSave}>
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

interface MissingDataPanelProps {
  items: MissingDataAlbumEntry[];
  onOpenAlbum: (album: AlbumEntry) => void;
}

function MissingDataPanel({ items, onOpenAlbum }: MissingDataPanelProps) {
  if (items.length === 0) {
    return (
      <div className="empty-state missing-data-empty">
        <p>No missing data remains.</p>
      </div>
    );
  }

  return (
    <div className="missing-data-panel">
      <p className="results-copy">
        These albums still have missing artwork or track durations. Open an album to fix the image,
        titles, and track data in one place.
      </p>
      <div className="missing-data-list">
        {items.map((item) => {
          const hasVisibleArtwork = Boolean(item.album.imageUrl) && !item.hasMissingArtwork;

          return (
            <button
              key={item.album.sourceKey}
              type="button"
              className="missing-data-item"
              onClick={() => onOpenAlbum(item.album)}
              aria-label={`Edit ${item.album.album} by ${item.album.artist}`}
            >
              <div className={`missing-data-artwork ${hasVisibleArtwork ? "" : "is-placeholder"}`.trim()}>
                {hasVisibleArtwork ? (
                  <img src={item.album.imageUrl} alt="" />
                ) : (
                  <div className="placeholder-copy">
                    <strong>{item.album.album}</strong>
                    <span>{item.album.artist}</span>
                  </div>
                )}
              </div>
              <div className="missing-data-copy">
                <strong>{item.album.album}</strong>
                <span>{item.album.artist}</span>
                <div className="missing-data-flags">
                  {item.hasMissingArtwork ? <span>Missing artwork</span> : null}
                  {item.hasMissingDurations ? <span>Missing track durations</span> : null}
                </div>
              </div>
            </button>
          );
        })}
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

function buildGeneratedResultKey(query: GeneratedResultState["query"]): string {
  return `${query.username}::${query.timeRange}::${query.rankingMode}`;
}

function formatTrackDurationInput(durationMs: number): string {
  if (durationMs <= 0) {
    return "";
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function parseTrackDurationInput(value: string): number | null {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  const match = trimmedValue.match(/^(\d+):([0-5]\d)$/);
  if (!match) {
    return null;
  }

  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }

  return (minutes * 60 + seconds) * 1000;
}

function buildMissingDataAlbums(
  albums: AlbumEntry[],
  missingArtwork: MissingArtworkEntry[],
  missingDurations: MissingDurationEntry[],
): MissingDataAlbumEntry[] {
  const missingArtworkKeys = new Set(missingArtwork.map((album) => album.sourceKey));
  const missingDurationAlbumKeys = new Set(
    missingDurations.map((track) => `${track.artist}::${track.album}`.toLowerCase()),
  );

  return albums.flatMap((album) => {
    const hasMissingArtwork = missingArtworkKeys.has(album.sourceKey);
    const hasMissingDurations = [...album.tracks.values()].some((track) =>
      missingDurationAlbumKeys.has(`${track.artist}::${track.album}`.toLowerCase()),
    );

    if (!hasMissingArtwork && !hasMissingDurations) {
      return [];
    }

    return [
      {
        album,
        hasMissingArtwork,
        hasMissingDurations,
      },
    ];
  });
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
