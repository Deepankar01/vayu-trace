/**
 * The map label and the city panel compute the city's model AQI by separate code paths
 * (`cityLabel` in map/layers/cities.ts, `cityView` here): for the same city, hour and weights
 * they must agree.
 */
import { describe, expect, it } from "vitest";
import { cityLabel } from "../map/layers/cities";
import { DEFAULT_SLIDERS, NO_SCENARIO, selectWeights } from "../state/weights";
import { makeMeta } from "../test-utils/meta";
import { cityView } from "./cityView";

describe("map label and city panel agree on the model AQI", () => {
  const meta = makeMeta({ hours: 48 });
  const scenarios = {
    defaults: { sliders: { ...DEFAULT_SLIDERS }, fireScaling: 1, firesContinue: true, regionScenario: { ...NO_SCENARIO } },
    reweighted: {
      sliders: { ...DEFAULT_SLIDERS, vehicles: 1.7, dust: 0.2 }, fireScaling: 2.5, firesContinue: false,
      regionScenario: { delhiOddEven: true, delhiConstructionBan: true },
    },
  };
  for (const [name, sc] of Object.entries(scenarios)) {
    it(`${name}: every city and hour`, () => {
      const weights = selectWeights({ meta, userSources: [], ...sc });
      for (const city of meta.cities) {
        for (const h of [0, 10, 15, 16, 30, 47]) {
          const label = cityLabel(city, h, weights);
          const view = cityView(city, weights, h, meta.hours.length, null, {});
          expect(label.aqi).toBe(view.simAqi);
        }
      }
    });
  }
});
