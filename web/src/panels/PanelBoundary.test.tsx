import { render, screen } from "@testing-library/react";
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
  it("renders children when nothing throws", () => {
    render(<PanelBoundary name="x"><p>fine</p></PanelBoundary>);
    expect(screen.getByText("fine")).toBeInTheDocument();
  });
});
