import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/breakdown-cases.json";
import { arrival, breakdown, breakdownIncomplete, type BreakdownRow } from "./breakdown";
import { COARSE_PREFIX, FIRE_STATES, REGIONS, SECTORS, TAGS, TAG_BY_ID } from "./tags";

type Json = number | string | null | boolean | Json[] | { [k: string]: Json };
const revive = (x: Json): Json =>
  x === "NaN" ? NaN : Array.isArray(x) ? x.map(revive) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, revive(v)])) : x;
// The port does the same double operations in the same order, so numbers must be identical.
const same = (a: number, b: number) => Object.is(a, b) || (a === b); // 0 and -0 count as equal

describe("tag catalogue", () => {
  it("matches vayu.domain.TAGS", () => {
    expect(TAGS.map((t) => ({ ...t }))).toEqual(fixture.catalogue);
    const fine = FIRE_STATES.length * 2 + SECTORS.length * REGIONS.length;
    expect(TAGS).toHaveLength(2 * fine);
  });

  it("lists every fine tag, then its coarse twin: same kind, sector, region, label and colour", () => {
    const fine = TAGS.filter((t) => t.size === "fine");
    const coarse = TAGS.filter((t) => t.size === "coarse");
    expect(TAGS.slice(0, fine.length)).toEqual(fine); // fine tag indices never change
    expect(coarse).toEqual(fine.map((t) => ({ ...t, id: `${COARSE_PREFIX}${t.id}`, size: "coarse" })));
    expect(fine.some((t) => t.id.startsWith(COARSE_PREFIX))).toBe(false);
    expect(TAG_BY_ID.get("coarse_dust_delhi_ncr")).toMatchObject({ sector: "dust", region: "delhi_ncr", size: "coarse" });
  });

  it("breakdown fixtures use fine tag ids only (coarse values are folded before the call)", () => {
    const ids = fixture.cases.flatMap((c) => Object.keys((c.input as { by_tag_now: object }).by_tag_now));
    expect(ids.some((id) => id.startsWith(COARSE_PREFIX))).toBe(false);
  });
});

describe("breakdown against the Python reference", () => {
  it("has the varied cases the contract needs", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(8);
    expect(fixture.generated).toMatch(/uv run python/);
  });

  for (const c of fixture.cases) {
    it(c.name, () => {
      const inp = revive(c.input as unknown as Json) as {
        by_tag_now: Record<string, number | null>; weights: Record<string, number>;
        city_region: string; measured?: number | null; labels?: Record<string, string>;
      };
      const exp = c.expected as { rows?: BreakdownRow[]; error?: string };
      const run = () => breakdown(inp.by_tag_now, inp.weights, inp.city_region, inp.measured, inp.labels);
      if (exp.error !== undefined) {
        expect(run).toThrow(exp.error);
        return;
      }
      const got = run();
      const want = revive(exp.rows as unknown as Json) as unknown as BreakdownRow[];
      expect(got.map((r) => r.key)).toEqual(want.map((r) => r.key)); // exact order
      got.forEach((r, i) => {
        const w = want[i];
        expect([r.key, r.label, r.kind, r.sector, r.minor, r.color]).toEqual([w.key, w.label, w.kind, w.sector, w.minor, w.color]);
        expect(same(r.value, w.value)).toBe(true);
        if (w.share === null) expect(r.share).toBeNull();
        else expect(same(r.share!, w.share)).toBe(true);
      });
    });
  }
});

describe("breakdown behaviour", () => {
  it("sums to the simulated total and adds an unexplained row only when measured is higher (sim 100, measured 160)", () => {
    const rows = breakdown({ vehicles_delhi_ncr: 60, residential_delhi_ncr: 40 }, {}, "delhi_ncr", 160);
    const un = rows.find((r) => r.kind === "unexplained")!;
    expect(un.value).toBe(60);
    expect(un.share).toBe(0.375);
    expect(un.label).toBe("Not explained by model");
    expect(rows.filter((r) => r.kind !== "unexplained").reduce((s, r) => s + r.value, 0)).toBe(100);
  });

  it("has no unexplained row when measured is missing or below the total", () => {
    for (const m of [null, undefined, NaN, 50]) {
      expect(breakdown({ vehicles_delhi_ncr: 100 }, {}, "delhi_ncr", m).some((r) => r.kind === "unexplained")).toBe(false);
    }
  });

  it("all-zero input gives no rows and a zero denominator gives null shares, never NaN", () => {
    expect(breakdown({ vehicles_delhi_ncr: 0 }, {}, "delhi_ncr", null)).toEqual([]);
    const rows = breakdown({ vehicles_delhi_ncr: 5, dust_delhi_ncr: 5 }, { dust_delhi_ncr: -1 }, "delhi_ncr", null);
    expect(rows.map((r) => r.share)).toEqual([null, null]);
    expect(rows.every((r) => r.minor === false)).toBe(true);
  });

  it("groups local vs transported and marks shares under 5% minor", () => {
    const rows = breakdown({ vehicles_delhi_ncr: 96, vehicles_punjab: 4 }, {}, "delhi_ncr", null);
    expect(rows.map((r) => [r.key, r.kind, r.minor])).toEqual([
      ["local:vehicles", "local", false],
      ["transported:vehicles:punjab", "transported", true],
    ]);
  });

  it("throws for a tag outside the catalogue", () => {
    expect(() => breakdown({ bogus: 1 }, {}, "delhi_ncr", null)).toThrow(/unknown source tag 'bogus'/);
  });
});

describe("arrival against the Python reference", () => {
  for (const c of fixture.arrival_cases) {
    it(c.name, () => {
      const inp = revive(c.input as unknown as Json) as { series: (number | null)[]; hour: number; age_h: number | null };
      const exp = c.expected as { error?: string };
      const run = () => arrival(inp.series, inp.hour, inp.age_h);
      if (exp.error) expect(run).toThrow(RangeError);
      else expect(run()).toEqual(c.expected);
    });
  }
});

describe("breakdownIncomplete", () => {
  it("is true when a tag with non-zero weight is missing", () => {
    expect(breakdownIncomplete({ vehicles_delhi_ncr: 5, fire_punjab: null }, {})).toBe(true);
    expect(breakdownIncomplete({ vehicles_delhi_ncr: NaN }, { vehicles_delhi_ncr: 2 })).toBe(true);
  });
  it("ignores missing tags whose weight is 0 and complete data", () => {
    expect(breakdownIncomplete({ vehicles_delhi_ncr: 5, fire_punjab: null }, { fire_punjab: 0 })).toBe(false);
    expect(breakdownIncomplete({ vehicles_delhi_ncr: 5 }, {})).toBe(false);
  });
});
