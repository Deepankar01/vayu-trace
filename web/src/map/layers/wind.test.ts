import type { WindField } from "../../api/types";
import { WIND_RETRY_MS, WindCache } from "./wind";

const field: WindField = { step: 1, lon0: 66, lat0: 6, nx: 2, ny: 2, u: [1, 1, 1, 1], v: [0, 0, 0, 0] };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("WindCache", () => {
  it("retries a failed hour after WIND_RETRY_MS, not before", async () => {
    let t = 0;
    let fail = true;
    const calls: number[] = [];
    const errors: string[] = [];
    const cache = new WindCache(
      (h) => {
        calls.push(h);
        return fail ? Promise.reject(new Error("down")) : Promise.resolve(field);
      },
      () => {}, (m) => errors.push(m), () => t,
    );
    expect(cache.get("b1", 5, 6)).toBeNull(); // hour 5 is the last: no prefetch
    await flush();
    expect(errors).toHaveLength(1);
    t = WIND_RETRY_MS - 1;
    cache.get("b1", 5, 6);
    await flush();
    expect(calls).toEqual([5]);
    fail = false;
    t = WIND_RETRY_MS;
    cache.get("b1", 5, 6);
    await flush();
    expect(calls).toEqual([5, 5]);
    expect(cache.get("b1", 5, 6)).not.toBeNull();
  });

  it("drops grids and failures when the build changes", async () => {
    const calls: string[] = [];
    let build = "b1";
    const cache = new WindCache((h) => {
      calls.push(`${build}:${h}`);
      return Promise.resolve(field);
    }, () => {}, () => {});
    cache.get("b1", 0, 1);
    await flush();
    expect(cache.get("b1", 0, 1)).not.toBeNull();
    build = "b2";
    expect(cache.get("b2", 0, 1)).toBeNull();
    await flush();
    expect(calls).toEqual(["b1:0", "b2:0"]);
  });
});
