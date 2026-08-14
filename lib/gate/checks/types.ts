/** Context passed into gate checks (subcategory routing + suspicion scan). */
export interface GateContext {
  /** Subcategories detected for the snapshot (drives the C6 noun union). */
  subcategories: string[];
  /** Text used for the category-agnostic suspicion fail-closed check. */
  snapshotText?: string;
  /**
   * THE BRAND NAMES OF THE COMPETITORS THE OPERATOR ACTUALLY SUPPLIED, read off
   * their INGESTED snapshots — an AUTOMATIC negative set for this run (C28).
   *
   * WHY IT EXISTS. C28's `negative` leg is the R50 enforcement point, and every
   * word of it depends on the MODEL having labelled the row `negative`. A rival
   * brand the model labels `placed` is in no lexicon (the four-test screen
   * covers disease nouns, action-paired nouns and superlatives — a brand name is
   * none of those), so it sails through: C28 guarantees LABELLED-NEGATIVE
   * absence, not RIVAL absence. This is the code-side signal that does not ask
   * the model anything. The operator typed those ASINs; the brand names are
   * sitting in the ingested snapshots' own `brand_name` / `manufacturer` fields.
   *
   * DERIVED OUTSIDE THE GATE, on purpose. The gate holds no ingestion and no
   * knowledge of `CompetitorIngestion`; `lib/audit/rivalBrands.ts` resolves the
   * set and the audit — which owns `verified` — supplies it on every run that
   * had competitors. Absent or empty => this leg does not exist and every
   * output is byte-identical, which is the required behaviour when the operator
   * supplied no competitors at all.
   *
   * Strings are already normalised for scanning; C28 matches them with the SAME
   * `termRegex` it uses for a model-declared `negative` row.
   */
  rivalBrands?: string[];
}
