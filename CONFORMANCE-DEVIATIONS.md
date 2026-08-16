# CONFORMANCE DEVIATIONS

Where this app knowingly differs from the source material — the
`SUPPLEMENT-ASIN-OPTIMIZATION-PLAYBOOK` and the `SUPPLEMENT-HARNESS-KIT` it was
ported from — and where the repository's own record was wrong.

A deviation is only defensible if it is **written down**. An undocumented
difference between what a check claims to do and what it does is the exact
failure this project exists to stop: it survives review precisely because the
record says it was handled. Every entry below states the difference, why it is
accepted, and what a future change to it must also change.

---

## 1. CORRECTED RECORD — the WS8 commit claimed C28 covered ALT and video. It did not.

Commit `ba8f920` ("WS8: 8-slot visual pack + video brief, ALT text, and CONTENT
checks C29/C30") states, of the image ALT strings, the A+ banner ALT and the
video brief's on-screen text:

> "(added to `customerSurfaces`/`aplusSurfaces`, so C6/C17/C18/C19/C27 **and the
> C28 negative list** all cover them)"

The first half was true. The parenthetical about C28 was **false**, and the
reason it was false is instructive: **C28 does not read `customerSurfaces` or
`aplusSurfaces` at all.** It has its own private surface reader,
`keywordSurfaceText` in `lib/gate/checks/c-keywords.ts`, because it must resolve
a surface **by the NAME the keyword artifact declares** rather than walk a flat
list of field/text pairs. Adding a surface to the shared readers therefore did
nothing for C28, and nobody noticed because the claim was in a commit message
rather than in a test.

The consequence was a live bypass of **R50** (rival-brand exclusion), the rule
**AM-9** exists to guarantee: a `negative`-status rival brand planted in an A+
module's `bannerAltText`, or in `videoBrief.onScreenText` / `.notes`, produced
**zero gate failures and a `verified: true` run**. Both surfaces are
customer-facing and invisible on the page — which is exactly where a stale
agency template's competitor name survives.

**Status: FIXED** (commit `47b5f1e`, finding F1). `aplusText` now reads
`bannerAltText`; a new `video` reader covers every string field of the brief
(`aspect`, `shots[]`, `onScreenText[]`, `notes`); `video` is registered in
`knowledge/rules.json` → `keywordRules.visibleSurfaces` so the vocabulary stays
pack-driven. `tests/keywordPlacement.surfaces.test.ts` holds every leg in both
directions — **12 of its 18 cases** fail against the pre-fix reader.

> **CORRECTED (M2, re-measured).** This said **14**. Reconstructing the pre-fix
> reader on the current tree — `aplusText` stops reading `bannerAltText`, and
> `video` comes out of `keywordRules.visibleSurfaces` — and running the suite
> gives **12 failed, 6 passed of 18**. The original 14 was measured against a
> tree that no longer exists in isolation (items 6, 7 and 10 have since added
> legs to C28), so the honest record is the number a reader can reproduce today
> by the method just stated, not a number nobody can check.

**The record is corrected here rather than in the old commit message**, which is
immutable. The lesson is kept deliberately: *a coverage claim belongs in a test,
not in prose.* The closed-world rule was doing its job in one direction the whole
time (an unknown DECLARED surface fails) and could not help in the other, because
a surface that is never named is never checked.

### 1.1 THE SAME HOLE, IN FOUR MORE CHECKS — closed by N1.

The fix above closed C28's reader and the C6/C10/C12/C21/C22 corpus. It did not
close the other two readers, and the difference sat there afterwards:

| reader | behind | image `altText` | `videoBrief.*` |
| --- | --- | --- | --- |
| `customerSurfaces` | C6/C10/C12/C21/C22 | read | read |
| `keywordSurfaceText` | C28 | read | read |
| `collectSurfaces` | **C18 / C19 / C27** | **NOT read** | **no branch at all** |
| `styleSurfaces` | **C17** | **NOT read** | **not read** |

So a price, a URL, an email address, a rank claim, a guarantee, a superlative,
an AI tell, a leaked instruction fragment or a non-ASCII glyph could sit in an
ALT string or anywhere in the video brief and produce **zero** failures — while
the identical string one field over, in `imagePlan[i].notes`, failed. That
asymmetry is the whole tell: these were never new surfaces, they were surfaces
four checks had been left behind on.

**Status: FIXED.** `collectSurfaces` reads `altText` in its existing `imagePlan`
branch and gains a `videoBrief` branch over every string field; `styleSurfaces`
reads `altText` in the existing `images` group and the brief in a new `video`
group; `videoBrief` is registered in `prohibitedContent.surfaces`,
`prohibitedMarketing.surfaces` and `outputHygiene.surfaces` so the vocabulary
stays pack-driven.

**The closed-world hole itself is now closed, in the direction that bit.** The
collector's group vocabulary is exported as `COLLECTED_SURFACE_GROUPS` and
`tests/n1.surfaceCoverage.gate.test.ts` §1 asserts it **equals** the set the
pack declares — so a group declared with no branch (silently unscanned: this
bug) and a branch nothing declares (dead code that reads as coverage) are both
test failures now, not review-survivable prose.

> **INCOMPLETE AS WRITTEN — see item 1.2 (M3).** "the set the pack declares" was
> the **UNION** of the three declaring keys, and a union is blind to a
> per-check omission. One was already there: C27 did not declare `facts`. §1.5
> now pins each check's list on its own.

**THE C17 SUB-RULE PARTITION, and why it is not a blanket add.** ALT text and
on-screen video text are SHORT DISPLAY STRINGS; a rule written for a prose
bullet is not automatically a rule about a motion-graphics overlay, and this
project treats over-blocking as exactly as severe as a bypass.

| sub-rule | `imagePlan[i].altText` | `videoBrief.*` | why |
| --- | --- | --- | --- |
| banned symbols | **applied** | **applied** | prohibited wherever they render, and both render |
| emoji | **applied** | **applied** | same rule, same reason |
| ASIN in copy | **applied** | **applied** | an identifier is never legitimate on a customer surface |
| HTML markup | **applied** | **applied** | a tag with no renderer behind it is a defect in every medium |
| ALL-CAPS (word + run) | **applied** | **NOT applied** | ALT is prose a screen reader reads aloud, in the same register as its `purpose`/`spec`/`notes` siblings. A brief is capitals in BOTH registers — typography in a title card, slug lines in a shot list — and C17 cannot tell either from shouting |
| banned characters | not applied | not applied | pack-scoped to the title surfaces + bullets, unchanged |
| promo term bans | not applied | not applied | pack-scoped to the title surfaces, unchanged |
| bullet start-capital | not applied | not applied | a rule about how a bullet LIST renders; an ALT attribute and a graphic are not list items |
| bullet trailing punctuation | not applied | not applied | same |

The ALL-CAPS exclusion is **pack data** (`style.allCapsExemptSurfaces:
["video"]`), and it can only SUBTRACT — an absent or empty list checks every
surface, which is the stricter behaviour and the one that shipped before the key
existed. That is why it is not a `REQUIRED_PACK_PIECES` row, on the same
reasoning that excludes `benignContextPhrases` and `asciiExemptSurfaces`.
**Nothing is given up by declining it**: the things that actually matter in an
overlay — a price, a CTA, a ranking claim, a superlative — are caught by C18/C19,
whose patterns are compiled case-insensitive, so a shouted one fails there
whatever its casing. Both the applied and the excluded rules are asserted in
§3 of the suite, because *an exclusion nobody tests is indistinguishable from an
omission*.

**THE C27 ASCII CARVE-OUT: decided NO for these surfaces, and recorded either
way.** At N1 `asciiExemptSurfaces` listed exactly one group,
`backendSearchTerms` (item 1.2 later adds `facts`, on a different argument), and
that exemption is *earned* by what the field is: a SEARCH-INDEX input whose job
is to carry other-language query variants, where a diacritic **is** the query.
ALT text and on-screen video text are the opposite — DISPLAY strings that ship
to a customer and into a feed — so a surviving non-ASCII character there is a
smart quote the emit-time fold left alone, an invisible, or a real accented word,
and each of those is a decision a human should make deliberately. `shots`/`notes`
are the production direction those display strings are rendered *from*, so
exempting them would only move the same character one field upstream. Asserted
in both directions in §5 (backend still exempt from ASCII but still phrase-scanned;
ALT and every video field not exempt).

**Both directions, and the lawful-copy battery.**
`tests/n1.surfaceCoverage.gate.test.ts` — 170 cases (159 at N1; §1.5 adds 11 at
M3, item 1.2). §2 plants a genuine
violation of each applicable check in each of the five new fields and requires a
failure naming that exact field; §4 is the over-blocking half, running the real
ALT, overlay, shot-direction and notes shapes the verified runs produce (all
eight golden ALT strings, the oral-care register of B00WNDG7V8, the
potency-overlay register of B00EEEITVA, plus shapes that *look* like violations
and are not) and requiring **zero** findings from all four checks and zero gate
failures overall; §6 requires every newly-emitted field to route to the images
group, so a new finding is repairable rather than a round-burning dead end; §7
reconstructs the pre-fix readers to prove the suite is not vacuous. Removing
`videoBrief` from all three declaring pack keys fails **68 of the 170**.

> **RE-MEASURED (M2).** This said "fails 64 of the 159", and a meta review
> reported 70. Neither was taken again; the number was therefore re-measured
> from scratch — `videoBrief` deleted from `prohibitedContent.surfaces`,
> `prohibitedMarketing.surfaces` and `outputHygiene.surfaces`, the suite run,
> the pack restored. The result is **68 failed / 102 passed of 170**, of which
> **4** are in the new §1.5, i.e. **64 of the original 159** — so the recorded
> 64 was right, the meta review's 70 was wrong, and the sentence is updated to
> the current suite rather than left to be re-derived. The 68 break down as:
> §1 ×2, §1.5 ×4, §2/C18 ×20, §2/C19 ×20, §2/C27 ×20, §5 ×1, §6 ×1.

---

### 1.2 THE SAME HOLE, ONE PACK KEY FURTHER ALONG — and two errors in this record.

Three findings from a final adversarial meta review, closed together because
they are one shape: **a coverage claim that no test could falsify.**

#### M1 — C27 did not scan `facts.*`

`outputHygiene.surfaces` declared **eleven** groups while
`prohibitedContent.surfaces` and `prohibitedMarketing.surfaces` each declared
**twelve**. The missing one was `facts`. `c27OutputHygiene` reads exactly what
its own pack key declares, so C17, C18 and C19 all scanned the canonical facts
and **C27 never scanned one** — a smart quote, a zero-width character, an AI
tell or a leaked instruction fragment parked in a fact string escaped, while the
identical string one field over failed. Same shape as N1: `facts` was never a
new surface, it was a surface one check had been left behind on.

**DECISION: `facts` joins `outputHygiene.surfaces`, and joins
`asciiExemptSurfaces` in the same change.** That is one decision about one rule,
not half of each — the three thirds of C27 are separable by design, and the pack
already has the mechanism for saying so.

