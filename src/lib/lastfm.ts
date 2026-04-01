import type {
  AlbumEntry,
  AlbumMetadata,
  FetchProgressState,
  LastFmAlbumInfoResponse,
  LastFmErrorResponse,
  LastFmImage,
  LastFmTextField,
  LastFmTopAlbumsResponse,
  MissingArtworkEntry,
  RankingMode,
  ResolveMissingArtworkResult,
  TimeRangeValue,
} from "../types";

const LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/";
const LASTFM_PLACEHOLDER_IMAGE_MARKERS = [
  "2a96cbd8b46e442fc41c2b86b821562f",
  "/default_album_",
];
const ALBUM_OVERRIDE_CACHE_KEY = "lastfm-collage-album-override-cache";
const ALBUM_METADATA_CACHE_KEY = "lastfm-collage-album-metadata-cache";
const ARTWORK_CACHE_KEY = "lastfm-collage-artwork-cache";
const TOP_ALBUMS_CACHE_KEY = "lastfm-collage-top-albums-cache";
const LASTFM_MIN_REQUEST_INTERVAL_MS = 1000;
const TOP_ALBUMS_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const PERIOD_BY_RANGE: Record<TimeRangeValue, string> = {
  "7d": "7day",
  "1m": "1month",
  "3m": "3month",
  "6m": "6month",
  "12m": "12month",
  "overall": "overall",
};

interface ArtworkCacheEntry {
  imageUrl: string;
  checkedAt: number;
}

interface AlbumOverrideCacheEntry {
  album: string;
  artist: string;
  imageUrl: string;
  checkedAt: number;
}

interface AlbumMetadataCacheEntry extends AlbumMetadata {
  checkedAt: number;
}

interface TopAlbumsCacheEntry {
  queryKey: string;
  cachedAt: number;
  albums: Array<{
    artist: string;
    album: string;
    imageUrl: string;
    playCount: number;
    sourceArtist: string;
    sourceAlbum: string;
    sourceKey: string;
  }>;
}

const albumOverrideCache = loadAlbumOverrideCache();
const artworkCache = loadArtworkCache();
const albumMetadataCache = loadAlbumMetadataCache();
const lastFmRequestScheduler = createRequestScheduler(
  import.meta.env.MODE === "test" ? 0 : LASTFM_MIN_REQUEST_INTERVAL_MS,
);

export async function fetchTopAlbums(
  username: string,
  timeRangeValue: TimeRangeValue,
  apiKey: string,
  onStatus?: (message: string) => void,
  onProgress?: (progress: FetchProgressState) => void,
): Promise<AlbumEntry[]> {
  const queryKey = `${normalizeForKey(username)}::${timeRangeValue}`;
  const cached = import.meta.env.MODE !== "test"
    ? loadTopAlbumsCacheEntry(queryKey)
    : null;
  if (cached && Date.now() - cached.cachedAt <= TOP_ALBUMS_CACHE_MAX_AGE_MS) {
    onStatus?.("Using cached top albums from Last.fm.");
    return cached.albums.map((entry) => ({
      ...entry,
      artistNames: new Set([entry.artist]),
      approximateListeningMs: 0,
      trackCount: null,
      albumDurationMs: null,
    }));
  }

  const period = PERIOD_BY_RANGE[timeRangeValue];
  const albums = new Map<string, AlbumEntry>();
  let page = 1;
  let totalPages = 1;
  const startedAt = Date.now();

  do {
    onStatus?.(`Fetching top albums from Last.fm... page ${page}`);

    const payload = await callLastFm<LastFmTopAlbumsResponse>("user.gettopalbums", {
      user: username,
      period,
      page: String(page),
      limit: "200",
    }, apiKey);

    const topAlbums = payload.topalbums;
    const pageAlbums = Array.isArray(topAlbums.album)
      ? topAlbums.album
      : [topAlbums.album].filter(Boolean);

    for (const album of pageAlbums) {
      const albumName = readText(album.name);
      const artistName = readText(album.artist);
      if (!albumName || !artistName) continue;

      const imageUrl = readBestImage(album.image);
      const sourceKey = buildAlbumKey(artistName, albumName);

      if (!albums.has(sourceKey)) {
        albums.set(sourceKey, {
          artist: artistName,
          artistNames: new Set([artistName]),
          album: albumName,
          imageUrl,
          playCount: Number(album.playcount ?? 0),
          approximateListeningMs: 0,
          trackCount: null,
          albumDurationMs: null,
          sourceArtist: artistName,
          sourceAlbum: albumName,
          sourceKey,
        });
      }
    }

    totalPages = Number(topAlbums["@attr"]?.totalPages || page);
    publishProgress(page, totalPages, startedAt, onProgress);
    page += 1;
  } while (page <= totalPages);

  const result = [...albums.values()];
  persistTopAlbumsCacheEntry({
    queryKey,
    cachedAt: Date.now(),
    albums: result.map((a) => ({
      artist: a.artist,
      album: a.album,
      imageUrl: a.imageUrl,
      playCount: a.playCount,
      sourceArtist: a.sourceArtist,
      sourceAlbum: a.sourceAlbum,
      sourceKey: a.sourceKey,
    })),
  });
  return result;
}

