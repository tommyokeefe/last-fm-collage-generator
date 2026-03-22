describe("Last.fm collage generator", () => {
  it("renders a collage using mocked Last.fm data", () => {
    cy.intercept("GET", "https://ws.audioscrobbler.com/2.0/?*", (request) => {
      const method = request.query.method;

      if (method === "user.getrecenttracks") {
        request.reply({
          statusCode: 200,
          body: {
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
          },
        });
        return;
      }

      request.reply({
        statusCode: 200,
        body: {
          track: {
            duration: "240000",
          },
        },
      });
    }).as("lastfm");

    cy.visit("/");
    cy.get('input[placeholder="Enter a Last.fm username"]').type("tommy");
    cy.contains("Generate collage").click();

    cy.wait("@lastfm");
    cy.contains("Collage generated successfully.");
    cy.contains("Album A");
    cy.contains("Album B");
    cy.contains("Export PNG").should("not.be.disabled");
  });
});
