/** Context passed into gate checks (subcategory routing + suspicion scan). */
export interface GateContext {
  /** Subcategories detected for the snapshot (drives the C6 noun union). */
  subcategories: string[];
  /** Text used for the category-agnostic suspicion fail-closed check. */
  snapshotText?: string;
}
