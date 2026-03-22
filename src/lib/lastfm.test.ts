import {
  aggregateAlbums,
  buildTimeRange,
  createRequestScheduler,
  fetchRecentTracks,
  formatMetric,
  getRecentTracksResumeState,
  hydrateApproximateListeningTimes,
  sortAlbums,
} from "./lastfm";
import type { AlbumEntry, LastFmRecentTrack } from "../types";

describe("lastfm helpers", () => {
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

    const durationGaps = await hydrateApproximateListeningTimes(albums, "test-key");

    expect(durationGaps).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[lastfm-duration-gap] Missing duration metadata for "Track Missing Duration" on album "Album A" by Artist One.',
    );

    fetchSpy.mockRestore();
    warnSpy.mockRestore();
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

  it("sorts by approximate listening time when requested", () => {
    const albums: AlbumEntry[] = [
      {
        artist: "Artist One",
        artistNames: new Set(["Artist One"]),
        album: "Album A",
        imageUrl: "",
        playCount: 4,
        approximateListeningMs: 2000,
        tracks: new Map(),
      },
      {
        artist: "Artist Two",
        artistNames: new Set(["Artist Two"]),
        album: "Album B",
        imageUrl: "",
        playCount: 2,
        approximateListeningMs: 4000,
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
      tracks: new Map(),
    };

    expect(formatMetric(album, "plays")).toBe("12 plays");
  });

  it("spaces scheduled Last.fm requests", async () => {
    let currentTime = 0;
    const startTimes: number[] = [];
    const waits: number[] = [];
    const scheduler = createRequestScheduler(200, {
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

    expect(startTimes).toEqual([0, 200, 400]);
    expect(waits).toEqual([200, 200]);
  });
});