* **The two PHRASE scans belong on facts and now run there.** `facts.*` is
  echoed **verbatim** into every repair prompt, so an AI tell or an instruction
  fragment sitting in a fact is both a defect in the canonical record and a
  prompt-injection route into the next round. Nothing about a fact makes stock
  model phrasing or a fragment of our own scaffolding legitimate.

* **The ASCII scan does not, and C27's own docstring says why without meaning
  to.** It reads: *the engine folds typographic punctuation to ASCII at emit, so
  anything non-ASCII that survives is a real character a human must decide
  about.* `lib/engine/typography.ts` **deliberately never folds `facts`** — and
  says so, in as many words, because facts are deterministic source truth read
  off the scraped page (and, under WS5.5, off an operator's confirmed panel
  reading), not model-written copy. The premise the rule rests on is false for
  this group.

  > **P3 CORRECTION — this bullet used to end "…false for this one group and
  > false for no other." That was overstated and wrong.** When it was written,
  > `normalizeListingTypography` also never folded `imagePlan[].altText`,
  > `aplusContent.modules[].bannerAltText` or **any** `videoBrief` string
  > (`aspect`, `shots[]`, `onScreenText[]`, `notes`) — three further surfaces
  > C27 scans. `altText` and `bannerAltText` were missed because their branches
  > listed their siblings and not them; `videoBrief` had no branch at all and
  > rode the object spread. So the premise was false for four groups, not one.
  > The `facts` conclusion is unaffected — it was argued from facts being
  > *source truth*, not from being unique — but the uniqueness claim is what
  > made the carve-out look principled, and it was not true.
  >
  > **The other three are FIXED IN THE FOLD, not carved out.** They are
  > model-written copy, so the honest repair is to make the premise true rather
  > than to widen the exemption: `normalizeListingTypography` now folds all
  > three. That direction also removes a real **over-blocking** asymmetry — a
  > curly apostrophe a model wrote into an ALT string was reported as "a
  > character a human must decide about" while the identical apostrophe in
  > `imagePlan[].notes` one field over was folded and never seen, and no repair
  > round can converge on a character class it is not told is mechanical.
  > Nothing is laundered: the substitution table is punctuation and spacing
  > only, so banned symbols, currency signs, emoji, zero-width characters and
  > accented words still arrive at C17/C27 exactly as the model wrote them, and
  > `undefined` is preserved as `undefined` so C29/C30 still see a MISSING
  > brief or ALT as missing rather than as empty. Both directions are in
  > `tests/p3.typographyFold.test.ts`.

* **And the failure would be unrepairable.** `facts` are rebuilt identically
  from the same snapshot on every round (`buildFacts`), so no regeneration can
  rewrite one — the routing table sends `facts.*` to the attributes group, but
  that group does not author them. A scraped en dash in `facts.weight` would
  burn every remaining round and end the run `verified:false` on a character
  nobody wrote: the unwinnable shape recorded as items 10.1 and 11.2, and this
  project treats over-blocking as exactly as severe as a bypass.

The evidence was taken before the decision, not after: the golden fixture's
facts (`50 Billion CFU` / `1 Capsule` / `2.4 Ounces` / `$24.99`) and both
live-verified fact shapes (B00WNDG7V8's `{price, formulaCount: 11}` and its
120-count follow-up, B00EEEITVA's potency-bearing block) are **entirely ASCII**,
so the carve-out gives up nothing that is happening today — it bounds what
happens the first time a scraped panel string carries a `–`, a `µ` or a
non-breaking space.

**Both directions in `tests/m1.factsHygiene.gate.test.ts` (41 cases).** §1
reproduces the hole against a reconstructed pre-M1 pack (the AI tell and the
fragment raise nothing there and fail now, while C18/C19 are identical either
side); §2 fires both phrase scans on every string fact, end to end through
`runGate`, and pins that the emitted failure ROUTES rather than dead-ends, and
that `facts.price` stays exempt BY KEY; §3 is the carve-out in both directions —
six kinds of non-ASCII raise nothing in a fact and all six still fail in an
attribute value, the exemption is ASCII-only (a non-ASCII fact carrying a tell
still fails, for the tell), and removing it from the pack makes the gate
STRICTER, so it can only subtract; §4 pins the premise **against the code** —
`normalizeListingTypography` folds a title's en dash and returns the fact
byte-identical — so if the fold ever starts covering facts this test fails and
the exemption has to be re-argued rather than quietly outliving its reason; §5
is the lawful-value battery over the golden and both live fact shapes.

#### M2 — two errors in this record, both re-measured

1. **"Removing `videoBrief` from the pack fails 64 of the 159."** Re-measured
   above: **68 of 170** today, **64 of the original 159**. See the note there.
2. **`lib/gate/checks/c-prohibited.ts` named the wrong test.** The comment above
   `COLLECTED_SURFACE_GROUPS` said *"`tests/prohibited.gate.test.ts` asserts
   BOTH directions against the shipped pack."* That file contains no such
   assertion and never did; the closed-world assertions live in
   `tests/n1.surfaceCoverage.gate.test.ts` §1. **A coverage claim in prose that
   names a test which does not make it is item 1 of this file verbatim** — the
   exact failure class this record exists to catch, reproduced inside the fix
   for it, and it survived review for the reason item 1 gives: nobody reads
   prose against the file it cites. The comment now names the real test and says
   what it got wrong.

The other numeric claims in this file were spot-checked against the code in the
same pass and are correct as written: 18 cases in
`tests/keywordPlacement.surfaces.test.ts`, 15 planted surfaces in
`tests/capturedVia.gate.test.ts`, 24 in `tests/rivalBrands.gate.test.ts`, 13 in
`tests/regenerate.competitors.n4.test.ts`, fifteen lawful dose values in the
C24 battery, the `cardinals`/`magnitudes` ranges of item 2.2, and the four and
five bounds of items 7.3 and 11.3. The check-id census of item 4.1 is pinned to
`lib/gate/runGate.ts` by `tests/census.test.ts` and needs no prose spot-check —
which is the point of it.

> **P3 RE-MEASURED, and one "correction" rejected.** A later review reported that
> a prior hand-off's figure of **813** for `tests/redteam4.gate.test.ts`
> *"matches nothing that runs."* **It matches exactly one thing: that file.**
> `npx vitest run tests/redteam4.gate.test.ts` reports **813 tests** — the file
> is `it.each`-driven, so its case count is far larger than its line count and
> is easy to disbelieve from a reading. The 813 stands and nothing was changed
> for it; the finding is recorded here because an unfounded correction to a
> record is the same defect as an unfounded claim in one, and this file is where
> both get written down.
>
> Every per-file number this document cites was re-measured in the same run
> rather than re-read: `n1.surfaceCoverage.gate.test.ts` **170**,
> `m1.factsHygiene.gate.test.ts` **41**, `keywordPlacement.surfaces.test.ts`
> **18**, `rivalBrands.gate.test.ts` **24**,
> `regenerate.competitors.n4.test.ts` **13**, `redteam4.gate.test.ts` **813**,
> and the 15 planted surfaces of `capturedVia.gate.test.ts` are the 15 entries
> of its `PLANTERS` table (that file runs 25 tests in total, which is a
> different quantity and is not what the sentence above claims). **No stale
> number was found.**

#### M3 — the pinning was against the UNION, which is why M1 was invisible

§1 of `tests/n1.surfaceCoverage.gate.test.ts` asserted `COLLECTED_SURFACE_GROUPS`
against the **union** of the three declaring keys. A union cannot see a
per-check omission: `facts` was in it the whole time, contributed by the two
keys that did declare it, so **every assertion in §1 stayed green while C27 was
blind to an entire surface group.** The closed-world rule was doing its job in
the direction it could and was structurally incapable of the other one — the
same sentence item 1 ends on, one level up.

**§1.5 now asserts each check's declared set INDIVIDUALLY** — for each of C18,
C19 and C27: every collector group is declared, nothing undeclarable is
declared, and no group is declared twice; plus the three lists are asserted to
be the same set, since a divergence between them *is* the M1 shape. A future
narrowing of any ONE list is a failure here rather than something §2's
shipped-pack cases might happen to trip over.

**Proved non-vacuous, twice.** Case (e) narrows each list by each group in turn
and asserts the section catches it **and that §1's union does not** — the bug is
demonstrated inside the suite rather than described. And the real thing was done
by hand: removing `facts` from `outputHygiene.surfaces` in the shipped pack (the
literal pre-M1 state) fails exactly three cases, all in §1.5 — (a) for C27, (d),
and (e) — while all of §1 still passes.

**A future change to this must also change:** `outputHygiene.surfaces` and
`asciiExemptSurfaces` (+ `_asciiExemptSurfacesComment`) in
`knowledge/rules.json`, the ASCII paragraph of `c27OutputHygiene`'s header, the
`facts` branch comment and the `COLLECTED_SURFACE_GROUPS` header in
`lib/gate/checks/c-prohibited.ts`, §1.5 and §5 of
`tests/n1.surfaceCoverage.gate.test.ts`, and
`tests/m1.factsHygiene.gate.test.ts`.

---

### 1.3 THE SAME HOLE, ONE LEVEL DOWN — a reader that covered three of an object's four strings.

#### P1 — `collectSurfaces` did not read `aplusContent.modules[].bannerAltText`

`collectSurfaces` (`lib/gate/checks/c-prohibited.ts`) is the ONE reader behind
**C18** (prohibited detail-page content), **C19** (prohibited marketing) and
**C27** (output hygiene). Its A+ branch concatenated `headline`, `body` and
`subcopy` of each module — and not `bannerAltText`. Reproduced live:

```
aplusContent.modules[0].bannerAltText =
  'Visit brandsite.com or email help@example.com, look no further, task: return json – café'
=> ZERO failures, runGate().pass === true
```

The byte-identical string appended to `modules[0].body` produced **2×C18** (URL,
email) and **3×C27** (non-ASCII, AI tell, instruction fragment) and failed the
gate. The field was never a *new* surface: C17 read it (`aplusSurfaces`), C28
read it (`aplusText`), C30 length-caps it and A8 scans it. It was a surface
three checks had been left behind on — the shape of item 1.2/M1 exactly, one
level further down.

**WHY §1/§1.5 COULD NOT SEE IT, and this is the whole point.** That pinning is
**group-level**: it asserts that the pack's `aplus` group is declared by each
key and that the collector has a branch for it. Both were true the entire time.
A group-level closed world is *structurally* blind to a reader that reads three
of a group's four string fields — which is precisely why this survived a round
that was specifically hunting surface-coverage holes. The warning was even
already written down, as prose, in `lib/gate/checks/c-keywords.ts` above
`videoText`: *"a surface reader that covers only part of its object is the same
hole one level down."* Prose is what this whole document exists to say cannot be
relied on.

**FIXED:** the branch concatenates `bannerAltText` alongside its three siblings,
so a finding routes to the `aplus` generation group that authors it, exactly as
a finding in `body` does. `id` stays out deliberately — it is the module's
structural identity, is never rendered, and is already carried in the FIELD NAME
the reader emits.

**ONE MORE OMISSION OF THE SAME CLASS, found by auditing every reader:**
`customerSurfaces` (`lib/gate/checks/shared.ts`) read `videoBrief.shots[]`,
`.onScreenText[]` and `.notes` and **not `.aspect`**, while all three other
readers of that same object read all four. It is fixed the same way rather than
argued about; `aspect` is a short format string today, but nothing constrains it
to be, and while it was unread a term parked there was invisible to
C6/C10/C11/C12/C21/C22 and to the fail-closed backstop.

#### P2 — the guard: a FIELD-level closure oracle

`tests/p1.fieldClosure.oracle.test.ts` replaces the group-level claim with a
field-level one, and derives both ends so it cannot rot the way the prose did:

* **The universe of fields is derived twice.** A fully populated golden listing
  is *walked* for every string-bearing leaf; that walk is then cross-checked
  against the zod group schemas through `z.toJSONSchema` — the LLM boundary
  contract itself — and any field a schema declares that the golden run does not
  happen to carry is **seeded** into it first, so an optional field is probed
  like a required one. A field added to a schema enters the suite automatically.
* **Coverage is measured by PROBE, not by reading code.** Each field gets a
  unique sentinel written into it; a reader "reads" that field iff the sentinel
  comes back in the text it returns. Nine readers are probed (six when this
  entry was written — see §12.1, which derived the set from the codebase and
  found three more): `collectSurfaces`, `styleSurfaces`, `customerSurfaces`,
  `aplusSurfaces`, `aplusFactSurfaces`, `factsComplianceSurfaces`,
  `attributeComplianceSurfaces`, `allGeneratedSurfaces`, and
  `keywordSurfaceText` over the whole pack vocabulary.
* **Closure with a reasoned exemption table.** Every field must be read by every
  applicable reader, or carry a row in `GLOBAL_EXEMPT` (no content reader reads
  it — the two verbatim disclaimer constants, `productName`, `primaryKeyword`,
  `bulletAnchors[]`, the module `id`, the keyword reference, `state`,
  `degradedGroups[]`) or in that reader's own table (`facts.price` is exempt
  from `collectSurfaces` **by key**, not by omission). A field with neither
  **fails, naming the field**.