export function computeListeningTimes(albums: AlbumEntry[]): void {
  for (const album of albums) {
    if (album.trackCount && album.trackCount > 0 && album.albumDurationMs && album.albumDurationMs > 0) {
      album.approximateListeningMs = (album.playCount / album.trackCount) * album.albumDurationMs;
    } else {
      album.approximateListeningMs = 0;
    }
  }
}

export function getMissingAlbumMetadataEntries(albums: AlbumEntry[]): AlbumEntry[] {
  return albums.filter(
    (album) => !album.trackCount || album.trackCount <= 0 || !album.albumDurationMs || album.albumDurationMs <= 0,
  );
}

export async function fetchMissingArtworkFromLastFm(
  albums: MissingArtworkEntry[],
  apiKey: string,
  onStatus?: (message: string) => void,
  onProgress?: (progress: FetchProgressState) => void,
): Promise<ResolveMissingArtworkResult> {
  syncArtworkCacheFromStorage();
  const pendingAlbums = albums.filter((album) => !readCachedArtwork(artworkCache[album.albumKey]));
  let completedRequests = 0;
  let resolvedCount = 0;
  const startedAt = Date.now();

  if (pendingAlbums.length > 0) {
    onProgress?.({
      completed: 0,
      total: pendingAlbums.length,
      estimatedRemainingMs: 0,
      unitLabel: "Albums",
    });
  } else {
    onStatus?.("No missing artwork remains.");
  }

  await mapWithConcurrency(pendingAlbums, 1, async (album) => {
    try {
      const payload = await callLastFm<LastFmAlbumInfoResponse>("album.getinfo", {
        artist: album.sourceArtist,
        album: album.sourceAlbum,
        autocorrect: "1",
      }, apiKey);
      const imageUrl = readBestImage(payload.album?.image);
      if (imageUrl && !isLastFmPlaceholderImageUrl(imageUrl)) {
        artworkCache[album.albumKey] = { imageUrl, checkedAt: Date.now() };
        resolvedCount += 1;
      }
    } catch (error) {
      console.warn("Last.fm artwork lookup failed", album, error);
    } finally {
      completedRequests += 1;
      if (pendingAlbums.length > 0) {
        const elapsedMs = Math.max(Date.now() - startedAt, 0);
        const averageRequestMs = completedRequests > 0 ? elapsedMs / completedRequests : 0;
        onProgress?.({
          completed: completedRequests,
          total: pendingAlbums.length,
          estimatedRemainingMs: Math.max(pendingAlbums.length - completedRequests, 0) * averageRequestMs,
          unitLabel: "Albums",
        });
        onStatus?.(`Fetching missing album artwork from Last.fm... ${completedRequests}/${pendingAlbums.length}`);
      }
    }
  });

  persistArtworkCache(artworkCache);

  return {
    resolvedCount,
    missingArtwork: buildMissingArtworkEntriesFromAlbums(albums),
  };
}

