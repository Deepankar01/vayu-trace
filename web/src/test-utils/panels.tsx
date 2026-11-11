/** Render a panel against its own store (no network: every fetch rejects). */
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";
import { StoreProvider } from "../panels/storeContext";
import { IDLE_CITY_DATA, createAppStore, type AppState, type CityDataState } from "../state/store";
import { makeMeta } from "./meta";

export function testStore(state: Partial<AppState> = {}) {
  const fetchMock = vi.fn(() => Promise.reject(new Error("no network in tests")));
  const store = createAppStore({ fetch: fetchMock as unknown as typeof fetch });
  const meta = state.meta ?? makeMeta();
  store.setState({ status: "ready", runId: meta.date, meta, fireScaling: meta.notes.fire_scaling_default, ...state });
  return { store, fetchMock };
}

export function renderPanel(ui: ReactElement, state: Partial<AppState> = {}) {
  const { store, fetchMock } = testStore(state);
  const r = render(<StoreProvider store={store}>{ui}</StoreProvider>);
  return { ...r, store, fetchMock };
}

export const measuredReady = (values: (number | null)[], stationCount = 4): CityDataState => ({
  ...IDLE_CITY_DATA, status: "ready", values, stationCount,
});

export const flat = (n: number, v: number | null) => Array.from({ length: n }, () => v);
