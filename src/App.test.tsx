import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "./App";
import { renderExportBlob } from "./lib/collage";

vi.mock("./lib/collage", () => ({
  renderExportBlob: vi.fn(),
}));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

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

  it("shows a centered progress overlay while generating a collage", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    const fetchDeferred = createDeferred<Response>();
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => fetchDeferred.promise);

    render(<App />);

    fireEvent.change(screen.getByLabelText("Last.fm username"), {
      target: { value: "tommy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    const progressDialog = screen.getByRole("dialog", { name: "Operation in progress" });
    expect(progressDialog).toBeInTheDocument();
    expect(within(progressDialog).getByText(/Fetching listening history from Last\.fm\.\.\./)).toBeInTheDocument();

    fetchDeferred.resolve(
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

    await waitFor(() => {
      expect(screen.getByText("Collage generated successfully.")).toBeInTheDocument();
    });
    expect(screen.queryByRole("dialog", { name: "Operation in progress" })).not.toBeInTheDocument();
  });

  it("refreshes album artwork and saves modal edits to the local cache", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    const refreshedArtworkRequest = createDeferred<Response>();
    const recentTracksResponse = new Response(
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
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(recentTracksResponse.clone())
      .mockReturnValueOnce(refreshedArtworkRequest.promise);

    const { unmount } = render(<App />);

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

    expect(screen.getByRole("dialog", { name: "Edit album information" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Update artwork on Last.fm" })).toHaveAttribute(
      "href",
      "https://www.last.fm/music/Artist%20One/Album%20A",
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh image" }));

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Operation in progress" })).toBeInTheDocument();
    });
    expect(screen.getByText("Refreshing artwork for Album A...")).toBeInTheDocument();

    refreshedArtworkRequest.resolve(
      new Response(
        JSON.stringify({
          album: {
            image: [{ "#text": "" }, { "#text": "https://example.com/refreshed.jpg" }],
          },
        }),
        { status: 200 },
      ),
    );

    await waitFor(() => {
      expect(screen.getByText("Refreshed artwork for Album A.")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Image URL")).toHaveValue("https://example.com/refreshed.jpg");

    fireEvent.change(screen.getByLabelText("Album title"), {
      target: { value: "Album A (Cached)" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(screen.getByText("Saved edits for Album A (Cached).")).toBeInTheDocument();
    });

    expect(screen.queryByRole("dialog", { name: "Edit album information" })).not.toBeInTheDocument();
    expect(screen.getByText("Album A (Cached)")).toBeInTheDocument();
    expect(screen.getByText("Album B")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Album A (Cached) by Artist One" })).toHaveAttribute(
      "src",
      "https://example.com/refreshed.jpg",
    );
    expect(screen.getByText("Showing the top 2 albums for tommy, ranked by album plays.")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    unmount();

    fetchSpy.mockReset();
    fetchSpy.mockResolvedValueOnce(recentTracksResponse.clone());

    render(<App />);

    fireEvent.change(screen.getByLabelText("Last.fm username"), {
      target: { value: "tommy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    await waitFor(() => {
      expect(screen.getByText("Album A (Cached)")).toBeInTheDocument();
    });
    expect(screen.getByRole("img", { name: "Album A (Cached) by Artist One" })).toHaveAttribute(
      "src",
      "https://example.com/refreshed.jpg",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("loads and saves track durations from the album information modal", async () => {
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
        new Response(JSON.stringify({ track: { duration: "180000" } }), { status: 200 }),
      );

    render(<App />);

    fireEvent.change(screen.getByLabelText("Last.fm username"), {
      target: { value: "tommy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    await waitFor(() => {
      expect(screen.getByText("Collage generated successfully.")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit Album A by Artist One" }));
    fireEvent.click(screen.getByRole("tab", { name: "Track information" }));

    await waitFor(() => {
      expect(screen.getByText("Fetched track data for Album A.")).toBeInTheDocument();
    });

    expect(screen.getByDisplayValue("03:00")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open album on MusicBrainz" })).toHaveAttribute(
      "href",
      "https://musicbrainz.org/search?query=Album+A+Artist+One&type=release&method=indexed",
    );

    fireEvent.change(screen.getByLabelText("Duration for Track 1"), {
      target: { value: "04:05" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(screen.getByText("Saved edits for Album A.")).toBeInTheDocument();
    });

    expect(
      JSON.parse(window.localStorage.getItem("lastfm-collage-duration-cache") ?? "{}"),
    ).toMatchObject({
      "artist one::track 1": {
        duration: 245000,
      },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not show missing duration data before listening-time mode has been generated", async () => {
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

    fireEvent.change(screen.getByLabelText("Last.fm username"), {
      target: { value: "tommy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    await waitFor(() => {
      expect(screen.getByText("Collage generated successfully.")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit Album A by Artist One" }));
    fireEvent.click(screen.getByRole("tab", { name: "Track information" }));

    await waitFor(() => {
      expect(screen.getByText("Fetched track data for Album A.")).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: /Missing data \(/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Duration gaps")).not.toBeInTheDocument();
  });

  it("shows the progress overlay above the album modal while track data is loading", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    const trackFetchDeferred = createDeferred<Response>();
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
              "@attr": { totalPages: "1" },
            },
          }),
          { status: 200 },
        ),
      )
      .mockImplementationOnce(() => trackFetchDeferred.promise);

    render(<App />);

    fireEvent.change(screen.getByLabelText("Last.fm username"), {
      target: { value: "tommy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    await waitFor(() => {
      expect(screen.getByText("Collage generated successfully.")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit Album A by Artist One" }));
    fireEvent.click(screen.getByRole("tab", { name: "Track information" }));

    expect(screen.getByRole("dialog", { name: "Edit album information" })).toBeInTheDocument();
    const progressDialog = screen.getByRole("dialog", { name: "Operation in progress" });
    expect(progressDialog).toBeInTheDocument();
    expect(within(progressDialog).getByText("Fetching track durations for Album A...")).toBeInTheDocument();

    trackFetchDeferred.resolve(
      new Response(JSON.stringify({ track: { duration: "180000" } }), { status: 200 }),
    );

    await waitFor(() => {
      expect(screen.getByText("Fetched track data for Album A.")).toBeInTheDocument();
    });
    expect(screen.queryByRole("dialog", { name: "Operation in progress" })).not.toBeInTheDocument();
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
      5,
      5,
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
        5,
        5,
        "plays",
        {
          showAlbumInfo: false,
          showMetric: false,
        },
      );
    });
  });

  it("asks the user to generate when switching to listening time without cached results", async () => {
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

    fireEvent.click(screen.getByLabelText("Approximate listening time per album"));

    expect(
      screen.getByText(
        "Generate the collage in approximate listening time mode to view those rankings.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export PNG" })).toBeDisabled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("reuses cached generated results when switching ranking modes for the same time range", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    const recentTracksResponse = new Response(
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
              artist: { name: "Artist One" },
              album: { "#text": "Album A" },
              name: "Track 1",
              image: [{ "#text": "" }, { "#text": "https://example.com/a.jpg" }],
              date: { uts: "124" },
            },
            {
              artist: { name: "Artist Two" },
              album: { "#text": "Album B" },
              name: "Track 2",
              image: [{ "#text": "" }, { "#text": "https://example.com/b.jpg" }],
              date: { uts: "125" },
            },
          ],
          "@attr": { totalPages: "1" },
        },
      }),
      { status: 200 },
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(recentTracksResponse.clone())
      .mockResolvedValueOnce(recentTracksResponse.clone())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ track: { duration: "100000" } }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ track: { duration: "300000" } }), { status: 200 }),
      );

    render(<App />);

    fireEvent.change(screen.getByLabelText("Last.fm username"), {
      target: { value: "tommy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    await waitFor(() => {
      expect(screen.getByText("Showing the top 2 albums for tommy, ranked by album plays.")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Approximate listening time per album"));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Generate the collage in approximate listening time mode to view those rankings.",
        ),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    await waitFor(() => {
      expect(
        screen.getByText("Showing the top 2 albums for tommy, ranked by approximate listening time."),
      ).toBeInTheDocument();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByLabelText("Most plays per album"));

    await waitFor(() => {
      expect(screen.getByText("Showing the cached album-plays collage.")).toBeInTheDocument();
    });
    expect(screen.getByText("Showing the top 2 albums for tommy, ranked by album plays.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "True PNG preview" }));

    await waitFor(() => {
      expect(vi.mocked(renderExportBlob)).toHaveBeenLastCalledWith(
        expect.any(Array),
        5,
        5,
        "plays",
        {
          showAlbumInfo: true,
          showMetric: true,
        },
      );
    });

    fireEvent.click(screen.getByLabelText("Approximate listening time per album"));

    await waitFor(() => {
      expect(screen.getByText("Showing the cached approximate listening-time collage.")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(vi.mocked(renderExportBlob)).toHaveBeenLastCalledWith(
        expect.any(Array),
        5,
        5,
        "listening-time",
        {
          showAlbumInfo: true,
          showMetric: true,
        },
      );
    });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
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

    const { container } = render(<App />);

    fireEvent.click(screen.getByLabelText("Approximate listening time per album"));
    fireEvent.change(screen.getByLabelText("Last.fm username"), {
      target: { value: "tommy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate collage" }));

    await waitFor(() => {
      expect(screen.getByText("Collage generated successfully.")).toBeInTheDocument();
    });

    expect(container.querySelector(".tile-warning-icon")).toBeInTheDocument();
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

  it("shows a unified missing data tab for albums with missing durations", async () => {
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
      expect(screen.getByRole("button", { name: "Missing data (1)" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Missing data (1)" }));
    expect(screen.getByText("Missing track durations")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit Album A by Artist One" }));
    expect(screen.getByRole("dialog", { name: "Edit album information" })).toBeInTheDocument();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("tries to fetch missing durations from MusicBrainz in the missing data view", async () => {
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
      expect(screen.getByRole("button", { name: "Missing data (1)" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Missing data (1)" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Try fetching missing durations from MusicBrainz" }),
    );

    await waitFor(() => {
      expect(screen.getByText("Recovered 1 track duration from MusicBrainz.")).toBeInTheDocument();
    });

    expect(
      JSON.parse(window.localStorage.getItem("lastfm-collage-duration-cache") ?? "{}"),
    ).toMatchObject({
      "artist one::track 1": {
        duration: 181000,
      },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("only asks MusicBrainz for tracks whose current duration is still zero", async () => {
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
                {
                  artist: { name: "Artist One" },
                  album: { "#text": "Album A" },
                  name: "Track 2",
                  image: [{ "#text": "" }, { "#text": "https://example.com/a.jpg" }],
                  date: { uts: "124" },
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
        new Response(JSON.stringify({ track: { duration: "240000" } }), { status: 200 }),
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
      expect(screen.getByRole("button", { name: "Missing data (1)" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Missing data (1)" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Try fetching missing durations from MusicBrainz" }),
    );

    await waitFor(() => {
      expect(screen.getByText("Recovered 1 track duration from MusicBrainz.")).toBeInTheDocument();
    });

    const lastFetchUrl = fetchSpy.mock.calls.at(-1)?.[0];

    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(typeof lastFetchUrl).toBe("string");
    expect(lastFetchUrl).toContain('recording%3A%22Track+1%22');
    expect(lastFetchUrl).not.toContain('recording%3A%22Track+2%22');
  });

  it("shows a unified missing data tab for albums with missing artwork", async () => {
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
      expect(screen.getByRole("button", { name: "Missing data (1)" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Missing data (1)" }));
    expect(screen.getByText("Missing artwork")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit Album A by Artist One" }));
    expect(screen.getByRole("dialog", { name: "Edit album information" })).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
