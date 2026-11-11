import { describe, expect, it } from "vitest";
import { keyAction } from "./keyboard";

const el = (tag: string, attrs: Record<string, string> = {}) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

describe("keyAction", () => {
  it("maps Space, arrows and Escape", () => {
    const body = document.body;
    expect(keyAction({ key: " ", target: body })).toBe("toggle");
    expect(keyAction({ key: "ArrowRight", target: body })).toBe("next");
    expect(keyAction({ key: "ArrowLeft", target: body })).toBe("prev");
    expect(keyAction({ key: "Escape", target: body })).toBe("escape");
    expect(keyAction({ key: "a", target: body })).toBeNull();
  });
  it("ignores keys while an input, select or textarea is focused", () => {
    for (const t of [el("input"), el("input", { type: "range" }), el("select"), el("textarea")]) {
      expect(keyAction({ key: " ", target: t })).toBeNull();
      expect(keyAction({ key: "ArrowLeft", target: t })).toBeNull();
    }
  });
  it("leaves Space to a focused button but still steps with arrows", () => {
    expect(keyAction({ key: " ", target: el("button") })).toBeNull();
    expect(keyAction({ key: " ", target: el("div", { role: "switch" }) })).toBeNull();
    expect(keyAction({ key: "ArrowRight", target: el("button") })).toBe("next");
  });
  it("Escape works even inside an input (closes the dialog)", () => {
    expect(keyAction({ key: "Escape", target: el("input") })).toBe("escape");
  });
  it("ignores modified keys", () => {
    expect(keyAction({ key: "ArrowRight", target: document.body, metaKey: true })).toBeNull();
  });
});
