/** `#rrggbb` to a deck.gl colour with the given alpha (0..255). */
export function hexToRgba(hex: string, alpha = 255): [number, number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), alpha];
}

/** Additive blending (a glow): colours add up where points overlap. luma.gl 9 parameter names. */
export const ADDITIVE_BLEND = {
  blend: true,
  blendColorOperation: "add",
  blendColorSrcFactor: "src-alpha",
  blendColorDstFactor: "one",
  blendAlphaOperation: "add",
  blendAlphaSrcFactor: "one",
  blendAlphaDstFactor: "one-minus-src-alpha",
} as const;
