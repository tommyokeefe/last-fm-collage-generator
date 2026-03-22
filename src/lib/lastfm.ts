import type {
  AlbumEntry,
  AlbumTrack,
  FetchProgressState,
  LastFmErrorResponse,
  LastFmImage,
  LastFmRecentTrack,
  LastFmRecentTracksResponse,
  LastFmTextField,
  LastFmTrackInfoResponse,
  RankingMode,
  RecentTracksResult,
  RecentTracksResumeState,
  TimeRange,
  TimeRangeValue,
} from "../types";

const LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/";
const DURATION_CACHE_KEY = "lastfm-collage-duration-cache";
const RECENT_TRACKS_CHECKPOINT_KEY = "lastfm-collage-recent-tracks-checkpoint";
const LASTFM_MIN_REQUEST_INTERVAL_MS = 200;
const MISSING_DURATION_RETRY_AFTER_MS = 60 * 60 * 1000;
const DAYS_BY_RANGE: Record<Exclude<TimeRangeValue, "overall">, number> = {
  "7d": 7,
  "1m": 30,
  "3m": 90,
  "6m": 180,
  "12m": 365,
};

const durationCache = loadDurationCache();
const lastFmRequestScheduler = createRequestScheduler(
  import.meta.env.MODE === "test" ? 0 : LASTFM_MIN_REQUEST_INTERVAL_MS,
);

interface DurationCacheEntry {
  duration: number;
  checkedAt: number;
}

interface RecentTracksCheckpoint {
  queryKey: string;
  nextPage: number;
  totalPages: number;
  startedAt: number;
  items: LastFmRecentTrack[];
}

export function buildTimeRange(value: TimeRangeValue): TimeRange {
  if (value === "overall") {
    return { label: "overall" };
  }

  const now = Math.floor(Date.now() / 1000);
  const days = DAYS_BY_RANGE[value];

  return {
    label: value,
    from: now - days * 24 * 60 * 60,
    to: now,
  };
}

export async function fetchRecentTracks(
  username: string,
  timeRange: TimeRange,
  apiKey: string,
  onStatus?: (message: string) => void,
  onProgress?: (progress: FetchProgressState) => void,
): Promise<RecentTracksResult> {
  const queryKey = buildRecentTracksQueryKey(username, timeRange);
  const storedCheckpoint = loadRecentTracksCheckpoint(queryKey);
  const checkpoint =
    storedCheckpoint &&
    storedCheckpoint.nextPage > 1 &&
    storedCheckpoint.nextPage <= storedCheckpoint.totalPages
      ? storedCheckpoint
      : null;
  const allTracks: LastFmRecentTrack[] = checkpoint ? [...checkpoint.items] : [];
  let page = checkpoint?.nextPage ?? 1;
  let totalPages = checkpoint?.totalPages ?? 1;
  const startedAt = checkpoint?.startedAt ?? Date.now();

  if (checkpoint) {
    onStatus?.(
      `Resuming listening history from Last.fm... page ${checkpoint.nextPage} of ${checkpoint.totalPages}`,
    );
    publishProgress(checkpoint.nextPage - 1, checkpoint.totalPages, startedAt, onProgress);
  }

  do {
    onStatus?.(`Fetching listening history from Last.fm... page ${page}`);

    const payload = await callLastFm<LastFmRecentTracksResponse>("user.getrecenttracks", {
      user: username,
      page: String(page),
      limit: "200",
      extended: "1",
      ...(timeRange.from ? { from: String(timeRange.from) } : {}),
      ...(timeRange.to ? { to: String(timeRange.to) } : {}),
    }, apiKey);

    const recentTracks = payload.recenttracks;
    const pageTracks = Array.isArray(recentTracks.track)
      ? recentTracks.track
      : [recentTracks.track].filter(Boolean);

    for (const track of pageTracks) {
      if (track.date?.uts) {
        allTracks.push(track);
      }
    }

    totalPages = Number(recentTracks?.["@attr"]?.totalPages || page);
    const completedPages = page;
    persistRecentTracksCheckpoint({
      queryKey,
      nextPage: completedPages + 1,
      totalPages,
      startedAt,
      items: allTracks,
    });
    publishProgress(completedPages, totalPages, startedAt, onProgress);
    page += 1;
  } while (page <= totalPages);

  clearRecentTracksCheckpoint(queryKey);

  return {
    items: allTracks,
    pagesFetched: totalPages,
  };
}

