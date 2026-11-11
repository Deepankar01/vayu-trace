import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, renderHook } from "@testing-library/react";
import { testStore } from "../test-utils/panels";
import { keyAction, modalOpen, useKeyboard } from "./keyboard";

afterEach(() => document.body.replaceChildren());

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
  it("only Escape while the drop dialog is open", () => {
    expect(keyAction({ key: " ", target: document.body, dialogOpen: true })).toBeNull();
    expect(keyAction({ key: "ArrowRight", target: document.body, dialogOpen: true })).toBeNull();
    expect(keyAction({ key: "Escape", target: document.body, dialogOpen: true })).toBe("escape");
  });
  it("leaves keys inside the map to MapLibre, except Escape", () => {
    const map = el("div", { class: "vayu-map" });
    const canvas = el("canvas", { class: "maplibregl-canvas" });
    map.appendChild(el("div", { class: "maplibregl-canvas-container" })).appendChild(canvas);
    document.body.appendChild(map);
    expect(keyAction({ key: "ArrowLeft", target: canvas })).toBeNull();
    expect(keyAction({ key: " ", target: canvas })).toBeNull();
    expect(keyAction({ key: "Escape", target: canvas })).toBe("escape");
  });
  it("modalOpen sees any aria-modal dialog (the Validation dialog as well as the drop dialog)", () => {
    expect(modalOpen()).toBe(false);
    document.body.appendChild(el("div", { role: "dialog", "aria-modal": "true", class: "vd" }));
    expect(modalOpen()).toBe(true);
  });
  it("ignores modified keys", () => {
    expect(keyAction({ key: "ArrowRight", target: document.body, metaKey: true })).toBeNull();
  });
});

describe("useKeyboard", () => {
  it("does not step the playhead while the Validation dialog (any aria-modal) is open", () => {
    const { store } = testStore({ hour: 5 });
    renderHook(() => useKeyboard(store));
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(store.getState().hour).toBe(6);
    document.body.appendChild(el("div", { role: "dialog", "aria-modal": "true" }));
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(store.getState().hour).toBe(6);
  });
});
