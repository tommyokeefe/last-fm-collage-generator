import { aggregateAlbums, buildTimeRange, formatMetric, sortAlbums } from "./lastfm";
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
});
