import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeMeta } from "../test-utils/meta";
import { testStore } from "../test-utils/panels";
import { MadeHereBlock, depositionNote } from "./MadeHere";
import { StoreProvider } from "./storeContext";

const NOTES = makeMeta().notes;
const W = {
  vehicles_delhi_ncr: 1, coarse_vehicles_delhi_ncr: 1, coarse_dust_delhi_ncr: 1, vehicles_punjab: 1, user_1: 1,
};
const CITY = {
  by_tag: { vehicles_delhi_ncr: [60], vehicles_punjab: [40], coarse_dust_delhi_ncr: [30], coarse_vehicles_delhi_ncr: [20] },
  by_tag_local: { vehicles_delhi_ncr: [54], coarse_dust_delhi_ncr: [27], coarse_vehicles_delhi_ncr: [6] },
};

function show(props: Partial<Parameters<typeof MadeHereBlock>[0]> = {}) {
  const { store } = testStore();
  return render(
    <StoreProvider store={store}>
      <MadeHereBlock city={CITY} weights={W} hour={0} pollutant="pm25" notes={NOTES} {...props} />
    </StoreProvider>,
  );
}
const rows = () => within(screen.getByRole("list", { name: "Made here vs arrived" }));

describe("MadeHereBlock", () => {
  it("PM2.5: two parts with values and shares, the caption, and the PM2.5 vs coarse comparison", () => {
    show();
    expect(screen.getByTestId("made-here-title")).toHaveTextContent("Made here vs arrived · PM2.5 (this hour)");
    expect(rows().getByTestId("mh-local")).toHaveTextContent("54 µg/m³54%");
    expect(rows().getByTestId("mh-arrived")).toHaveTextContent("46 µg/m³46%");
    expect(rows().queryByTestId("mh-added")).toBeNull();
    expect(screen.getByTestId("mh-seg-local").style.width).toBe("54%");
    expect(screen.getByTestId("mh-seg-arrived").style.width).toBe("46%");
    expect(screen.getByText("Made here: emitted inside the city's own ≈ 30 km square. Model estimate, not measured.")).toBeInTheDocument();
    // coarse: 33 of 50 made here
    expect(screen.getByTestId("made-here-compare")).toHaveTextContent("Made here: PM2.5 54% · coarse 66%");
  });

  it("follows the pollutant in view; the comparison line stays the same", () => {
    show({ pollutant: "coarse" });
    expect(screen.getByTestId("made-here-title")).toHaveTextContent("coarse PM (this hour)");
    expect(rows().getByTestId("mh-local")).toHaveTextContent("33 µg/m³66%");
    expect(rows().getByTestId("mh-arrived")).toHaveTextContent("17 µg/m³34%");
    expect(screen.getByTestId("made-here-compare")).toHaveTextContent("Made here: PM2.5 54% · coarse 66%");
  });

  it("applies the weights", () => {
    show({ weights: { ...W, vehicles_punjab: 0 } }); // nothing arrives from Punjab: 54 of 60
    expect(rows().getByTestId("mh-local")).toHaveTextContent("54 µg/m³90%");
    expect(screen.getByTestId("made-here-compare")).toHaveTextContent("PM2.5 90%");
  });

  it("added sources are a separate third part, only when they contribute", () => {
    const city = { ...CITY, by_tag: { ...CITY.by_tag, user_1: [100] } };
    const { unmount } = show({ city });
    expect(rows().getByText("Added sources")).toBeInTheDocument();
    expect(rows().getByTestId("mh-added")).toHaveTextContent("100 µg/m³50%");
    expect(rows().getByTestId("mh-local")).toHaveTextContent("54 µg/m³27%");
    unmount();
    show({ city, weights: { ...W, user_1: 0 } });
    expect(rows().queryByText("Added sources")).toBeNull();
  });

  it("an undefined share is a dash, never 0%", () => {
    show({ city: { by_tag: { vehicles_delhi_ncr: [60] }, by_tag_local: {} } }); // no coarse PM at all
    expect(screen.getByTestId("made-here-compare")).toHaveTextContent("Made here: PM2.5 0% · coarse –");
    expect(screen.getByTestId("made-here-compare").textContent).not.toMatch(/coarse 0%/);
  });

  it("missing data: dashes for the values and the shares", () => {
    show({ city: { by_tag: { vehicles_delhi_ncr: [null] }, by_tag_local: { vehicles_delhi_ncr: [null] } } });
    expect(rows().getByTestId("mh-local")).toHaveTextContent("– µg/m³–");
    expect(rows().getByTestId("mh-arrived")).toHaveTextContent("– µg/m³–");
  });

  it("the physics note is built from the run's deposition velocities", () => {
    show();
    expect(screen.getByTestId("deposition-note")).toHaveTextContent(
      "In the model coarse particles deposit 5× faster than fine ones (0.01 vs 0.002 m/s), so less coarse PM arrives from far away.",
    );
    expect(depositionNote({ v_dep_fine_m_s: 0.002, v_dep_coarse_m_s: 0.007 })).toContain("3.5× faster");
    expect(depositionNote({ v_dep_fine_m_s: 0, v_dep_coarse_m_s: 0.01 })).toBeNull();
    expect(depositionNote({} as never)).toBeNull();
  });

  it("renders nothing on stale weights (the breakdown reports that problem)", () => {
    const { container } = show({ weights: {} });
    expect(container.querySelector("section")).toBeNull();
  });
});