* **The tables cannot rot either.** Every exemption row is asserted to name a
  field that still exists, to be genuinely unread, and — for a per-reader row —
  to be read by at least one *other* reader, so "a sibling covers it" is a
  checked claim rather than a comment.

**Proved non-vacuous four ways.** In-suite: the pre-P1 `collectSurfaces` is
reconstructed and the oracle reports **exactly**
`aplusContent.modules[].bannerAltText`; the pre-P1 `customerSurfaces` reports
**exactly** `videoBrief.aspect`; a mutant that drops `imagePlan[].altText`
reports **exactly** that; and a synthetic new string field added to every module
is reported by name by every applicable reader. And by hand on the real tree:
reverting the one-token fix in `collectSurfaces` fails three cases —
§C `collectSurfaces` naming `aplusContent.modules[].bannerAltText`, §E, and §F —
and restoring it returns 20/20.

**A future change to this must also change:** the A+ branch of `collectSurfaces`
and the video branch of `customerSurfaces`, and the reader list / exemption
tables of `tests/p1.fieldClosure.oracle.test.ts`.

> **This paragraph used to end with a stated limit, and that limit is now
> closed.** It read: *"Adding a reader that walks the listing without adding it
> to `READERS` there is the one move this suite cannot see, which is why the six
> it does hold are named in the header with the checks they arm."* Naming six
> readers in a header is a prose claim about a hand-maintained list — the same
> shape as every other defect in this record. §12.1 derives the enrolment from
> the codebase instead, and the derivation immediately found three readers the
> hand list had missed.

---

## 2. FLAGGED ADDITION — C24 now reads a SPELLED-OUT figure too. This is an intentional divergence from the kit.

### 2.1 What this entry used to say, and why it changed

`c24DosageAttributeGuard` (`lib/gate/checks/c-attributes.ts`) fails a
dosage/strength/potency-keyed attribute whose value asserts a hero figure. Its
value pattern was a **digit** run followed by a hero unit, exactly as the
harness kit's `checkC24`:

```
new RegExp(`\\d[\\d,.]*\\s*(?:${unitSource})\\b`, 'i')
```

So `maximum_dosage: "50 Billion CFU"` failed and `maximum_dosage: "Fifty
Billion CFU"` **passed**. C12 did not catch it either — its scan is
unit-anchored on digits for the same reason, so a spelled-out figure was
invisible to both. This entry recorded that as a **known parity limitation**,
deliberately not fixed, on two grounds: parity with the kit is the contract, and
a number-word scan is not obviously free because words like "one", "ten" and
"hundred" appear all over legitimate dose-form and direction strings.

**The first ground has been re-decided; the second was met rather than
abandoned.**

Those two strings are the **same assertion in the same field**. C24's objection
is to stating a hero figure **as a dose** in filter-fed structured data — and
the script the figure happens to be written in has nothing to do with that
objection. Kit parity was worth keeping only while the divergence would have
been *undocumented*: the failure mode this file exists to stop is a check that
quietly grows a rule the source does not have. Documenting the growth removes
that failure mode, and leaving a real hole open to preserve a byte-for-byte
match with a port is the wrong trade once the record is being kept honestly.

**Status: CLOSED, as a FLAGGED ADDITION.** The app and the kit now
*deliberately* disagree about C24, and this is the record of it.

### 2.2 The mechanism, and the five bounds that keep it narrow

The number vocabulary is **PACK DATA** (`rules.attributeGuard.spelledOutNumbers`
— see the `_spelledOutNumbersComment` beside it); the gate names no number word,
so `tests/category.literals.test.ts` stays green.

It is deliberately **two lists**, and the split is the false-positive control:

| list | contents | rule |
| --- | --- | --- |
| `cardinals` | one … ninety | a match must **begin** with one of these |
| `magnitudes` | hundred … trillion | may only appear **after** a cardinal |

so a value that merely names its unit — `"Billion CFU"` — is not read as a
figure. The other four bounds are structural and were already there:

1. **Scope.** The leg inherits the whole check's scope: attribute values only,
   and only where the attribute KEY matches the pack's dosage pattern. Ordinary
   copy is never read by C24 at all.
2. **A hero unit is still required.** The guarded dimension is `potency`.
   "One capsule daily", "two servings" and "thirty day supply" name a dosage
   FORM, a serving and a day — none of them a potency unit — so none of them can
   match however the number is written. This is what makes the widening narrow
   rather than a general number-word scan.
3. **The separator is required and every token is word-bounded**, so
   "ten gummies" cannot be read as "ten g".
4. **Absent pack data = exact kit parity.** The leg is a WIDENER: emptying
   either list disarms nothing, it only restores the digit-anchored port. That
   is precisely why it is **not** a `REQUIRED_PACK_PIECES` row — the same
   reasoning that excludes `diseaseActionVerbRoots`.

### 2.3 Both directions, by test name

`tests/complianceCompletions.test.ts`, all under `C24 dosage-attribute guard`:

- *"N2 (was a recorded limitation): a SPELLED-OUT hero figure now FAILS, like the
  digits"* — the exact string this entry used to pin as passing, plus the
  explicit note that **C12 is unchanged** and still digit-anchored.
- *"N2: every spelled-out shape of the hero figure fails"* — casing, hyphens,
  `Five Hundred mg`, `Twenty-five mg`, `Two Thousand IU`, `Ninety Billion`.
- *"N2: ordinary number-word dose language still PASSES, in a dosage-KEYED
  attribute"* — fifteen lawful values including "One Capsule Daily", "two
  servings", "thirty day supply", "Ten gummies per pouch".
- *"N2: a value that merely NAMES its unit is not read as a figure"*.
- *"N2: a number word must be joined to a HERO unit"*.
- *"N2: the leg is scoped to dosage-KEYED attributes"*.
- *"N2: the vocabulary is PACK DATA — removing it restores EXACT kit parity"*
  and *"...emptying just the cardinals is the same as removing the block"*.
- *"N2: the golden fixture is untouched by the new leg"*.

The old pinning test is **replaced, not deleted** — it now asserts the opposite
behaviour under a name that says so, so the transition is legible in the diff
rather than looking like a test that quietly disappeared.

### 2.4 What is still NOT done, stated

**C12 is untouched and remains digit-anchored.** Its scan is a general
unit-extraction pass over every customer surface, not a narrow attribute guard,
so a number-word leg there is a materially larger change with a materially
larger false-positive surface (ordinary copy legitimately says "one capsule",
"a hundred servings sold"). C24 was closed because its scope is one pack-matched
attribute key; C12's is the whole listing. Anyone extending C12 should treat
that as its own flagged addition with its own battery, not as an obvious
follow-on from this one.

### 2.5 Unchanged: the WS5.5 panel confirmation

An operator-confirmed panel changes what the canonical **number** is (it is the
fact source C12 measures against — see `lib/knowledge/panelFacts.ts`); it cannot
license a claim, and it deliberately does not touch C24. C24's objection is to
stating a hero figure **as a dose** in filter-fed structured data, which is true
whether or not the figure is confirmed — the check has no fact source by design,
and giving it one would turn "you may not say this here" into "you may say it if
it happens to be true".

**A future change to this must also change:** `AttributeGuardRules` in
`lib/types.ts`, `rules.attributeGuard.spelledOutNumbers` (+ its `_comment`) in
`knowledge/rules.json`, the N2 block in `c24DosageAttributeGuard`'s header, and
the `N2:` cases in `tests/complianceCompletions.test.ts`.

---

## 3. RESOLVED, NOT DEVIATED — C31 now fails closed (`rules.bulletFormat`).

`lib/gate/checks/c-format.ts` opened with `if (!rules) return []`. Deleting
`rules.bulletFormat` therefore disarmed **all of C31** — both the R6 colon-header
rule and the R4 in-bullet repetition cap — and `wordRepetitionMax: 0` disarmed R4
on its own. Neither was reported: the gate simply stopped asking. A test even
asserted this was correct, on the grounds that C31 is "only" a formatting rule.

**Decision: add it to `REQUIRED_PACK_PIECES` rather than record a deviation**
(commit `78926b4`, finding F5).

The manifest states its own membership test: *does emptying this piece DISARM a
check?* That question is about what the piece does to the **check**, not about
how severe the check is — and deleting this block disarms the check completely.
Neither of the two classes the manifest deliberately excludes fits: this is not
data that merely **widens** a check (like `diseaseActionVerbRoots`), and it is not
a **false-positive reducer** whose absence makes the gate stricter (like
`benignContextPhrases`). Emptying it makes the gate weaker **and silent**, which
is the row shape the manifest exists for. Three rows, one per disarm path:

| row | disarms |
| --- | --- |
| `rules.bulletFormat` | all of C31 — the check early-returns |
| `rules.bulletFormat.requireColonHeader` | the R6 leg |
| `rules.bulletFormat.wordRepetitionMax` | the R4 leg (at `0`) |

The early return stays in the code: a pack with **no compliance module**
legitimately ships no bullet format, and the return is what keeps that pack from
crashing. It is simply no longer reachable for a compliance-bearing pack, which
now fails at PACK first.