export function applyCachedArtwork(albums: AlbumEntry[]): void {
  applyCachedAlbumOverrides(albums);
  syncArtworkCacheFromStorage();

  for (const album of albums) {
    const cachedImageUrl = readCachedArtwork(artworkCache[buildAlbumKey(album.artist, album.album)]);
    if (cachedImageUrl) {
      album.imageUrl = cachedImageUrl;
    }
  }
}

export function applyCachedAlbumOverrides(albums: AlbumEntry[]): void {
  syncAlbumOverrideCacheFromStorage();

  for (const album of albums) {
    const cacheEntry = albumOverrideCache[album.sourceKey];
    if (!cacheEntry) continue;

    album.album = cacheEntry.album;
    album.artist = cacheEntry.artist;
    album.artistNames = new Set([cacheEntry.artist]);
    album.imageUrl = cacheEntry.imageUrl;
  }
}

export function applyCachedAlbumMetadata(albums: AlbumEntry[]): void {
  syncAlbumMetadataCacheFromStorage();

  for (const album of albums) {
    const entry = albumMetadataCache[album.sourceKey];
    if (!entry) continue;
    album.trackCount = entry.trackCount;
    album.albumDurationMs = entry.albumDurationMs;
  }
}

export function getMissingArtworkEntries(albums: AlbumEntry[]): MissingArtworkEntry[] {
  syncArtworkCacheFromStorage();

  return sortMissingArtworkEntries(
    albums.flatMap((album) => {
      if (album.imageUrl && !isLastFmPlaceholderImageUrl(album.imageUrl)) {
        return [];
      }

      const albumKey = buildAlbumKey(album.artist, album.album);
      if (readCachedArtwork(artworkCache[albumKey])) {
        return [];
      }

      return [
        {
          artist: album.artist,
          album: album.album,
          albumKey,
          sourceArtist: album.sourceArtist,
          sourceAlbum: album.sourceAlbum,
          sourceKey: album.sourceKey,
        },
      ];
    }),
  );
}

export function saveAlbumArtworkOverride(
  album: Pick<MissingArtworkEntry, "artist" | "album" | "albumKey">,
  imageUrl: string,
): void {
  artworkCache[album.albumKey] = {
    imageUrl: imageUrl.trim(),
    checkedAt: Date.now(),
  };
  persistArtworkCache(artworkCache);
}

export function saveAlbumOverride(
  album: Pick<AlbumEntry, "sourceKey">,
  override: {
    album: string;
    artist: string;
    imageUrl: string;
  },
): void {
  albumOverrideCache[album.sourceKey] = {
    album: override.album.trim(),
    artist: override.artist.trim(),
    imageUrl: override.imageUrl.trim(),
    checkedAt: Date.now(),
  };
  persistAlbumOverrideCache(albumOverrideCache);
}

export function saveAlbumMetadata(
  album: Pick<AlbumEntry, "sourceKey">,
  metadata: AlbumMetadata,
): void {
  albumMetadataCache[album.sourceKey] = {
    trackCount: Math.max(Math.round(metadata.trackCount), 0),
    albumDurationMs: Math.max(Math.round(metadata.albumDurationMs), 0),
    checkedAt: Date.now(),
  };
  persistAlbumMetadataCache(albumMetadataCache);
}

export function buildLastFmAlbumUrl(album: Pick<MissingArtworkEntry, "artist" | "album">): string {
  return `https://www.last.fm/music/${encodeURIComponent(album.artist)}/${encodeURIComponent(album.album)}`;
}

