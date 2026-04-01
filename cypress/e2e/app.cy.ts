describe("Last.fm collage generator", () => {
  it("renders a collage using mocked Last.fm data", () => {
    cy.intercept("GET", "https://ws.audioscrobbler.com/2.0/?*", (request) => {
      const method = request.query.method;

      if (method === "user.gettopalbums") {
        request.reply({
          statusCode: 200,
          body: {
            topalbums: {
              album: [
                {
                  name: "Album A",
                  playcount: "50",
                  artist: { name: "Artist One" },
                  image: [{ "#text": "" }, { "#text": "https://example.com/a.jpg" }],
                },
                {
                  name: "Album B",
                  playcount: "30",
                  artist: { name: "Artist Two" },
                  image: [{ "#text": "" }, { "#text": "https://example.com/b.jpg" }],
                },
              ],
              "@attr": { totalPages: "1" },
            },
          },
        });
        return;
      }

      request.reply({ statusCode: 200, body: {} });
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
