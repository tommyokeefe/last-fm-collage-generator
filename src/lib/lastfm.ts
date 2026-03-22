import type {
  AlbumEntry,
  AlbumTrack,
  LastFmErrorResponse,
  LastFmImage,
  LastFmRecentTrack,
  LastFmRecentTracksResponse,
  LastFmTextField,
  LastFmTrackInfoResponse,
  RankingMode,
  RecentTracksResult,
  TimeRange,
  TimeRangeValue,
} from "../types";

const LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/";
const DURATION_CACHE_KEY = "lastfm-collage-duration-cache";
const DAYS_BY_RANGE: Record<Exclude<TimeRangeValue, "overall">, number> = {
  "7d": 7,
  "1m": 30,
  "3m": 90,
  "6m": 180,
  "12m": 365,
};

const durationCache = loadDurationCache();

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
): Promise<RecentTracksResult> {
  const allTracks: LastFmRecentTrack[] = [];
  let page = 1;
  let totalPages = 1;

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
    page += 1;
  } while (page <= totalPages);

  return {
    items: allTracks,
    pagesFetched: totalPages,
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
): Promise<number> {
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
    ([trackKey]) => typeof durationCache[trackKey] !== "number",
  );
  let completedRequests = 0;

  await mapWithConcurrency(uncachedTracks, 5, async ([trackKey, track]) => {
    try {
      const payload = await callLastFm<LastFmTrackInfoResponse>("track.getInfo", {
        artist: track.artist,
        track: track.name,
        autocorrect: "1",
      }, apiKey);

      const duration = Number(payload.track?.duration || 0);
      durationCache[trackKey] = Number.isFinite(duration) ? duration : 0;
      if (!durationCache[trackKey]) {
        warnMissingDuration(track);
        durationGaps += 1;
      }
    } catch (error) {
      console.warn("Duration lookup failed", track, error);
      durationCache[trackKey] = 0;
      warnMissingDuration(track);
      durationGaps += 1;
    } finally {
      completedRequests += 1;
      if (uncachedTracks.length > 0) {
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
      total += (durationCache[trackKey] || 0) * track.plays;
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

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Last.fm request failed with HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as T | LastFmErrorResponse;
  if ("error" in payload) {
    throw new Error(payload.message || `Last.fm API error ${payload.error}.`);
  }

  return payload;
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

function loadDurationCache(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(DURATION_CACHE_KEY);
    if (!raw) {
      return {};
    }

    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch (error) {
    console.warn("Could not load duration cache", error);
    return {};
  }
}

function persistDurationCache(cache: Record<string, number>): void {
  window.localStorage.setItem(DURATION_CACHE_KEY, JSON.stringify(cache));
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
