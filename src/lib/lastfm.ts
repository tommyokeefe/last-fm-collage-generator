import type {
  AlbumEntry,
  AlbumTrack,
  AlbumTrackDurationEntry,
  FetchProgressState,
  HydrateListeningTimesResult,
  LastFmAlbumInfoResponse,
  LastFmErrorResponse,
  LastFmImage,
  MissingArtworkEntry,
  MissingDurationEntry,
  LastFmRecentTrack,
  LastFmRecentTracksResponse,
  LastFmTextField,
  LastFmTrackInfoResponse,
  RankingMode,
  RecentTracksResult,
  RecentTracksResumeState,
  ResolveMissingArtworkResult,
  ResolveMissingDurationsResult,
  TimeRange,
  TimeRangeValue,
} from "../types";

const LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/";
const MUSICBRAINZ_RECORDING_API_URL = "https://musicbrainz.org/ws/2/recording";
const MUSICBRAINZ_RELEASE_API_URL = "https://musicbrainz.org/ws/2/release";
const LASTFM_PLACEHOLDER_IMAGE_MARKERS = [
  "2a96cbd8b46e442fc41c2b86b821562f",
  "/default_album_",
];
const ALBUM_OVERRIDE_CACHE_KEY = "lastfm-collage-album-override-cache";
const DURATION_CACHE_KEY = "lastfm-collage-duration-cache";
const ARTWORK_CACHE_KEY = "lastfm-collage-artwork-cache";
const RECENT_TRACKS_CHECKPOINT_KEY = "lastfm-collage-recent-tracks-checkpoint";
const RECENT_TRACKS_CACHE_KEY = "lastfm-collage-recent-tracks-cache";
const LASTFM_MIN_REQUEST_INTERVAL_MS = 1000;
const MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS = 1100;
const MISSING_DURATION_RETRY_AFTER_MS = 60 * 60 * 1000;
const DAYS_BY_RANGE: Partial<Record<TimeRangeValue, number>> = {
  "7d": 7,
  "1m": 30,
  "3m": 90,
  "6m": 180,
  "12m": 365,
};
const RECENT_TRACKS_CACHE_MAX_AGE_MS: Record<TimeRangeValue, number> = {
  "7d": 12 * 60 * 60 * 1000,
  "1m": 12 * 60 * 60 * 1000,
  "3m": 12 * 60 * 60 * 1000,
  "6m": 12 * 60 * 60 * 1000,
  "12m": 12 * 60 * 60 * 1000,
  "overall": 24 * 60 * 60 * 1000,
};

const durationCache = loadDurationCache();
const albumOverrideCache = loadAlbumOverrideCache();
const artworkCache = loadArtworkCache();
const lastFmRequestScheduler = createRequestScheduler(
  import.meta.env.MODE === "test" ? 0 : LASTFM_MIN_REQUEST_INTERVAL_MS,
);
const musicBrainzRequestScheduler = createRequestScheduler(
  import.meta.env.MODE === "test" ? 0 : MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS,
);

interface DurationCacheEntry {
  duration: number;
  checkedAt: number;
}

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

interface RecentTracksCheckpoint {
  queryKey: string;
  nextPage: number;
  totalPages: number;
  startedAt: number;
  items: LastFmRecentTrack[];
}

interface RecentTracksCacheEntry extends RecentTracksResult {
  queryKey: string;
  cachedAt: number;
}

interface MusicBrainzRecording {
  title?: string;
  length?: number | null;
  score?: number | string;
  releases?: Array<{
    title?: string;
  }>;
  "artist-credit"?: Array<{
    name?: string;
    artist?: {
      name?: string;
    };
  }>;
}

interface MusicBrainzRecordingSearchResponse {
  recordings?: MusicBrainzRecording[];
}

interface MusicBrainzRelease {
  id?: string;
  title?: string;
  score?: number | string;
  "artist-credit"?: Array<{
    name?: string;
    artist?: {
      name?: string;
    };
  }>;
  "cover-art-archive"?: {
    front?: boolean;
  };
}

