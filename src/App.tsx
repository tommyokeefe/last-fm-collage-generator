import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  THEME_CHANGE_EVENT,
  getStoredThemePreference,
  initTheme,
  setThemePreference,
} from "@tommyokeefe/theme/theme-client";
import { renderExportBlob } from "./lib/collage";
import {
  aggregateAlbums,
  applyCachedArtwork,
  applyCachedDurations,
  buildLastFmAlbumUrl,
  buildMusicBrainzAlbumUrl,
  buildMusicBrainzTrackUrl,
  buildTimeRange,
  fetchMissingDurationsFromMusicBrainz,
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
const BASE_TIME_RANGE_OPTIONS: ReadonlyArray<{ value: TimeRangeValue; label: string }> = [
  { value: "7d", label: "Last 7 days" },
  { value: "1m", label: "Last 30 days" },
];
const EXTENDED_TIME_RANGE_OPTIONS: ReadonlyArray<{ value: TimeRangeValue; label: string }> = [
  { value: "3m", label: "Last 90 days" },
  { value: "6m", label: "Last 180 days" },
  { value: "12m", label: "Last 365 days" },
  { value: "overall", label: "All time" },
];

function getTimeRangeOptions(): ReadonlyArray<{ value: TimeRangeValue; label: string }> {
  try {
    const flag = window.localStorage.getItem("lastfm-collage-enable-extended-time-ranges");
    if (flag === "1" || flag === "true") {
      return [...BASE_TIME_RANGE_OPTIONS, ...EXTENDED_TIME_RANGE_OPTIONS];
    }
  } catch (e) {
    // ignore
  }

  return BASE_TIME_RANGE_OPTIONS;
}
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
const THEME_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;
const DEFAULT_SETTINGS: Settings = {
  username: "",
  timeRange: "7d",
  gridSize: "5x5",
  rankingMode: "plays",
  showAlbumInfo: true,
  showMetric: true,
};
const edgeBorderClass = "border-emerald-600/30";
const softBorderClass = "border-black/10 dark:border-white/8";
const panelClass =
  `rounded-panel border ${edgeBorderClass} bg-surface shadow-surface [background:linear-gradient(180deg,rgba(255,255,255,0.02),transparent),rgb(var(--theme-surface))]`;
const sectionPanelClass = `${panelClass} p-6 max-sm:p-4`;
const fieldClass =
  `w-full rounded-control border ${softBorderClass} bg-surface-muted px-4 py-[0.85rem] text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-55`;
const secondaryButtonClass =
  `inline-flex min-h-12 items-center justify-center rounded-control border ${softBorderClass} bg-surface-muted px-4 py-[0.85rem] text-sm font-medium text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition hover:-translate-y-px hover:border-black/15 dark:hover:border-white/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-55`;
const primaryButtonClass =
  "inline-flex min-h-12 items-center justify-center rounded-control border border-accent bg-accent px-4 py-[0.85rem] text-sm font-semibold text-accent-foreground shadow-[0_12px_24px_rgb(var(--theme-shadow-color)/0.16)] transition hover:-translate-y-px hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-55";
const toggleGroupClass =
  "inline-flex flex-wrap gap-2 rounded-[14px] border border-black/10 bg-foreground/[0.03] p-1.5 backdrop-blur-sm dark:border-emerald-600/30";
const toggleButtonClass =
  "min-w-0 rounded-control border border-black/10 bg-transparent px-4 py-2.5 text-sm font-medium text-muted transition hover:-translate-y-px hover:border-black/15 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:border-emerald-600/30 dark:hover:border-emerald-600/30";
const toggleButtonActiveClass =
  "border-accent bg-accent font-semibold text-accent-foreground shadow-[0_12px_24px_rgb(var(--theme-shadow-color)/0.16)]";
const themeToggleGroupClass = "flex flex-wrap items-center justify-center gap-1.5";
const themeToggleButtonClass =
  "group flex h-9 w-9 items-center justify-center rounded border border-black/15 text-muted transition-colors hover:bg-black/5 hover:text-foreground focus-visible:bg-black/5 focus-visible:outline-none dark:border-emerald-600/30 dark:hover:bg-white/5 dark:hover:text-foreground dark:focus-visible:bg-white/5";
const emptyStateClass =
  "grid min-h-[260px] place-items-center rounded-[18px] border border-dashed border-border/12 bg-foreground/[0.03] text-muted [background:linear-gradient(180deg,rgba(255,255,255,0.02),transparent),rgb(var(--theme-foreground)/0.03)]";
const themeIconClass =
  "h-[18px] w-[18px] transition-colors duration-300 ease-in-out group-hover:animate-pulse group-focus-visible:animate-pulse";

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function ThemeIcon({ theme }: { theme: ThemePreference }) {
  if (theme === "light") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={themeIconClass}
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" />
        <line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" />
        <line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>
    );
  }

  if (theme === "dark") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={themeIconClass}
        aria-hidden="true"
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    );
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={themeIconClass}
      aria-hidden="true"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