export function getRecentTracksResumeState(
  username: string,
  timeRange: TimeRange,
): RecentTracksResumeState | null {
  const checkpoint = loadRecentTracksCheckpoint(buildRecentTracksQueryKey(username, timeRange));
  if (!checkpoint || checkpoint.nextPage <= 1 || checkpoint.nextPage > checkpoint.totalPages) {
    return null;
  }

  return {
    nextPage: checkpoint.nextPage,
    totalPages: checkpoint.totalPages,
  };
}

export function aggregateAlbums(scrobbles: LastFmRecentTrack[]): AlbumEntry[] {
  const albums = new Map<string, AlbumEntry>();

  for (const track of scrobbles) {
    const artist = readText(track.artist);
    const album = readText(track.album);
    const trackName = readText(track.name);

    if (!artist || !album || !trackName) {
      continue;
    }

    const imageUrl = readBestImage(track.image);
    const albumKey = resolveAlbumKey(albums, album, imageUrl);
    const trackKey = buildKey(artist, trackName);

    if (!albums.has(albumKey)) {
      albums.set(albumKey, {
        artist,
        artistNames: new Set([artist]),
        album,
        imageUrl,
        playCount: 0,
        approximateListeningMs: 0,
        tracks: new Map<string, AlbumTrack>(),
      });
    }

    const entry = albums.get(albumKey);
    if (!entry) {
      continue;
    }

    entry.artistNames.add(artist);
    entry.artist = formatArtistNames(entry.artistNames);
    entry.playCount += 1;

    if (!entry.imageUrl && imageUrl) {
      entry.imageUrl = imageUrl;
    }

    if (!entry.tracks.has(trackKey)) {
        entry.tracks.set(trackKey, {
          artist,
          album,
          name: trackName,
          plays: 0,
        });
    }

    const albumTrack = entry.tracks.get(trackKey);
    if (albumTrack) {
      albumTrack.plays += 1;
    }
  }

  return [...albums.values()];
}

export async function hydrateApproximateListeningTimes(
  albums: AlbumEntry[],
  apiKey: string,
  onStatus?: (message: string) => void,
  onProgress?: (progress: FetchProgressState) => void,
): Promise<number> {
  syncDurationCacheFromStorage();
  const uniqueTracks = new Map<string, AlbumTrack>();

  for (const album of albums) {
    for (const [trackKey, track] of album.tracks.entries()) {
      if (!uniqueTracks.has(trackKey)) {
        uniqueTracks.set(trackKey, track);
      }
    }
  }

  let durationGaps = 0;
  const uncachedTracks = [...uniqueTracks.entries()].filter(
    ([trackKey]) => shouldFetchDuration(durationCache[trackKey]),
  );
  let completedRequests = 0;
  const startedAt = Date.now();

  if (uncachedTracks.length > 0) {
    onProgress?.({
      completed: 0,
      total: uncachedTracks.length,
      estimatedRemainingMs: 0,
      unitLabel: "Tracks",
    });
  } else {
    onStatus?.("All required track durations were already cached.");
  }

  await mapWithConcurrency(uncachedTracks, 5, async ([trackKey, track]) => {
    try {
      const payload = await callLastFm<LastFmTrackInfoResponse>("track.getInfo", {
        artist: track.artist,
        track: track.name,
        autocorrect: "1",
      }, apiKey);

      const duration = Number(payload.track?.duration || 0);
      const normalizedDuration = Number.isFinite(duration) ? duration : 0;
      durationCache[trackKey] = {
        duration: normalizedDuration,
        checkedAt: Date.now(),
      };
      if (!normalizedDuration) {
        warnMissingDuration(track);
        durationGaps += 1;
      }
    } catch (error) {
      console.warn("Duration lookup failed", track, error);
      durationCache[trackKey] = {
        duration: 0,
        checkedAt: Date.now(),
      };
      warnMissingDuration(track);
      durationGaps += 1;
    } finally {
      completedRequests += 1;
      if (uncachedTracks.length > 0) {
        const elapsedMs = Math.max(Date.now() - startedAt, 0);
        const averageRequestMs = completedRequests > 0 ? elapsedMs / completedRequests : 0;
        onProgress?.({
          completed: completedRequests,
          total: uncachedTracks.length,
          estimatedRemainingMs:
            Math.max(uncachedTracks.length - completedRequests, 0) * averageRequestMs,
          unitLabel: "Tracks",
        });
        onStatus?.(
          `Fetching track durations for approximate listening time... ${completedRequests}/${uncachedTracks.length}`,
        );
      }
    }
  });

  persistDurationCache(durationCache);

  for (const album of albums) {
    let total = 0;

    for (const [trackKey, track] of album.tracks.entries()) {
      total += readCachedDuration(durationCache[trackKey]) * track.plays;
    }

    album.approximateListeningMs = total;
  }

  return durationGaps;
}