interface MusicBrainzReleaseSearchResponse {
  releases?: MusicBrainzRelease[];
}

export function buildTimeRange(value: TimeRangeValue): TimeRange {
  const now = Math.floor(Date.now() / 1000);
  const days = (DAYS_BY_RANGE as Partial<Record<string, number>>)[value];

  if (typeof days !== "number") {
    return { label: value };
  }

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
  const cachedResult = loadRecentTracksCacheEntry(queryKey);
  if (cachedResult && isRecentTracksCacheFresh(cachedResult, timeRange)) {
    onStatus?.("Using cached listening history from Last.fm.");
    publishProgress(cachedResult.pagesFetched, cachedResult.pagesFetched, cachedResult.cachedAt, onProgress);
    return {
      items: cachedResult.items,
      pagesFetched: cachedResult.pagesFetched,
    };
  }

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
  persistRecentTracksCacheEntry({
    queryKey,
    cachedAt: Date.now(),
    items: allTracks,
    pagesFetched: totalPages,
  });

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
        sourceArtist: artist,
        sourceAlbum: album,
        sourceKey: buildAlbumKey(artist, album),
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
): Promise<HydrateListeningTimesResult> {
  syncDurationCacheFromStorage();
  const uniqueTracks = new Map<string, AlbumTrack>();

  for (const album of albums) {
    for (const [trackKey, track] of album.tracks.entries()) {
      if (!uniqueTracks.has(trackKey)) {
        uniqueTracks.set(trackKey, track);
      }
    }
  }

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
      }
    } catch (error) {
      console.warn("Duration lookup failed", track, error);
      durationCache[trackKey] = {
        duration: 0,
        checkedAt: Date.now(),
      };
      warnMissingDuration(track);
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
  applyCachedDurations(albums);

  return {
    missingDurations: getMissingDurationEntries(albums),
  };
}

export async function fetchMissingDurationsFromMusicBrainz(
  tracks: MissingDurationEntry[],
  onStatus?: (message: string) => void,
  onProgress?: (progress: FetchProgressState) => void,
): Promise<ResolveMissingDurationsResult> {
  syncDurationCacheFromStorage();
  const pendingTracks = tracks.filter((track) => readCachedDuration(durationCache[track.trackKey]) === 0);
  let completedRequests = 0;
  let resolvedCount = 0;
  const startedAt = Date.now();

  if (pendingTracks.length > 0) {
    onProgress?.({
      completed: 0,
      total: pendingTracks.length,
      estimatedRemainingMs: 0,
      unitLabel: "Tracks",
    });
  } else {
    onStatus?.("No unresolved durations remain.");
  }

  await mapWithConcurrency(pendingTracks, 1, async (track) => {
    try {
      const duration = await lookupMusicBrainzTrackDuration(track);
      durationCache[track.trackKey] = {
        duration,
        checkedAt: Date.now(),
      };
      if (duration > 0) {
        resolvedCount += 1;
      }
    } catch (error) {
      console.warn("MusicBrainz duration lookup failed", track, error);
    } finally {
      completedRequests += 1;
      if (pendingTracks.length > 0) {
        const elapsedMs = Math.max(Date.now() - startedAt, 0);
        const averageRequestMs = completedRequests > 0 ? elapsedMs / completedRequests : 0;
        onProgress?.({
          completed: completedRequests,
          total: pendingTracks.length,
          estimatedRemainingMs: Math.max(pendingTracks.length - completedRequests, 0) * averageRequestMs,
          unitLabel: "Tracks",
        });
        onStatus?.(
          `Trying MusicBrainz for missing track durations... ${completedRequests}/${pendingTracks.length}`,
        );
      }
    }
  });

  persistDurationCache(durationCache);

  return {
    resolvedCount,
    missingDurations: buildMissingDurationEntriesFromTracks(tracks),
  };
}

