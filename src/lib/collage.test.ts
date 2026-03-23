import { calculateFollowingTextBaseline } from "./collage";

describe("collage layout helpers", () => {
  it("does not reserve an extra title line before the artist label", () => {
    expect(calculateFollowingTextBaseline(100, 1, 34, 26)).toBe(126);
    expect(calculateFollowingTextBaseline(100, 2, 34, 26)).toBe(160);
  });
});
