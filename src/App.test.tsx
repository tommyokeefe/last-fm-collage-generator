import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";

describe("App", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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
    expect(screen.getByRole("button", { name: "Export PNG" })).toBeEnabled();
  });
});