export async function refreshAlbumTrackDurationsFromMusicBrainz(
  album: AlbumEntry,
  onStatus?: (message: string) => void,
  onProgress?: (progress: FetchProgressState) => void,
): Promise<{ resolvedCount: number }> {
  syncDurationCacheFromStorage();
  const tracks = getAlbumTrackDurationEntries(album);
  let completedRequests = 0;
  let resolvedCount = 0;
  const startedAt = Date.now();

  if (tracks.length > 0) {
    onProgress?.({
      completed: 0,
      total: tracks.length,
      estimatedRemainingMs: 0,
      unitLabel: "Tracks",
    });
  } else {
    onStatus?.("No tracks are available for this album.");
  }

  await mapWithConcurrency(tracks, 1, async (track) => {
    try {
      const duration = await lookupMusicBrainzTrackDuration(track);
      if (duration > 0) {
        durationCache[track.trackKey] = {
          duration,
          checkedAt: Date.now(),
        };
        resolvedCount += 1;
      } else if (!durationCache[track.trackKey]) {
        durationCache[track.trackKey] = {
          duration: 0,
          checkedAt: Date.now(),
        };
      }
    } catch (error) {
      console.warn("MusicBrainz duration refresh failed", track, error);
      if (!durationCache[track.trackKey]) {
        durationCache[track.trackKey] = {
          duration: 0,
          checkedAt: Date.now(),
        };
      }
    } finally {
      completedRequests += 1;
      if (tracks.length > 0) {
        const elapsedMs = Math.max(Date.now() - startedAt, 0);
        const averageRequestMs = completedRequests > 0 ? elapsedMs / completedRequests : 0;
        onProgress?.({
          completed: completedRequests,
          total: tracks.length,
          estimatedRemainingMs: Math.max(tracks.length - completedRequests, 0) * averageRequestMs,
          unitLabel: "Tracks",
        });
        onStatus?.(
          `Refreshing track durations from MusicBrainz... ${completedRequests}/${tracks.length}`,
        );
      }
    }
  });

  persistDurationCache(durationCache);

  return {
    resolvedCount,
  };
}

export async function fetchMissingArtworkFromMusicBrainz(
  albums: MissingArtworkEntry[],
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
      const imageUrl = await lookupMusicBrainzAlbumArtwork(album);
      if (imageUrl) {
        artworkCache[album.albumKey] = {
          imageUrl,
          checkedAt: Date.now(),
        };
        resolvedCount += 1;
      }
    } catch (error) {
      console.warn("MusicBrainz artwork lookup failed", album, error);
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
        onStatus?.(
          `Trying MusicBrainz for missing album artwork... ${completedRequests}/${pendingAlbums.length}`,
        );
      }
    }
  });

  persistArtworkCache(artworkCache);

  return {
    resolvedCount,
    missingArtwork: buildMissingArtworkEntriesFromAlbums(albums),
  };
}

export function applyCachedDurations(albums: AlbumEntry[]): void {
  syncDurationCacheFromStorage();

  for (const album of albums) {
    let total = 0;

    for (const [trackKey, track] of album.tracks.entries()) {
      total += readCachedDuration(durationCache[trackKey]) * track.plays;
    }

    album.approximateListeningMs = total;
  }
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
    if (!cacheEntry) {
      continue;
    }

    album.album = cacheEntry.album;
    album.artist = cacheEntry.artist;
    album.artistNames = new Set([cacheEntry.artist]);
    album.imageUrl = cacheEntry.imageUrl;
  }
}

export function getMissingDurationEntries(albums: AlbumEntry[]): MissingDurationEntry[] {
  syncDurationCacheFromStorage();
  const missingTracks = new Map<string, MissingDurationEntry>();

  for (const album of albums) {
    for (const [trackKey, track] of album.tracks.entries()) {
      const cacheEntry = durationCache[trackKey];
      if (readCachedDuration(cacheEntry) > 0 || missingTracks.has(trackKey)) {
        continue;
      }

      missingTracks.set(trackKey, {
        ...track,
        trackKey,
        checkedAt: cacheEntry?.checkedAt ?? 0,
      });
    }
  }

  return sortMissingDurationEntries([...missingTracks.values()]);
}