export async function refreshAlbumArtwork(
  album: Pick<AlbumEntry, "sourceArtist" | "sourceAlbum">,
  apiKey: string,
): Promise<string> {
  const payload = await callLastFm<LastFmAlbumInfoResponse>("album.getinfo", {
    artist: album.sourceArtist,
    album: album.sourceAlbum,
    autocorrect: "1",
  }, apiKey);
  const lastFmImage = readBestImage(payload.album?.image);
  if (lastFmImage && !isLastFmPlaceholderImageUrl(lastFmImage)) {
    return lastFmImage;
  }
  return "";
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

export function createRequestScheduler(
  minIntervalMs: number,
  options?: {
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  },
): { schedule<T>(task: () => Promise<T>): Promise<T> } {
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
      startGate = scheduledStart.then(() => undefined, () => undefined);
      return scheduledStart.then(() => task());
    },
  };
}

function readText(value: LastFmTextField): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value["#text"] === "string") return value["#text"].trim();
  if (value && typeof value.name === "string") return value.name.trim();
  return "";
}

function readBestImage(images?: LastFmImage[]): string {
  if (!Array.isArray(images)) return "";
  for (const image of [...images].reverse()) {
    if (typeof image?.["#text"] === "string" && image["#text"].trim()) {
      return image["#text"].trim();
    }
  }
  return "";
}

function isLastFmPlaceholderImageUrl(imageUrl: string): boolean {
  const normalizedUrl = imageUrl.trim().toLowerCase();
  if (!normalizedUrl) return false;
  return LASTFM_PLACEHOLDER_IMAGE_MARKERS.some((marker) => normalizedUrl.includes(marker));
}

function buildKey(left: string, right: string): string {
  return `${normalizeForKey(left)}::${normalizeForKey(right)}`;
}

function buildAlbumKey(artist: string, album: string): string {
  return buildKey(artist, album);
}

function sortMissingArtworkEntries(entries: MissingArtworkEntry[]): MissingArtworkEntry[] {
  return [...entries].sort((left, right) =>
    `${left.artist} ${left.album}`.localeCompare(`${right.artist} ${right.album}`),
  );
}

function buildMissingArtworkEntriesFromAlbums(albums: MissingArtworkEntry[]): MissingArtworkEntry[] {
  return sortMissingArtworkEntries(
    albums.flatMap((album) =>
      readCachedArtwork(artworkCache[album.albumKey]) ? [] : [{ ...album }],
    ),
  );
}

function normalizeForKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
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

function loadArtworkCache(): Record<string, ArtworkCacheEntry> {
  try {
    const raw = window.localStorage.getItem(ARTWORK_CACHE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([albumKey, value]) => {
        const entry = normalizeArtworkCacheEntry(value);
        return entry ? [[albumKey, entry]] : [];
      }),
    );
  } catch (error) {
    console.warn("Could not load artwork cache", error);
    return {};
  }
}

function loadAlbumOverrideCache(): Record<string, AlbumOverrideCacheEntry> {
  try {
    const raw = window.localStorage.getItem(ALBUM_OVERRIDE_CACHE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([sourceKey, value]) => {
        const entry = normalizeAlbumOverrideCacheEntry(value);
        return entry ? [[sourceKey, entry]] : [];
      }),
    );
  } catch (error) {
    console.warn("Could not load album override cache", error);
    return {};
  }
}

function loadAlbumMetadataCache(): Record<string, AlbumMetadataCacheEntry> {
  try {
    const raw = window.localStorage.getItem(ALBUM_METADATA_CACHE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([sourceKey, value]) => {
        const entry = normalizeAlbumMetadataCacheEntry(value);
        return entry ? [[sourceKey, entry]] : [];
      }),
    );
  } catch (error) {
    console.warn("Could not load album metadata cache", error);
    return {};
  }
}

function persistArtworkCache(cache: Record<string, ArtworkCacheEntry>): void {
  window.localStorage.setItem(ARTWORK_CACHE_KEY, JSON.stringify(cache));
}

function persistAlbumOverrideCache(cache: Record<string, AlbumOverrideCacheEntry>): void {
  window.localStorage.setItem(ALBUM_OVERRIDE_CACHE_KEY, JSON.stringify(cache));
}