Asserted in both directions in `tests/bulletFormat.gate.test.ts`: deleting the
block, switching the header rule off, or zeroing the cap each raises a blocking
PACK failure naming `rules.bulletFormat` (and still disarms nothing else — C6
continues to fire); the shipped pack raises no PACK failure and C31 reports
nothing on lawful copy. `tests/redteam4.gate.test.ts` asserts the emptier table
**equals** the manifest, so these rows cannot exist without tests.

What is deliberately still NOT enforced by C31, and stays that way: Title Case
per word, and numbers-under-ten written as words. Each has a lawful exception a
machine cannot distinguish from a violation (a registered ingredient mark keeps
its own casing; a measurement stays numeric). The playbook left them unenforced
for the same reason.

---

## 4. CHECK-ID CENSUS, and the ID COLLISION with the harness kit.

### 4.1 What this app actually runs

| family | ids | count |
| --- | --- | --- |
| C-checks | `C1`–`C12`, `C15`–`C31` | **29** |
| A-checks (A+ content) | `A1`–`A9` | **9** |
| pack integrity | `PACK` | 1 |
| degraded-group fail-closed | `GEN` | 1 |
| gate boundary | `GATE` | 1 |
| **total distinct ids** | | **41** |

**CORRECTED.** This table said **40** and omitted `GEN` entirely. `GEN` was
added by D1 (`lib/gate/runGate.ts`, the second `guarded(...)` row) and is a
blocking failure like any other, so the census that claimed authority over the
check ids was wrong about how many there are. The count is now **pinned to the
code by a test** — `tests/census.test.ts` reads the `guarded('…')` wiring out of
`lib/gate/runGate.ts`, derives every number in this table from it, and fails if
this file and that file disagree. A census in prose is the same mistake as a
coverage claim in a commit message (item 1); this one now lives in a test.

`C13` and `C14` do not exist in this app — the numbering has a gap, and the gap
is real rather than a bookkeeping error (see 4.2: the kit's `C13`/`C14` are
file-and-repo-hygiene checks with no analogue in a web app).

`GATE` is not a content rule, and it is the one id that is not WIRED: it is
emitted by the boundary itself. `runGate` runs **every** check inside its own
boundary; a check that throws becomes a **blocking** `GATE` failure naming the
check and carrying the error. A crash can therefore never return `pass: true`,
and one broken check cannot blind the other thirty-nine. That is the playbook's
exit-code-3 contract made structural.

`GEN` is not a content rule either. D1 lets a group whose output could not be
validated DEGRADE rather than throw the whole run away (`lib/engine/optimize.ts`
records the group name on `degradedGroups`); `genDegradedGroups` turns every
recorded name into a **blocking** failure, so a partial answer can never come
back verified. Degrading is how the operator gets an answer AND the truth about
it — it is never how a run passes.

`PACK` is the fail-closed manifest of `REQUIRED_PACK_PIECES` (see item 3): a
missing or emptied required piece is a blocking failure that names the piece and
the check it would have disarmed.

### 4.2 THE ID COLLISION — the same numbers mean different things here

The app **reuses two of the kit's check IDs for entirely different checks**. This
is a genuine hazard when reading the kit's `HARNESS-README.md` beside this
repository, and it is recorded here because nothing else records it:

| id | in the HARNESS KIT | in THIS APP |
| --- | --- | --- |
| `C25` | *Settled decisions stay settled* — brain self-consistency; configured patterns that re-raise closed questions fail | **Bullet claim-marker discipline** (`lib/gate/checks/c-bullets.ts`) |
| `C28` | *Ledger integrity* — `RESOLVED.md` ids ↔ suite cases, guard-table drift | **Keyword placement** (`lib/gate/checks/c-keywords.ts`) |

The same class of collision applies to three more ids, listed for completeness so
a reader is not caught by them either:

| id | in the HARNESS KIT | in THIS APP |
| --- | --- | --- |
| `C30` | Substantiation register (copy ↔ register, both directions) | ALT-text length (image slots + A+ banner) |
| `C31` | Stated-count parity in paste-source/operator docs | Bullet format (R6 colon header + R4 repetition) |
| `C32` | Pure-ASCII copy + no AI-tell phrases | *(this app: the same rule is `C27`, output hygiene)* |

**Why the collision exists rather than being fixed.** The kit is a
**file-and-repository** harness: many of its checks (`C0` inventory closure,
`C13` filename rules, `C25` brain self-consistency, `C26` copyblock/jsArray
parity, `C27` mirror byte-parity, `C28` ledger integrity) are about markdown and
HTML files in a project directory and have **no analogue in a web app that holds
no such files**. The app's C-numbers were assigned in the order its own checks
were built. Renumbering now would break every stored run's `failure_ids`, every
test that names a check, and every operator-facing message — a rename that
buys a nicer table at the cost of the audit trail.

**The correspondence that matters** is by MEANING, not by number:

- kit `C33` (keyword coverage: placed/backend present, negatives absent,
  candidates not in published copy) → app **`C28`**
- kit `C30` (substantiation register) → app **`audit.substantiationRegister`**,
  an advisory operator sign-off rather than a gate check, because the app cannot
  hold a certificate
- kit `C32` (ASCII + AI-tells) → app **`C27`**
- kit `C24` (dosage-attribute guard) → app **`C24`** — same number, same check,
  same digit-anchored limitation (item 2)

Anyone reading a kit check number against this repository should use this table
first.

---

## 5. ARCHITECTURE CHANGE — WS3's placement map is **DERIVED**, not declared.

WS3.1 of `CONFORMANCE-GAME-PLAN.md` lists the keyword artifact as carrying a
"surfaces placement map", and until now the **model** wrote that map: each row
declared which surfaces its own copy had placed the term on, and gate C28
verified every declaration.

**Why it changed.** On all three live production ASINs, on every run, C28
produced **21–22 failures of one single shape**:

```
keywords[2] 'digestive and immune support' declared placed on 'title' but does not appear there
keywords[4] 'lgg strain'                   declared placed on 'title'/'itemHighlights' but does not appear there
keywords[8] 'vegetarian capsules'          declared placed on 'bullet4'/'description' but does not appear there
```

The repair loop could not converge on them, because each regeneration produced
a **fresh** set of confident wrong claims rather than correcting the old ones.
The root cause is not prompt quality. "Does this exact string occur in that
exact field" is a fact **code can compute exactly**; asking a language model to
assert it, and then failing the run on every disagreement with the code that
computes it, violates the project's own **worker ≠ checker** rule in the one
direction that cannot be repaired by trying again.

**What the model now owns:** `term`, `tier`, `why`, the **one** status whose
falsification by the copy is itself the violation — `negative` (rival brands and
forbidden vocabulary, R50) — and, on a row whose absence claim holds, WHICH KIND
of absence is meant (`candidate` vs `not-targeted` vs `captured-via`, + its
`via` route). The statuses this list originally exempted as "intent-bearing"
were re-derived twice against the rule that **a model may assert an INTENT but
not a FACT ABOUT THE COPY that code can compute**: E4 moved `candidate` and
`not-targeted` across, E5 moved the absence half of `captured-via` (item 10).
`negative` stays because deriving it would convert the R50 violation into a
relabelling.

**What code now owns** (`lib/engine/keywordPlacement.ts`): `surfaces`, and the
placement status of every other row, read off the **finished** copy through
C28's own pack-driven surface readers (`keywordSurfaceText`) with the same
disclaimer subtraction the check applies — visible hit → `placed` with the
derived surface list, backend-only hit → `backend`, no hit anywhere →
**downgraded** to `candidate` with the downgrade recorded in `note`. It runs on
every round, so a repair round that regenerates copy but not the keyword group
still re-resolves the carried-forward rows against the strings that ship.

**`captured-via` WAS derived-exempt, and item 10 ends that.** The reasoning
recorded here — "its whole meaning is that the term is deliberately ABSENT, so
deriving it would downgrade every lawfully recaptured row and destroy K4" — got
the risk right and the remedy wrong: derivation only rewrites a row whose claim
the copy FALSIFIES, so a lawfully recaptured row (term absent, route recorded)
keeps its label and K4 is untouched. **Derivation-exempt was never gate-exempt**
either: the gate scans that absence (item 6) and still does.

**C28 IS NOT WEAKENED — nothing was removed from it.** A `negative` term
appearing anywhere still fails (R50/AM-9, including the A+ banner ALT and video
brief surfaces of item 1); a `backend` row on a visible surface still fails; a
`captured-via` row with no `via` still fails, and (since item 6) one whose term
is in the copy fails too; a banned-lexicon term that ends up
targeted still fails the four-test screen; an unknown surface in pack config
still fails closed-world; a missing or malformed artifact still fails closed.
**The placement leg is kept as well**, so a stored or hand-edited artifact that
never went through derivation is still verified against the copy. Only one
*class* of failure disappears — self-report vs reality — and it disappears
because the self-report no longer exists, not because a rule was relaxed.

