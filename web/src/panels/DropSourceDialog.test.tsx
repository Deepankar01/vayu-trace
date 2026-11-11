import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDropStore } from "../map/dropStore";
import { renderPanel } from "../test-utils/panels";
import { DropSourceDialog } from "./DropSourceDialog";
import { useKeyboard } from "./keyboard";
import { useAppStore } from "./storeContext";
import { validateDrop } from "./dropKinds";

describe("validateDrop", () => {
  const ok = { kind: "custom", amount: 10, startHour: 0, durationH: 6 };
  it("accepts a valid form", () => expect(validateDrop(ok, 30)).toEqual({}));
  it("duration bounds 1..72", () => {
    expect(validateDrop({ ...ok, durationH: 0 }, 30).durationH).toBeDefined();
    expect(validateDrop({ ...ok, durationH: 73 }, 30).durationH).toBeDefined();
    expect(validateDrop({ ...ok, durationH: 72 }, 30).durationH).toBeUndefined();
    expect(validateDrop({ ...ok, durationH: 2.5 }, 30).durationH).toBeDefined();
  });
  it("start inside the window", () => {
    expect(validateDrop({ ...ok, startHour: 30 }, 30).startHour).toBeDefined();
    expect(validateDrop({ ...ok, startHour: -1 }, 30).startHour).toBeDefined();
    expect(validateDrop({ ...ok, startHour: 29 }, 30).startHour).toBeUndefined();
  });
  it("amount > 0; fireworks takes an event size", () => {
    expect(validateDrop({ ...ok, amount: 0 }, 30).amount).toBeDefined();
    expect(validateDrop({ ...ok, amount: NaN }, 30).amount).toBeDefined();
    expect(validateDrop({ ...ok, kind: "fireworks", amount: 2 }, 30)).toEqual({});
    expect(validateDrop({ ...ok, kind: "fireworks", amount: 5 }, 30).amount).toBeDefined();
  });
});

describe("DropSourceDialog", () => {
  beforeEach(() => useDropStore.setState({ armedForDrop: false, pending: { lon: 77.2, lat: 28.6, x: 500, y: 400 } }));
  afterEach(() => useDropStore.setState({ armedForDrop: false, pending: null, busy: false }));

  function WithKeys() {
    useKeyboard(useAppStore());
    return null;
  }

  it("Escape mid-submit keeps the dialog, so the server error is still shown", async () => {
    const { store } = renderPanel(<><WithKeys /><DropSourceDialog /></>);
    let finish!: () => void;
    store.setState({
      addSource: () =>
        new Promise<void>((resolve) => {
          finish = () => {
            store.setState({ sourceError: "simulation failed: out of memory" });
            resolve();
          };
        }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    await waitFor(() => expect(useDropStore.getState().busy).toBe(true));
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useDropStore.getState().pending).not.toBeNull();
    await act(async () => finish());
    expect(screen.getByRole("alert")).toHaveTextContent("simulation failed: out of memory");
    expect(useDropStore.getState().busy).toBe(false);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useDropStore.getState().pending).toBeNull();
  });

  it("traps Tab inside the dialog", () => {
    renderPanel(<DropSourceDialog />);
    const add = screen.getByRole("button", { name: "Add source" });
    add.focus();
    fireEvent.keyDown(add, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByLabelText("Kind"));
    fireEvent.keyDown(screen.getByLabelText("Kind"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(add);
  });

  it("defaults the start to the playhead hour and shows the kind's assumption", () => {
    renderPanel(<DropSourceDialog />, { hour: 13.4 });
    expect(screen.getByLabelText("Start")).toHaveValue("13");
    expect(screen.getByLabelText("Duration (hours)")).toHaveValue(6);
    expect(screen.getByText(/You give the PM2.5 emission rate directly/)).toBeInTheDocument();
    expect(screen.getByText("kg PM2.5 per hour")).toBeInTheDocument();
  });

  it("shows validation errors and does not submit", () => {
    const { store } = renderPanel(<DropSourceDialog />);
    const add = vi.spyOn(store.getState(), "addSource");
    fireEvent.change(screen.getByLabelText("Duration (hours)"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(screen.getByText(/Duration must be a whole number of hours, 1 to 72/)).toBeInTheDocument();
    expect(add).not.toHaveBeenCalled();
  });

  it("shows the server error in the dialog and stays open", async () => {
    const { store } = renderPanel(<DropSourceDialog />);
    store.setState({
      addSource: async () => {
        store.setState({ sourceError: "at most 5 added sources per run" });
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("at most 5 added sources per run"));
    expect(useDropStore.getState().pending).not.toBeNull();
  });

  it("submits the request and closes on success", async () => {
    const { store } = renderPanel(<DropSourceDialog />, { hour: 3 });
    const calls: unknown[] = [];
    store.setState({ addSource: async (req) => void calls.push(req) });
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: "12.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    await waitFor(() => expect(useDropStore.getState().pending).toBeNull());
    expect(calls).toEqual([{ kind: "custom", lon: 77.2, lat: 28.6, amount: 12.5, start_hour: 3, duration_h: 6 }]);
  });

  it("fireworks uses an event size choice", () => {
    renderPanel(<DropSourceDialog />);
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "fireworks" } });
    expect(screen.getByRole("radio", { name: "Medium" })).toBeChecked();
    expect(screen.queryByLabelText(/^Amount/)).toBeNull();
  });
});