function persistAlbumMetadataCache(cache: Record<string, AlbumMetadataCacheEntry>): void {
  window.localStorage.setItem(ALBUM_METADATA_CACHE_KEY, JSON.stringify(cache));
}

function loadTopAlbumsCacheEntry(queryKey: string): TopAlbumsCacheEntry | null {
  try {
    const raw = window.localStorage.getItem(TOP_ALBUMS_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const entry = (parsed as Record<string, unknown>)[queryKey];
    if (!entry || typeof entry !== "object") return null;
    const e = entry as Partial<TopAlbumsCacheEntry>;
    if (e.queryKey !== queryKey || !Array.isArray(e.albums) || typeof e.cachedAt !== "number") return null;
    return { queryKey: e.queryKey, cachedAt: e.cachedAt, albums: e.albums };
  } catch {
    return null;
  }
}

function persistTopAlbumsCacheEntry(entry: TopAlbumsCacheEntry): void {
  try {
    const raw = window.localStorage.getItem(TOP_ALBUMS_CACHE_KEY);
    const cache: Record<string, TopAlbumsCacheEntry> =
      raw ? (JSON.parse(raw) as Record<string, TopAlbumsCacheEntry>) : {};
    cache[entry.queryKey] = entry;
    window.localStorage.setItem(TOP_ALBUMS_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // ignore storage errors
  }
}

function syncArtworkCacheFromStorage(): void {
  const latestCache = loadArtworkCache();
  for (const key of Object.keys(artworkCache)) {
    if (!(key in latestCache)) delete artworkCache[key];
  }
  Object.assign(artworkCache, latestCache);
}

function syncAlbumOverrideCacheFromStorage(): void {
  const latestCache = loadAlbumOverrideCache();
  for (const key of Object.keys(albumOverrideCache)) {
    if (!(key in latestCache)) delete albumOverrideCache[key];
  }
  Object.assign(albumOverrideCache, latestCache);
}

function syncAlbumMetadataCacheFromStorage(): void {
  const latestCache = loadAlbumMetadataCache();
  for (const key of Object.keys(albumMetadataCache)) {
    if (!(key in latestCache)) delete albumMetadataCache[key];
  }
  Object.assign(albumMetadataCache, latestCache);
}

function readCachedArtwork(entry?: ArtworkCacheEntry): string {
  return entry?.imageUrl.trim() ?? "";
}

function normalizeArtworkCacheEntry(value: unknown): ArtworkCacheEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<ArtworkCacheEntry>;
  if (typeof entry.imageUrl !== "string" || typeof entry.checkedAt !== "number") return null;
  return {
    imageUrl: entry.imageUrl.trim(),
    checkedAt: Number.isFinite(entry.checkedAt) ? entry.checkedAt : 0,
  };
}

function normalizeAlbumOverrideCacheEntry(value: unknown): AlbumOverrideCacheEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<AlbumOverrideCacheEntry>;
  if (
    typeof entry.album !== "string" ||
    typeof entry.artist !== "string" ||
    typeof entry.imageUrl !== "string" ||
    typeof entry.checkedAt !== "number"
  ) return null;
  return {
    album: entry.album.trim(),
    artist: entry.artist.trim(),
    imageUrl: entry.imageUrl.trim(),
    checkedAt: Number.isFinite(entry.checkedAt) ? entry.checkedAt : 0,
  };
}

function normalizeAlbumMetadataCacheEntry(value: unknown): AlbumMetadataCacheEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<AlbumMetadataCacheEntry>;
  if (
    typeof entry.trackCount !== "number" ||
    typeof entry.albumDurationMs !== "number" ||
    typeof entry.checkedAt !== "number"
  ) return null;
  if (!Number.isFinite(entry.trackCount) || !Number.isFinite(entry.albumDurationMs) || !Number.isFinite(entry.checkedAt)) return null;
  return {
    trackCount: entry.trackCount,
    albumDurationMs: entry.albumDurationMs,
    checkedAt: entry.checkedAt,
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
