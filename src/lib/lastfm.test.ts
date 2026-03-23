import {
  aggregateAlbums,
  applyCachedAlbumOverrides,
  applyCachedArtwork,
  buildMusicBrainzAlbumUrl,
  buildLastFmAlbumUrl,
  buildTimeRange,
  buildMusicBrainzTrackUrl,
  createRequestScheduler,
  fetchMissingArtworkFromMusicBrainz,
  fetchMissingDurationsFromMusicBrainz,
  fetchRecentTracks,
  formatMetric,
  getAlbumTrackDurationEntries,
  getMissingArtworkEntries,
  getRecentTracksResumeState,
  hydrateApproximateListeningTimes,
  refreshAlbumTrackDurationsFromMusicBrainz,
  refreshAlbumArtwork,
  saveAlbumOverride,
  saveAlbumArtworkOverride,
  sortAlbums,
} from "./lastfm";
import type { AlbumEntry, LastFmRecentTrack } from "../types";

describe("lastfm helpers", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("returns overall range without timestamps", () => {
    expect(buildTimeRange("overall")).toEqual({ label: "overall" });
  });

  it("aggregates albums from extended artist payloads", () => {
    const tracks: LastFmRecentTrack[] = [
      {
        artist: { name: "Artist One" },
        album: { "#text": "Album A" },
        name: "Track 1",
        image: [{ "#text": "" }, { "#text": "https://example.com/a.jpg" }],
        date: { uts: "123" },
      },
      {
        artist: { name: "Artist One" },
        album: { "#text": "Album A" },
        name: "Track 1",
        image: [{ "#text": "https://example.com/a.jpg" }],
        date: { uts: "456" },
      },
    ];

    const albums = aggregateAlbums(tracks);

    expect(albums).toHaveLength(1);
    expect(albums[0]).toMatchObject({
      artist: "Artist One",
      album: "Album A",
      imageUrl: "https://example.com/a.jpg",
      playCount: 2,
    });
  });

  it("combines the same album across multiple artists", () => {
    const tracks: LastFmRecentTrack[] = [
      {
        artist: { name: "Artist One" },
        album: { "#text": "Collab Album" },
        name: "Track 1",
        image: [{ "#text": "https://example.com/collab.jpg" }],
        date: { uts: "123" },
      },
      {
        artist: { name: "Artist Two" },
        album: { "#text": "Collab Album" },
        name: "Track 2",
        image: [{ "#text": "https://example.com/collab.jpg" }],
        date: { uts: "456" },
      },
    ];

    const albums = aggregateAlbums(tracks);

    expect(albums).toHaveLength(1);
    expect(albums[0]).toMatchObject({
      artist: "Artist One, Artist Two",
      album: "Collab Album",
      playCount: 2,
    });
  });

  it("keeps same-title albums separate when their cover art differs", () => {
    const tracks: LastFmRecentTrack[] = [
      {
        artist: { name: "Artist One" },
        album: { "#text": "Shared Title" },
        name: "Track 1",
        image: [{ "#text": "https://example.com/one.jpg" }],
        date: { uts: "123" },
      },
      {
        artist: { name: "Artist Two" },
        album: { "#text": "Shared Title" },
        name: "Track 2",
        image: [{ "#text": "https://example.com/two.jpg" }],
        date: { uts: "456" },
      },
    ];

    const albums = aggregateAlbums(tracks);

    expect(albums).toHaveLength(2);
  });

  it("warns when a track duration is missing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ track: { duration: "0" } }), { status: 200 }),
    );

    const albums = aggregateAlbums([
      {
        artist: { name: "Artist One" },
        album: { "#text": "Album A" },
        name: "Track Missing Duration",
        image: [{ "#text": "https://example.com/a.jpg" }],
        date: { uts: "123" },
      },
    ]);

    const result = await hydrateApproximateListeningTimes(albums, "test-key");

    expect(result.missingDurations).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[lastfm-duration-gap] Missing duration metadata for "Track Missing Duration" on album "Album A" by Artist One.',
    );

    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("reuses successful cached durations without refetching", async () => {
    window.localStorage.setItem(
      "lastfm-collage-duration-cache",
      JSON.stringify({
        "artist one::track 1": {
          duration: 180000,
          checkedAt: 1000,
        },
      }),
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const albums = aggregateAlbums([
      {
        artist: { name: "Artist One" },
        album: { "#text": "Album A" },
        name: "Track 1",
        image: [{ "#text": "https://example.com/a.jpg" }],
        date: { uts: "123" },
      },
    ]);

    await hydrateApproximateListeningTimes(albums, "test-key");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(albums[0]?.approximateListeningMs).toBe(180000);
    fetchSpy.mockRestore();
  });

  it("reuses legacy cached durations without checkedAt metadata", async () => {
    window.localStorage.setItem(
      "lastfm-collage-duration-cache",
      JSON.stringify({
        "artist one::track 1": {
          duration: 180000,
        },
      }),
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const albums = aggregateAlbums([
      {
        artist: { name: "Artist One" },
        album: { "#text": "Album A" },
        name: "Track 1",
        image: [{ "#text": "https://example.com/a.jpg" }],
        date: { uts: "123" },
      },
    ]);

    await hydrateApproximateListeningTimes(albums, "test-key");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(albums[0]?.approximateListeningMs).toBe(180000);
    fetchSpy.mockRestore();
  });

  it("retries missing durations after one hour", async () => {
    vi.spyOn(Date, "now").mockReturnValue(4_000_000);
    window.localStorage.setItem(
      "lastfm-collage-duration-cache",
      JSON.stringify({
        "artist one::track 1": {
          duration: 0,
          checkedAt: 1000,
        },
      }),
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ track: { duration: "240000" } }), { status: 200 }),
    );
    const albums = aggregateAlbums([
      {
        artist: { name: "Artist One" },
        album: { "#text": "Album A" },
        name: "Track 1",
        image: [{ "#text": "https://example.com/a.jpg" }],
        date: { uts: "123" },
      },
    ]);

    await hydrateApproximateListeningTimes(albums, "test-key");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(albums[0]?.approximateListeningMs).toBe(240000);
    fetchSpy.mockRestore();
  });

  it("does not retry missing durations before one hour", async () => {
    vi.spyOn(Date, "now").mockReturnValue(3_500_000);
    window.localStorage.setItem(
      "lastfm-collage-duration-cache",
      JSON.stringify({
        "artist one::track 1": {
          duration: 0,
          checkedAt: 1000,
        },
      }),
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const albums = aggregateAlbums([
      {
        artist: { name: "Artist One" },
        album: { "#text": "Album A" },
        name: "Track 1",
        image: [{ "#text": "https://example.com/a.jpg" }],
        date: { uts: "123" },
      },
    ]);

    await hydrateApproximateListeningTimes(albums, "test-key");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(albums[0]?.approximateListeningMs).toBe(0);
    fetchSpy.mockRestore();
  });

  it("tries MusicBrainz for unresolved missing durations", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          recordings: [
            {
              title: "Track 1",
              length: 181000,
              score: "100",
              releases: [{ title: "Album A" }],
              "artist-credit": [{ name: "Artist One" }],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const tracks = [
      {
        artist: "Artist One",
        album: "Album A",
        name: "Track 1",
        plays: 1,
        trackKey: "artist one::track 1",
        checkedAt: 0,
      },
    ];

    const result = await fetchMissingDurationsFromMusicBrainz(tracks);

    expect(result.resolvedCount).toBe(1);
    expect(result.missingDurations).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("musicbrainz.org/ws/2/recording"),
      expect.objectContaining({
        headers: {
          Accept: "application/json",
        },
      }),
    );
    expect(
      JSON.parse(window.localStorage.getItem("lastfm-collage-duration-cache") ?? "{}"),
    ).toMatchObject({
      "artist one::track 1": {
        duration: 181000,
      },
    });

    fetchSpy.mockRestore();
  });

  it("lists album track durations from the cache", () => {
    window.localStorage.setItem(
      "lastfm-collage-duration-cache",
      JSON.stringify({
        "artist one::track 1": {
          duration: 181000,
          checkedAt: 1000,
        },
      }),
    );

    const albums = aggregateAlbums([
      {
        artist: { name: "Artist One" },
        album: { "#text": "Album A" },
        name: "Track 1",
        image: [{ "#text": "https://example.com/a.jpg" }],
        date: { uts: "123" },
      },
    ]);

    expect(getAlbumTrackDurationEntries(albums[0] as AlbumEntry)).toEqual([
      expect.objectContaining({
        name: "Track 1",
        durationMs: 181000,
        checkedAt: 1000,
      }),
    ]);
  });

  it("refreshes album track durations from MusicBrainz", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          recordings: [
            {
              title: "Track 1",
              length: 181000,
              score: "100",
              releases: [{ title: "Album A" }],
              "artist-credit": [{ name: "Artist One" }],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const albums = aggregateAlbums([
      {
        artist: { name: "Artist One" },
        album: { "#text": "Album A" },
        name: "Track 1",
        image: [{ "#text": "https://example.com/a.jpg" }],
        date: { uts: "123" },
      },
    ]);

    const result = await refreshAlbumTrackDurationsFromMusicBrainz(albums[0] as AlbumEntry);

    expect(result.resolvedCount).toBe(1);
    expect(getAlbumTrackDurationEntries(albums[0] as AlbumEntry)[0]?.durationMs).toBe(181000);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("musicbrainz.org/ws/2/recording"),
      expect.objectContaining({
        headers: {
          Accept: "application/json",
        },
      }),
    );
  });

  it("tries MusicBrainz for unresolved missing artwork", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          releases: [
            {
              id: "release-123",
              title: "Album A",
              score: "100",
              "cover-art-archive": { front: true },
              "artist-credit": [{ name: "Artist One" }],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const albums = aggregateAlbums([
      {
        artist: { name: "Artist One" },
        album: { "#text": "Album A" },
        name: "Track 1",
        image: [{ "#text": "" }],
        date: { uts: "123" },
      },
    ]);
    const missingArtwork = getMissingArtworkEntries(albums);

    const result = await fetchMissingArtworkFromMusicBrainz(missingArtwork);

    applyCachedArtwork(albums);

    expect(result.resolvedCount).toBe(1);
    expect(result.missingArtwork).toEqual([]);
    expect(albums[0]?.imageUrl).toBe("https://coverartarchive.org/release/release-123/front");
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("musicbrainz.org/ws/2/release"),
      expect.objectContaining({
        headers: {
          Accept: "application/json",
        },
      }),
    );
    expect(
      JSON.parse(window.localStorage.getItem("lastfm-collage-artwork-cache") ?? "{}"),
    ).toMatchObject({
      "artist one::album a": {
        imageUrl: "https://coverartarchive.org/release/release-123/front",
      },
    });

    fetchSpy.mockRestore();
  });

  it("treats Last.fm placeholder artwork as missing", () => {
    const albums = aggregateAlbums([
      {
        artist: { name: "Artist One" },
        album: { "#text": "Album A" },
        name: "Track 1",
        image: [
          {
            "#text":
              "https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png",
          },
        ],
        date: { uts: "123" },
      },
    ]);

    expect(getMissingArtworkEntries(albums)).toEqual([
      {
        artist: "Artist One",
        album: "Album A",
        albumKey: "artist one::album a",
        sourceArtist: "Artist One",
        sourceAlbum: "Album A",
        sourceKey: "artist one::album a",
      },
    ]);
  });

  it("builds MusicBrainz search URLs for tracks and albums", () => {
    expect(
      buildMusicBrainzTrackUrl({
        artist: "Artist One",
        album: "Album A",
        name: "Track 1",
        plays: 1,
      }),
    ).toBe(
      "https://musicbrainz.org/search?query=Track+1+Artist+One+Album+A&type=recording&method=indexed",
    );
    expect(
      buildLastFmAlbumUrl({
        artist: "Artist One",
        album: "Album A",
      }),
    ).toBe(
      "https://www.last.fm/music/Artist%20One/Album%20A",
    );
    expect(
      buildMusicBrainzAlbumUrl({
        artist: "Artist One",
        album: "Album A",
      }),
    ).toBe(
      "https://musicbrainz.org/search?query=Album+A+Artist+One&type=release&method=indexed",
    );
  });

  it("saves local artwork overrides into the artwork cache", () => {
    saveAlbumArtworkOverride(
      {
        artist: "Artist One",
        album: "Album A",
        albumKey: "artist one::album a",
      },
      "https://example.com/override.jpg",
    );
    const albums = aggregateAlbums([
      {
        artist: { name: "Artist One" },
        album: { "#text": "Album A" },
        name: "Track 1",
        image: [{ "#text": "" }],
        date: { uts: "123" },
      },
    ]);

    applyCachedArtwork(albums);

    expect(albums[0]?.imageUrl).toBe("https://example.com/override.jpg");
    expect(
      JSON.parse(window.localStorage.getItem("lastfm-collage-artwork-cache") ?? "{}"),
    ).toMatchObject({
      "artist one::album a": {
        imageUrl: "https://example.com/override.jpg",
      },
    });
  });

  it("persists album metadata overrides and reapplies them by source key", () => {
    const albums = aggregateAlbums([
      {
        artist: { name: "Artist One" },
        album: { "#text": "Album A" },
        name: "Track 1",
        image: [{ "#text": "https://example.com/a.jpg" }],
        date: { uts: "123" },
      },
    ]);

    saveAlbumOverride(albums[0] as AlbumEntry, {
      album: "Album A (Cached)",
      artist: "Artist One",
      imageUrl: "https://example.com/cached.jpg",
    });

    const regeneratedAlbums = aggregateAlbums([
      {
        artist: { name: "Artist One" },
        album: { "#text": "Album A" },
        name: "Track 1",
        image: [{ "#text": "https://example.com/a.jpg" }],
        date: { uts: "123" },
      },
    ]);

    applyCachedAlbumOverrides(regeneratedAlbums);

    expect(regeneratedAlbums[0]).toMatchObject({
      album: "Album A (Cached)",
      artist: "Artist One",
      imageUrl: "https://example.com/cached.jpg",
    });
  });

  it("refreshes artwork from Last.fm before falling back to MusicBrainz", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            album: {
              image: [{ "#text": "" }, { "#text": "https://example.com/from-lastfm.jpg" }],
            },
          }),
          { status: 200 },
        ),
      );

    const imageUrl = await refreshAlbumArtwork(
      {
        sourceArtist: "Artist One",
        sourceAlbum: "Album A",
      },
      "test-key",
    );

    expect(imageUrl).toBe("https://example.com/from-lastfm.jpg");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockReset();
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            album: {
              image: [
                {
                  "#text":
                    "https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png",
                },
              ],
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            releases: [
              {
                id: "release-123",
                title: "Album A",
                score: "100",
                "cover-art-archive": { front: true },
                "artist-credit": [{ name: "Artist One" }],
              },
            ],
          }),
          { status: 200 },
        ),
      );

    const fallbackImageUrl = await refreshAlbumArtwork(
      {
        sourceArtist: "Artist One",
        sourceAlbum: "Album A",
      },
      "test-key",
    );

    expect(fallbackImageUrl).toBe("https://coverartarchive.org/release/release-123/front");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("resumes recent track fetching from the last successful page", async () => {
    window.localStorage.clear();
    const timeRange = buildTimeRange("1m");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            recenttracks: {
              track: [
                {
                  artist: { name: "Artist One" },
                  album: { "#text": "Album A" },
                  name: "Track 1",
                  image: [{ "#text": "https://example.com/a.jpg" }],
                  date: { uts: "123" },
                },
              ],
              "@attr": { totalPages: "3" },
            },
          }),
          { status: 200 },
        ),
      )
      .mockRejectedValueOnce(new Error("Network down"));

    await expect(fetchRecentTracks("tommy", timeRange, "test-key")).rejects.toThrow("Network down");
    expect(getRecentTracksResumeState("tommy", timeRange)).toEqual({
      nextPage: 2,
      totalPages: 3,
    });

    fetchSpy.mockReset();
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            recenttracks: {
              track: [
                {
                  artist: { name: "Artist Two" },
                  album: { "#text": "Album B" },
                  name: "Track 2",
                  image: [{ "#text": "https://example.com/b.jpg" }],
                  date: { uts: "456" },
                },
              ],
              "@attr": { totalPages: "3" },
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            recenttracks: {
              track: [
                {
                  artist: { name: "Artist Three" },
                  album: { "#text": "Album C" },
                  name: "Track 3",
                  image: [{ "#text": "https://example.com/c.jpg" }],
                  date: { uts: "789" },
                },
              ],
              "@attr": { totalPages: "3" },
            },
          }),
          { status: 200 },
        ),
      );

    const resumed = await fetchRecentTracks("tommy", timeRange, "test-key");

    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("page=2"),
    );
    expect(resumed.items).toHaveLength(3);
    expect(getRecentTracksResumeState("tommy", timeRange)).toBeNull();

    fetchSpy.mockRestore();
  });

  it("reuses cached recent tracks without refetching while the cache is fresh", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const timeRange = buildTimeRange("7d");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          recenttracks: {
            track: [
              {
                artist: { name: "Artist One" },
                album: { "#text": "Album A" },
                name: "Track 1",
                image: [{ "#text": "https://example.com/a.jpg" }],
                date: { uts: "123" },
              },
            ],
            "@attr": { totalPages: "1" },
          },
        }),
        { status: 200 },
      ),
    );

    const first = await fetchRecentTracks("tommy", timeRange, "test-key");
    expect(first.items).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(1_000_000 + 5 * 60 * 1000);

    const second = await fetchRecentTracks("tommy", timeRange, "test-key");
    expect(second.items).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockRestore();
  });

  it("sorts by approximate listening time when requested", () => {
    const albums: AlbumEntry[] = [
      {
        artist: "Artist One",
        artistNames: new Set(["Artist One"]),
        album: "Album A",
        imageUrl: "",
        playCount: 4,
        approximateListeningMs: 2000,
        sourceArtist: "Artist One",
        sourceAlbum: "Album A",
        sourceKey: "artist one::album a",
        tracks: new Map(),
      },
      {
        artist: "Artist Two",
        artistNames: new Set(["Artist Two"]),
        album: "Album B",
        imageUrl: "",
        playCount: 2,
        approximateListeningMs: 4000,
        sourceArtist: "Artist Two",
        sourceAlbum: "Album B",
        sourceKey: "artist two::album b",
        tracks: new Map(),
      },
    ];

    const sorted = sortAlbums(albums, "listening-time");

    expect(sorted[0]?.album).toBe("Album B");
  });

  it("formats play metrics", () => {
    const album: AlbumEntry = {
      artist: "Artist",
      artistNames: new Set(["Artist"]),
      album: "Album",
      imageUrl: "",
      playCount: 12,
      approximateListeningMs: 0,
      sourceArtist: "Artist",
      sourceAlbum: "Album",
      sourceKey: "artist::album",
      tracks: new Map(),
    };

    expect(formatMetric(album, "plays")).toBe("12 plays");
  });

  it("spaces scheduled Last.fm requests", async () => {
    let currentTime = 0;
    const startTimes: number[] = [];
    const waits: number[] = [];
    const scheduler = createRequestScheduler(1000, {
      now: () => currentTime,
      sleep: (milliseconds) => {
        waits.push(milliseconds);
        currentTime += milliseconds;
        return Promise.resolve();
      },
    });

    await Promise.all([
      scheduler.schedule(() => {
        startTimes.push(currentTime);
        return Promise.resolve();
      }),
      scheduler.schedule(() => {
        startTimes.push(currentTime);
        return Promise.resolve();
      }),
      scheduler.schedule(() => {
        startTimes.push(currentTime);
        return Promise.resolve();
      }),
    ]);

    expect(startTimes).toEqual([0, 1000, 2000]);
    expect(waits).toEqual([1000, 1000]);
  });

  it("allows scheduled requests to overlap in flight", async () => {
    let currentTime = 0;
    const startTimes: number[] = [];
    const completions: string[] = [];
    const scheduler = createRequestScheduler(1000, {
      now: () => currentTime,
      sleep: (milliseconds) => {
        currentTime += milliseconds;
        return Promise.resolve();
      },
    });

    let resolveFirst: (() => void) | undefined;
    const first = scheduler.schedule(
      () =>
        new Promise<void>((resolve) => {
          startTimes.push(currentTime);
          resolveFirst = () => {
            completions.push("first");
            resolve();
          };
        }),
    );
    const second = scheduler.schedule(() => {
      startTimes.push(currentTime);
      completions.push("second");
      return Promise.resolve();
    });

    await second;

    expect(startTimes).toEqual([0, 1000]);
    expect(completions).toEqual(["second"]);

    resolveFirst?.();
    await Promise.all([first, second]);

    expect(completions).toEqual(["second", "first"]);
  });
});
