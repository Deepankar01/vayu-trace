import { describe, expect, it } from "vitest";
import {
  MINUS, compass16, fmtError, fmtIST, fmtISTDay, fmtISTHour, fmtNumber, fmtShare, fmtSharesToWhole,
} from "./format";

describe("fmtShare", () => {
  it("is a dash for null", () => expect(fmtShare(null)).toBe("–"));
  it("rounds to whole percent", () => {
    expect(fmtShare(0.375)).toBe("38%");
    expect(fmtShare(0.3749)).toBe("37%");
    expect(fmtShare(1)).toBe("100%");
    expect(fmtShare(0)).toBe("0%");
  });
  it("shows <1% for a positive share under half a percent", () => {
    expect(fmtShare(0.004)).toBe("<1%");
    expect(fmtShare(0.005)).toBe("1%");
  });
  it("is a dash for NaN", () => expect(fmtShare(NaN)).toBe("–"));
});

describe("fmtError", () => {
  it("signs the model relative to measured with a true minus", () => {
    expect(fmtError(112, 100)).toBe("+12%");
    expect(fmtError(97, 100)).toBe(`${MINUS}3%`);
    expect(fmtError(97, 100)).toBe("−3%");
    expect(fmtError(100, 100)).toBe("0%");
    expect(fmtError(62.5, 100)).toBe(`${MINUS}38%`);
    expect(fmtError(137.5, 100)).toBe("+38%");
  });
  it("is empty when either side is missing or measured is not positive", () => {
    expect(fmtError(null, 100)).toBe("");
    expect(fmtError(100, null)).toBe("");
    expect(fmtError(100, 0)).toBe("");
    expect(fmtError(NaN, 100)).toBe("");
  });
});

describe("IST formatting", () => {
  const t = "2025-11-07T12:30:00+00:00"; // 18:00 IST
  it("fmtIST gives date, time and zone", () => expect(fmtIST(t)).toBe("07 Nov 2025 · 18:00 IST"));
  it("accepts a Date", () => expect(fmtIST(new Date(Date.UTC(2025, 10, 7, 12, 30)))).toBe("07 Nov 2025 · 18:00 IST"));
  it("crosses midnight into the next IST day", () => {
    expect(fmtIST("2025-11-07T19:00:00Z")).toBe("08 Nov 2025 · 00:30 IST");
  });
  it("short forms", () => {
    expect(fmtISTHour(t)).toBe("18:00 IST");
    expect(fmtISTDay(t)).toBe("07 Nov");
  });
});

describe("compass16", () => {
  it("names 16 points (direction the wind comes from)", () => {
    expect(compass16(0)).toBe("N");
    expect(compass16(11.24)).toBe("N");
    expect(compass16(11.26)).toBe("NNE");
    expect(compass16(45)).toBe("NE");
    expect(compass16(292.5)).toBe("WNW");
    expect(compass16(315)).toBe("NW");
    expect(compass16(359)).toBe("N");
    expect(compass16(360)).toBe("N");
    expect(compass16(-45)).toBe("NW");
  });
  it("is Calm for null", () => expect(compass16(null)).toBe("Calm"));
});

describe("fmtNumber", () => {
  it("groups thousands with a thin space", () => {
    expect(fmtNumber(1842)).toBe("1 842");
    expect(fmtNumber(1234567)).toBe("1 234 567");
    expect(fmtNumber(999)).toBe("999");
  });
  it("rounds to the given digits", () => {
    expect(fmtNumber(12.345, 1)).toBe("12.3");
    expect(fmtNumber(-1500)).toBe(`${MINUS}1 500`);
  });
  it("is a dash for missing", () => {
    expect(fmtNumber(null)).toBe("–");
    expect(fmtNumber(NaN)).toBe("–");
  });
});

describe("fmtSharesToWhole", () => {
  const sum = (xs: string[]) => xs.reduce((a, x) => a + (x === "<1%" ? 0 : parseInt(x, 10)), 0);
  it("sums to 100 where independent rounding gave 99", () => {
    const third = 1 / 3;
    expect([third, third, third].map(fmtShare)).toEqual(["33%", "33%", "33%"]);
    const out = fmtSharesToWhole([third, third, third]);
    expect(sum(out)).toBe(100);
    expect(out).toEqual(["33%", "33%", "34%"]);
  });
  it("sums to 100 where independent rounding gave 101", () => {
    const xs = [0.335, 0.335, 0.33];
    expect(xs.map(fmtShare)).toEqual(["34%", "34%", "33%"]);
    const out = fmtSharesToWhole(xs);
    expect(sum(out)).toBe(100);
    expect(out).toEqual(["33%", "34%", "33%"]);
  });
  it("keeps a trailing 37.5% at 38% (ties go to the later entry)", () => {
    expect(fmtSharesToWhole([0.375, 0.25, 0.375])).toEqual(["37%", "25%", "38%"]);
  });
  it("shows <1% for tiny positive shares and counts them as 0", () => {
    const out = fmtSharesToWhole([0.996, 0.004]);
    expect(out).toEqual(["100%", "<1%"]);
  });
  it("a positive share left at 0 by the allocation shows <1%, never 0%", () => {
    // 49.75 + 49.75 + 0.5: the two remainder points go to the 0.75s, the 0.5 % entry stays at 0
    expect(fmtSharesToWhole([0.4975, 0.4975, 0.005])).toEqual(["50%", "50%", "<1%"]);
  });
  it("falls back to per-entry formatting with nulls or nothing positive", () => {
    expect(fmtSharesToWhole([null, 0.5])).toEqual(["–", "50%"]);
    expect(fmtSharesToWhole([0, 0])).toEqual(["0%", "0%"]);
  });
});
