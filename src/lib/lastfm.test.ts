import {
  applyCachedAlbumMetadata,
  applyCachedAlbumOverrides,
  computeListeningTimes,
  createRequestScheduler,
  fetchTopAlbums,
  formatMetric,
  getMissingAlbumMetadataEntries,
  getMissingArtworkEntries,
  saveAlbumMetadata,
  saveAlbumOverride,
  sortAlbums,
} from "./lastfm";
import type { AlbumEntry, LastFmTopAlbumsResponse } from "../types";

function makeAlbum(overrides: Partial<AlbumEntry> = {}): AlbumEntry {
  return {
    artist: "Artist",
    artistNames: new Set(["Artist"]),
    album: "Album",
    imageUrl: "https://example.com/cover.jpg",
    playCount: 10,
    approximateListeningMs: 0,
    trackCount: null,
    albumDurationMs: null,
    sourceArtist: "Artist",
    sourceAlbum: "Album",
    sourceKey: "artist::album",
    ...overrides,
  };
}

describe("computeListeningTimes", () => {
  it("computes approximateListeningMs correctly", () => {
    const album = makeAlbum({ playCount: 10, trackCount: 10, albumDurationMs: 60000 });
    computeListeningTimes([album]);
    expect(album.approximateListeningMs).toBe(60000);
  });

  it("computes proportionally when playCount < trackCount", () => {
    const album = makeAlbum({ playCount: 5, trackCount: 10, albumDurationMs: 60000 });
    computeListeningTimes([album]);
    expect(album.approximateListeningMs).toBe(30000);
  });

  it("sets approximateListeningMs to 0 when trackCount is null", () => {
    const album = makeAlbum({ playCount: 10, trackCount: null, albumDurationMs: 60000 });
    computeListeningTimes([album]);
    expect(album.approximateListeningMs).toBe(0);
  });

  it("sets approximateListeningMs to 0 when albumDurationMs is null", () => {
    const album = makeAlbum({ playCount: 10, trackCount: 10, albumDurationMs: null });
    computeListeningTimes([album]);
    expect(album.approximateListeningMs).toBe(0);
  });

  it("sets approximateListeningMs to 0 when trackCount is 0", () => {
    const album = makeAlbum({ playCount: 10, trackCount: 0, albumDurationMs: 60000 });
    computeListeningTimes([album]);
    expect(album.approximateListeningMs).toBe(0);
  });
});

describe("getMissingAlbumMetadataEntries", () => {
  it("returns albums with missing trackCount", () => {
    const album = makeAlbum({ trackCount: null, albumDurationMs: 60000 });
    expect(getMissingAlbumMetadataEntries([album])).toHaveLength(1);
  });

  it("returns albums with missing albumDurationMs", () => {
    const album = makeAlbum({ trackCount: 10, albumDurationMs: null });
    expect(getMissingAlbumMetadataEntries([album])).toHaveLength(1);
  });

  it("does not return albums with complete metadata", () => {
    const album = makeAlbum({ trackCount: 10, albumDurationMs: 60000 });
    expect(getMissingAlbumMetadataEntries([album])).toHaveLength(0);
  });

  it("returns albums with zero trackCount", () => {
    const album = makeAlbum({ trackCount: 0, albumDurationMs: 60000 });
    expect(getMissingAlbumMetadataEntries([album])).toHaveLength(1);
  });
});

describe("saveAlbumMetadata / applyCachedAlbumMetadata", () => {
  it("round-trips metadata through localStorage", () => {
    const album = makeAlbum({ sourceKey: "test-artist::test-album" });
    saveAlbumMetadata(album, { trackCount: 12, albumDurationMs: 2700000 });

    const restored = makeAlbum({ sourceKey: "test-artist::test-album" });
    applyCachedAlbumMetadata([restored]);

    expect(restored.trackCount).toBe(12);
    expect(restored.albumDurationMs).toBe(2700000);
  });

  it("does not apply metadata from a different sourceKey", () => {
    const album = makeAlbum({ sourceKey: "other-artist::other-album" });
    saveAlbumMetadata(album, { trackCount: 5, albumDurationMs: 1000 });

    const unrelated = makeAlbum({ sourceKey: "not-the-same::key" });
    applyCachedAlbumMetadata([unrelated]);

    expect(unrelated.trackCount).toBeNull();
    expect(unrelated.albumDurationMs).toBeNull();
  });
});