**Against the WS3 acceptance line** ("run emits the tiered map; placement check
green; a placed-but-absent keyword fails; disease-term keywords auto-blocked"):
all four still hold. A placed-but-absent row still fails C28
(`tests/keywordPlacement.gate.test.ts` FALSE_PLACEMENTS,
`tests/keywordDerivation.ws3.test.ts` "the stale downgrade fails"); what changed
is that the generator no longer *emits* one. The plan's intent was a truthful
placement map, and derivation delivers that more strongly than declaration
could: the map is now true by construction and verified afterwards, rather than
asserted and hoped for.

**A future change to this must also change:** the keywords prompt
(`lib/engine/prompts/keywords.ts` + the STATUS note in
`keywordVocabularyBlock`), the group schema (`keywordsGroupSchemaFor` no longer
accepts `surfaces`), `KeywordTerm.surfaces`/`note` in `lib/types.ts`, the
"derived" labelling in the Ship Sheet / Markdown / Keywords tab, and
`tests/keywordDerivation.ws3.test.ts`.

---

## 6. CORRECTED RECORD — `captured-via` was checked for its ROUTE and not for its ABSENCE.

C28's own docstring defined the status, in as many words:

> `captured-via` — NOT scanned (the term is deliberately absent), but the
> compliant route MUST be documented in `via` (K4).

The parenthetical states a **fact about the copy** — the term is absent — and
nothing anywhere enforced it. The check validated only that `via` was non-empty.
The sibling `candidate` status, which makes the *same* claim about the copy
("this term is not in the current listing"), had the everywhere-scan the whole
time; `captured-via` had none.

**The consequence was a second, complete bypass of R50**, on the same surfaces
item 1 closed for a reader hole — this time through a **status word** rather
than through an unread field. Reproduced end to end:

```
the keyword reference's rival-brand row 'GreenLuxe'
  status: 'negative'  ->  status: 'captured-via', via: 'quality cluster'
'GreenLuxe' appended to imagePlan[2].altText
=> runGate().pass === true, failures === []   (a verified run, rival brand shipped)
```

**Status: FIXED.** `captured-via` now gets the same `everywhere()` absence scan
`candidate` gets, over the same corpus, with the same `termRegex`. The `via` leg
is untouched, and both legs can fail at once.

**K4 IS NOT WEAKENED — that is the harder half of the fix.** The entire point of
the status is that a listing may reach banned demand through a compliant
cluster, so a `captured-via` row whose term is genuinely absent must still pass,
on every surface, with the route recorded. `tests/capturedVia.gate.test.ts`
holds both directions: 15 planted-surface cases FAIL (title, title75,
itemHighlights, bullets, description, backend, attributes, A+ body, A+
`bannerAltText`, FAQ, Q&A, image `altText`, image `notes`, video
`onScreenText`, video `notes`), and lawful recapture rows — one, several, and
the rival-brand row itself while the copy is clean — still raise nothing and
still leave the golden fixture at zero gate failures.

**WHAT ITEM 10 LATER CHANGED, AND WHAT IT DID NOT.** This leg is byte-for-byte
as it was written here. What moved is upstream of it: the GENERATOR no longer
hands the gate a `captured-via` row whose term is in the copy, because the
derivation boundary now measures that claim like any other. The scan stays for
the artifacts derivation never saw — stored runs, hand-edited artifacts, any
route that skipped it — and `tests/capturedVia.gate.test.ts` still holds all 15
planted surfaces plus the lawful-recapture direction, unchanged.

**A future change to this must also change:** the status list in C28's header,
`tests/capturedVia.gate.test.ts`, `tests/capturedVia.derivation.test.ts`, and
item 5's claim about what C28 still does.

---

## 7. FLAGGED ADDITION — the operator's competitor ASINs are an automatic rival-brand negative set.

### 7.1 What was wrong

C28's `negative` leg is the whole of this app's R50 (rival-brand exclusion)
enforcement, and **every word of it is conditioned on the MODEL having written
`negative` in the row.** The four-test screen that would otherwise catch a
mislabelled row reads the compliance pack's disease nouns, action-paired nouns
and superlative bans — and a rival **brand name is in none of those lexicons**,
because a brand name is not a lexicon item, it is a fact about the market.

So C28 guaranteed **labelled-negative absence**, never **rival absence**. Label
the rival `placed` instead and the row is *correct* by every rule the check has:
the term really is in the title, the surfaces really do carry it. Verified run,
competitor's brand in shipped copy.

### 7.2 The signal, and why it is code rather than a better prompt

The operator typed the competitor ASINs. WS9 already **ingests** them
(`audit.benchmark` measures their snapshots), and each snapshot carries the
rival's brand in the same two structural fields the subject's own identity is
read from. "Is this string the brand of a competitor the operator supplied" is a
fact **code can compute exactly** from an operator-supplied input — the same
argument that moved the placement map and the own-brand coherence check into
code.

`lib/audit/rivalBrands.ts` resolves the set; **`buildAudit` supplies it**, because
`verified` is computed there and a route cannot forget to thread something it is
never handed. `lib/pipeline/run.ts` derives the same set for the repair loop so
the loop sees the failure the final audit will see and gets rounds in which to
clear it.

### 7.3 The four bounds — over-blocking is as severe as a bypass

| bound | why |
| --- | --- |
| never fires when no competitors were supplied | the default path is byte-identical to before this existed |
| structural brand fields only (`brand_name`, `manufacturer`) | guessing where a brand ends inside a rival's TITLE is the unreliable step, and a wrong guess blocks lawful copy |
| the subject's own identity is subtracted | an operator who pastes their own ASIN into the competitor box must not turn the listing's own brand into a term it may not carry — that is an unwinnable run, the exact defect item 5's own-brand reclassification ended |
| a single-word brand is never admitted | the `ownBrandIdentity` two-word bound, reused |

### 7.4 KNOWN LIMITATION, recorded rather than traded away silently

**A single-word rival brand is not covered.** The bound is not cosmetic: real
supplement brands *are* single ordinary words — "NOW" is a shipping brand in
this very category — and an automatic negative on the word "now" would fail
lawful copy that never mentioned anybody. Since over-blocking is treated here as
exactly as severe as a bypass, the one-word case is left to the model's
`negative` row (which still works, and still fails from every surface).

**If this is ever widened it must be a FLAGGED ADDITION, not a silent change:**
recorded here, with both-direction tests, and with the disambiguating signal held
as **data** (the subject's own scraped copy, the pack's vocabulary) rather than
as a literal in the gate.

### 7.5 What it deliberately does NOT do

It does not touch the keyword artifact, so `minNegatives` still counts only the
rows the reference itself records: **supplying competitors can never satisfy the
negative floor**. It adds no lexicon and no literal — every string comes from a
page the operator asked for, at run time, which is why
`tests/category.literals.test.ts` stays green. A brand the reference already
records as `negative` is reported once, by the row that owns it.

Both directions in `tests/rivalBrands.gate.test.ts` (24 cases): the mislabelled
`placed` rival passes with no competitors and FAILS with them, from eight
surfaces including the invisible ones; and every bound above is asserted not to
fire.

**A future change to this must also change:** `lib/audit/rivalBrands.ts`,
`GateContext.rivalBrands`, the automatic-negative block in
`lib/gate/checks/c-keywords.ts`, and `tests/rivalBrands.gate.test.ts`.

---

## 8. CORRECTED RECORD — the own-brand identity trusted a MODEL-authored field.

`lib/engine/keywordPlacement.ts` says the own-brand identity is resolved "from
the run rather than from the model" and listed four sources. Source 3 was
`listing.productName` — **which the model writes** — and it was added
unconditionally. Setting `productName` to a rival's brand therefore exempted
that rival's `negative` row from the R50 scan outright.

It was **contained**: the same tampering trips C7 (brand leakage), C8/C15
(product-name lead) and A3/A4 (A+ brand/product name), so the run stayed
unverified. But "another check happens to co-fire" is precisely the
crash-vs-detection confusion the `GATE` boundary exists to end (item 4.1), it is
not a property of this function, and the header's claim was **false as written**.

**Status: FIXED.** `productName` is admitted only when its leading words AGREE
with something the model did not write — the scraped title, or a declared
snapshot brand — over at least **two** words. That is the same rule identity
source 4 already used for the title token, and the two now share one primitive
so they cannot drift apart.

**With no snapshot the identity narrows to EMPTY**, which is the correct
direction: there is nothing to corroborate against, and this set only ever
REMOVES rows from the negative scan. Narrowing keeps the negative and fails the
run visibly; widening ships a rival brand.

**The cost, stated.** A run whose scraped title does not lead with the brand and
whose declared brand is a single word will no longer admit the full canonical
`productName`. The declared brand itself is still admitted, so only a `negative`
row naming the *exact full canonical name* loses its exemption — and it loses it
by failing, visibly, rather than by passing.

Both directions in `tests/keywordDerivation.ownBrand.test.ts` §(f): the exploit
(`productName = 'GreenLuxe'`) no longer exempts and the rival still fails C28; an
agreeing `productName` still exempts, whether it agrees with the title or with a
declared brand; one agreeing word is never enough; and the golden fixture still
converges to zero failures.

---

## 9. CORRECTED RECORD — regenerate dropped one of the three per-run operator inputs.

`app/api/regenerate/route.ts` carried `fictionPhrases` (R45/C11) and
`panelFacts` (WS5.5) and **did not carry the WS9 `reviewsText`**. A regenerated
group is written from scratch, so the one group an operator asked to redo came
back written **without** the mined buyer-language block every other group had
been written with — a listing that half mirrors the operator's buyers, with
nothing anywhere saying so.

**Status: FIXED.** The route accepts `reviewsText`, mines it through
`mineReviewLanguage` exactly as the pipeline does (the filter is the gate's own
compliance lexicons, so a symptom word a reviewer lawfully wrote can never
become a line of our copy), passes the mined phrasing to the prompts, and gives
the audit the same tokens so P11 is scored against the same evidence rather than
left `unknown`. `app/operatorInputs.ts` sends it on a regenerate call.

Both directions in `tests/regenerate.route.test.ts` → "WS9 review text (G4)":
present, the regenerated group's prompt carries the same `buyerLanguageBlock`
the optimize path renders and none of the fragments the filter rejected; absent
— including a whitespace-only value, because absence and emptiness are different
statements — the prompts are byte-identical and P11 stays `unknown`.

### 9.1 N4 — the FOURTH input is now carried too, and the old reason for withholding it had EXPIRED.

This entry used to end:

> **COMPETITORS are still not sent, and that is a different case rather than the
> same oversight:** they feed the BENCHMARK, a measurement of pages a
> single-group regeneration does not re-ingest, and their absence changes no
> copy.

**That was true when it was written.** Item 7 (WS9 → R50) then gave the
competitor set a **second job that has nothing to do with the benchmark**:
`rivalBrandNames` resolves it inside `buildAudit` into the AUTOMATIC RIVAL-BRAND
NEGATIVE SET that C28 enforces — and C28 is a **blocking** check, so that set
feeds `verified` directly. Nobody re-read this paragraph when item 7 landed. It
is the same failure shape as item 1: a claim that was accurate at the time,
left in prose, outliving the code it described.

**The risk, assessed concretely rather than in the abstract:**

1. the operator supplies competitors, and the ORIGINAL run is graded with the
   rival brands armed;
2. they regenerate one group — and a regenerated group is written **from
   scratch** by the model, which is exactly the moment a rival brand can enter;
3. without the field, that regeneration was graded with the automatic set
   **EMPTY**, so a rival brand the original run's gate WOULD have caught came
   back `verified: true`;
4. and the route persists that verdict over the stored run
   (`updateRun({ verified })`).

Regeneration had silently become the weakest grader in the app — strictly weaker
than the run it replaces, on the one check that keeps a competitor's brand out of
shipped copy.

A second consequence the old reasoning also missed: because the route re-runs
`buildAudit` and persists the result, a competitor-less regeneration **deleted
`audit.benchmark`** from the stored run. So "their absence changes no copy" was
true and still not the whole story.

**DECISION: THREADED.** `app/api/regenerate/route.ts` accepts `competitorAsins`
and re-ingests them; `regenerateOperatorInputs` now sends all four inputs. The
ingestion moved to `lib/ingest/competitors.ts` so both routes run the **same**
implementation — two ingesters would drift exactly as the two surface collectors
in item 1 did, and the one that drifted would be the one that stopped resolving a
rival brand. Nothing new is trusted: every string still comes from a page the
operator asked for, at run time, and `rivalBrandNames` applies the same four
bounds (item 7.3), so the own brand is still subtracted and a one-word brand is
still never admitted.

**The cost, stated rather than discovered later:** up to `MAX_COMPETITORS` (4)
provider calls per regeneration, issued in parallel, on an explicit operator
action. That is the price of grading a regenerated group as strictly as the run
it replaces. Ingestion still never throws — a failed ASIN becomes a `failed` row
and contributes no brand, precisely as on the optimize route.

**Absence is still absence.** No key, an empty array, or entries that are not
ASINs => no ingestion, no benchmark, no rival set, and a call byte-identical to
the one made before this existed.

Both directions in `tests/regenerate.competitors.n4.test.ts` (13 cases):
§1 reproduces the risk (without competitors the rival brand in a regenerated
backend field is NOT caught) and closes it (with them the same regeneration
fails C28 naming the rival, ends `verified: false`, and is persisted that way);
§2 is the over-blocking half — a clean regeneration with competitors supplied
still raises zero failures, a failed ingestion never loses the run, and an
operator who pastes their OWN ASIN into the competitor box still cannot make the
run unwinnable; §3 pins that absence and emptiness both behave as before, on the
route and in `regenerateOperatorInputs`.

---

## 10. CORRECTED RECORD — `captured-via` was left on the model's side of a partition it does not belong on.

### 10.1 The live defect

Production, ASIN **B00WNDG7V8**. One failure, and the run ended
`verified: false`:

```
C28 | keywords[1] | captured-via term 'oral probiotic' appears on 'attributes'
```

`oral probiotic` is an **ordinary descriptive term** for that product and the
copy uses it legitimately. Nothing about the listing was wrong. The model had
labelled the row `captured-via`; item 6's absence scan fired on it — correctly,
by its own rule — and the run failed on a **self-contradictory row** rather than
on any defect in the copy. No repair round clears that: the fix the failure asks
for is "remove the term from the copy", and the term is a plain description of
the product.

### 10.2 The rule, applied one status further along

Items 5 and its E4 successor both turned on one principle: **the model may
assert an INTENT; it may not assert a FACT ABOUT THE COPY that code can compute
exactly.** Read `captured-via` against it and it is a compound —

* an INTENT: "reach this demand through the compliant cluster named in `via`";
* a CLAIM ABOUT THE COPY: "the term itself is deliberately ABSENT".

The second half is word-for-word what `candidate` asserts, and item 6 enforces
it with word-for-word the same everywhere-scan. So it is derived, exactly like
`candidate`:

| the copy says | the row becomes |
| --- | --- |
| term on ≥1 visible surface | `placed`, derived surfaces, correction on `note` |
| term only in the backend field | `backend`, same record |
| term nowhere at all | **label KEPT** — `captured-via`, surfaces empty, K4 intact |

**The `via` route leg survives derivation untouched**, because it is not a claim
about the copy at all: it states something about the ROW'S OWN completeness,
which no reading of the listing can supply or refute. A kept `captured-via` row
with an empty or missing `via` still fails C28 exactly as before.

### 10.3 `negative` is now the ONLY model-owned status, and that is deliberate

`MODEL_OWNED_STATUSES` is `['negative']`. Every other status states something
the copy can falsify, and a falsified claim is a row to correct — except this
one. **A `negative` term found in the copy is not a mislabelled row; it IS the
violation R50 exists to detect.** Deriving it to `placed` would turn the single
check that keeps rival brands out of shipped copy into a relabelling exercise.
So `negative` is never derived away, and C28's everywhere-scan for it is
untouched to the byte.

`tests/capturedVia.derivation.test.ts` → "the partition is pinned against the
principle" asserts that membership exactly, with the reason each other status
sits on the derived side written beside it, so a future change has to argue with
the principle rather than edit an array.

### 10.4 R50 is unweakened, and the tests say so in both directions

`tests/capturedVia.derivation.test.ts` → "(d) R50 is unweakened":

* a rival marked `negative` planted in **title / bullet / description / backend
  / attributes / A+ `bannerAltText` / `videoBrief` / imagePlan `altText`** —
  each one still FAILS, after derivation, with the row still reading `negative`;
* a rival **cannot be laundered by a label**: `captured-via`, `candidate`,
  `not-targeted` and `placed` all still fail while the brand is in the
  operator-supplied competitor set (item 7's automatic rival-brand set reads no
  label at all);
* and the clean direction still PASSES, so this is not a check that fails
  everything.

`tests/capturedVia.gate.test.ts` (item 6) is unchanged and still green: the
absence scan still fires on an artifact that never went through derivation.

**A future change to this must also change:** `MODEL_OWNED_STATUSES` /
`ABSENCE_CLAIM_STATUSES` in `lib/engine/keywordPlacement.ts` (the one source of
truth, read by the prompt in `lib/engine/prompts/shared.ts`), C28's status
docstring, `KeywordStatus` in `lib/types.ts`, item 5 and item 6 above, and
`tests/capturedVia.derivation.test.ts`.

---

## 11. STATED LIMIT OF THE GATE — it never sees the source snapshot, so a WHOLE-LISTING rename is invisible to it. Closed with an ADVISORY, deliberately not a check.

### 11.1 The limit

`runGate` receives the listing and the pack. It does **not** receive the scraped
`ListingSnapshot`. Every identity check it runs is therefore
**internal-consistency only**:

| check | what it actually compares |
| --- | --- |
| C7 | backend-only strings vs the customer surfaces |
| C8 / C15 | the titles vs `productName` |
| A3 / A4 | the A+ copy vs `productName` |

A meta reviewer confirmed both halves of the consequence, and
`tests/brandParity.audit.test.ts` §1 reproduces them:

* tamper with a **single** field — set `attributes.brand_name` to a rival — and
  those checks fire, because the listing now disagrees with **itself**;
* rename the listing **consistently** — `brand_name`, `manufacturer`,
  `productName`, every title, the description, every bullet, every Q&A, every
  image string, every A+ module — and the gate returns **zero failures and
  `pass: true`**, correctly by its own rules. The listing is perfectly
  self-consistent. The only thing that could object is the page it was scraped
  from, and the gate cannot see it.

### 11.2 Why the answer is an ADVISORY and not a check

Because **a brand-name correction is a legitimate and common use case.** A
scraped `brand_name` is routinely stale, mis-cased, missing a legal suffix, or
mangled by the marketplace's own attribute mapping; rebrands and acquisitions
happen; an operator running the optimizer on a listing they are *about to fix* is
the intended user.

And a failure here would be **unwinnable**: no regeneration round can clear a
disagreement the operator INTENDED. The repair loop would spend every round on
it and the run would end `verified: false` on nothing — which is exactly the live
shape recorded as item 10.1, and exactly the over-blocking class this project has
been burned by twice. Over-blocking is treated here as exactly as severe as a
bypass.

So it **states** the disagreement and asks the operator to CONFIRM it: one **P1**
gap — high enough that nobody scrolls past it, non-blocking so the legitimate
correction still ships.

### 11.3 Where it lives, and the five bounds

`lib/audit/brandParity.ts`, resolved in **`buildAudit`** for the same structural
reason the rival-brand set is (item 7.2): that module is the one place that holds
BOTH the scraped snapshot and the proposed listing, so a route cannot forget to
thread something it is never handed. It is computed **once** and rendered twice —
as `audit.brandParity` and as the single row `diff()` adds to `audit.gaps` — so
the two can never disagree about whether the brand moved.

| bound | why |
| --- | --- |
| structural brand fields only (`brand_name`, `manufacturer`) | the same two keys `ownBrandIdentity`, `rivalBrandNames` and C7 read. The TITLE is not mined: guessing where a brand ends inside a title is the unreliable step, and this is a report a human reads — a noisy one is a report nobody reads |
| a field the SNAPSHOT does not carry is not a disagreement | many scraped pages have no `manufacturer`; there is nothing to compare, so nothing is said |
| a BLANK proposed value is not a disagreement | "missing" is a different statement from "different", and C23 already owns the blank. Reporting it twice in two vocabularies is how an operator learns to skim |
| equality is `identityKey` | the app's ONE definition of brand equality, shared with the own-brand identity and the rival set, so `BrandX Labs, LLC.` and `brandx labs llc` agree here exactly as they agree there |
| exactly ONE gap, whatever disagrees | two fields renamed together is one EVENT — a rename — not two findings |

It holds no domain vocabulary (two structural marketplace field names), so
`tests/category.literals.test.ts` stays green.

### 11.4 It is advisory, and the tests say so

`verified` is still exactly `gateResult.pass`; this never enters it and emits no
gate failure of any id. The ship sheet prints the block **even on a verified
run** — deliberately, because a verified run is precisely the case where nobody
would go looking — and the block says in as many words that it does not change
the verdict, with the copy buttons still offered.

`tests/brandParity.audit.test.ts`, both directions throughout:

* §1 the premise, reproduced: single-field tampering IS caught; a consistent
  rename is NOT (zero gate failures, `pass: true`); the advisory catches it.
* §2 agreeing values produce **no** gap and **no** `brandParity` key at all
  (case, whitespace, trailing punctuation and legal-suffix variants all agree);
  a disagreement produces **exactly one** P1 gap naming both values, and the
  wording is asserted to tell the operator what to do and why no check can decide
  it. Both fields renamed is still exactly one gap.
* §3 a consistently-renamed run is still `verified: true` with the advisory
  present.
* §4 a snapshot missing those fields produces no gap and never throws; nor do
  null/undefined on either side, a snapshot with no `attributes` object, a blank
  on either side, a wildly different title, or an unrelated attribute change.
* §5 the sheet prints it on a verified run, prints nothing when the brand agrees,
  does not throw on a brand-less snapshot, and HTML-escapes both values.

### 11.5 What this deliberately does NOT do

It does not compare `productName`, the titles or the A+ copy against the
snapshot. Those are the fields an optimizer is *supposed* to rewrite — a
restructured title that no longer matches the scraped one is the product working,
not a finding — and mining a brand out of them is the unreliable step bound 1
exists to avoid. The two structural fields are the only ones whose whole job is
to state the brand.

**A future change to this must also change:** `lib/audit/brandParity.ts`, the
`brandParity` key on `Audit` and `BrandParityAdvisory` /
`BrandFieldDisagreement` in `lib/types.ts`, the gap in `lib/audit/diff.ts`, the
block in `lib/export/shipSheet.ts`, and `tests/brandParity.audit.test.ts`.

---

## 12. ROUND Q — three guards that were derived at one end and hand-listed at the other, and one live convergence failure.

### 12.1 CORRECTED RECORD — the field-closure oracle held its READER LIST by hand.

`tests/p1.fieldClosure.oracle.test.ts` (§1 above) derives the FIELD universe from
the zod group schemas and measures coverage by probe. It then compared that
derived universe against a `READERS` array written out by hand, and its own
header said so. Every one of the four bypasses this repository has found was the
same shape — **a surface reader existed and was not enrolled in the guard that
was supposed to cover it**: C28's `keywordSurfaceText` omitted `bannerAltText`
and had no `video` case, `collectSurfaces` omitted `bannerAltText`,
`customerSurfaces` omitted `videoBrief.aspect`, `outputHygiene.surfaces` omitted
`facts`. A hand-written enrolment list is that shape one level up.

**Enrolment is now derived, by two independent detectors whose union must be
enrolled** (§B.0 of that file):

* **STATIC.** Every `.ts` under `lib/gate/` is read from disk *recursively*, so a
  new FILE counts, and its exported function SIGNATURES are parsed. A function
  is a candidate when it takes `OptimizedListing` or `AplusContent` and returns
  text — `string`, `string | null`, `string[]`, `[string, string][]`, or `T[]`
  for a `T` the gate itself declares with a `text: string` member (that type set
  is read out of the sources too, so `ScanSurface` and `StyleSurface` are not
  named in the test). `Failure[]` is not text, so the ~40 CHECKS drop out on
  their **return type**, not on a name. A function with no declared return type
  is undecidable and is therefore a candidate as well — fail-closed.
* **DYNAMIC.** Every gate module is imported through `import.meta.glob` (vite
  expands it from the filesystem, so again a new file counts) and every exported
  function is CALLED with a listing whose fields carry a sentinel. Anything that
  returns text-shaped output containing that sentinel is reading the listing,
  whatever its signature claims.

**What the derivation catches.** Neither detector reads a name, a comment or a
marker: one reads the type annotations the compiler already enforces, the other
reads behaviour. A `READERS` row no longer carries a closure over the function it
names — it carries an ADAPTER, and the oracle passes it the function object it
resolved from that module's own exports. A row cannot enrol a stub, a wrapper or
a lookalike; it is handed the real export or the run fails. Both directions are
asserted: a candidate with no row fails naming `file::function`, and a row naming
something no longer recognised fails too. The single escape hatch,
`NOT_A_SURFACE_READER`, holds one row (`presentAllergens`, which returns filtered
PACK rows and is a candidate only because it declares no return type), and that
row is machine-checked — the function must still exist and must not be observed
echoing listing text.

**CORRECTED RECORD (round R) — this section, and the matching header in the test,
used to say "why it cannot be faked". That was FALSE.** An overstated coverage
claim is the exact failure class this record exists to catch, so it is corrected
rather than softened. An adversarial reviewer wrote a **five-line reader into
`lib/gate/checks/` that escaped BOTH detectors**, and tried eight evasion shapes
in all; **six escaped**.

*Precisely what is and is not covered:*

* **CAUGHT — the accidental class, which is what all four historical bypasses
  were.** A plainly-declared `export function` under `lib/gate/**` that names
  `OptimizedListing` / `AplusContent` in its parameter list and declares a text
  return type is caught statically, on the annotation the compiler enforces; a
  MISSING return type is caught too (undecidable is treated as a reader).
  Anything the dynamic vectors can call that echoes probe text back is caught
  whatever its signature says — that leg caught an arrow function on an exported
  `const`, which the static parser does not read.
* **NOT CAUGHT — code shaped to evade it.** The static half is a regex over ONE
  declaration form matching ONE literal type name; the dynamic half only sees
  paths a fixed set of argument vectors reaches, with one probe listing.
  Demonstrated escapes: (1) a parameter typed through an ALIAS
  (`type L2 = OptimizedListing`) so the literal name never appears, paired with a
  return path the probe listing never exercises — that pair is the five-line
  reader; (2) an object METHOD (`export const readers = { text(l) {…} }`);
  (3) a FACTORY, whose export returns the reader rather than text; (4) a GENERIC
  with the constraint in the generics group
  (`export function f<T extends OptimizedListing>(l: T)`), which the parser skips
  before reading parameters; (5) a function declared without `export` and
  re-exported afterwards; (6) a reader defined OUTSIDE `lib/gate/**`, which both
  halves are rooted in.

None of those six is reachable by accident. The claim this guard supports —
and the only one it now makes — is that **a reader added the way readers have
actually been added must be enrolled**.

### 12.1a CLOSED (round R) — `READERS[].checks` was prose, and nothing verified it.

The gap ranked highest by the same review. A row asserted, in English, which
checks read the listing through its reader. Nothing measured it, so **a check
refactored onto a private PARTIAL scanner would have reopened the original bypass
class with the oracle still green and needing no new reader** — the guard would
have kept verifying that the READER covers its object while the CHECK quietly
stopped consuming the reader.

**§B.1 of `tests/p1.fieldClosure.oracle.test.ts` binds them behaviourally.** Each
check id in a row's `checks` string is resolved from **the gate's own dispatch
table**, parsed out of `lib/gate/runGate.ts` (so the test holds no hand-written
check list, and a check the gate no longer dispatches fails the row), then called
**exactly as `runGate` calls it** against a listing whose every string leaf has
been replaced by a recording GETTER. The check must READ every field its row's
reader reads. Nine rows, zero exemptions: every check named by every row consumes
its reader's full coverage today.

*One deliberate arrangement:* the pack handed to the checks has
`compliancePack.fictionPhrases` ARMED (it ships empty — "operator-supplied
known-false descriptors" — and C11/A6 return early on an empty list). Measuring
against the empty default would have reported a fact about this pack's DATA
rather than about whether the check is wired to its reader. Arming only ever adds
a live leg, so it cannot hide a missing one.

*What §B.1 does NOT prove, stated in the file and here:* it observes a **read,
not a scan** — a check that touches a field for an unrelated reason counts as
consuming it; it does not prove the read went **through** the named reader — a
check that inlined an identical FULL private walk would pass, and only the
PARTIAL one (the bypass shape) fails; and it measures **one pack and one
populated listing**, so a branch that only fires on other pack data is not
exercised.

*Non-vacuous, two ways.* A synthetic partial scanner that reads only the title is
asserted to be reported on more than ten fields, `bannerAltText` named among
them, while the real C17 is asserted to read that field. And adding `C3` (backend
bytes) to the `styleSurfaces` row's `checks` string fails
*"styleSurfaces — its checks read what it reads"* on the real tree; removing it
returns 42/42.

**It found real omissions immediately.** The hand list held six readers; the
derivation found nine. `aplusFactSurfaces` (the C12 A+ corpus),
`factsComplianceSurfaces` and `attributeComplianceSurfaces` — three readers
whose field coverage nothing measured — are now probed field by field like the
rest.

**Proved non-vacuous on the real tree, twice.** A throwaway
`export function throwawayHygieneSurfaces(l: OptimizedListing): [string, string][]`
added to `lib/gate/checks/c-hygiene.ts` fails §B.0 *"every detected surface
reader has a READERS row"* with `checks/c-hygiene.ts::throwawayHygieneSurfaces —
takes the listing and returns [string, string][] [found by: signature,
behaviour]`. Re-typed to dodge the static detector entirely —
`export function throwawayHygieneSurfaces(l: { title?: unknown; description?: unknown }): string[]`
— it still fails, `[found by: behaviour]`. Removing it returns 29/29.

**A future change to this must also change:** §B.0 and §B.1 of
`tests/p1.fieldClosure.oracle.test.ts` — `signatureCandidates`,
`behaviourCandidates`, `isTextReturn`, `NOT_A_SURFACE_READER`, `gateDispatch`,
`instrumented`, `armedPack`, `readerCoverage` — the `file` / `read` / `checks` /
`checkExempt` fields of every `READERS` row, and the `guarded('ID', () => fn(…))`
shape of `lib/gate/runGate.ts`, which §B.1 parses.

### 12.2 CORRECTED RECORD — prompt hygiene classified pack guidance by WORD COUNT.

`tests/promptHygiene.test.ts` corpus B scanned pack strings of **eight words or
more**. A prohibition of seven words or fewer — `Avoid any disease or symptom
wording` — was therefore never shown to the scan at all. The tree was clean; the
threshold was the only thing keeping it that way, and a threshold is not a
reason.

The logic is **inverted**: every pack string rendered verbatim into a prompt is
scanned, and an exemption must be PROVED from the pack's own data —
(1) the string IS one of the terms the gate scans for; (2) it is a sibling in an
array proved to be a gate-scanned lexicon, because one of that array's own
elements satisfies (1) (this is what makes `naturalStates[9] = "post-menopause"`
legal without a hand-written row); or (3) it is a `prohibited{Content,Marketing}`
pattern LABEL that its OWN regex matches, i.e. an example of the thing it names.
A guidance array can never qualify: no sentence of guidance equals a lexicon
entry, so `promptRules.compliance` stays fully scanned at any length.

Exemption (3) paid for itself on the first run: the label `"discount claim"` sat
on the `\d{1,3}% off` pattern, which does not match it — the word `discount` is
matched by the NEXT pattern — so the prompt was handing the model a C18
promotional-claim term in order to forbid a different thing. Both `discount
claim` labels were rewritten to describe their own regexes (`percentage-off
claim`, `half-price claim`).

Two assertions keep the change honest: **§B.1 proves it is a pure widening** —
no string the old eight-word rule scanned may be exempt now — and a canary
proves the new rule catches what the old one could not, asserted both ways (the
six-word sentence is invisible to `isGuidanceShaped` and caught by the current
corpus).

**Canary, on the real tree:** adding `"Avoid any disease or symptom wording"` to
`knowledge/compliance.supplements.json` → `promptRules.compliance` fails corpus B
with `crossCheckCompliancePacks[0].promptRules.compliance[4]: C6 disease noun
'disease'`. Six words: the previous rule could not see it.

### 12.3 CORRECTED RECORD — prompt hygiene corpus C was a DIRECTORY, not a property.

Corpus C extracted string literals from `lib/engine/prompts/*.ts` and nothing
else, so a prohibition constant defined anywhere else and rendered into a prompt
escaped all three corpora.

Membership is now **measured** (§C.2). The suite runs the real generator three
ways — a plain round, a REPAIR round and a REPARSE — captures every prompt at
the LLM boundary, then enrols every module under `lib/` and `app/` one of whose
own string literals is rendered verbatim into one of them. It immediately found
two modules the directory could not: `lib/engine/optimize.ts` (the repair-round
header) and `lib/engine/llm.ts` (the reparse instruction).

Two supporting changes were required. `stringLiteralsOf` now skips REGEX
literals: outside the prompts directory a character class like `/[^a-z0-9']+/`
carries an apostrophe that would otherwise open a string frame and swallow the
rest of the file as "authored text". And a segment only enrols a module if it is
NOT also present in the pack — `lib/ingest/labelMap.ts` holds `country of
origin`, which reaches the prompt from the attribute schema, not from it; text
whose origin is the pack is corpus B's job.

**Stated boundary.** The failure-context PAYLOAD (`[C6] bullets[2]: … → FIX:
Remove banned disease term 'x'`) is deliberately outside this corpus, and the
capture uses a marker in its place. That text is a REACTION to copy the model
already wrote and was already failed for; it names the offending term because a
repair instruction cannot be expressed otherwise, it exists only in a round that
has already failed, and the gate re-runs afterwards, so an echo is caught
deterministically rather than shipped. What A/B/C are about is the STANDING text
every prompt carries whatever the model wrote — which is what a model
paraphrases into house style, and where both live defects were found.

**Canary, on the real tree:** adding `Never mention any disease anywhere in the
rewritten copy.` to the repair header in `lib/engine/optimize.ts` fails §C.2 with
`lib/engine/optimize.ts: C6 disease noun 'disease'`. The previous corpus C could
not have read that file.

### 12.4 CORRECTED RECORD — C4's own repair instruction could not converge.

A live run of ASIN **B00EEEITVA** ended `verified:false` on a single **C4**
failure (one of six runs in the batch; the other five verified clean, and the
same ASIN verified on its other run). C4 routes correctly and always has —
`description` has owned a row in `FIELD_TO_GROUP` since the table existed — so
the loop regenerated the right group every round and still could not converge.

The cause was arithmetic. C4 measures the **assembled** description: the model's
text plus the verbatim disclaimer `optimize()` appends afterwards (`\n\n` plus
156 characters on supplements). Three places stated the budget and all three
disagreed:

| where | what it said | derived from |
| --- | --- | --- |
| system prompt | `Description ≤2000 chars (leave ~250 chars headroom)` | nothing |
| description prompt | `≤1700 chars` | nothing |
| C4's own `fix` | `Shorten description to ≤2000 chars` | `rules.descriptionMax` |

The `fix` line is the one `lib/engine/repair.ts` pastes into the regeneration
prompt verbatim, so it is the most specific and most recent instruction the model
sees — and **obeying it reproduces the defect**: 2000 characters of the model's
own text plus 158 appended is 2158, and the next gate run reports the same
failure with a slightly different number.

`descriptionBudget(pack)` in `lib/gate/checks/c-length.ts` is now the single
arithmetic — `max = rules.descriptionMax`, `reserve = separator + the pack's own
disclaimer`, `budget = max - reserve` — and all three sites render from it.
`DISCLAIMER_APPEND_SEPARATOR` lives beside the check that measures the assembled
string and `lib/engine/optimize.ts` imports it, in the direction
`lib/engine/repair.ts` already imports `runGate`; two homes for that one fact is
exactly the drift that produced this.

**C4 is not weakened.** Its trigger is byte-identical — empty, or assembled
length over `rules.descriptionMax` — and `tests/c4.descriptionBudget.test.ts`
pins both directions on both packs: a description written TO the budget lands
exactly on the cap and passes; one character over still fails. The convergence
property is asserted as a property, not as a string: the number is parsed back
out of the repair line the loop would send, and a model writing exactly that many
characters must pass, while the same test shows a model aiming at
`descriptionMax` — the pre-fix instruction — still failing.

**A future change to this must also change:** `descriptionBudget` and
`c4DescriptionLength` in `lib/gate/checks/c-length.ts`, `appendDisclaimer` in
`lib/engine/optimize.ts`, the `disclaimerHeadroom` line in
`lib/engine/prompts/system.ts`, `descriptionPrompt` in
`lib/engine/prompts/description.ts`, and `tests/c4.descriptionBudget.test.ts`.

### 12.5 CORRECTED RECORD — the typography fold's "OPTIONALITY IS PRESERVED" note.

`lib/engine/typography.ts` claimed *"`altText`, `bannerAltText` and `videoBrief`
are all optional, and C29/C30 report a MISSING one as its own failure. Folding
must not turn `undefined` into `''` … so each is rebuilt only when it is actually
there."* Two things in that were wrong. Inside a PRESENT `videoBrief`,
`t(video.aspect)` and `t(video.notes)` do coerce `undefined` to `''` and the two
array fields coerce a non-array to `[]`, so it was never a property of the
function. And C30 reports an absent `imagePlan[].altText` and an empty one
identically (`"(empty)"`), and an absent `bannerAltText` not at all, so no guard
here is load-bearing for a gate verdict.

**The comment was corrected rather than the code**, because the rule the code
actually follows is a good one and the comment stated it too broadly: a field is
guarded exactly where the output CONTRACT makes it optional (`subcopy`,
`bannerAltText`, `altText`, and `videoBrief` itself), so the fold never invents a
key the model did not write — which matters for the persisted and exported JSON.
`VideoBrief` declares all five of its fields required, so there is no "missing
notes" state to preserve; the coercion hands malformed output to the checks in
the shape the type promises instead of propagating a hole. Adding guards to match
the over-broad reading would have made the emitted shape depend on model
malformation and bought no signal.

---

## 13. ROUND R — a third instance of one coherence class, and two overstated claims.

### 13.1 ARCHITECTURE CHANGE — a PROPERTY OF THE PRODUCT can never be a rival-exclusion term.

**The live defect.** Three of nine production runs, two ASINs, neither able to
converge:

```
B00IO89MYA  C28 | keywords[24] | negative term 'elderberry' appears on 'title'
B00EEEITVA  C28 | keywords[24] | negative term 'dairy free' appears on 'itemHighlights'
```

`elderberry` is an **actual ingredient of the product being optimized**;
`dairy free` is a **legitimate diet attribute** of it. The copy names both
because a listing for that product must name them. The model had used
`negative` — a status whose sole meaning is rival-brand exclusion (R50) — as a
**dumping ground for "terms I chose not to target"**, which is what
`not-targeted` is for.

**Why no repair round could clear it.** `negative` is the one status the
derivation must never overwrite: for a genuine rival, presence in the copy *is*
the violation, so deriving it away would turn the check that keeps rival brands
out into a relabelling exercise (§10). C28 was right about its rule and the model
was wrong about its input, and the only fix the failure asks for is *"delete your
own ingredient from your own title"*.

**This is the third instance of one class.** §8 established that a term which IS
the subject product's brand cannot be a rival's brand; §10 established that a
status asserting something about the copy belongs on the derived side. The
general fact both are instances of: **a term that is a property of the product
being optimized cannot be a rival-exclusion term.** The brand is one such
property; an ingredient, a diet or allergen flag, a form or a size are others.

**Where it reads from, and where it deliberately does not.**
`productPropertyIdentity` in `lib/engine/keywordPlacement.ts` reads
`snapshot.attributes` — the ingested page's own **structured** marketplace data —
and nothing else.

* **Not the generated copy**, at all. Deriving "is this a property of the
  product?" from the copy would let a model launder a rival by writing it in: the
  term would appear, and appearing would be the reason it stopped being scanned
  for appearing.
* **Not the snapshot's free-text bullets, description or title.** A competitor
  can be named lawfully in prose, and prose is exactly where a rival brand would
  be sitting.
* **No attribute KEY is named in code.** Naming one would put a category lexicon
  in the engine (`tests/category.literals.test.ts`) and would also be wrong: what
  the ingested page declares about ITSELF is a property of itself, whichever key
  it arrived under.

**The bounds.** (1) structured attributes only; (2) **exact normalised equality
on a whole list item** — the value is split on list punctuation and each item
must match whole, so `berry` is not exempted by `elderberry` any more than
`immunity` is exempted by the brand `Instant Immunity`; (3) the
**operator-supplied competitor set is never reclassified** (see below); (4) no
snapshot ⇒ empty set ⇒ nothing exempted. The row is **reclassified, not deleted**,
with the correction on `note`, exactly as §8's own-brand path does, and
`minNegatives` still counts only surviving negatives.

**UNIFIED WITH `ownBrandIdentity`, BUT DELIBERATELY NOT THE SAME SET.**
`productIdentity()` is the one entry point for "this term names the product being
optimized": it unions the brand identity with the property identity, keyed by the
same `identityKey` and matched by the same equality rule, and records WHICH kind
each key is so the note can say what the correction rests on. It is the
derivation's set. `ownBrandIdentity` stays the **narrow, brand-only** set, because
`lib/audit/rivalBrands.ts` subtracts it (bound 3 of §7) from the automatic
competitor-derived rival list — **had that subtraction been widened, a rival brand
that happens to collide with one of our ingredient strings would have dropped out
of the operator-supplied signal by coincidence.** That is asserted directly:
`tests/keywordDerivation.productProperty.test.ts` §(d) plants a rival whose brand
IS an ingredient item verbatim, watches the derivation reclassify the model's row
(correctly — it is reading the snapshot the operator's own page supplied), and
asserts **the run still fails**, on the automatic leg, which reads no label at
all.

**R50 IS UNWEAKENED, and it is asserted rather than argued.** §(b) of that file
plants a genuine rival brand marked `negative` in the **title, a bullet, the
description, the backend field, an attribute value, the A+ `bannerAltText`, the
video brief and an `imagePlan[].altText`** — eight surfaces, the invisible ones
included — and every one still fails C28 and still fails the gate, with the row
still saying `negative` and carrying no note. §(c) asserts the exemption is not a
wildcard: a term sharing a word with an ingredient still fails; a name that
appears only in the snapshot's PROSE is not a property; and a rival written all
over the GENERATED copy is not laundered by having been written there.

**One interaction, pinned rather than hidden.** The fixture snapshot declares
`primary_supplement_type`, whose value is the word
`tests/keywordDerivation.ownBrand.test.ts` §(c) used as its "shares a word with
the brand" probe. Under the full snapshot that word is now exempted — correctly,
by THIS rule, not by the brand rule. That test's brand-rule leg is therefore
measured against a snapshot declaring the brand and nothing else, and a new
assertion beside it states the interaction explicitly: the word is not in
`ownBrandIdentity`, and the note it earns says `PROPERTY OF THIS PRODUCT` and not
`OWN brand identity`.

**Prevention, from pack data.** `rules.keywordRules.negativeScopeNote` states what
`negative` is FOR and what it is not for, and is rendered into the keywords
prompt. Prompt-only, like `ownBrandNote`: it is not a `REQUIRED_PACK_PIECES` row,
because what is ENFORCED is the reclassification and the floor.

**STATED RESIDUAL RISK.** A rival brand string that appears **verbatim as an item
of the subject listing's own structured attributes** would be exempted from the
model-declared negative scan. Three things bound it: the source is the subject's
own marketplace attribute data (not prose, not our copy); the match is whole-item
equality; and the operator-supplied competitor set — the only rival signal that
does not come from the model — is untouched by it and still fails the run.

**A future change to this must also change:** `productPropertyIdentity`,
`productIdentity`, `ownBrandIdentity` and `deriveKeywordPlacement` in
`lib/engine/keywordPlacement.ts`, the bound-3 subtraction in
`lib/audit/rivalBrands.ts`, `negativeScopeNote` in `lib/types.ts` and
`knowledge/rules.json`, its rendering in `lib/engine/prompts/keywords.ts`, and
`tests/keywordDerivation.productProperty.test.ts` +
`tests/keywordDerivation.ownBrand.test.ts`.

### 13.2 ASSESSED, NO CHANGE — the C4 follow-up was a model overshoot, not a stale number.

A later live run showed `C4 | description | 2088 chars (1930 written + 158
appended)`. The §12.4 fix is intact and the arithmetic has one home:
`descriptionBudget(pack)` returns `max 2000`, `reserve 158`
(`'\n\n'.length` + the pack disclaimer's 156 characters) and `budget 1842`, and
`descriptionPrompt` renders `budget.budget` / `budget.reserve` / `budget.max`
directly — it states **1842, the budget the model controls**, never the raw cap.
`tests/c4.descriptionBudget.test.ts` pins that in both directions: every prompt
that states the limit must contain the DERIVED budget and the DERIVED reserve,
and must not contain either of the deleted hand-copied constants (`1700`,
`~250 chars headroom`).

So the model was told 1842 and wrote 1930 — an 88-character overshoot of a
correctly-stated budget, not an instruction that reproduced the defect. The
repair line the loop feeds back says `≤1842`, and the test *"OBEYING the C4 repair
line converges in one round"* parses the number back out of that very line and
asserts a model that writes it passes. The run that carried this also carried a
C28 failure of the §13.1 class, which is what consumed the rounds. **Nothing was
changed.**
