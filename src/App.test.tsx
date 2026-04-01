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

function makeTopAlbumsResponse(albums: Array<{ name: string; playcount: string; artist: string; imageUrl: string }>, totalPages = "1") {
  return {
    topalbums: {
      album: albums.map((a) => ({
        name: a.name,
        playcount: a.playcount,
        artist: { name: a.artist },
        image: [{ "#text": "" }, { "#text": a.imageUrl }],
      })),
      "@attr": { totalPages },
    },
  };
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

  it("renders a preview from mocked top albums", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify(makeTopAlbumsResponse([
          { name: "Album A", playcount: "10", artist: "Artist One", imageUrl: "https://example.com/a.jpg" },
        ])),
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
    expect(within(progressDialog).getByText(/Fetching top albums from Last\.fm\.\.\./)).toBeInTheDocument();

    fetchDeferred.resolve(
      new Response(
        JSON.stringify(makeTopAlbumsResponse([
          { name: "Album A", playcount: "10", artist: "Artist One", imageUrl: "https://example.com/a.jpg" },
        ])),
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
    const topAlbumsResponse = new Response(
      JSON.stringify(makeTopAlbumsResponse([
        { name: "Album A", playcount: "10", artist: "Artist One", imageUrl: "https://example.com/a.jpg" },
        { name: "Album B", playcount: "5", artist: "Artist Two", imageUrl: "https://example.com/b.jpg" },
      ])),
      { status: 200 },
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(topAlbumsResponse.clone())
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
    fetchSpy.mockResolvedValueOnce(topAlbumsResponse.clone());

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
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("removes an album from the collage and restores it from the configuration view", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify(makeTopAlbumsResponse([
          { name: "Album A", playcount: "10", artist: "Artist One", imageUrl: "https://example.com/a.jpg" },
          { name: "Album B", playcount: "5", artist: "Artist Two", imageUrl: "https://example.com/b.jpg" },
        ])),
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

    fireEvent.click(screen.getByRole("button", { name: "Edit Album A by Artist One" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove album from collage" }));

    await waitFor(() => {
      expect(screen.getByText("Removed Album A from the collage.")).toBeInTheDocument();
    });

    expect(
      screen.queryByRole("dialog", { name: "Edit album information" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit Album A by Artist One" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Album B by Artist Two" })).toBeInTheDocument();
    expect(screen.getByText("Showing the top 1 albums for tommy, ranked by album plays.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore removed albums (1)" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Restore removed albums (1)" }));

    await waitFor(() => {
      expect(screen.getByText("Restored removed albums to the collage.")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "Edit Album A by Artist One" })).toBeInTheDocument();
    expect(screen.getByText("Showing the top 2 albums for tommy, ranked by album plays.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Restore removed albums (1)" }),
    ).not.toBeInTheDocument();
  });

  it("saves album metadata from the listening time tab", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify(makeTopAlbumsResponse([
          { name: "Album A", playcount: "10", artist: "Artist One", imageUrl: "https://example.com/a.jpg" },
        ])),
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
      expect(screen.getByText("Collage generated successfully.")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit Album A by Artist One" }));
    fireEvent.click(screen.getByRole("tab", { name: "Listening time" }));

    expect(screen.getByPlaceholderText("e.g. 12")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("mm:ss (e.g. 45:00)")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("e.g. 12"), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByPlaceholderText("mm:ss (e.g. 45:00)"), {
      target: { value: "40:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(screen.getByText("Saved edits for Album A.")).toBeInTheDocument();
    });

    expect(
      JSON.parse(window.localStorage.getItem("lastfm-collage-album-metadata-cache") ?? "{}"),
    ).toMatchObject({
      "artist one::album a": {
        trackCount: 10,
        albumDurationMs: 2400000,
      },
    });
  });

  it("does not show missing metadata before listening-time mode has been generated", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify(makeTopAlbumsResponse([
          { name: "Album A", playcount: "10", artist: "Artist One", imageUrl: "https://example.com/a.jpg" },
        ])),
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

    expect(screen.queryByRole("button", { name: /Missing data \(/ })).not.toBeInTheDocument();
  });

  it("toggles to an exact PNG preview", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify(makeTopAlbumsResponse([
          { name: "Album A", playcount: "10", artist: "Artist One", imageUrl: "https://example.com/a.jpg" },
        ])),
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

    await waitFor(() => {
      expect(screen.getByRole("img", { name: "Exact PNG preview for tommy" })).toHaveAttribute(
        "src",
        "blob:preview",
      );
    });
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

  it("recalculates the exact preview when switching views and when closing the album modal", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify(makeTopAlbumsResponse([
          { name: "Album A", playcount: "10", artist: "Artist One", imageUrl: "https://example.com/a.jpg" },
        ])),
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
      expect(vi.mocked(renderExportBlob)).toHaveBeenCalled();
    });

    vi.mocked(renderExportBlob).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "True PNG preview" }));

    await waitFor(() => {
      expect(vi.mocked(renderExportBlob).mock.calls.length).toBeGreaterThan(0);
    });
    const callCountAfterExportView = vi.mocked(renderExportBlob).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Configuration view" }));

    await waitFor(() => {
      expect(vi.mocked(renderExportBlob).mock.calls.length).toBeGreaterThan(callCountAfterExportView);
    });
    const callCountAfterConfigView = vi.mocked(renderExportBlob).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Edit Album A by Artist One" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Edit album information" })).not.toBeInTheDocument();
      expect(vi.mocked(renderExportBlob).mock.calls.length).toBeGreaterThan(callCountAfterConfigView);
    });
  });

  it("updates true PNG render options when export toggles change", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify(makeTopAlbumsResponse([
          { name: "Album A", playcount: "10", artist: "Artist One", imageUrl: "https://example.com/a.jpg" },
        ])),
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
        JSON.stringify(makeTopAlbumsResponse([
          { name: "Album A", playcount: "10", artist: "Artist One", imageUrl: "https://example.com/a.jpg" },
        ])),
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
    const playsResponse = new Response(
      JSON.stringify(makeTopAlbumsResponse([
        { name: "Album A", playcount: "20", artist: "Artist One", imageUrl: "https://example.com/a.jpg" },
        { name: "Album B", playcount: "10", artist: "Artist Two", imageUrl: "https://example.com/b.jpg" },
      ])),
      { status: 200 },
    );
    const listeningTimeResponse = new Response(
      JSON.stringify(makeTopAlbumsResponse([
        { name: "Album A", playcount: "20", artist: "Artist One", imageUrl: "https://example.com/a.jpg" },
        { name: "Album B", playcount: "10", artist: "Artist Two", imageUrl: "https://example.com/b.jpg" },
      ])),
      { status: 200 },
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(playsResponse.clone())
      .mockResolvedValueOnce(listeningTimeResponse.clone());

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

    expect(fetchSpy).toHaveBeenCalledTimes(2);

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

    expect(fetchSpy).toHaveBeenCalledTimes(2);
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
            JSON.stringify(makeTopAlbumsResponse([
              { name: "Album A", playcount: "10", artist: "Artist One", imageUrl: "https://example.com/a.jpg" },
            ], "2")),
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
        JSON.stringify(makeTopAlbumsResponse([
          { name: "Album B", playcount: "5", artist: "Artist Two", imageUrl: "https://example.com/b.jpg" },
        ], "2")),
        { status: 200 },
      ),
    );

    await waitFor(() => {
      expect(screen.getByText("Collage generated successfully.")).toBeInTheDocument();
    });
  });

  it("highlights albums with missing artwork and missing metadata in configuration view", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify(makeTopAlbumsResponse([
          {
            name: "Album A",
            playcount: "10",
            artist: "Artist One",
            imageUrl: "https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png",
          },
        ])),
        { status: 200 },
      ),
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

  it("supports selecting a 10 x 10 grid", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify(makeTopAlbumsResponse([
          { name: "Album A", playcount: "10", artist: "Artist One", imageUrl: "https://example.com/a.jpg" },
        ])),
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

  it("reuses cached generated results when only the grid size changes", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify(makeTopAlbumsResponse([
          { name: "Album A", playcount: "10", artist: "Artist One", imageUrl: "https://example.com/a.jpg" },
        ])),
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

  it("shows progress while regenerating the true PNG preview after a grid size change", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    const nextPreview = createDeferred<Blob>();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify(makeTopAlbumsResponse([
          { name: "Album A", playcount: "10", artist: "Artist One", imageUrl: "https://example.com/a.jpg" },
        ])),
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

    await waitFor(() => {
      expect(screen.getByRole("img", { name: "Exact PNG preview for tommy" })).toBeInTheDocument();
    });

    vi.mocked(renderExportBlob).mockImplementation(() => nextPreview.promise);

    fireEvent.change(screen.getByLabelText("Grid size"), {
      target: { value: "6x6" },
    });

    await waitFor(() => {
      expect(screen.getByText("Regenerating the exact PNG preview...")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("img", { name: "Exact PNG preview for tommy" }),
    ).not.toBeInTheDocument();

    nextPreview.resolve(new Blob(["updated-preview"], { type: "image/png" }));

    await waitFor(() => {
      expect(screen.getByRole("img", { name: "Exact PNG preview for tommy" })).toBeInTheDocument();
    });
    expect(screen.queryByText("Regenerating the exact PNG preview...")).not.toBeInTheDocument();
  });

  it("shows a unified missing data tab for albums with missing metadata in listening-time mode", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify(makeTopAlbumsResponse([
          { name: "Album A", playcount: "10", artist: "Artist One", imageUrl: "https://example.com/a.jpg" },
        ])),
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
    expect(screen.getByText("Missing listening time data")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit Album A by Artist One" }));
    expect(screen.getByRole("dialog", { name: "Edit album information" })).toBeInTheDocument();
  });

  it("shows a unified missing data tab for albums with missing artwork", async () => {
    vi.stubEnv("VITE_LASTFM_API_KEY", "test-key");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify(makeTopAlbumsResponse([
          {
            name: "Album A",
            playcount: "10",
            artist: "Artist One",
            imageUrl: "https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png",
          },
        ])),
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