interface GeneratedResultState {
  query: {
    username: string;
    timeRange: TimeRangeValue;
    rankingMode: RankingMode;
  };
  albums: AlbumEntry[];
  hiddenAlbumSourceKeys: string[];
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
type ThemePreference = (typeof THEME_OPTIONS)[number]["value"];

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
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(loadThemePreference);
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
  const [isGeneratingExportPreview, setIsGeneratingExportPreview] = useState(false);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("config");
  const [viewRefreshKey, setViewRefreshKey] = useState(0);
  const [resultsCopy, setResultsCopy] = useState(
    "Your collage will appear here after generation.",
  );
  const exportPreviewRequestIdRef = useRef(0);

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    const themeController = initTheme();
    const syncThemePreference = () => {
      setThemePreferenceState(loadThemePreference());
    };

    syncThemePreference();
    window.addEventListener(THEME_CHANGE_EVENT, syncThemePreference);

    return () => {
      themeController.dispose();
      window.removeEventListener(THEME_CHANGE_EVENT, syncThemePreference);
    };
  }, []);

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
  const hasAttemptedListeningTimeForCurrentRange = useMemo(
    () =>
      Object.values(generatedResultCache).some(
        (result) =>
          result.query.username === trimmedUsername &&
          result.query.timeRange === settings.timeRange &&
          result.query.rankingMode === "listening-time",
      ),
    [generatedResultCache, settings.timeRange, trimmedUsername],
  );
  const visibleGeneratedAlbums = useMemo(
    () =>
      generatedResult
        ? getVisibleAlbums(generatedResult.albums, generatedResult.hiddenAlbumSourceKeys)
        : [],
    [generatedResult],
  );
  const hiddenAlbumCount = generatedResult?.hiddenAlbumSourceKeys.length ?? 0;
  const visibleMissingDurations = useMemo(
    () => (hasAttemptedListeningTimeForCurrentRange ? missingDurations : []),
    [hasAttemptedListeningTimeForCurrentRange, missingDurations],
  );
  const missingDataAlbums = useMemo(
    () => buildMissingDataAlbums(visibleGeneratedAlbums, missingArtwork, visibleMissingDurations),
    [missingArtwork, visibleGeneratedAlbums, visibleMissingDurations],
  );
  const visibleSummary = useMemo(
    () =>
      summary
        ? {
            ...summary,
            durationGaps: visibleMissingDurations.length,
          }
        : null,
    [summary, visibleMissingDurations.length],
  );

  useEffect(() => {
    if (!generatedResult || !matchesGeneratedQuery(generatedResult, generatedQuery)) {
      return;
    }

    const nextRenderedAlbums = visibleGeneratedAlbums.slice(0, rows * columns);
    setRenderedAlbums(nextRenderedAlbums);
    setResultsCopy(
      nextRenderedAlbums.length > 0
        ? buildResultsCopy(generatedQuery.username, generatedQuery.rankingMode, nextRenderedAlbums.length)
        : "No albums remain in the collage.",
    );
  }, [columns, generatedQuery, generatedResult, rows, viewRefreshKey, visibleGeneratedAlbums]);

  useEffect(() => {
    if (previewMode === "missing-data" && missingDataAlbums.length === 0) {
      setPreviewMode("config");
    }
  }, [missingDataAlbums.length, previewMode]);

  useEffect(() => {
    let cancelled = false;

    async function syncExactPreview() {
      const requestId = exportPreviewRequestIdRef.current + 1;
      exportPreviewRequestIdRef.current = requestId;

      if (renderedAlbums.length === 0) {
        if (requestId === exportPreviewRequestIdRef.current) {
          setIsGeneratingExportPreview(false);
          setNextExportPreview(null);
        }
        return;
      }

      setIsGeneratingExportPreview(true);
      setNextExportPreview(null);
      const previewBlob = await tryRenderExportPreview(
        renderedAlbums,
        rows,
        columns,
        settings.rankingMode,
        exportRenderOptions,
      );

      if (!cancelled && requestId === exportPreviewRequestIdRef.current) {
        setNextExportPreview(previewBlob);
        setIsGeneratingExportPreview(false);
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
  const isProgressOverlayVisible =
    isBusy || isLoadingAlbumTracks || isRefreshingAlbumTracks || isRefreshingAlbumArtwork;

  function requestViewRefresh() {
    setViewRefreshKey((current) => current + 1);
  }

  function handlePreviewModeChange(nextMode: PreviewMode) {
    setPreviewMode(nextMode);
    requestViewRefresh();
  }

  function syncGeneratedResultCache(nextState: CachedGeneratedResultState) {
    setGeneratedResultCache((current) => ({
      ...current,
      [buildGeneratedResultKey(nextState.query)]: nextState,
    }));
  }

  function applyGeneratedResultState(nextState: CachedGeneratedResultState) {
    const nextVisibleAlbums = getVisibleAlbums(nextState.albums, nextState.hiddenAlbumSourceKeys);
    const nextRenderedAlbums = nextVisibleAlbums.slice(0, rows * columns);
    setGeneratedResult({
      query: nextState.query,
      albums: nextState.albums,
      hiddenAlbumSourceKeys: nextState.hiddenAlbumSourceKeys,
    });
    setMissingArtwork(nextState.missingArtwork);
    setMissingDurations(nextState.missingDurations);
    setSummary(nextState.summary);
    setRenderedAlbums(nextRenderedAlbums);
    setResultsCopy(
      nextRenderedAlbums.length > 0
        ? buildResultsCopy(nextState.query.username, nextState.query.rankingMode, nextRenderedAlbums.length)
        : "No albums remain in the collage.",
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
    const nextVisibleAlbums = getVisibleAlbums(
      nextSortedAlbums,
      generatedResult.hiddenAlbumSourceKeys,
    );
    const nextMissingDurations = getMissingDurationEntries(nextVisibleAlbums);
    const nextRenderedAlbums = nextVisibleAlbums.slice(0, rows * columns);
    const nextGeneratedResult = {
      ...generatedResult,
      albums: nextSortedAlbums,
    };
    const nextSummary = summary
      ? {
          ...summary,
          albums: nextVisibleAlbums.length,
          durationGaps: nextMissingDurations.length,
        }
      : summary;

    setGeneratedResult(nextGeneratedResult);
    setMissingDurations(nextMissingDurations);
    setRenderedAlbums(nextRenderedAlbums);
    setResultsCopy(
      nextRenderedAlbums.length > 0
        ? buildResultsCopy(
            generatedResult.query.username,
            generatedResult.query.rankingMode,
            nextRenderedAlbums.length,
          )
        : "No albums remain in the collage.",
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

  async function handleMissingDurationRefresh() {
    if (!generatedResult) {
      return;
    }

    if (visibleMissingDurations.length === 0) {
      return;
    }

    setIsRefreshingAlbumTracks(true);
    setStatus({
      tone: "info",
      message: "Refreshing missing track durations from MusicBrainz...",
      progress: {
        completed: 0,
        total: visibleMissingDurations.length,
        estimatedRemainingMs: 0,
        unitLabel: "Tracks",
      },
    });

    try {
      const result = await fetchMissingDurationsFromMusicBrainz(
        visibleMissingDurations,
        (message) =>
          setStatus((current) => ({
            tone: "info",
            message,
            progress: current.progress,
          })),
        (progress) =>
          setStatus({
            tone: "info",
            message: `Refreshing missing track durations from MusicBrainz... ${progress.completed} of ${progress.total}`,
            progress,
          }),
      );

      syncGeneratedResultAfterDurationChange();
      setStatus({
        tone: result.resolvedCount > 0 ? "success" : "info",
        message:
          result.resolvedCount > 0
            ? `Recovered ${result.resolvedCount} track duration${result.resolvedCount === 1 ? "" : "s"} from MusicBrainz.`
            : "MusicBrainz did not find additional missing track durations.",
      });
    } catch (error) {
      console.error(error);
      setStatus({
        tone: "error",
        message: error instanceof Error ? error.message : "MusicBrainz duration refresh failed.",
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
        hiddenAlbumSourceKeys: [],
      };
      const nextSummary = {
        scrobbles: recentTracks.items.length,
        albums: sorted.length,
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
    requestViewRefresh();
  }

  function handleAlbumRemove() {
    if (!generatedResult || !editingAlbum) {
      return;
    }

    const hiddenAlbumSourceKeys = Array.from(
      new Set([...generatedResult.hiddenAlbumSourceKeys, editingAlbum.sourceKey]),
    );
    const nextVisibleAlbums = getVisibleAlbums(generatedResult.albums, hiddenAlbumSourceKeys);
    const nextMissingArtwork = getMissingArtworkEntries(nextVisibleAlbums);
    const nextMissingDurations = getMissingDurationEntries(nextVisibleAlbums);
    const nextRenderedAlbums = nextVisibleAlbums.slice(0, rows * columns);
    const nextGeneratedResult = {
      ...generatedResult,
      hiddenAlbumSourceKeys,
    };
    const nextSummary = summary
      ? {
          ...summary,
          albums: nextVisibleAlbums.length,
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
      message: `Removed ${editingAlbum.album} from the collage.`,
    });
    handleAlbumEditClose();
  }

  function handleRestoreRemovedAlbums() {
    if (!generatedResult || generatedResult.hiddenAlbumSourceKeys.length === 0) {
      return;
    }

    const nextVisibleAlbums = generatedResult.albums;
    const nextMissingArtwork = getMissingArtworkEntries(nextVisibleAlbums);
    const nextMissingDurations = getMissingDurationEntries(nextVisibleAlbums);
    const nextRenderedAlbums = nextVisibleAlbums.slice(0, rows * columns);
    const nextGeneratedResult = {
      ...generatedResult,
      hiddenAlbumSourceKeys: [],
    };
    const nextSummary = summary
      ? {
          ...summary,
          albums: nextVisibleAlbums.length,
          durationGaps: nextMissingDurations.length,
        }
      : summary;

    setGeneratedResult(nextGeneratedResult);
    setMissingArtwork(nextMissingArtwork);
    setMissingDurations(nextMissingDurations);
    setRenderedAlbums(nextRenderedAlbums);
    setResultsCopy(buildResultsCopy(trimmedUsername, settings.rankingMode, nextRenderedAlbums.length));
    setSummary(nextSummary);
    syncGeneratedResultCache({
      ...nextGeneratedResult,
      missingArtwork: nextMissingArtwork,
      missingDurations: nextMissingDurations,
      summary: nextSummary,
    });
    setStatus({
      tone: "success",
      message: "Restored removed albums to the collage.",
    });
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
    const nextVisibleAlbums = getVisibleAlbums(
      nextSortedAlbums,
      generatedResult.hiddenAlbumSourceKeys,
    );
    const nextMissingArtwork = getMissingArtworkEntries(nextVisibleAlbums);
    const nextMissingDurations = getMissingDurationEntries(nextVisibleAlbums);
    const nextRenderedAlbums = nextVisibleAlbums.slice(0, rows * columns);

    const nextGeneratedResult = {
      ...generatedResult,
      albums: nextSortedAlbums,
    };
    const nextSummary = summary
      ? {
          ...summary,
          albums: nextVisibleAlbums.length,
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

    setStatus({
      tone: "info",
      message: `Refreshing artwork for ${editingAlbum.album}...`,
    });
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
    <div className="mx-auto min-h-screen w-[min(1200px,calc(100%-2rem))] py-8 max-sm:w-[min(100%-1rem,100%)]">
      <header className="mb-8 flex items-start justify-between gap-4 max-lg:flex-col max-lg:items-stretch">
        <div className="grid gap-3">
          <h1 className="text-[clamp(2rem,3vw,3rem)]">Last.fm Collage Generator</h1>
          <p className="max-w-[64ch] text-muted">
            Last FM album cover collage generation based on play count or
            approximate listening time.
          </p>
        </div>
        <div className="flex justify-end">
          <div className={themeToggleGroupClass} role="group" aria-label="Theme mode">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={classNames(
                  themeToggleButtonClass,
                  themePreference === option.value &&
                    "bg-black/5 text-foreground dark:bg-white/5",
                )}
                aria-label={`${option.label} theme`}
                aria-pressed={themePreference === option.value}
                onClick={() => {
                  setThemePreference(option.value);
                  setThemePreferenceState(option.value);
                }}
              >
                <ThemeIcon theme={option.value} />
                <span className="sr-only">{option.label}</span>
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="grid gap-6 lg:grid-cols-[minmax(290px,380px)_minmax(0,1fr)]">
        <section className={sectionPanelClass}>
          <h2 className="text-2xl font-semibold text-foreground">Generate a collage</h2>
          <form className="mt-4 grid gap-4" onSubmit={(event) => void handleGenerate(event)}>
            <label className="grid gap-2">
              <span>Last.fm username</span>
              <input
                className={fieldClass}
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

            <label className="grid gap-2">
              <span>Time range</span>
              <select
                className={fieldClass}
                value={settings.timeRange}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    timeRange: event.target.value as TimeRangeValue,
                  }))
                }
                disabled={isBusy}
              >
                {getTimeRangeOptions().map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-2">
              <span>Grid size</span>
              <select
                className={fieldClass}
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

            <fieldset className={`grid gap-2 rounded-2xl border p-4 ${softBorderClass}`}>
              <legend className="px-1 font-semibold text-foreground">Album ranking mode</legend>
              <label className="grid grid-cols-[auto_1fr] items-center gap-3">
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
              <label className="grid grid-cols-[auto_1fr] items-center gap-3">
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

            <fieldset className={`grid gap-2 rounded-2xl border p-4 ${softBorderClass}`}>
              <legend className="px-1 font-semibold text-foreground">True PNG preview and export</legend>
              <label className="grid grid-cols-[auto_1fr] items-center gap-3">
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
              <label className="grid grid-cols-[auto_1fr] items-center gap-3">
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

            <div className="flex gap-3 max-sm:flex-col">
              <button className={classNames(primaryButtonClass, "w-full")} type="submit" disabled={isBusy}>
                {isBusy ? "Generating..." : "Generate collage"}
              </button>
              <button
                className={classNames(primaryButtonClass, "w-full")}
                type="button"
                onClick={() => void handleExport()}
                disabled={!canExport}
              >
                Export PNG
              </button>
            </div>
          </form>

          {!isProgressOverlayVisible ? <StatusBanner status={status} /> : null}
          <SummaryPanel
            summary={visibleSummary}
            showDurationGaps={hasAttemptedListeningTimeForCurrentRange}
          />
        </section>

        <section className={sectionPanelClass}>
          <div className="flex items-start justify-between gap-4 max-lg:flex-col">
            <div>
                <h2 className="text-2xl font-semibold text-foreground">Preview</h2>
              <p className="max-w-[64ch] text-muted">{resultsCopy}</p>
            </div>
            <div className="flex flex-col items-end gap-3 max-lg:w-full max-lg:items-stretch">
              <div className={toggleGroupClass} role="tablist" aria-label="Preview modes">
                <button
                  type="button"
                  className={classNames(
                    toggleButtonClass,
                    previewMode === "config" && toggleButtonActiveClass,
                  )}
                  onClick={() => handlePreviewModeChange("config")}
                  aria-pressed={previewMode === "config"}
                >
                  Configuration view
                </button>
                <button
                  type="button"
                  className={classNames(
                    toggleButtonClass,
                    previewMode === "export" && toggleButtonActiveClass,
                  )}
                  onClick={() => handlePreviewModeChange("export")}
                  aria-pressed={previewMode === "export"}
                >
                  True PNG preview
                </button>
                {missingDataAlbums.length > 0 ? (
                  <button
                    type="button"
                    className={classNames(
                      toggleButtonClass,
                      previewMode === "missing-data" && toggleButtonActiveClass,
                    )}
                    onClick={() => handlePreviewModeChange("missing-data")}
                    aria-pressed={previewMode === "missing-data"}
                  >
                    Missing data ({missingDataAlbums.length})
                  </button>
                ) : null}
              </div>
              {previewMode === "config" && hiddenAlbumCount > 0 ? (
                <button
                  type="button"
                  className={classNames(secondaryButtonClass, "max-lg:w-full")}
                  onClick={handleRestoreRemovedAlbums}
                >
                  Restore removed albums ({hiddenAlbumCount})
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
              isRefreshingDurations={isRefreshingAlbumTracks}
              onOpenAlbum={handleAlbumEditOpen}
              onRefreshMissingDurations={() => void handleMissingDurationRefresh()}
            />
          ) : (
            <ExportPreview
              exportPreviewUrl={exportPreviewUrl}
              hasAlbums={renderedAlbums.length > 0}
              isGenerating={isGeneratingExportPreview}
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
          onRemoveAlbum={handleAlbumRemove}
          onRefreshArtwork={() => void handleAlbumArtworkRefresh()}
          onRefreshTrackData={() => void handleAlbumTrackRefresh()}
          onTabChange={(nextTab) => void handleAlbumEditTabChange(nextTab)}
          onSave={handleAlbumEditSave}
        />
      ) : null}
      {isProgressOverlayVisible ? <ProgressOverlay status={status} /> : null}
    </div>
  );
}

interface StatusBannerProps {
  status: StatusState;
}

function StatusBanner({ status }: StatusBannerProps) {
  const className = classNames(
    `mt-4 rounded-[14px] border ${edgeBorderClass} bg-foreground/[0.03] p-4 text-muted`,
    status.tone === "error" && "border-red-600/35 text-red-700 dark:text-red-200",
    status.tone === "success" && "border-emerald-600/30 text-emerald-700 dark:text-emerald-200",
  );

  return (
    <div className={className}>
      <StatusContent status={status} />
    </div>
  );
}

interface StatusContentProps {
  status: StatusState;
}

function StatusContent({ status }: StatusContentProps) {
  return (
    <>
      <div className="leading-6">{status.message}</div>
      {status.progress ? <FetchProgress progress={status.progress} /> : null}
    </>
  );
}

interface FetchProgressProps {
  progress: FetchProgressState;
}

function FetchProgress({ progress }: FetchProgressProps) {
  const completionRatio = progress.total > 0 ? (progress.completed / progress.total) * 100 : 0;
  return (
    <div className="mt-3.5 grid gap-2">
      <div className="flex justify-between gap-4 text-sm">
        <span>
          {progress.unitLabel} {progress.completed} of {progress.total}
        </span>
        <span>
          {progress.completed === 0 && progress.total > 0
            ? "ETA calculating..."
            : `ETA ${formatEta(progress.estimatedRemainingMs)}`}
        </span>
      </div>
      <progress
        className="h-3 w-full overflow-hidden rounded-full"
        value={progress.completed}
        max={progress.total}
      >
        {Math.max(0, Math.min(100, completionRatio))}%
      </progress>
    </div>
  );
}

interface ProgressOverlayProps {
  status: StatusState;
}

function ProgressOverlay({ status }: ProgressOverlayProps) {
  const className = classNames(
    `rounded-[14px] border ${edgeBorderClass} bg-foreground/[0.03] p-4 text-muted`,
    status.tone === "error" && "border-red-600/35 text-red-700 dark:text-red-200",
    status.tone === "success" && "border-emerald-600/30 text-emerald-700 dark:text-emerald-200",
  );

  return (
    <div
      className="fixed inset-0 z-30 grid place-items-center overflow-y-auto bg-surface-backdrop/40 p-4"
      role="presentation"
    >
      <div
        className={`w-full max-w-[440px] rounded-panel border ${edgeBorderClass} bg-surface/95 p-4 shadow-surface [background:linear-gradient(180deg,rgba(255,255,255,0.02),transparent),rgb(var(--theme-surface)/0.95)] backdrop-blur`}
        role="dialog"
        aria-modal="true"
        aria-label="Operation in progress"
      >
        <div className="mb-3 text-xs font-bold uppercase tracking-[0.08em] text-muted">Working...</div>
        <div className={className}>
          <StatusContent status={status} />
        </div>
      </div>
    </div>
  );
}

interface SummaryPanelProps {
  summary: SummaryState | null;
  showDurationGaps: boolean;
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
  onRemoveAlbum: () => void;
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
  onRemoveAlbum,
  onTabChange,
  onSave,
}: AlbumEditModalProps) {
  return (
    <div
      className="fixed inset-0 z-20 grid place-items-center overflow-y-auto bg-surface-backdrop/80 p-4"
      role="presentation"
    >
      <div
        className={`max-h-[calc(100vh-2rem)] w-full max-w-[760px] overflow-y-auto rounded-panel border ${edgeBorderClass} bg-surface p-5 shadow-surface [background:linear-gradient(180deg,rgba(255,255,255,0.02),transparent),rgb(var(--theme-surface))]`}
        role="dialog"
        aria-modal="true"
        aria-label="Edit album information"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
             <h2 className="text-2xl font-semibold text-foreground">Edit album information</h2>
            <p className="max-w-[64ch] text-muted">
              Update the current collage entry by changing its image, title, artist label, or track durations.
            </p>
          </div>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            Close
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-3" role="tablist" aria-label="Album edit sections">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "details"}
            className={classNames(
              secondaryButtonClass,
              activeTab === "details" && "border-accent bg-foreground/8",
            )}
            onClick={() => onTabChange("details")}
          >
            Image and titles
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "tracks"}
            className={classNames(
              secondaryButtonClass,
              activeTab === "tracks" && "border-accent bg-foreground/8",
            )}
            onClick={() => onTabChange("tracks")}
          >
            Track information
          </button>
        </div>
        {activeTab === "details" ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(220px,280px)_minmax(0,1fr)]">
            <div className="self-start overflow-hidden rounded-2xl border border-border/12 bg-foreground/[0.03]">
              {draft.imageUrl ? (
                <img className="block aspect-square w-full object-cover" src={draft.imageUrl} alt={`${draft.album} by ${draft.artist}`} />
              ) : (
                <div className={classNames(emptyStateClass, "min-h-[220px] rounded-none border-0")}>
                  <p>No image set.</p>
                </div>
              )}
            </div>
            <div className="grid gap-3.5">
              <label className="grid gap-1.5">
                <span>Album title</span>
                <input
                  className={fieldClass}
                  type="text"
                  value={draft.album}
                  onChange={(event) => onChange("album", event.target.value)}
                />
              </label>
              <label className="grid gap-1.5">
                <span>Artist label</span>
                <input
                  className={fieldClass}
                  type="text"
                  value={draft.artist}
                  onChange={(event) => onChange("artist", event.target.value)}
                />
              </label>
              <label className="grid gap-1.5">
                <span>Image URL</span>
                <input
                  className={fieldClass}
                  type="url"
                  placeholder="https://example.com/cover.jpg"
                  value={draft.imageUrl}
                  onChange={(event) => onChange("imageUrl", event.target.value)}
                />
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <a
                  className={secondaryButtonClass}
                  href={buildLastFmAlbumUrl({
                    artist: album.sourceArtist,
                    album: album.sourceAlbum,
                  })}
                  target="_blank"
                  rel="noreferrer"
                >
                  Update artwork on Last.fm
                </a>
                <button className={secondaryButtonClass} type="button" onClick={onRefreshArtwork} disabled={isRefreshingArtwork}>
                  {isRefreshingArtwork ? "Refreshing image..." : "Refresh image"}
                </button>
                <button className={secondaryButtonClass} type="button" onClick={onRemoveAlbum}>
                  Remove album from collage
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-4 grid gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <a
                className={secondaryButtonClass}
                href={buildMusicBrainzAlbumUrl({
                  artist: album.sourceArtist,
                  album: album.sourceAlbum,
                })}
                target="_blank"
                rel="noreferrer"
              >
                Open album on MusicBrainz
              </a>
              <button className={secondaryButtonClass} type="button" onClick={onRefreshTrackData} disabled={isRefreshingTracks}>
                {isRefreshingTracks ? "Refreshing track data..." : "Refresh track data"}
              </button>
            </div>
            {isLoadingTracks ? (
              <div className={classNames(emptyStateClass, "min-h-[180px]")}>
                <p>Loading track information...</p>
              </div>
            ) : (
              <div className="grid gap-3">
                {trackDrafts.map((track) => (
                  <div
                    key={track.trackKey}
                    className="grid items-end gap-3 rounded-2xl border border-border/12 bg-foreground/[0.03] p-3.5 [background:linear-gradient(180deg,rgba(255,255,255,0.02),transparent),rgb(var(--theme-foreground)/0.03)] lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:items-end"
                  >
                    <div className="grid gap-1">
                      <strong>{track.name}</strong>
                      <span className="text-[0.82rem] text-muted">
                        {track.plays === 1 ? "1 play" : `${track.plays} plays`}
                      </span>
                    </div>
                    <label className="grid gap-1.5">
                      <span>Duration</span>
                      <input
                        className={classNames(fieldClass, "w-28")}
                        type="text"
                        inputMode="numeric"
                        aria-label={`Duration for ${track.name}`}
                        placeholder="00:00"
                        value={track.durationInput}
                        onChange={(event) => onTrackDurationChange(track.trackKey, event.target.value)}
                      />
                    </label>
                    <a
                      className={secondaryButtonClass}
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
        <div className="mt-4 flex justify-end gap-4">
          <button className={secondaryButtonClass} type="button" onClick={onClose}>
            Cancel
          </button>
          <button className={primaryButtonClass} type="button" onClick={onSave}>
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

interface MissingDataPanelProps {
  items: MissingDataAlbumEntry[];
  isRefreshingDurations: boolean;
  onOpenAlbum: (album: AlbumEntry) => void;
  onRefreshMissingDurations: () => void;
}

function MissingDataPanel({
  items,
  isRefreshingDurations,
  onOpenAlbum,
  onRefreshMissingDurations,
}: MissingDataPanelProps) {
  if (items.length === 0) {
    return (
      <div className={emptyStateClass}>
        <p>No missing data remains.</p>
      </div>
    );
  }

  const hasMissingDurations = items.some((item) => item.hasMissingDurations);

  return (
    <div className="mt-5 grid gap-4">
      <p className="max-w-[64ch] text-muted">
        These albums still have missing artwork or track durations. Open an album to fix the image,
        titles, and track data in one place.
      </p>
      {hasMissingDurations ? (
        <div className="flex justify-start">
          <button
            className={secondaryButtonClass}
            type="button"
            onClick={onRefreshMissingDurations}
            disabled={isRefreshingDurations}
          >
            {isRefreshingDurations
              ? "Fetching missing durations..."
              : "Try fetching missing durations from MusicBrainz"}
          </button>
        </div>
      ) : null}
      <div className="grid gap-3.5">
        {items.map((item) => {
          const hasVisibleArtwork = Boolean(item.album.imageUrl) && !item.hasMissingArtwork;

          return (
            <button
              key={item.album.sourceKey}
              type="button"
              className={`grid gap-3.5 rounded-2xl border ${edgeBorderClass} bg-foreground/[0.03] p-4 text-left [background:linear-gradient(180deg,rgba(255,255,255,0.02),transparent),rgb(var(--theme-foreground)/0.03)] sm:grid-cols-[88px_minmax(0,1fr)]`}
              onClick={() => onOpenAlbum(item.album)}
              aria-label={`Edit ${item.album.album} by ${item.album.artist}`}
            >
              <div
                className={classNames(
                  "aspect-square overflow-hidden rounded-[14px] border border-border/12 bg-foreground/[0.03]",
                  !hasVisibleArtwork && "grid place-items-center p-2",
                )}
              >
                {hasVisibleArtwork ? (
                  <img className="block h-full w-full object-cover" src={item.album.imageUrl} alt="" />
                ) : (
                  <div className="text-center">
                    <strong>{item.album.album}</strong>
                    <span className="block text-[0.82rem] text-muted">{item.album.artist}</span>
                  </div>
                )}
              </div>
              <div className="grid gap-1.5">
                <strong>{item.album.album}</strong>
                <span className="text-muted">{item.album.artist}</span>
                <div className="flex flex-wrap gap-2">
                  {item.hasMissingArtwork ? (
                    <span className="inline-flex items-center rounded-full bg-foreground/8 px-2 py-1 text-[0.78rem] text-foreground">
                      Missing artwork
                    </span>
                  ) : null}
                  {item.hasMissingDurations ? (
                    <span className="inline-flex items-center rounded-full bg-foreground/8 px-2 py-1 text-[0.78rem] text-foreground">
                      Missing track durations
                    </span>
                  ) : null}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SummaryPanel({ summary, showDurationGaps }: SummaryPanelProps) {
  if (!summary) {
    return null;
  }

  return (
    <dl className="mt-4 grid grid-cols-2 gap-3.5">
      <div className={`rounded-[14px] border ${edgeBorderClass} bg-foreground/[0.03] p-3.5`}>
        <dt className="text-[0.85rem] text-muted">Scrobbles</dt>
        <dd className="mt-1 text-[1.1rem] font-bold text-foreground">
          {summary.scrobbles.toLocaleString()}
        </dd>
      </div>
      <div className={`rounded-[14px] border ${edgeBorderClass} bg-foreground/[0.03] p-3.5`}>
        <dt className="text-[0.85rem] text-muted">Albums found</dt>
        <dd className="mt-1 text-[1.1rem] font-bold text-foreground">{summary.albums.toLocaleString()}</dd>
      </div>
      {showDurationGaps ? (
        <div className={`rounded-[14px] border ${edgeBorderClass} bg-foreground/[0.03] p-3.5`}>
          <dt className="text-[0.85rem] text-muted">Duration gaps</dt>
          <dd className="mt-1 text-[1.1rem] font-bold text-foreground">
            {summary.durationGaps.toLocaleString()}
          </dd>
        </div>
      ) : null}
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
      <div
        className="mt-5 grid gap-3 [grid-template-columns:repeat(var(--columns),minmax(0,1fr))] max-sm:grid-cols-2"
        style={style}
      >
        <div className={emptyStateClass}>
          <p>No collage generated yet.</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="mt-5 grid gap-3 [grid-template-columns:repeat(var(--columns),minmax(0,1fr))] max-sm:grid-cols-2"
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
            className={classNames(
              "group relative aspect-square overflow-hidden rounded-2xl border border-border/20 bg-surface-muted p-0 text-left",
              !album.imageUrl &&
                "grid place-items-center bg-surface-muted p-4 [background:linear-gradient(135deg,rgba(255,255,255,0.06),rgba(255,255,255,0.02)),rgb(var(--theme-surface-muted))]",
              warningClassName === "has-warning" &&
                "border-amber-300 shadow-[inset_0_0_0_1px_rgba(255,194,92,0.45)]",
              warningClassName === "has-critical-warning" &&
                "border-orange-400 shadow-[inset_0_0_0_1px_rgba(255,138,101,0.45)]",
            )}
            onClick={() => onEdit(album)}
            aria-label={`Edit ${album.album} by ${album.artist}`}
          >
            {hasWarning ? (
              <span
                className="tile-warning-icon absolute left-2.5 top-2.5 z-10 inline-grid h-[1.35rem] w-[1.35rem] place-items-center rounded-full border border-amber-500/75 bg-amber-50/95 text-[0.78rem] font-extrabold leading-none text-amber-800 shadow-[0_6px_18px_rgb(var(--theme-shadow-color)/0.22)] dark:border-amber-300/60 dark:bg-surface/95 dark:text-amber-300"
                aria-hidden="true"
              >
                !
              </span>
            ) : null}
            {album.imageUrl ? (
              <img className="block h-full w-full object-cover" src={album.imageUrl} alt={`${album.album} by ${album.artist}`} />
            ) : (
              <div className="text-center">
                <strong>{album.album}</strong>
                <span className="block text-[0.82rem] text-muted">{album.artist}</span>
              </div>
            )}
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-background/95 via-background/80 to-transparent p-3">
              <strong>{album.album}</strong>
              <span className="block text-[0.82rem] text-muted">{album.artist}</span>
              <div className="mt-1.5 text-[0.78rem] text-muted">{formatMetric(album, rankingMode)}</div>
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
  isGenerating: boolean;
  username: string;
}

function ExportPreview({ exportPreviewUrl, hasAlbums, isGenerating, username }: ExportPreviewProps) {
  if (!hasAlbums) {
    return (
      <div className={classNames(emptyStateClass, "mt-5")}>
        <p>No collage generated yet.</p>
      </div>
    );
  }

  if (isGenerating) {
    return (
      <div className={classNames(emptyStateClass, "mt-5")}>
        <p>Regenerating the exact PNG preview...</p>
        <progress
          className="mt-4 h-3 w-full max-w-[360px] overflow-hidden rounded-full"
          aria-label="Regenerating exact PNG preview"
        />
      </div>
    );
  }

  if (!exportPreviewUrl) {
    return (
      <div className={classNames(emptyStateClass, "mt-5")}>
        <p>The exact PNG preview is not available yet.</p>
      </div>
    );
  }

  return (
    <div className="mt-5 grid place-items-center rounded-[18px] border border-border/12 bg-foreground/[0.03] p-4 [background:linear-gradient(180deg,rgba(255,255,255,0.02),transparent),rgb(var(--theme-foreground)/0.03)]">
      <img
        className="block h-auto w-full max-w-[880px] rounded-2xl shadow-surface"
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

    const timeRange = getTimeRangeOptions().some((option) => option.value === parsed.timeRange)
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

function loadThemePreference(): ThemePreference {
  const preference = getStoredThemePreference();
  if (preference === "light" || preference === "dark") {
    return preference;
  }

  return "system";
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

function getVisibleAlbums(albums: AlbumEntry[], hiddenAlbumSourceKeys: string[]): AlbumEntry[] {
  if (hiddenAlbumSourceKeys.length === 0) {
    return albums;
  }

  const hiddenAlbumSourceKeySet = new Set(hiddenAlbumSourceKeys);
  return albums.filter((album) => !hiddenAlbumSourceKeySet.has(album.sourceKey));
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
