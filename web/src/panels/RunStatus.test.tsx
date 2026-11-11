import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderPanel } from "../test-utils/panels";
import { RunStatus } from "./RunStatus";

describe("RunStatus", () => {
  it("shows the stage and progress while building", () => {
    renderPanel(<RunStatus onRetry={() => {}} />, { status: "running", stage: "simulating", progress: 0.42, meta: null });
    expect(screen.getByText("simulating")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByText(/about a minute/)).toBeInTheDocument();
  });
  it("shows the server's error text with Retry", () => {
    const onRetry = vi.fn();
    renderPanel(<RunStatus onRetry={onRetry} />, { status: "error", error: "Open-Meteo returned 503", meta: null });
    expect(screen.getByText("Open-Meteo returned 503")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });
  it("shows a dismissible notice", () => {
    const { store } = renderPanel(<RunStatus onRetry={() => {}} />, { notice: "Run refreshed; added sources were removed" });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(store.getState().notice).toBeNull();
  });
  it("nothing while ready", () => {
    const { container } = renderPanel(<RunStatus onRetry={() => {}} />);
    expect(container.textContent).toBe("");
  });
});