describe("sortAlbums", () => {
  it("sorts by playCount descending in plays mode", () => {
    const albums = [
      makeAlbum({ album: "B", playCount: 5 }),
      makeAlbum({ album: "A", playCount: 10 }),
    ];
    const sorted = sortAlbums(albums, "plays");
    expect(sorted[0]!.album).toBe("A");
    expect(sorted[1]!.album).toBe("B");
  });

  it("sorts by approximateListeningMs descending in listening-time mode", () => {
    const albums = [
      makeAlbum({ album: "B", approximateListeningMs: 1000, playCount: 10 }),
      makeAlbum({ album: "A", approximateListeningMs: 2000, playCount: 5 }),
    ];
    const sorted = sortAlbums(albums, "listening-time");
    expect(sorted[0]!.album).toBe("A");
    expect(sorted[1]!.album).toBe("B");
  });

  it("falls back to alphabetical when listening time is equal", () => {
    const albums = [
      makeAlbum({ artist: "Z", album: "Z", approximateListeningMs: 1000, playCount: 5 }),
      makeAlbum({ artist: "A", album: "A", approximateListeningMs: 1000, playCount: 5 }),
    ];
    const sorted = sortAlbums(albums, "listening-time");
    expect(sorted[0]!.album).toBe("A");
  });
});

describe("formatMetric", () => {
  it("formats plays correctly", () => {
    const album = makeAlbum({ playCount: 1234 });
    expect(formatMetric(album, "plays")).toBe("1,234 plays");
  });

  it("formats listening time in minutes when under an hour", () => {
    const album = makeAlbum({ approximateListeningMs: 30 * 60 * 1000 });
    expect(formatMetric(album, "listening-time")).toBe("30 min approx listening time");
  });

  it("formats listening time in hours and minutes", () => {
    const album = makeAlbum({ approximateListeningMs: 90 * 60 * 1000 });
    expect(formatMetric(album, "listening-time")).toBe("1 hr 30 min approx listening time");
  });
});

describe("getMissingArtworkEntries", () => {
  it("returns albums with no imageUrl", () => {
    const album = makeAlbum({ imageUrl: "" });
    expect(getMissingArtworkEntries([album])).toHaveLength(1);
  });

  it("does not return albums with a valid imageUrl", () => {
    const album = makeAlbum({ imageUrl: "https://example.com/cover.jpg" });
    expect(getMissingArtworkEntries([album])).toHaveLength(0);
  });

  it("returns albums with placeholder imageUrl", () => {
    const album = makeAlbum({ imageUrl: "https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png" });
    expect(getMissingArtworkEntries([album])).toHaveLength(1);
  });
});

describe("applyCachedArtwork / saveAlbumOverride / applyCachedAlbumOverrides", () => {
  it("applies a cached album override", () => {
    const album = makeAlbum({ sourceKey: "override-test::override-album" });
    saveAlbumOverride(album, { album: "New Title", artist: "New Artist", imageUrl: "https://example.com/new.jpg" });

    const restored = makeAlbum({ sourceKey: "override-test::override-album" });
    applyCachedAlbumOverrides([restored]);

    expect(restored.album).toBe("New Title");
    expect(restored.artist).toBe("New Artist");
    expect(restored.imageUrl).toBe("https://example.com/new.jpg");
  });
});

describe("createRequestScheduler", () => {
  it("runs a task immediately when minIntervalMs is 0", async () => {
    const scheduler = createRequestScheduler(0);
    const result = await scheduler.schedule(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("enforces minimum interval between tasks", async () => {
    const timestamps: number[] = [];
    let currentTime = 0;
    const now = () => currentTime;
    const sleep = (ms: number) => {
      currentTime += ms;
      return Promise.resolve();
    };

    const scheduler = createRequestScheduler(100, { now, sleep });
    await scheduler.schedule(() => Promise.resolve(timestamps.push(currentTime)));
    await scheduler.schedule(() => Promise.resolve(timestamps.push(currentTime)));

    expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(100);
  });
});

describe("fetchTopAlbums", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches and returns albums from user.gettopalbums", async () => {
    const mockResponse: LastFmTopAlbumsResponse = {
      topalbums: {
        album: [
          {
            name: "Album A",
            playcount: "50",
            artist: { name: "Artist One", "#text": "Artist One" },
            image: [{ "#text": "https://example.com/a.jpg", size: "extralarge" }],
          },
          {
            name: "Album B",
            playcount: "30",
            artist: { name: "Artist Two", "#text": "Artist Two" },
            image: [{ "#text": "https://example.com/b.jpg", size: "extralarge" }],
          },
        ],
        "@attr": { totalPages: "1" },
      },
    };

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    );

    const albums = await fetchTopAlbums("tommy", "7d", "test-api-key");

    expect(albums).toHaveLength(2);
    expect(albums[0]!.album).toBe("Album A");
    expect(albums[0]!.playCount).toBe(50);
    expect(albums[1]!.album).toBe("Album B");
    expect(albums[1]!.playCount).toBe(30);
  });

  it("handles single album (non-array) response", async () => {
    const mockResponse: LastFmTopAlbumsResponse = {
      topalbums: {
        album: {
          name: "Solo Album",
          playcount: "20",
          artist: "Solo Artist",
          image: [{ "#text": "https://example.com/solo.jpg" }],
        },
        "@attr": { totalPages: "1" },
      },
    };

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    );

    const albums = await fetchTopAlbums("tommy", "7d", "test-api-key");
    expect(albums).toHaveLength(1);
    expect(albums[0]!.album).toBe("Solo Album");
  });
});