export function sortAlbums(albums: AlbumEntry[], rankingMode: RankingMode): AlbumEntry[] {
  return [...albums].sort((left, right) => {
    if (rankingMode === "listening-time") {
      if (right.approximateListeningMs !== left.approximateListeningMs) {
        return right.approximateListeningMs - left.approximateListeningMs;
      }
    }

    if (right.playCount !== left.playCount) {
      return right.playCount - left.playCount;
    }

    return `${left.artist} ${left.album}`.localeCompare(`${right.artist} ${right.album}`);
  });
}

export function formatMetric(album: AlbumEntry, rankingMode: RankingMode): string {
  if (rankingMode === "listening-time") {
    return `${formatDuration(album.approximateListeningMs)} approx listening time`;
  }

  return `${album.playCount.toLocaleString()} plays`;
}

export function formatDuration(milliseconds: number): string {
  const totalMinutes = Math.round(milliseconds / 60000);
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
}

function warnMissingDuration(track: AlbumTrack): void {
  console.warn(
    `[lastfm-duration-gap] Missing duration metadata for "${track.name}" on album "${track.album}" by ${track.artist}.`,
  );
}

async function callLastFm<T extends object>(
  method: string,
  params: Record<string, string>,
  apiKey: string,
): Promise<T> {
  const url = new URL(LASTFM_API_URL);
  url.search = new URLSearchParams({
    method,
    api_key: apiKey,
    format: "json",
    ...params,
  }).toString();

  const response = await lastFmRequestScheduler.schedule(() => fetch(url.toString()));
  if (!response.ok) {
    throw new Error(`Last.fm request failed with HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as T | LastFmErrorResponse;
  if ("error" in payload) {
    throw new Error(payload.message || `Last.fm API error ${payload.error}.`);
  }

  return payload;
}

interface RequestScheduler {
  schedule<T>(task: () => Promise<T>): Promise<T>;
}

export function createRequestScheduler(
  minIntervalMs: number,
  options?: {
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  },
): RequestScheduler {
  const now = options?.now ?? (() => Date.now());
  const sleep = options?.sleep ?? wait;
  let nextStartAt = 0;
  let startGate = Promise.resolve();

  return {
    schedule<T>(task: () => Promise<T>): Promise<T> {
      const reserveStartSlot = async () => {
        const waitMs = Math.max(nextStartAt - now(), 0);
        if (waitMs > 0) {
          await sleep(waitMs);
        }

        nextStartAt = now() + minIntervalMs;
      };

      const scheduledStart = startGate.then(reserveStartSlot, reserveStartSlot);
      startGate = scheduledStart.then(
        () => undefined,
        () => undefined,
      );
      return scheduledStart.then(() => task());
    },
  };
}

function readText(value: LastFmTextField): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (value && typeof value["#text"] === "string") {
    return value["#text"].trim();
  }

  if (value && typeof value.name === "string") {
    return value.name.trim();
  }

  return "";
}

function readBestImage(images?: LastFmImage[]): string {
  if (!Array.isArray(images)) {
    return "";
  }

  for (const image of [...images].reverse()) {
    if (typeof image?.["#text"] === "string" && image["#text"].trim()) {
      return image["#text"].trim();
    }
  }

  return "";
}

function buildKey(left: string, right: string): string {
  return `${normalizeForKey(left)}::${normalizeForKey(right)}`;
}

function resolveAlbumKey(
  albums: Map<string, AlbumEntry>,
  album: string,
  imageUrl: string,
): string {
  const normalizedAlbum = normalizeForKey(album);

  for (const [key, entry] of albums.entries()) {
    if (normalizeForKey(entry.album) !== normalizedAlbum) {
      continue;
    }

    if (imageUrl && entry.imageUrl && entry.imageUrl !== imageUrl) {
      continue;
    }

    return key;
  }

  return imageUrl ? `${normalizedAlbum}::${imageUrl}` : normalizedAlbum;
}

function formatArtistNames(artistNames: Set<string>): string {
  return [...artistNames].sort((left, right) => left.localeCompare(right)).join(", ");
}

function normalizeForKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildRecentTracksQueryKey(username: string, timeRange: TimeRange): string {
  return `${normalizeForKey(username)}::${timeRange.label}`;
}

function loadDurationCache(): Record<string, DurationCacheEntry> {
  try {
    const raw = window.localStorage.getItem(DURATION_CACHE_KEY);
    if (!raw) {
      return {};
    }

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).flatMap(([trackKey, value]) => {
        const entry = normalizeDurationCacheEntry(value);
        return entry ? [[trackKey, entry]] : [];
      }),
    );
  } catch (error) {
    console.warn("Could not load duration cache", error);
    return {};
  }
}

function persistDurationCache(cache: Record<string, DurationCacheEntry>): void {
  window.localStorage.setItem(DURATION_CACHE_KEY, JSON.stringify(cache));
}

function syncDurationCacheFromStorage(): void {
  const latestCache = loadDurationCache();

  for (const key of Object.keys(durationCache)) {
    if (!(key in latestCache)) {
      delete durationCache[key];
    }
  }

  Object.assign(durationCache, latestCache);
}

function loadRecentTracksCheckpoint(queryKey: string): RecentTracksCheckpoint | null {
  try {
    const raw = window.localStorage.getItem(RECENT_TRACKS_CHECKPOINT_KEY);
    if (!raw) {
      return null;
    }

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const checkpoint = parsed as Partial<RecentTracksCheckpoint>;
    if (
      checkpoint.queryKey !== queryKey ||
      !Array.isArray(checkpoint.items) ||
      typeof checkpoint.nextPage !== "number" ||
      typeof checkpoint.totalPages !== "number" ||
      typeof checkpoint.startedAt !== "number"
    ) {
      return null;
    }

    return {
      queryKey: checkpoint.queryKey,
      nextPage: checkpoint.nextPage,
      totalPages: checkpoint.totalPages,
      startedAt: checkpoint.startedAt,
      items: checkpoint.items,
    };
  } catch (error) {
    console.warn("Could not load recent tracks checkpoint", error);
    return null;
  }
}

function persistRecentTracksCheckpoint(checkpoint: RecentTracksCheckpoint): void {
  window.localStorage.setItem(RECENT_TRACKS_CHECKPOINT_KEY, JSON.stringify(checkpoint));
}

function clearRecentTracksCheckpoint(queryKey: string): void {
  const checkpoint = loadRecentTracksCheckpoint(queryKey);
  if (!checkpoint) {
    return;
  }

  window.localStorage.removeItem(RECENT_TRACKS_CHECKPOINT_KEY);
}

function publishProgress(
  completedPages: number,
  totalPages: number,
  startedAt: number,
  onProgress?: (progress: FetchProgressState) => void,
): void {
  const elapsedMs = Math.max(Date.now() - startedAt, 0);
  const averagePageMs = completedPages > 0 ? elapsedMs / completedPages : 0;
  onProgress?.({
    completed: completedPages,
    total: totalPages,
    estimatedRemainingMs: Math.max(totalPages - completedPages, 0) * averagePageMs,
    unitLabel: "Pages",
  });
}

function shouldFetchDuration(entry?: DurationCacheEntry): boolean {
  if (!entry) {
    return true;
  }

  if (entry.duration > 0) {
    return false;
  }

  return Date.now() - entry.checkedAt > MISSING_DURATION_RETRY_AFTER_MS;
}

function readCachedDuration(entry?: DurationCacheEntry): number {
  return entry?.duration ?? 0;
}

function normalizeDurationCacheEntry(value: unknown): DurationCacheEntry | null {
  if (typeof value === "number") {
    return {
      duration: Number.isFinite(value) ? value : 0,
      checkedAt: value > 0 ? Date.now() : 0,
    };
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const entry = value as Partial<DurationCacheEntry>;
  if (typeof entry.duration !== "number" || typeof entry.checkedAt !== "number") {
    return null;
  }

  return {
    duration: Number.isFinite(entry.duration) ? entry.duration : 0,
    checkedAt: Number.isFinite(entry.checkedAt) ? entry.checkedAt : 0,
  };
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<void>,
): Promise<void[]> {
  const results = new Array<Promise<void> | void>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex] as T, currentIndex);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    () => worker(),
  );

  await Promise.all(workers);
  return results.map(() => undefined);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}
