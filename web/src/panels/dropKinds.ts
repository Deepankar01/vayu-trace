/**
 * The kinds of source a researcher can drop, mirroring `KINDS` in server/vayu/emissions/dropped.py
 * (labels and units verbatim; the server validates and is the authority). `assumption` restates
 * the factor and the assumptions written out next to it in that file, for the dialog.
 */

export const MAX_ADDED_SOURCES = 5; // server/vayu/api.py MAX_USER_SOURCES
export const MAX_DURATION_H = 72; // server/vayu/emissions/dropped.py MAX_DURATION_H
export const DEFAULT_DURATION_H = 6;

export interface DropKind {
  id: "traffic" | "construction" | "fireworks" | "custom";
  label: string;
  unit: string;
  /** Default amount, in `unit` (fireworks: 1 small, 2 medium, 3 large). */
  defaultAmount: number;
  assumption: string;
}

export const DROP_KINDS: readonly DropKind[] = [
  {
    id: "custom", label: "Custom source", unit: "kg PM2.5 per hour", defaultAmount: 10,
    assumption: "You give the PM2.5 emission rate directly; it is held constant for the duration.",
  },
  {
    id: "traffic", label: "Traffic (assumed mixed Indian fleet, 30 km per vehicle per day, no road dust)",
    unit: "vehicles", defaultAmount: 100000,
    assumption:
      "Exhaust (ARAI factors) plus tyre, brake and road wear (EMEP/EEA) for an assumed fleet of 70% two-wheelers, " +
      "20% cars, 5% three-wheelers and 5% trucks, each driving 30 km a day: about 0.044 g PM2.5 per vehicle per hour. " +
      "Resuspended road dust, often larger, is not included.",
  },
  {
    id: "construction", label: "Construction site (US site-average dust factor, watered)", unit: "m² of site",
    defaultAmount: 10000,
    assumption:
      "US site-average construction dust factor for a watered site (Bay Area AQMD method): about 0.034 kg PM2.5 per " +
      "hour for a 1 hectare site. Real sites can differ several-fold.",
  },
  {
    id: "fireworks", label: "Fireworks (assumed 10 / 100 / 1000 kg of product per event)",
    unit: "small / medium / large event", defaultAmount: 2,
    assumption:
      "40 g of PM2.5 per kg of product burnt (German inventory). The product per event is assumed: 10 kg small, " +
      "100 kg medium, 1000 kg large. The event total is spread evenly over the duration.",
  },
];

export const FIREWORKS_SIZES = [
  { amount: 1, name: "Small" },
  { amount: 2, name: "Medium" },
  { amount: 3, name: "Large" },
] as const;

export interface DropForm {
  kind: string;
  amount: number;
  startHour: number;
  durationH: number;
}

export type DropErrors = Partial<Record<"kind" | "amount" | "startHour" | "durationH", string>>;

/** Field errors for the dialog (empty when valid); the run window is hours 0..nHours-1. */
export function validateDrop(f: DropForm, nHours: number): DropErrors {
  const e: DropErrors = {};
  const kind = DROP_KINDS.find((k) => k.id === f.kind);
  if (!kind) e.kind = "Choose a kind of source";
  if (kind?.id === "fireworks") {
    if (![1, 2, 3].includes(f.amount)) e.amount = "Choose an event size";
  } else if (!(Number.isFinite(f.amount) && f.amount > 0)) {
    e.amount = "Amount must be greater than 0";
  }
  if (!(Number.isInteger(f.startHour) && f.startHour >= 0 && f.startHour < nHours)) {
    e.startHour = "Start must be inside the run window";
  }
  if (!(Number.isInteger(f.durationH) && f.durationH >= 1 && f.durationH <= MAX_DURATION_H)) {
    e.durationH = `Duration must be a whole number of hours, 1 to ${MAX_DURATION_H}`;
  }
  return e;
}