export function getAlbumTrackDurationEntries(album: AlbumEntry): AlbumTrackDurationEntry[] {
  syncDurationCacheFromStorage();

  return [...album.tracks.entries()]
    .map(([trackKey, track]) => {
      const cacheEntry = durationCache[trackKey];

      return {
        ...track,
        trackKey,
        checkedAt: cacheEntry?.checkedAt ?? 0,
        durationMs: readCachedDuration(cacheEntry),
      };
    })
    .sort((left, right) =>
      right.plays - left.plays || `${left.name} ${left.artist}`.localeCompare(`${right.name} ${right.artist}`),
    );
}

export function getMissingArtworkEntries(albums: AlbumEntry[]): MissingArtworkEntry[] {
  syncArtworkCacheFromStorage();

  return sortMissingArtworkEntries(
    albums.flatMap((album) => {
      if (album.imageUrl) {
        if (!isLastFmPlaceholderImageUrl(album.imageUrl)) {
          return [];
        }
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

export function saveTrackDurationOverride(track: AlbumTrack, durationMs: number): void {
  const normalizedDuration = Math.max(Math.round(durationMs), 0);
  durationCache[buildKey(track.artist, track.name)] = {
    duration: normalizedDuration,
    checkedAt: Date.now(),
  };
  persistDurationCache(durationCache);
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

export function buildMusicBrainzTrackUrl(track: AlbumTrack): string {
  return buildMusicBrainzSearchUrl({
    query: `${track.name} ${track.artist} ${track.album}`,
    type: "recording",
  });
}

export function buildMusicBrainzAlbumUrl(
  album: Pick<MissingArtworkEntry, "artist" | "album">,
): string {
  return buildMusicBrainzSearchUrl({
    query: `${album.album} ${album.artist}`,
    type: "release",
  });
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

  return lookupMusicBrainzAlbumArtwork({
    artist: album.sourceArtist,
    album: album.sourceAlbum,
  });
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

async function lookupMusicBrainzTrackDuration(track: AlbumTrack): Promise<number> {
  const query = [
    `recording:"${escapeMusicBrainzQueryValue(track.name)}"`,
    `artist:"${escapeMusicBrainzQueryValue(track.artist)}"`,
    `release:"${escapeMusicBrainzQueryValue(track.album)}"`,
  ].join(" AND ");
  const payload = await callMusicBrainz<MusicBrainzRecordingSearchResponse>(
    MUSICBRAINZ_RECORDING_API_URL,
    {
      query,
      fmt: "json",
      limit: "5",
    },
  );
  return pickMusicBrainzDuration(payload.recordings ?? [], track);
}

async function lookupMusicBrainzAlbumArtwork(
  album: Pick<MissingArtworkEntry, "artist" | "album">,
): Promise<string> {
  const query = [
    `release:"${escapeMusicBrainzQueryValue(album.album)}"`,
    `artist:"${escapeMusicBrainzQueryValue(album.artist)}"`,
  ].join(" AND ");
  const payload = await callMusicBrainz<MusicBrainzReleaseSearchResponse>(
    MUSICBRAINZ_RELEASE_API_URL,
    {
      query,
      fmt: "json",
      limit: "5",
    },
  );

  return pickMusicBrainzArtwork(payload.releases ?? [], album);
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

async function callMusicBrainz<T extends object>(
  endpoint: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL(endpoint);
  url.search = new URLSearchParams(params).toString();

  const response = await musicBrainzRequestScheduler.schedule(() =>
    fetch(url.toString(), {
      headers: {
        Accept: "application/json",
      },
    }),
  );
  if (!response.ok) {
    throw new Error(`MusicBrainz request failed with HTTP ${response.status}.`);
  }

  return (await response.json()) as T;
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

function isLastFmPlaceholderImageUrl(imageUrl: string): boolean {
  const normalizedUrl = imageUrl.trim().toLowerCase();
  if (!normalizedUrl) {
    return false;
  }

  return LASTFM_PLACEHOLDER_IMAGE_MARKERS.some((marker) => normalizedUrl.includes(marker));
}

function buildKey(left: string, right: string): string {
  return `${normalizeForKey(left)}::${normalizeForKey(right)}`;
}

function buildAlbumKey(artist: string, album: string): string {
  return buildKey(artist, album);
}

function sortMissingDurationEntries(entries: MissingDurationEntry[]): MissingDurationEntry[] {
  return [...entries].sort((left, right) =>
    `${left.artist} ${left.album} ${left.name}`.localeCompare(
      `${right.artist} ${right.album} ${right.name}`,
    ),
  );
}

function sortMissingArtworkEntries(entries: MissingArtworkEntry[]): MissingArtworkEntry[] {
  return [...entries].sort((left, right) =>
    `${left.artist} ${left.album}`.localeCompare(`${right.artist} ${right.album}`),
  );
}

function buildMissingDurationEntriesFromTracks(tracks: MissingDurationEntry[]): MissingDurationEntry[] {
  return sortMissingDurationEntries(
    tracks.flatMap((track) => {
      const cacheEntry = durationCache[track.trackKey];
      if (readCachedDuration(cacheEntry) > 0) {
        return [];
      }

      return [
        {
          ...track,
          checkedAt: cacheEntry?.checkedAt ?? track.checkedAt,
        },
      ];
    }),
  );
}

function buildMissingArtworkEntriesFromAlbums(albums: MissingArtworkEntry[]): MissingArtworkEntry[] {
  return sortMissingArtworkEntries(
    albums.flatMap((album) =>
      readCachedArtwork(artworkCache[album.albumKey])
        ? []
        : [
            {
              ...album,
            },
          ],
    ),
  );
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

function escapeMusicBrainzQueryValue(value: string): string {
  return value.replace(/(["\\])/g, "\\$1").trim();
}

function pickMusicBrainzDuration(recordings: MusicBrainzRecording[], track: AlbumTrack): number {
  const normalizedTrack = normalizeForKey(track.name);
  const normalizedArtist = normalizeForKey(track.artist);
  const normalizedAlbum = normalizeForKey(track.album);
  const candidates = recordings
    .map((recording) => ({
      duration: typeof recording.length === "number" && recording.length > 0 ? recording.length : 0,
      normalizedTitle: normalizeForKey(recording.title ?? ""),
      normalizedArtists: readMusicBrainzArtists(recording),
      normalizedReleases: (recording.releases ?? [])
        .map((release) => normalizeForKey(release.title ?? ""))
        .filter(Boolean),
      score:
        typeof recording.score === "string"
          ? Number.parseInt(recording.score, 10) || 0
          : typeof recording.score === "number"
            ? recording.score
            : 0,
    }))
    .filter((recording) => recording.duration > 0)
    .sort((left, right) => right.score - left.score);

  const exactReleaseMatch = candidates.find(
    (candidate) =>
      candidate.normalizedTitle === normalizedTrack &&
      candidate.normalizedArtists.includes(normalizedArtist) &&
      candidate.normalizedReleases.includes(normalizedAlbum),
  );
  if (exactReleaseMatch) {
    return exactReleaseMatch.duration;
  }

  const exactArtistMatch = candidates.find(
    (candidate) =>
      candidate.normalizedTitle === normalizedTrack &&
      candidate.normalizedArtists.includes(normalizedArtist),
  );
  if (exactArtistMatch) {
    return exactArtistMatch.duration;
  }

  const exactTrackMatch = candidates.find(
    (candidate) => candidate.normalizedTitle === normalizedTrack,
  );
  return exactTrackMatch?.duration ?? 0;
}

function readMusicBrainzArtists(recording: MusicBrainzRecording): string[] {
  return (recording["artist-credit"] ?? [])
    .map((credit) => normalizeForKey(credit.artist?.name ?? credit.name ?? ""))
    .filter(Boolean);
}

function pickMusicBrainzArtwork(
  releases: MusicBrainzRelease[],
  album: Pick<MissingArtworkEntry, "artist" | "album">,
): string {
  const normalizedAlbum = normalizeForKey(album.album);
  const normalizedArtist = normalizeForKey(album.artist);
  const candidates = releases
    .map((release) => ({
      id: release.id ?? "",
      normalizedTitle: normalizeForKey(release.title ?? ""),
      normalizedArtists: readMusicBrainzReleaseArtists(release),
      hasFrontArtwork: Boolean(release["cover-art-archive"]?.front),
      score:
        typeof release.score === "string"
          ? Number.parseInt(release.score, 10) || 0
          : typeof release.score === "number"
            ? release.score
            : 0,
    }))
    .filter((release) => release.id && release.hasFrontArtwork)
    .sort((left, right) => right.score - left.score);

  const exactArtistAndAlbumMatch = candidates.find(
    (candidate) =>
      candidate.normalizedTitle === normalizedAlbum &&
      candidate.normalizedArtists.includes(normalizedArtist),
  );
  if (exactArtistAndAlbumMatch) {
    return buildCoverArtArchiveUrl(exactArtistAndAlbumMatch.id);
  }

  const exactAlbumMatch = candidates.find(
    (candidate) => candidate.normalizedTitle === normalizedAlbum,
  );
  return exactAlbumMatch ? buildCoverArtArchiveUrl(exactAlbumMatch.id) : "";
}

function readMusicBrainzReleaseArtists(release: MusicBrainzRelease): string[] {
  return (release["artist-credit"] ?? [])
    .map((credit) => normalizeForKey(credit.artist?.name ?? credit.name ?? ""))
    .filter(Boolean);
}

function buildCoverArtArchiveUrl(releaseId: string): string {
  return `https://coverartarchive.org/release/${encodeURIComponent(releaseId)}/front`;
}

function buildMusicBrainzSearchUrl(params: {
  query: string;
  type: "recording" | "release";
}): string {
  const url = new URL("https://musicbrainz.org/search");
  url.search = new URLSearchParams({
    query: params.query,
    type: params.type,
    method: "indexed",
  }).toString();
  return url.toString();
}

function buildRecentTracksQueryKey(username: string, timeRange: TimeRange): string {
  return `${normalizeForKey(username)}::${timeRange.label}`;
}

function loadRecentTracksCache(): Record<string, RecentTracksCacheEntry> {
  try {
    const raw = window.localStorage.getItem(RECENT_TRACKS_CACHE_KEY);
    if (!raw) {
      return {};
    }

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).flatMap(([queryKey, value]) => {
        const entry = normalizeRecentTracksCacheEntry(queryKey, value);
        return entry ? [[queryKey, entry]] : [];
      }),
    );
  } catch (error) {
    console.warn("Could not load recent tracks cache", error);
    return {};
  }
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

function loadArtworkCache(): Record<string, ArtworkCacheEntry> {
  try {
    const raw = window.localStorage.getItem(ARTWORK_CACHE_KEY);
    if (!raw) {
      return {};
    }

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

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
    if (!raw) {
      return {};
    }

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

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

function persistDurationCache(cache: Record<string, DurationCacheEntry>): void {
  window.localStorage.setItem(DURATION_CACHE_KEY, JSON.stringify(cache));
}

function persistArtworkCache(cache: Record<string, ArtworkCacheEntry>): void {
  window.localStorage.setItem(ARTWORK_CACHE_KEY, JSON.stringify(cache));
}

function persistAlbumOverrideCache(cache: Record<string, AlbumOverrideCacheEntry>): void {
  window.localStorage.setItem(ALBUM_OVERRIDE_CACHE_KEY, JSON.stringify(cache));
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

function syncArtworkCacheFromStorage(): void {
  const latestCache = loadArtworkCache();

  for (const key of Object.keys(artworkCache)) {
    if (!(key in latestCache)) {
      delete artworkCache[key];
    }
  }

  Object.assign(artworkCache, latestCache);
}

function syncAlbumOverrideCacheFromStorage(): void {
  const latestCache = loadAlbumOverrideCache();

  for (const key of Object.keys(albumOverrideCache)) {
    if (!(key in latestCache)) {
      delete albumOverrideCache[key];
    }
  }

  Object.assign(albumOverrideCache, latestCache);
}

function loadRecentTracksCacheEntry(queryKey: string): RecentTracksCacheEntry | null {
  return loadRecentTracksCache()[queryKey] ?? null;
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

function persistRecentTracksCacheEntry(entry: RecentTracksCacheEntry): void {
  const cache = loadRecentTracksCache();
  cache[entry.queryKey] = entry;
  window.localStorage.setItem(RECENT_TRACKS_CACHE_KEY, JSON.stringify(cache));
}

function clearRecentTracksCheckpoint(queryKey: string): void {
  const checkpoint = loadRecentTracksCheckpoint(queryKey);
  if (!checkpoint) {
    return;
  }

  window.localStorage.removeItem(RECENT_TRACKS_CHECKPOINT_KEY);
}

function isRecentTracksCacheFresh(entry: RecentTracksCacheEntry, timeRange: TimeRange): boolean {
  const maxAge = RECENT_TRACKS_CACHE_MAX_AGE_MS[timeRange.label];
  return Date.now() - entry.cachedAt <= maxAge;
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
  const duration =
    typeof entry.duration === "number"
      ? entry.duration
      : typeof entry.duration === "string"
        ? Number(entry.duration)
        : Number.NaN;
  const checkedAt =
    typeof entry.checkedAt === "number"
      ? entry.checkedAt
      : typeof entry.checkedAt === "string"
        ? Number(entry.checkedAt)
        : duration > 0
          ? Date.now()
          : 0;

  if (!Number.isFinite(duration) || !Number.isFinite(checkedAt)) {
    return null;
  }

  return {
    duration,
    checkedAt,
  };
}

function normalizeArtworkCacheEntry(value: unknown): ArtworkCacheEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const entry = value as Partial<ArtworkCacheEntry>;
  if (typeof entry.imageUrl !== "string" || typeof entry.checkedAt !== "number") {
    return null;
  }

  return {
    imageUrl: entry.imageUrl.trim(),
    checkedAt: Number.isFinite(entry.checkedAt) ? entry.checkedAt : 0,
  };
}

function normalizeAlbumOverrideCacheEntry(value: unknown): AlbumOverrideCacheEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const entry = value as Partial<AlbumOverrideCacheEntry>;
  if (
    typeof entry.album !== "string" ||
    typeof entry.artist !== "string" ||
    typeof entry.imageUrl !== "string" ||
    typeof entry.checkedAt !== "number"
  ) {
    return null;
  }

  return {
    album: entry.album.trim(),
    artist: entry.artist.trim(),
    imageUrl: entry.imageUrl.trim(),
    checkedAt: Number.isFinite(entry.checkedAt) ? entry.checkedAt : 0,
  };
}

function normalizeRecentTracksCacheEntry(
  queryKey: string,
  value: unknown,
): RecentTracksCacheEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const entry = value as Partial<RecentTracksCacheEntry>;
  if (
    entry.queryKey !== queryKey ||
    !Array.isArray(entry.items) ||
    typeof entry.pagesFetched !== "number" ||
    typeof entry.cachedAt !== "number"
  ) {
    return null;
  }

  return {
    queryKey: entry.queryKey,
    items: entry.items,
    pagesFetched: entry.pagesFetched,
    cachedAt: entry.cachedAt,
  };
}

function readCachedArtwork(entry?: ArtworkCacheEntry): string {
  return entry?.imageUrl.trim() ?? "";
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
