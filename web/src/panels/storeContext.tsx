/**
 * Which app store the panels read. The app uses the global `useStore`; tests wrap a panel in
 * `<StoreProvider store={createAppStore({ fetch: mock })}>` so nothing touches the network.
 */
import { createContext, useContext, type ReactNode } from "react";
import { useStore, type AppState, type AppStore } from "../state/store";

const StoreCtx = createContext<AppStore>(useStore);

export function StoreProvider({ store, children }: { store: AppStore; children: ReactNode }) {
  return <StoreCtx.Provider value={store}>{children}</StoreCtx.Provider>;
}

/** The store itself (for actions and `getState`). */
export function useAppStore(): AppStore {
  return useContext(StoreCtx);
}

/** Subscribe to a slice. Selectors must return stable values (primitives or store-owned objects). */
export function useApp<T>(selector: (s: AppState) => T): T {
  return useContext(StoreCtx)(selector);
}
