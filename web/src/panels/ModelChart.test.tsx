import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModelChart, type ModelChartProps } from "./ModelChart";

const N = 30;
const HOURS = Array.from({ length: N }, (_, h) => new Date(Date.UTC(2026, 10, 10, h)).toISOString());
const W = 288, L = 24, R = 4;
const x = (h: number) => Math.round((L + (h / (N - 1)) * (W - L - R)) * 10) / 10;

function chart(over: Partial<ModelChartProps> = {}) {
  const props: ModelChartProps = {
    hours: HOURS, sim: Array.from({ length: N }, () => 50), measured: null, cams: null, camsNote: null,
    measuredNote: null, hour: 5, forecastFrom: null, firesAssumedFrom: null, onSeek: () => {}, ...over,
  };
  return render(<ModelChart {...props} />).container;
}

/** The x of each path's first point. */
const startX = (paths: NodeListOf<Element>) => [...paths].map((p) => Number(/^M([\d.]+),/.exec(p.getAttribute("d")!)![1]));

describe("ModelChart", () => {
  it("draws the model solid up to forecast_from and dashed from it (the two meet there)", () => {
    const c = chart({ forecastFrom: 24 });
    const solid = c.querySelectorAll("path.line-model:not(.forecast)");
    const dashed = c.querySelectorAll("path.line-model.forecast");
    expect(solid).toHaveLength(1);
    expect(dashed).toHaveLength(1);
    expect(startX(dashed)).toEqual([x(24)]);
    expect(solid[0].getAttribute("d")!.includes(`${x(24)},`)).toBe(true);
    expect(c.querySelector(".now-real")).not.toBeNull();
  });

  it("no dashed part and no now marker without a forecast", () => {
    const c = chart();
    expect(c.querySelectorAll("path.line-model.forecast")).toHaveLength(0);
    expect(c.querySelector(".now-real")).toBeNull();
  });

  it("shades from fires_assumed_from to the end, labelled", () => {
    const c = chart({ firesAssumedFrom: 20, forecastFrom: 24 });
    const band = c.querySelector(".fires-band rect")!;
    expect(Number(band.getAttribute("x"))).toBeCloseTo(L + (20 / (N - 1)) * (W - L - R), 6);
    expect(Number(band.getAttribute("x")) + Number(band.getAttribute("width"))).toBeCloseTo(W - R, 6);
    expect(c.querySelector(".fires-band text")!.textContent).toBe("fires assumed");
  });

  it("a missing hour breaks the line into separate runs (never drawn through as 0)", () => {
    const sim = Array.from({ length: N }, (_, h) => (h === 10 || h === 11 ? null : 50));
    const c = chart({ sim });
    const runs = c.querySelectorAll("path.line-model:not(.forecast)");
    expect(runs).toHaveLength(2);
    expect(startX(runs)).toEqual([x(0), x(12)]);
    const cams = Array.from({ length: N }, (_, h) => (h < 5 ? null : 40));
    expect(chart({ cams }).querySelectorAll("path.line-cams")).toHaveLength(1);
  });
});
