import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelBoundary } from "./PanelBoundary";

function Boom(): never {
  throw new Error("no weight for source tag 'user_9'");
}

describe("PanelBoundary", () => {
  // React and the boundary both log the caught error; keep the test output clean
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => spy.mockRestore());

  it("shows a compact message with the error text instead of the panel", () => {
    render(
      <div>
        <PanelBoundary name="City panel"><Boom /></PanelBoundary>
        <p>map still here</p>
      </div>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Panel error — reload");
    expect(screen.getByRole("alert")).toHaveTextContent("City panel: no weight for source tag 'user_9'");
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getByText("map still here")).toBeInTheDocument();
  });
  it("Try again re-renders the children in place", () => {
    let fail = true;
    function Flaky() {
      if (fail) throw new Error("flaky");
      return <p>recovered</p>;
    }
    render(<PanelBoundary name="City panel"><Flaky /></PanelBoundary>);
    expect(screen.getByRole("alert")).toHaveTextContent("flaky");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("recovered")).toBeInTheDocument();
  });
  it("resets by itself when the reset key (the run) changes", () => {
    let fail = true;
    function Flaky() {
      if (fail) throw new Error("stale tag");
      return <p>new run</p>;
    }
    const { rerender } = render(<PanelBoundary name="x" resetKey="build-1"><Flaky /></PanelBoundary>);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fail = false;
    rerender(<PanelBoundary name="x" resetKey="build-1"><Flaky /></PanelBoundary>);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    rerender(<PanelBoundary name="x" resetKey="build-2"><Flaky /></PanelBoundary>);
    expect(screen.getByText("new run")).toBeInTheDocument();
  });
  it("calls onError so the owner can clear state the panel left behind", () => {
    const onError = vi.fn();
    render(<PanelBoundary name="Drop source dialog" onError={onError}><Boom /></PanelBoundary>);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "no weight for source tag 'user_9'" }));
  });
  it("renders children when nothing throws", () => {
    render(<PanelBoundary name="x"><p>fine</p></PanelBoundary>);
    expect(screen.getByText("fine")).toBeInTheDocument();
  });
});
