import { STATUS_W, declutterLabels, type LabelBox } from "./labelDeclutter";

const box = (id: string, x: number, y: number, priority: number, name = id): LabelBox => ({ id, x, y, name, priority });

describe("declutterLabels", () => {
  it("hides the lower-priority label when two label boxes overlap (Lucknow over Kanpur)", () => {
    const shown = declutterLabels([box("kanpur", 711, 463, 2), box("lucknow", 733, 450, 1)]);
    expect([...shown]).toEqual(["lucknow"]);
  });
  it("keeps labels that do not overlap", () => {
    const shown = declutterLabels([box("a", 100, 100, 1), box("b", 100, 200, 2), box("c", 400, 100, 3)]);
    expect(shown).toEqual(new Set(["a", "b", "c"]));
  });
  it("ties keep input order", () => {
    expect([...declutterLabels([box("first", 0, 0, 1), box("second", 5, 5, 1)])]).toEqual(["first"]);
  });
  it("is independent of the status text (stable during playback)", () => {
    const a = declutterLabels([box("x", 0, 0, 1), box("y", 0, 40, 2)]);
    expect(a).toEqual(new Set(["x", "y"]));
  });
  it("sizes the status line for the longest text it can show (\"smoke present · N h old\")", () => {
    // ~185 px at 10 px type: a 120 px box let a neighbour 150 px to the right through, and the
    // two labels overlapped once smoke text appeared during playback
    expect(STATUS_W).toBeGreaterThanOrEqual(185);
    const shown = declutterLabels([box("amritsar", 0, 0, 1, "Amritsar"), box("jalandhar", 150, 0, 2, "Jalandhar")]);
    expect([...shown]).toEqual(["amritsar"]);
  });
  it("skips cities that do not project (off-screen / NaN)", () => {
    expect(declutterLabels([box("n", NaN, 0, 0)]).size).toBe(0);
  });
});
