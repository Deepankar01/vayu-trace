import { describe, expect, it } from "vitest";
import { makeMeta } from "../test-utils/meta";
import { initialHour } from "./initialHour";

describe("initialHour", () => {
  it("opens a past run on the evening of its date (13:00 UTC = 18:30 IST)", () => {
    // test meta: date 2026-11-10, hours from 2026-11-10T00:00Z
    expect(initialHour(makeMeta({ hours: 30 }))).toBe(13);
  });
  it("opens a forecast run at the last observed hour when that is earlier", () => {
    expect(initialHour(makeMeta({ hours: 30, forecast_from: 9 }))).toBe(8);
  });
  it("falls back to the last hour when the date's evening is outside the window", () => {
    expect(initialHour(makeMeta({ hours: 5 }))).toBe(4);
  });
});
