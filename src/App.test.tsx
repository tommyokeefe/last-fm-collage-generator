import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { renderExportBlob } from "./lib/collage";

vi.mock("./lib/collage", () => ({
  renderExportBlob: vi.fn(),
}));

describe("App", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(renderExportBlob).mockResolvedValue(new Blob(["preview"], { type: "image/png" }));
    vi.spyOn(window.URL, "createObjectURL").mockReturnValue("blob:preview");
    vi.spyOn(window.URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("shows missing key messaging when no env key exists", () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "");

    render(<App />);

    fireEvent.change(screen.getByLabelText("Last.fm username"), {
      target: { value: "tommy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    expect(
      screen.getByText(
        "Missing Last.fm API key. Set VITE_LASTFM_API_KEY before generating a collage.",
      ),
    ).toBeInTheDocument();
  });

  it("renders a preview from mocked recent tracks", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          recenttracks: {
            track: [
              {
                artist: { name: "Artist One" },
                album: { "#text": "Album A" },
                name: "Track 1",
                image: [{ "#text": "" }, { "#text": "https://example.com/a.jpg" }],
                date: { uts: "123" },
              },
            ],
            "@attr": { totalPages: "1" },
          },
        }),
        { status: 200 },
      ),
    );

    render(<App />);

    fireEvent.change(screen.getByLabelText("Last.fm username"), {
      target: { value: "tommy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    await waitFor(() => {
      expect(screen.getByText("Collage generated successfully.")).toBeInTheDocument();
    });

    expect(screen.getByText("Album A")).toBeInTheDocument();
    expect(screen.queryByText("#1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export PNG" })).toBeEnabled();
  });

  it("opens the album editor and saves metadata changes without refetching", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          recenttracks: {
            track: [
              {
                artist: { name: "Artist One" },
                album: { "#text": "Album A" },
                name: "Track 1",
                image: [{ "#text": "" }, { "#text": "https://example.com/a.jpg" }],
                date: { uts: "123" },
              },
              {
                artist: { name: "Artist Two" },
                album: { "#text": "Album B" },
                name: "Track 2",
                image: [{ "#text": "" }, { "#text": "https://example.com/b.jpg" }],
                date: { uts: "456" },
              },
            ],
            "@attr": { totalPages: "1" },
          },
        }),
        { status: 200 },
      ),
    );

    render(<App />);

    fireEvent.change(screen.getByLabelText("Last.fm username"), {
      target: { value: "tommy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    await waitFor(() => {
      expect(screen.getByText("Collage generated successfully.")).toBeInTheDocument();
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Edit Album A by Artist One" }),
    );

    expect(screen.getByRole("dialog", { name: "Edit album metadata" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Album title"), {
      target: { value: "Album A (Edited)" },
    });
    fireEvent.change(screen.getByLabelText("Image URL"), {
      target: { value: "https://example.com/edited.jpg" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(screen.getByText("Saved edits for Album A (Edited).")).toBeInTheDocument();
    });

    expect(screen.queryByRole("dialog", { name: "Edit album metadata" })).not.toBeInTheDocument();
    expect(screen.getByText("Album A (Edited)")).toBeInTheDocument();
    expect(screen.getByText("Album B")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Album A (Edited) by Artist One" })).toHaveAttribute(
      "src",
      "https://example.com/edited.jpg",
    );
    expect(screen.getByText("Showing the top 2 albums for tommy, ranked by album plays.")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("toggles to an exact PNG preview", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          recenttracks: {
            track: [
              {
                artist: { name: "Artist One" },
                album: { "#text": "Album A" },
                name: "Track 1",
                image: [{ "#text": "" }, { "#text": "https://example.com/a.jpg" }],
                date: { uts: "123" },
              },
            ],
            "@attr": { totalPages: "1" },
          },
        }),
        { status: 200 },
      ),
    );

    render(<App />);

    fireEvent.change(screen.getByLabelText("Last.fm username"), {
      target: { value: "tommy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    await waitFor(() => {
      expect(screen.getByText("Collage generated successfully.")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "True PNG preview" }));

    expect(screen.getByRole("img", { name: "Exact PNG preview for tommy" })).toHaveAttribute(
      "src",
      "blob:preview",
    );
    expect(vi.mocked(renderExportBlob)).toHaveBeenLastCalledWith(
      expect.any(Array),
      4,
      4,
      "plays",
      {
        showAlbumInfo: true,
        showMetric: true,
      },
    );
  });

  it("updates true PNG render options when export toggles change", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          recenttracks: {
            track: [
              {
                artist: { name: "Artist One" },
                album: { "#text": "Album A" },
                name: "Track 1",
                image: [{ "#text": "" }, { "#text": "https://example.com/a.jpg" }],
                date: { uts: "123" },
              },
            ],
            "@attr": { totalPages: "1" },
          },
        }),
        { status: 200 },
      ),
    );

    render(<App />);

    fireEvent.change(screen.getByLabelText("Last.fm username"), {
      target: { value: "tommy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    await waitFor(() => {
      expect(screen.getByText("Collage generated successfully.")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Show album and artist text"));
    fireEvent.click(screen.getByLabelText("Show play count or listening time"));

    await waitFor(() => {
      expect(vi.mocked(renderExportBlob)).toHaveBeenLastCalledWith(
        expect.any(Array),
        4,
        4,
        "plays",
        {
          showAlbumInfo: false,
          showMetric: false,
        },
      );
    });
  });

  it("shows fetch progress and an ETA while loading multiple pages", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    let resolveSecondPage: ((value: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => {
        now = 2000;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              recenttracks: {
                track: [
                  {
                    artist: { name: "Artist One" },
                    album: { "#text": "Album A" },
                    name: "Track 1",
                    image: [{ "#text": "" }, { "#text": "https://example.com/a.jpg" }],
                    date: { uts: "123" },
                  },
                ],
                "@attr": { totalPages: "2" },
              },
            }),
            { status: 200 },
          ),
        );
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecondPage = resolve;
          }),
      );

    render(<App />);

    fireEvent.change(screen.getByLabelText("Last.fm username"), {
      target: { value: "tommy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    await waitFor(() => {
      expect(screen.getByText("Pages 1 of 2")).toBeInTheDocument();
    });

    expect(screen.getByText("ETA about 2 sec")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("max", "2");
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "1");

    resolveSecondPage?.(
      new Response(
        JSON.stringify({
          recenttracks: {
            track: [
              {
                artist: { name: "Artist One" },
                album: { "#text": "Album A" },
                name: "Track 1",
                image: [{ "#text": "" }, { "#text": "https://example.com/a.jpg" }],
                date: { uts: "456" },
              },
            ],
            "@attr": { totalPages: "2" },
          },
        }),
        { status: 200 },
      ),
    );

    await waitFor(() => {
      expect(screen.getByText("Collage generated successfully.")).toBeInTheDocument();
    });
  });

  it("highlights albums with missing artwork and duration gaps in configuration view", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            recenttracks: {
              track: [
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
              ],
              "@attr": { totalPages: "1" },
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ track: { duration: "0" } }), { status: 200 }),
      );

    render(<App />);

    fireEvent.click(screen.getByLabelText("Approximate listening time per album"));
    fireEvent.change(screen.getByLabelText("Last.fm username"), {
      target: { value: "tommy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    await waitFor(() => {
      expect(screen.getByText("Collage generated successfully.")).toBeInTheDocument();
    });

    expect(screen.getByText("! Artwork missing")).toBeInTheDocument();
    expect(screen.getByText("! Duration gaps")).toBeInTheDocument();
  });

  it("shows a two-step progress flow for listening-time mode", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");

    let resolveSecondPage: ((value: Response) => void) | undefined;
    let resolveDuration: ((value: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            recenttracks: {
              track: [
                {
                  artist: { name: "Artist One" },
                  album: { "#text": "Album A" },
                  name: "Track 1",
                  image: [{ "#text": "" }, { "#text": "https://example.com/a.jpg" }],
                  date: { uts: "123" },
                },
              ],
              "@attr": { totalPages: "2" },
            },
          }),
          { status: 200 },
        ),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecondPage = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveDuration = resolve;
          }),
      );

    render(<App />);

    fireEvent.click(screen.getByLabelText("Approximate listening time per album"));
    fireEvent.change(screen.getByLabelText("Last.fm username"), {
      target: { value: "tommy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    await waitFor(() => {
      expect(
        screen.getByText(/Step 1 of 2: Fetching listening history from Last\.fm\.\.\. page/),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Pages 1 of 2")).toBeInTheDocument();

    resolveSecondPage?.(
      new Response(
        JSON.stringify({
          recenttracks: {
            track: [
              {
                artist: { name: "Artist One" },
                album: { "#text": "Album A" },
                name: "Track 1",
                image: [{ "#text": "" }, { "#text": "https://example.com/a.jpg" }],
                date: { uts: "456" },
              },
            ],
            "@attr": { totalPages: "2" },
          },
        }),
        { status: 200 },
      ),
    );

    await waitFor(() => {
      expect(screen.getByText("Step 2 of 2: Fetching track durations from Last.fm... 0 of 1")).toBeInTheDocument();
    });

    expect(screen.getByText("Tracks 0 of 1")).toBeInTheDocument();
    expect(screen.getByText("ETA calculating...")).toBeInTheDocument();

    resolveDuration?.(
      new Response(
        JSON.stringify({
          track: {
            duration: "180000",
          },
        }),
        { status: 200 },
      ),
    );

    await waitFor(() => {
      expect(screen.getByText("Collage generated successfully.")).toBeInTheDocument();
    });
  });

  it("supports selecting a 10 x 10 grid", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          recenttracks: {
            track: [
              {
                artist: { name: "Artist One" },
                album: { "#text": "Album A" },
                name: "Track 1",
                image: [{ "#text": "" }, { "#text": "https://example.com/a.jpg" }],
                date: { uts: "123" },
              },
            ],
            "@attr": { totalPages: "1" },
          },
        }),
        { status: 200 },
      ),
    );

    render(<App />);

    fireEvent.change(screen.getByLabelText("Grid size"), {
      target: { value: "10x10" },
    });
    fireEvent.change(screen.getByLabelText("Last.fm username"), {
      target: { value: "tommy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    await waitFor(() => {
      expect(screen.getByText("Collage generated successfully.")).toBeInTheDocument();
    });

    expect(screen.getByDisplayValue("10 x 10")).toBeInTheDocument();
    expect(vi.mocked(renderExportBlob)).toHaveBeenLastCalledWith(
      expect.any(Array),
      10,
      10,
      "plays",
      {
        showAlbumInfo: true,
        showMetric: true,
      },
    );
  });

  it("retries a failed fetch from the saved page checkpoint", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    vi.spyOn(console, "error").mockImplementation(() => {});
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
                  image: [{ "#text": "" }, { "#text": "https://example.com/a.jpg" }],
                  date: { uts: "123" },
                },
              ],
              "@attr": { totalPages: "2" },
            },
          }),
          { status: 200 },
        ),
      )
      .mockRejectedValueOnce(new Error("Network down"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            recenttracks: {
              track: [
                {
                  artist: { name: "Artist Two" },
                  album: { "#text": "Album B" },
                  name: "Track 2",
                  image: [{ "#text": "" }, { "#text": "https://example.com/b.jpg" }],
                  date: { uts: "456" },
                },
              ],
              "@attr": { totalPages: "2" },
            },
          }),
          { status: 200 },
        ),
      );

    render(<App />);

    fireEvent.change(screen.getByLabelText("Last.fm username"), {
      target: { value: "tommy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    await waitFor(() => {
      expect(
        screen.getByText("Network down Retry Generate to resume from page 2 of 2."),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    await waitFor(() => {
      expect(screen.getByText("Collage generated successfully.")).toBeInTheDocument();
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("page=2"),
    );
  });

  it("reuses cached generated results when only the grid size changes", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          recenttracks: {
            track: [
              {
                artist: { name: "Artist One" },
                album: { "#text": "Album A" },
                name: "Track 1",
                image: [{ "#text": "" }, { "#text": "https://example.com/a.jpg" }],
                date: { uts: "123" },
              },
            ],
            "@attr": { totalPages: "1" },
          },
        }),
        { status: 200 },
      ),
    );

    render(<App />);

    fireEvent.change(screen.getByLabelText("Last.fm username"), {
      target: { value: "tommy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    await waitFor(() => {
      expect(screen.getByText("Collage generated successfully.")).toBeInTheDocument();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("Grid size"), {
      target: { value: "6x6" },
    });

    await waitFor(() => {
      expect(vi.mocked(renderExportBlob)).toHaveBeenLastCalledWith(
        expect.any(Array),
        6,
        6,
        "plays",
        {
          showAlbumInfo: true,
          showMetric: true,
        },
      );
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Showing the top 1 albums for tommy, ranked by album plays.")).toBeInTheDocument();
  });

  it("shows missing durations and lets users save a local override", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            recenttracks: {
              track: [
                {
                  artist: { name: "Artist One" },
                  album: { "#text": "Album A" },
                  name: "Track 1",
                  image: [{ "#text": "" }, { "#text": "https://example.com/a.jpg" }],
                  date: { uts: "123" },
                },
              ],
              "@attr": { totalPages: "1" },
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ track: { duration: "0" } }), { status: 200 }),
      );

    render(<App />);

    fireEvent.click(screen.getByLabelText("Approximate listening time per album"));
    fireEvent.change(screen.getByLabelText("Last.fm username"), {
      target: { value: "tommy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Missing durations (1)" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Missing durations (1)" }));

    const musicBrainzLink = screen.getByRole("link", { name: "Update on MusicBrainz" });
    expect(musicBrainzLink).toHaveAttribute(
      "href",
      "https://musicbrainz.org/search?query=Track+1+Artist+One+Album+A&type=recording&method=indexed",
    );

    fireEvent.change(screen.getByLabelText("Local duration (sec)"), {
      target: { value: "180" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save local override" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Missing durations (1)" })).not.toBeInTheDocument();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("tries MusicBrainz for missing durations on demand", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            recenttracks: {
              track: [
                {
                  artist: { name: "Artist One" },
                  album: { "#text": "Album A" },
                  name: "Track 1",
                  image: [{ "#text": "" }, { "#text": "https://example.com/a.jpg" }],
                  date: { uts: "123" },
                },
              ],
              "@attr": { totalPages: "1" },
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ track: { duration: "0" } }), { status: 200 }),
      )
      .mockResolvedValueOnce(
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

    render(<App />);

    fireEvent.click(screen.getByLabelText("Approximate listening time per album"));
    fireEvent.change(screen.getByLabelText("Last.fm username"), {
      target: { value: "tommy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Missing durations (1)" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Missing durations (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Try fetching from MusicBrainz" }));

    await waitFor(() => {
      expect(screen.getByText("MusicBrainz resolved 1 missing duration.")).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: "Missing durations (1)" })).not.toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("shows MusicBrainz artwork links and lets users save a local image override", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          recenttracks: {
            track: [
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
            ],
            "@attr": { totalPages: "1" },
          },
        }),
        { status: 200 },
      ),
    );

    render(<App />);

    fireEvent.change(screen.getByLabelText("Last.fm username"), {
      target: { value: "tommy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Missing artwork (1)" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Missing artwork (1)" }));

    const lastFmLink = screen.getByRole("link", { name: "Update artwork on Last.fm" });
    expect(lastFmLink).toHaveAttribute(
      "href",
      "https://www.last.fm/music/Artist%20One/Album%20A",
    );

    fireEvent.change(screen.getByLabelText("Local image URL"), {
      target: { value: "https://example.com/override.jpg" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save local override" }));

    await waitFor(() => {
      expect(screen.getByText("Saved a local artwork override for Album A.")).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: "Missing artwork (1)" })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Album A by Artist One" })).toHaveAttribute(
      "src",
      "https://example.com/override.jpg",
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
