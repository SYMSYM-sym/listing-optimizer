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
directions — **12 of the 18 cases the fix shipped** fail against the pre-fix
reader.

> **CORRECTED (M2, re-measured).** This said **14**. Reconstructing the pre-fix
> reader on the current tree — `aplusText` stops reading `bannerAltText`, and
> `video` comes out of `keywordRules.visibleSurfaces` — and running the suite
> gives **12 failed, 6 passed of 18**. The original 14 was measured against a
> tree that no longer exists in isolation (items 6, 7 and 10 have since added
> legs to C28), so the honest record is the number a reader can reproduce today
> by the method just stated, not a number nobody can check.
>
> **RE-MEASURED AGAIN (AC-G3).** §1.4 added six cases to that file, so it now
> holds **24**, and the same method now gives **13 failed, 11 passed of 24**.
> Five of the six new cases exercise `images`, which F1 did not change, and pass
> either way; the sixth asserts the pack vocabulary contains `video` and is
> therefore one more case the reconstruction fails. The F1-era number is
> unchanged and is stated as such above.

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

### 1.4 AM-10d IS SUPERSEDED BY F1 — recorded here, because it was superseded in code and nowhere else.

**THE AMENDMENT.** The game plan's **AM-10d** rules on where keyword placement
is measured, and it excludes the visual surfaces:

> **AM-10d** — image/video ALT text is **NOT** a keyword-placement surface.

**THE SHIPPED BEHAVIOUR CONTRADICTS IT.** `knowledge/rules.json` →
`keywordRules.visibleSurfaces` lists `images` and `video`, so C28 resolves both
(`keywordSurfaceText` in `lib/gate/checks/c-keywords.ts` reads every image
slot's `purpose`/`spec`/`notes`/`altText`, and every string field of the video
brief), and a keyword row may be **declared placed** on either of them.

**THE TWO HALVES ARRIVED SEPARATELY, and the record should not blur them.**
`images` has been in `visibleSurfaces` since WS3 itself (commit `12c2e6a`, the
commit that created C28) — so half of AM-10d was contradicted the day the check
was written, silently. `video` was added by commit **`47b5f1e` (finding F1)**,
and that is the commit that makes the contradiction deliberate and reasoned.

**WHY IT WAS SUPERSEDED, AND BY WHAT.** By **commit `47b5f1e` (finding F1)**,
whose subject is recorded in §1 above — not by drift and not by a
reinterpretation. AM-10d's exclusion is a rule about *credit*: an ALT string
is not a place a term earns discoverability, so a listing should not be able to
satisfy a placement obligation by writing the term into an ALT attribute. C28's
surface vocabulary is not only a credit list, though — **it is also the corpus
the `negative`, `candidate` and `captured-via` legs scan for ABSENCE**, and R50
(the rule **AM-9** exists to guarantee) is enforced entirely through that
corpus. Leaving `images` and `video` out of `visibleSurfaces` therefore did not
merely withhold credit: it left a rival brand planted in an A+ `bannerAltText`
or a `videoBrief.onScreenText` **unscanned**, producing zero gate failures and a
`verified: true` run. That was proven live, and it is the bypass F1 closed.

**THE DIRECTION IS THE POINT.** The widening is **safe-direction**: adding a
surface to `visibleSurfaces` can only cause a term to be found in MORE places.
For an absence leg (`negative`/`candidate`/`captured-via`) that is strictly more
enforcement. For the `placed` leg it is not a loosening either — a `placed` row
must declare its surfaces and the term must actually appear on each declared
one, so admitting `images`/`video` to the vocabulary adds an obligation a row
can fail, never a way to pass one it would otherwise fail. What AM-10d's
underlying intent asks for — *an ALT string must not be how a term earns its
placement* — is a **generation** rule, and it lives in the placement doctrine
the prompt renders, not in the check's absence corpus. Nothing in the shipped
prompt directs the model to place a term in ALT text.

**THE COST, STATED.** A model that declares `placed` with `images` as its only
surface will pass C28, which is the residue of AM-10d that F1 did not preserve.
That is accepted for the reason above (it costs the run nothing an operator
cannot see in the artifact, whereas the alternative cost a live R50 bypass) and
it is recorded here rather than left as a silent difference.

**WHERE THE SUPERSESSION IS TESTED.** `tests/keywordPlacement.surfaces.test.ts`
§ *"AC-G3 — AM-10d is superseded by F1, and the vocabulary says so"* (six cases,
added here). It asserts that `visibleSurfaces` names **both** `images` and
`video` and that both resolve; that a `negative` rival brand planted in an image
`altText` FAILS C28 and drops `runGate` to `pass: false`; that lawful ALT copy in
the very same field raises nothing and leaves the whole gate green; and — the
honest half — that a `placed` row carried ONLY by an image ALT **passes**, which
is the residue of AM-10d that F1 did not preserve, together with the row failing
when the term is not actually there. The same file's F1-era cases cover the A+
`bannerAltText` and all four video-brief fields in both directions, and the
closed-world rule (`tests/keywordPlacement.gate.test.ts`) fails any pack surface
the reader cannot resolve, so neither name can be removed from the vocabulary
without a test changing.

**A future change to this must also change:** `keywordRules.visibleSurfaces` in
`knowledge/rules.json`, `keywordSurfaceText` in `lib/gate/checks/c-keywords.ts`,
`tests/keywordPlacement.surfaces.test.ts`, and §1 above.

---

---

## 2. FLAGGED ADDITION — C24, **C12** and (Y2) **C10/A5** now read a SPELLED-OUT figure too. This is an intentional divergence from the kit.

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

It is deliberately **three lists**, and the split is the false-positive control:

| list | contents | rule |
| --- | --- | --- |
| `cardinals` | one … ninety | a match must **begin** with one of these |
| `magnitudes` | hundred … trillion | may only appear **after** a cardinal |
| `connectors` (Y1) | the inert words — `and`, `a`, `an` | does not begin or end a run on its own; may sit **between** two value words, or lead one in front of a magnitude that OPENS no unit token here (Z3 (b)), where it supplies the implicit one (`"a hundred"` = 100). Pinned by *"Y1 (d)"* and *"Z3 (b): an inert lead is still allowed in front of a magnitude that opens no unit token"* |

so a value that merely names its unit — `"Billion CFU"`, and `"a Billion CFU"` —
is not read as a figure. Each word carries its **value** (`{"fifty": 50}`, `{"billion": 1e9}`)
because N3 (item 2.4) *measures* the figure rather than merely detecting it; C24
uses only the keys. One list, not a list plus a parallel table that can drift.

The other four bounds are structural and were already there:

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
  digits"* — the exact string this entry used to pin as passing, plus the note
  that C12 **agrees** with that value (it resolves to the canonical 50), so only
  C24 objects. That is the whole reason C24 exists separately from C12.
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

**Where the vocabulary becomes a pattern.** `spelledOutRunSource` and
`heroUnitSource` in `lib/gate/checks/shared.ts` are the ONLY places the pack
lists are compiled. `c24DosageAttributeGuard` calls both; N3's
`spelledOutFigureReader` (same file) calls both; C26's amount stripper calls
`spelledOutRunSource`. There is no second copy of the pattern to drift, which is
the condition item 2.4 set on any future extension and the reason the C24 leg
was refactored in the same commit that added the C12 one.

### 2.4 N3 — the C12 half, CLOSED as a flagged addition of its own

**What 2.4 used to say.** *"C12 is untouched and remains digit-anchored."* It
justified that on scope: C12's scan is a general unit-extraction pass over every
customer surface, not a narrow attribute guard, so a number-word leg there was a
materially larger change with a materially larger false-positive surface. It
told anyone extending C12 to treat it as its own flagged addition with its own
battery.

**That was done, and this entry then claimed "the limitation no longer
exists". That claim was OVERSTATED — see 2.4.8.** What N3 actually closed was
the PLAIN word form: a run of number words the pack's vocabulary can read
end-to-end, `"Fifty Billion CFU per serving"` and `"Ninety Billion CFU"`. What
it did NOT close was any form containing a word the vocabulary does not hold —
above all the ordinary English connector in `"One Hundred and Fifty Billion
CFU"`, which N3 read as the sub-run `"Fifty Billion CFU"` and reported as
AGREEING with a canonical 50. That was found by ADVERSARIAL REVIEW after the
change shipped, not by the battery written alongside it: every N3 test used a
connector-free numeral, so nothing in the suite exercised the fallback. The
class was closed in Y1 (2.4.8); the residue that remains after Y1 is stated
there rather than described as absent.

The hole N3 addressed was still the worse of the two: C24's is a filter-fed
attribute stating a number as a dose *even when the number is right*; C12's was
a bullet or description reading **"Fifty Billion CFU per serving"** while the
canonical potency was something else — an **overstated potency claim shipping in
customer-facing copy**, which is the exact class C12 exists to prevent. A
recorded limitation is not a licence to keep one; it is a promise to come back.

**Status: CLOSED, as a FLAGGED ADDITION.** N3 is a second deliberate divergence
beyond the source kit's behaviour, on top of N2, and this is the record of it.

#### 2.4.1 The mechanism

`c12FactConsistency` (`lib/gate/checks/c-quality.ts`) now passes a
`spelledOutFigureReader` into `factConsistencyOver`. The reader is built from
**the same pack lists, by the same compiler**, as C24's leg (2.3 above) — no
second vocabulary, no second pattern. `extractUnitNumbers` takes it as an
OPTIONAL third argument, so every other caller keeps the exact digit-anchored
scan it had.

The reader is applied to all three of C12's inputs, deliberately:

| input | why |
| --- | --- |
| the surface being scanned | the figure being measured |
| the ingredient breakdown (`declaredFigures`) | a one-sided reader would be **over-blocking** — an attributed word figure would be measured while the word-form declaration that licenses it stayed invisible |
| `facts.potency` (`parsePotencyFact`) | a canonical fact written in words used to parse to nothing, which switched the potency comparison OFF for the entire listing |

`facts.servingSize` is deliberately **not** read with it: every value extracted
there lands in the COUNT allow-set regardless of dimension, so feeding it hero
figures would widen what a count figure may claim.

#### 2.4.2 The bounds, and the false-positive conditions — stated

C12's scope is every customer surface, so ordinary supplement prose is the real
risk. Five bounds, four inherited from N2 and one new:

1. **A HERO UNIT IS STILL REQUIRED**, and the hero dimension is pack data
   (`attributeGuard.unitDimensions` = `potency`). Count, day and dosage-form
   figures stay **digit-only**. This is what makes `"one capsule daily"`,
   `"two servings"`, `"thirty day supply"`, `"sixty capsules, one month
   supply"`, `"ten strains"` and `"one hundred percent plant based"`
   unmatchable however the number is written — and it is a *deliberate*
   narrowing, not an oversight: the digit halves of `"90 Capsules per bottle"`
   and `"a 30 day supply"` still fail, and a test asserts exactly that pair.
2. **A CARDINAL MUST LEAD** — `"Billion CFU"` is not a figure. Y1 admits one
   further lead and no more: an inert connector in front of a magnitude the
   caller does not also append as a unit (`"A hundred Billion CFU"` is a figure;
   `"a Billion CFU"` is not, because there the token is the unit).
3. **THE SEPARATOR IS REQUIRED** and both sides are word-bounded.
4. **THE VALUE COMPOSES AS THE DIGITS DO, OR THERE IS NO VALUE.** This is the
   bound that decides whether the change is safe, and Y1 (2.4.8) supplied its
   missing half: a run this reader cannot read WHOLE yields no figure at all,
   never the value of a fragment of itself. `"Fifty Billion CFU"` is FIFTY of
   the compound unit `billion cfu` — exactly what the digit scan reads out of
   `"50 Billion CFU"` — **not** fifty thousand million. The run pattern is
   therefore **lazy**, so the longest-first unit alternation wins the token
   `billion`; a greedy run would swallow it as a MAGNITUDE and fail truthful
   copy. (For C24, which only asks whether the value matches at all, greedy and
   lazy accept precisely the same strings.)
5. **ABSENT PACK DATA = EXACT PRIOR BEHAVIOUR** — see 2.4.4.

**The conditions under which it CAN false-positive, written down rather than
implied:**

- **A hero-unit token used rhetorically.** This pack lists the bare magnitude
  `billion` as a potency unit in its own right (so `"90 Billion"` is a figure),
  which means `"six billion reasons to feel good"` reads as 6 CFU-family units
  and is reported. **This is inherited, not introduced:** `"6 billion reasons"`
  already failed the digit scan, and a test pins the two to behave identically.
  The condition belongs to the pack's unit list; narrowing it is a pack change,
  not a gate change.
- **A word-form figure in the same unit family as `facts.potency` that is
  genuinely different and genuinely not the product's potency** — for example a
  competitor figure quoted in first-person copy. That is the same exposure the
  digit scan has always had; the A+ `comparison.typical` column (the one place
  a rival's figure legitimately lives) stays exempt, and a test asserts it.
- **A pack whose `spelledOutNumbers` values are wrong.** The value now matters:
  a mis-entered `{"fifty": 15}` would fail truthful copy. The words are asserted
  against the digits in the battery, not merely listed.

Not a false-positive risk, because the bounds forbid it: any sentence in which a
number word is *not* joined to a hero unit — which is nearly all of them.

#### 2.4.3 Both directions, by test name

`tests/complianceCompletions.test.ts`, all under `C12 reads a SPELLED-OUT hero
figure (N3)`:

- *"N3 (was a recorded limitation): an overstated potency SPELLED OUT in a
  bullet now FAILS"* — the exact string this entry used to pin as invisible.
- *"N3: the word form and the digit form are reported identically"*.
- *"N3: every surface C12 already reads is covered — description, A+ and
  attributes"*, and *"N3: the A+ 'typical' column stays exempt"*.
- *"N3: TRUTHFUL word-form copy PASSES — the compound unit is not read as a
  magnitude"* — the guard on bound 4.
- *"N3: magnitude composition matches the digit scan"* (`Five Hundred mg`
  passes against a 500 mg fact, `Two Thousand mg` fails).
- *"N3: ordinary supplement prose still PASSES on a customer surface"* — 26
  lawful phrases, including every phrase named in bound 1.
- *"N3: a cardinal must LEAD"*, *"N3: the leg requires a HERO unit — count and
  day figures stay digit-only"* (both directions, word vs digit).
- *"N3: an ATTRIBUTED word figure is exempt only when the breakdown declares
  it"*.
- *"N3: a rhetorical hero-unit token behaves exactly as the digit form already
  did"* — the inherited condition above, pinned rather than left to be
  rediscovered as a finding.
- *"N3: the vocabulary is PACK DATA — emptying it restores the exact prior
  scan, it does not disarm C12"* and *"N3: ONE vocabulary — the same pack lists
  drive C24 and C12"*.
- *"N3: the golden fixture is untouched — still ZERO gate failures"*.

#### 2.4.4 Emptying the pack list NARROWS, it never disarms

Asserted three ways in one test — vocabulary deleted, cardinals emptied, and the
whole `attributeGuard` block deleted. In every case: the word form goes back to
passing (**exactly** the pre-N3 behaviour), and the digit failures are asserted
**equal to the digit failures under the full pack** — so C12 is narrowed to its
port, never switched off. That is why `spelledOutNumbers` remains deliberately
NOT a `REQUIRED_PACK_PIECES` row while `rules.attributeGuard` itself still is.

#### 2.4.5 C26's amount stripper, extended in the same commit — the OTHER direction

`c26ActiveIngredientSubset` strips `number + unit` out of an ingredient NAME
before comparing names, because the amount is a property of the panel and the
full label list routinely omits it. That stripper was digit-only, so
`active_ingredients: "Probiotic Blend Fifty Billion CFU"` against
`ingredients: "… Probiotic Blend …"` was reported as an **undeclared
ingredient** purely because the amount was spelled out — the digit form of the
identical label passed. That is over-blocking, which this project treats as
exactly as severe as a bypass, and N3 would have made it more likely by
legitimising word-form figures elsewhere. The stripper now uses the same shared
`spelledOutRunSource`. It is a **tolerance** widener: a "name" consisting only
of an amount yields no name words and is skipped, exactly as the digit form
already was, so the widening does not create an undetected ingredient in the
cases tested. (Z2 — this used to read *"stripping more can never manufacture a
bypass"*; the reasoning is unchanged but the unbounded form is not, and what is
verified is the two named tests below.) Both directions are tested (*"N3: a SPELLED-OUT amount is stripped from the name…"*
and *"N3: stripping the amount does NOT hide a genuinely undeclared
ingredient"*).

#### 2.4.6 C10/A5 potency PHRASING — DECLINED at N3, RE-DECIDED and EXTENDED at Y2

**What this section used to say, and the part of it that was false.** N3 left
`potencyPhrasingOver` (C10 on customer copy, A5 on A+) digit-anchored and gave
three reasons. One of them was:

> *"The residue is bounded. An untrue word-form per-serving figure is now caught
> by C12; what still evades is a true figure attached to a dose in words."*

**That was false as written, and Y1 proved it.** `"Delivers One Hundred and
Fifty Billion CFU per serving"` against a canonical `50 Billion CFU` is an
untrue word-form per-serving figure, and C12 did not catch it — it measured it
as truthful (2.4.8). Both halves failed together on exactly the sentence shape
the argument named, so the boundedness it asserted did not hold. It was an
argument about a residue nobody had measured.

**RE-DECIDED ON THE MERITS: EXTENDED.** Not because the C12 hole is now fixed —
that would rebuild the same argument on a repaired premise — but because the
decline reasoned from the wrong property of these two checks:

- **C10/A5 need no composed VALUE.** They object to attaching the headline
  potency to a single dose *whatever the number is*. That makes them DETECTION
  rules, in the same sense C24 is, and detection is unaffected by a run the
  reader would refuse to compose. So C10/A5 are precisely the right home for the
  residue C12's fragment refusal must leave behind (2.4.8) — the one part of the
  gate that can still speak about a figure it cannot read.
- **The "different objection" argument was correct and is honoured**, not
  discarded: this is NEW blocking behaviour on a phrasing rule, so it carries
  its own both-direction battery under `Y2` in
  `tests/complianceCompletions.test.ts` rather than riding on N3's.
- **The structural argument was real and is answered structurally.** The two
  patterns are no longer built inside `compileUnits`. They live in
  `phrasingPatterns`, with their own cache keyed by the `UnitRules` object AND
  by the compiled run source, so the hot path `CompiledUnits` shares with
  `extractUnitNumbers` keeps its old key, and a caller that passes no vocabulary
  gets byte-for-byte the pattern it had.

**The mechanism.** `potencyPhrasingOver` takes the pack's `attributeGuard` and
compiles the figure alternation as *digits* **or** `spelledOutRunSource` — the
same vocabulary, the same compiler, no second copy. Every other bound is
untouched: a POTENCY unit and a PER-DOSE phrase are both still required within
the same clause, and the negation context still applies.

**Both directions, by test name** (`tests/complianceCompletions.test.ts`, under
`Y2 — C10/A5 potency PHRASING reads the spelled-out figure`):

- *"Y2: a word-form per-serving attachment now FAILS C10, exactly as the digit
  form does"* — three sentences, each asserted to produce the **same number of
  failures with the same fix text** as its digit twin.
- *"Y2: the TRUE word-form figure is caught too — the attachment is the
  objection, not the number"* — `"Delivers Fifty Billion CFU per serving"` with
  a canonical 50: C12 is silent, C10 is not. C12 reports only DISAGREEMENT with
  the canonical fact, so it has nothing to say about a figure that agrees with
  it — which is the case this test pins and the reason the extension is worth
  its false-positive surface. (Z2 — this used to read *"the case C12 can never
  cover"*.)
- *"Y2: A5 gets the same leg on A+ copy"*.
- *"Y2: over-blocking — ordinary prose, and a potency NOT attached to a dose,
  still PASS"* — ten phrases including `"Fifty Billion CFU in every capsule of
  the blend"`, `"A Fifty Billion CFU blend of ten strains"`, `"a hundred percent
  vegan"` and a negated mention.
- *"Y2: the leg is PACK DATA — no vocabulary is the exact digit-anchored rule
  C10/A5 shipped with"*, where the digit failures are asserted **equal** to the
  digit failures under the full pack.
- *"Y2: the golden fixture is untouched — still ZERO gate failures"*.

**What is verified, stated precisely and no wider:** under the shipped pack the
three sentences named in the first test fail C10, the A+ sentence fails A5, and
the ten phrases named in the fourth test do not fail. This is one attachment rule
widened to a second script. It is **not** a claim that C10/A5 now catch every way
a dose attachment can be phrased, and it is not a claim about any figure shape
the reader's own bounds exclude (2.4.2 bound 1).

**A future change to this must also change:** `phrasingPatterns` and
`potencyPhrasingOver` in `lib/gate/checks/shared.ts`, both call sites
(`c10PotencyPhrasing` in `c-quality.ts`, `a5AplusPotencyPhrasing` in
`a-aplus.ts`), the `Y2:` cases in `tests/complianceCompletions.test.ts` and this
entry.

#### 2.4.7 The other figure-reading code, examined and declined

| where | decision |
| --- | --- |
| `lib/engine/facts.ts` (`extractPotency`, count/day extraction) | **Declined.** It decides what the canonical facts ARE rather than measuring against them; a word-form leg there changes the yardstick, not the check, and it lives in `lib/engine`. `parsePotencyFact` already gives C12 the benefit when a fact arrives in words from anywhere else. |
| `lib/audit/scoreAgainstPrinciples.ts` | **Declined.** Advisory scoring, not a verdict (`verified` is computed only in `lib/audit/buildAudit.ts`). It calls `extractUnitNumbers` without a reader, so it is byte-for-byte unchanged. |
| `lib/gate/util.ts` timeframe-claim pattern | **No change needed** — it already reads number words (`in|within|after (\d+|a|an|one|two|…)`), so there is no script asymmetry to close. |
| C23 (attribute completeness/enums), C31 (bullet format), C4 (length budgets) | **No figure semantics at all** — they count characters, match enums, or test structure. |

**A future change to N3 must also change:** `spelledOutRunSource` /
`heroUnitSource` / `spelledOutFigureReader` in `lib/gate/checks/shared.ts`, the
N3 block in `c12FactConsistency`'s header, `AttributeGuardRules` in
`lib/types.ts`, `rules.attributeGuard.spelledOutNumbers` (+ its `_comment`) in
`knowledge/rules.json`, and the `N3:` cases in
`tests/complianceCompletions.test.ts`.

#### 2.4.8 Y1 — CORRECTED RECORD and CLOSED CLASS: N3 mis-MEASURED the connector form

**THE DEFECT, as an adversarial reviewer proved it through the real `runGate`.**

```
bullets[0] = "Delivers One Hundred and Fifty Billion CFU per serving"
facts.potency = "50 Billion CFU"
=> ZERO failures from the entire gate
```

`and` was not in the pack vocabulary and **could not be**: `valueMap` keeps only
entries whose `value > 0`, so an inert word declared as a cardinal is widened
into the PATTERN and then dropped from the VALUE table. The run pattern could
not cross `and`, so the reader fell back to the SUB-RUN `"Fifty Billion CFU"`,
composed **50**, and — 50 being the canonical figure — the check concluded the
copy **agreed with the facts**.

That is not a miss. It is a **MIS-MEASUREMENT**: the gate affirmatively measured
a threefold overstatement as truthful. Two more forms were confirmed:
`"Two Hundred and Fifty Billion CFU"` read as 50 the same way, and
`"A Hundred Billion CFU"` evaded entirely because an article cannot lead a run.
C24 still *detected* the and-form in a dosage attribute — detection needs no
measurement — so the defect was C12-specific, i.e. the half N3 was for.

**Why the N3 battery did not find it.** Every N3 case used a connector-free
numeral (`Fifty Billion CFU`, `Ninety Billion CFU`, `Five Hundred mg`,
`Two Thousand mg`). The suite tested the vocabulary it had; it did not test what
happens at the edge of that vocabulary. That is the general lesson here, and it
is why the Y1 battery asserts behaviour with the pack list **emptied** as well
as full.

**TWO FIXES. The second is the one that closes the class.**

**(1) The INERT CONNECTOR is pack data in its own right.**
`rules.attributeGuard.spelledOutNumbers.connectors` — `and`, `a`, `an` on this
pack. It is a list of **words**, not word→value pairs, and the shape is
load-bearing rather than cosmetic: being valueless is what a connector IS, so no
`value > 0` filter can strip one out of a string list and leave the pattern and
the value table disagreeing. `lib/gate` names no connector, so
`tests/category.literals.test.ts` stays green.

Two placement rules, both structural and both in the pattern:

| rule | effect |
| --- | --- |
| a connector inside a run is **glued to the value word after it** | a run does not begin or end on one — `"fifty and"` + a unit is not a figure, pinned by *"Y1 (d): the refusal is vocabulary-INDEPENDENT — an unknown joiner is refused too"* (`"Fifty and Sixty mg"` → no reading) |
| a connector may **lead** a run only in front of a magnitude, and only one the caller does not also append as a **unit** | `"A hundred"` is 100; `"a Billion CFU"` stays the UNIT reading the digit scan gives `"1 Billion CFU"`, so a truthful `1 Billion CFU` listing is not failed as 1,000,000,000 |

and one composition rule, in `composeSpelledValue`: a connector is accepted only
where English puts it — leading (supplying the implicit one) or directly after a
magnitude. `"fifty and sixty"` is therefore **not** composed as 110; it returns
`null`, i.e. no reading.

**(2) THE READER REFUSES A FRAGMENT — the actual root cause.**
`hasUnreadFigureBefore` in `lib/gate/checks/shared.ts`. A run the reader cannot
read WHOLE now yields **no figure at all** rather than the value of part of
itself. The guard is deliberately **vocabulary-independent**, because the
fallback recurs with any word a pack happens to lack:

- the token in front of the match is a value-bearing number word or a bare digit
  run the match did not consume → fragment (`"Hundred Fifty Billion CFU"`);
- the token in front is a FUNCTION word (`nonAttributingWords` — structural
  English plus every token the pack declares as a unit, dosage form, per-dose
  phrase, potency verb or supply cue) and the token before THAT is a value word
  → fragment. This is the `and` case, and it consults **no connector list**, so
  it fires for `and`, `plus`, `or` and anything else of that shape whether or
  not the pack declares it.

It stops there, and the stopping rule is the false-positive control: a CONTENT
word in front of the run ENDS the numeral to its left. In `"Ten Strains Fifty
Billion CFU"` the `Ten` belongs to `Strains`, so that reading is kept and a real
detection is not silently dropped; `"Ten Billion CFU and Fifty Billion CFU"` is
a LIST of two complete figures and both are read; clause punctuation ends the
search entirely.

**THE CHOSEN BEHAVIOUR ON A HIT IS TO REFUSE TO MEASURE, NOT TO FAIL CLOSED —
and the defence.** Failing closed would mean emitting a compliance failure about
a figure the reader has just said it cannot read, and it would be an over-block
the operator cannot act on, because the message could not name a correct figure.

**CORRECTED (Z2, adversarial review).** This paragraph used to defend that with
`"Ten Billion CFU and Fifty Billion CFU"` as an example of *lawful copy a
fail-closed guard would wrongly fail*. **That example was wrong**, and the
reviewer ran it: under the shipped pack that input produces **two C12 failures**
— `Potency 'Ten Billion CFU' disagrees with canonical facts.potency
'50 Billion CFU'` plus `Two different potency figures in one surface — internal
conflict`. It is a list of two COMPLETE figures, so the fragment guard never
sees it at all; it demonstrated nothing about refusal. Its companion
`"Ten Billion and Fifty Billion CFU"` fails too (one failure, on the composed
`Ten Billion`). Both are struck.

**The replacement, which has actually been run.** The lawful copy that reaches
the guard is the **truthful form of the very sentence the guard refuses**:

```
bullets[0]    = "Now One Hundred & Fifty Billion CFU."
facts.potency = "150 Billion CFU"
=> C12 silent on that bullet (the reader refuses; no reading, no failure)
```

The copy is true, the reader cannot compose it, and a fail-closed guard would
report that true sentence as a compliance failure. That is over-blocking, which
this project treats as exactly as severe as a bypass. Pinned by
*"Z1 (b): the truthful forms of the same five sentences still PASS"*.

**What refusing is verified to do — no absolute.** On the strings the Y1 and Z1
batteries name, a refused run yields NO reading, so no fragment is compared
against the canonical fact; the truthful forms of those same sentences stay
silent; and the golden fixture still produces zero gate failures
(*"Y1 (d)"*, *"Z1 (a)"*, *"Z1 (b)"*, *"Z1 (f)"*).

**CORRECTED (Z2, adversarial review).** This paragraph used to say refusing
*"can never affirm a false figure as truthful, and can never report a true one
as false"*. **That was FALSE as written, and Z1 (2.4.9) disproves it**:
`"Now One Hundred & Fifty Billion CFU."` against a canonical `50 Billion CFU`
composed the sub-run to 50 and affirmed a threefold overstatement as agreeing
with the facts — through the guard this sentence said could never do that. The
claim was forward-looking and unbounded; the mechanism it described (the guard)
was itself the thing that could fail. It is replaced by the paragraph above,
which names tests instead. **This is the third consecutive round in which a
forward-looking absolute in this record has been falsified** (2.4.6's "an untrue
word-form per-serving figure is now caught by C12", then this one), so the rule
this file now follows is: state what a NAMED test pins, and let the residue be
residue.

What refusing costs is **coverage**, and that cost is bounded and deliberately
covered elsewhere rather than assumed away: C24 still DETECTS the same string in
a dosage attribute, and Y2 (2.4.6) gave C10/A5 the same detection on customer
copy — because detection needs no composed value. This is the same division of
labour that already makes C24 exist separately from C12.

**Both directions, by test name** (`tests/complianceCompletions.test.ts`, under
`Y1 — connectors, and the fragment the reader refuses (C12)`):

| letter | test | what it pins |
| --- | --- | --- |
| (a) | *"Y1 (a): all three PROVEN bypasses now FAIL C12 against a contradicting canonical figure"* and *"...the whole gate reports them — the reviewer ran `runGate`, so this does too"* | the three exact strings |
| (b) | *"Y1 (b): the same three forms, TRUTHFUL, still PASS"* | the over-block direction: the bullet is silent, and the whole listing behaves identically to the digit form of the same truthful sentence |
| (b) | *"Y1 (b): truthful in the OTHER script too — a word-form canonical FACT matches digit copy"* | the fact side reads the connector form as well |
| (c) | *"Y1 (c): word form and digit form resolve to the SAME number, asserted against the digit scan"* | value, unit AND dimension asserted equal to `extractUnitNumbers` on `150/250/100 Billion CFU` |
| (c) | *"Y1 (c): the three named values are 150, 250 and 100 exactly"* | plus `A Thousand mg` = 1000 and `Two Thousand and Five Hundred mg` = 2500, so the rule generalises rather than special-casing three strings |
| (d) | *"Y1 (d): with connectors emptied, the and-form resolves to NOTHING — never to the fragment"* | the chosen safe behaviour, asserted **explicitly** on the reader (`[]`, where the pre-Y1 answer was `[{ value: 50 }]`) |
| (d) | *"Y1 (d): the refusal is vocabulary-INDEPENDENT — an unknown joiner is refused too"* | `plus`, `or`, a leading magnitude, and a connector English does not put there |
| (d) | *"Y1 (d): refusing is NARROW — a complete figure beside another quantity is still read"* | the coverage the guard must NOT cost |
| (e) | *"Y1 (e): connector-bearing lawful prose still PASSES"* | `"one and a half servings"`, `"a hundred percent"`, `"take one and then another"`, `"two and three"`, `"a one-time purchase"` and nine more, against C12 **and** C10 |
| (e) | *"Y1 (e): the whole N3 lawful-prose battery is unchanged by the connector leg"* | the reviewer's original battery, re-run |
| (f) | *"Y1 (f): emptying the pack vocabulary restores EXACT digit-only behaviour"* | three emptyings; the digit failures asserted **equal** to the digit failures under the full pack, for C12 and C10 |
| (f) | *"Y1 (f): emptying ONLY the connectors narrows the reader — it does not reopen the fragment"* | the new list is a widener like the other two |
| (g) | *"Y1 (g): the golden fixture is untouched — still ZERO gate failures"* | plus C12, C10 and A5 individually silent on it |

**What is verified, stated precisely and no wider.** The three named strings fail
C12 under the shipped pack and pass when the canonical fact matches; the reader
composes `One Hundred and Fifty` / `Two Hundred and Fifty` / `A Hundred` to the
same numbers, units and dimensions the digit scan yields; and a run that reaches
`hasUnreadFigureBefore` or that `composeSpelledValue` returns `null` for produces
no reading. **This is not a claim that every uncomposable numeral is now
detected.** A word-form figure the reader refuses is measured by nothing —
C10/A5 detect the *attachment* shape (2.4.6) and C24 the *attribute* shape, and
neither is a measurement. That residue is the price of refusing, it is stated
here rather than argued away, and the way to shrink it is to add words to the
pack vocabulary — which is a pack change, not a gate change.

**A future change to Y1 must also change:** `spelledOutRunSource`,
`connectorWords`, `composeSpelledValue`, `hasUnreadFigureBefore`,
`previousToken` and `spelledOutFigureReader` in `lib/gate/checks/shared.ts`,
`AttributeGuardRules.spelledOutNumbers.connectors` in `lib/types.ts`,
`rules.attributeGuard.spelledOutNumbers.connectors` (+ its
`_spelledOutNumbersComment`) in `knowledge/rules.json`, and the `Y1:` cases in
`tests/complianceCompletions.test.ts`.

#### 2.4.9 Z1 — CLOSED CLASS: the guard was vocabulary-independent but not ORTHOGRAPHY-independent

**THE DEFECT, as an adversarial reviewer proved it through the real `runGate`,
after Y1 shipped.**

```
description   = "Now One Hundred & Fifty Billion CFU."
facts.potency = "50 Billion CFU"
=> ZERO gate failures — and NOT by refusal
```

The reader composed the sub-run `"Fifty Billion CFU"` to **50** and the check
affirmed a threefold overstatement as agreeing with the facts: the same
MIS-MEASUREMENT Y1 existed to close, through the same guard, one round later.
Four more forms were confirmed — `+`, `/`, `"100 & Fifty Billion CFU"` and
`"One Hundred n Fifty Billion CFU"` — and all five were reachable from the
description, the bullets, the title and the Q&A.

**WHY Y1's GUARD DID NOT FIRE.** `previousToken` skipped only `[\s\-]` and
returned `null` on any other character outside `[A-Za-z0-9']`. `&`, `+` and `/`
therefore read as **clause punctuation that ends the neighbourhood**, so
`hasUnreadFigureBefore` concluded there was nothing unread in front of `Fifty`
and the fragment guard never ran. The guard was vocabulary-independent exactly as
designed and as tested — the Y1 battery emptied the connector list and asserted
`plus` and `or` — but every one of those cases was a WORD. Nobody tested the
same joiner written as a glyph, and `&` is the single commonest written form of
"and" in Amazon listing copy; `normalize` even decodes `&amp;` into `&` before
the guard runs. The en/em/non-breaking DASH class had been handled (`normalize`
folds it, so `"One Hundred — Fifty"` correctly reads 150); the joiner-GLYPH class
was missed. `n` slipped through a different door: a one-letter token is not a
function word, so the guard treated it as a CONTENT word that owns the numeral to
its left — while `isAttributed`, ten lines above it in the same file, already
refused to attribute a figure to a one-letter token. The two disagreed.

**THE RULE, and where the line is drawn.** A **JOINER** — a glyph, or a token
carrying a single letter, that stands in for a joining WORD inside a phrase — is
a **GAP**: it does not end the neighbourhood, so the fragment guard sees the
value word behind it and the reader **refuses**. A **CLAUSE BOUNDARY** — `.` `,`
`;` `:` `!` `?` brackets, quotes — still ends it.

| shape | example | behaviour |
| --- | --- | --- |
| joiner glyph | `"One Hundred & Fifty Billion CFU"`, `+`, `/`, `&amp;`, fullwidth `＆` | GAP → refused, no reading |
| one-letter token | `"One Hundred n Fifty Billion CFU"`, `"One Hundred 'n' Fifty…"` | GAP → refused |
| function word (Y1) | `"One Hundred and Fifty Billion CFU"` | GAP → composed WHOLE (150) when the pack declares the connector, refused when it does not |
| content word | `"Ten Strains & Fifty Billion CFU"` | TERMINATES → `Fifty` is complete, read as 50 |
| clause boundary | `"Ten Billion CFU. Fifty Billion CFU"`, `", Fifty…"`, `"(Fifty…)"` | ENDS the neighbourhood → both figures read, exactly as before |
| line break | `"One Hundred\nFifty Billion CFU"` | `normalize` collapses whitespace, so this is a SEPARATOR: the run is read WHOLE (150), never as the fragment 50 |

**WHY REFUSE RATHER THAN COMPOSE.** `&` is genuinely ambiguous — it may mean
"and" (one figure, 150) or a list separator (two figures, 100 and 50) — and `/`
does not mean "and" at all. Composing any value would be an invention, and
composing the wrong one would be the Z1 defect again with a different number. The
reader refuses, and what the tests pin is the thing that matters: **none of the
five composes 50**.

**WHY THIS IS ENGINE DATA AND NOT PACK DATA.** The glyph class is
**orthography**, not domain vocabulary — it lives beside the `[\s\-]` separator
class in `previousToken` and the dash fold in `normalize`, both of which are
already engine-side, and it names no unit, ingredient or category word, so
`tests/category.literals.test.ts` stays green. The pack keeps what the pack is
for: **words** (`spelledOutNumbers.connectors`). Putting the glyphs in the pack
would make a compliance guard that a pack could silently forget — a widener
where this needs a fail-closed default.

**THE COST OF DRAWING THE LINE WRONGLY IS ONE-SIDED**, which is why the class can
be drawn generously. A gap only ever produces a REFUSAL, and a refusal emits no
failure. Mis-classifying a real boundary as a joiner loses coverage; it cannot
manufacture a failure against lawful copy. Mis-classifying a joiner as a boundary
is this defect.

**Both directions, by test name** (`tests/complianceCompletions.test.ts`, under
`Z1 — joiner glyphs are a GAP inside a numeral, not a clause boundary (C12)`):

| letter | test | what it pins |
| --- | --- | --- |
| (a) | *"Z1 (a): all five PROVEN bypasses now resolve to NOTHING — none composes 50"* | the outcome is REFUSE, asserted on the reader, and `50` asserted absent |
| (a) | *"Z1 (a): through the WHOLE gate, against a contradicting canonical, on every surface"* | all five × description / bullets / title / Q&A: no potency reading, and no gate failure that cites `facts.potency '50 Billion CFU'` |
| (a) | *"Z1 (a): the pre-Z1 behaviour is pinned as GONE — the fragment guard, asserted directly"* | eight strings including `"'n'"`, `"&/"` and a fullwidth `＆`, each `[]` where the pre-Z1 answer was `[{ value: 50 }]` |
| (a) | *"Z1 (a): the refusal is VOCABULARY-independent — it holds with the connector list emptied"* | the Y1 property, re-asserted for the glyph class |
| (b) | *"Z1 (b): the truthful forms of the same five sentences still PASS"* | the over-block direction, at three different canonical figures |
| (b) | *"Z1 (b): a joiner glyph beside a COMPLETE figure is still read and still measured"* | `"Ten Strains & Fifty Billion CFU"` = 50, `"Ten Billion CFU & Fifty Billion CFU"` = 10 and 50, and an overstatement beside a strain count still reported |
| (c) | *"Z1 (c): genuine clause boundaries still end the neighbourhood — 50 is still read"* | thirteen inputs across `.` `,` `;` `:` `!` `?` brackets and quotes |
| (c) | *"Z1 (c): a line break inside a run is a separator, and the run is read WHOLE — never as 50"* | the one item on the boundary list that `normalize` has already turned into a space |
| (c) | *"Z1 (c): and those clause-boundary readings behave through C12 exactly as they did"* | the boundary cases are still MEASURED, not refused |
| (d) | *"Z1 (d): `&amp;` behaves identically to a literal `&` once `normalize` has decoded it"* | asserted as equality of the readings AND of the C12 output |
| (e) | *"Z1 (e): the lawful-prose battery still passes on every surface"* | the reviewer's ten sentences plus five written with glyph joiners, against C12, C10 and A5 |
| (f) | *"Z1 (f): the golden fixture is untouched — still ZERO gate failures"* | plus C12/C10/A5 individually silent |
| (f) | *"Z1 (f): an emptied vocabulary still restores EXACT digit-only behaviour"* | two emptyings; digit failures asserted **equal** to those under the full pack |

**What is verified, stated precisely and no wider.** The five named strings
produce no reading under the shipped pack, on four surfaces, and no gate failure
citing the canonical fact; their truthful forms stay silent; the thirteen named
clause-boundary inputs still read the figures they read before; `&amp;` and `&`
behave identically; the golden fixture is still at zero. **This is not a claim
that the joiner class is complete.** A glyph nobody has thought of would behave
as a boundary and could hide a fragment again — that residue is the same shape as
the one Y1 left and Z1 found, it is stated here rather than argued away, and the
way to shrink it is another adversarial round.

**A future change to Z1 must also change:** `JOINER_GLYPHS`, `isJoinerGlyph`,
`isJoinerRun`, `previousToken`, `isNumeralGap` and `hasUnreadFigureBefore` in
`lib/gate/checks/shared.ts`, and the `Z1` cases in
`tests/complianceCompletions.test.ts`.

#### 2.4.10 Z3 — two smaller items from the same review: a missing unit, and an assumption about pack shape

**(a) `million cfu` was not a pack unit token — ADDED.** `"Two Hundred Thousand
Million CFU"` and its digit twin `"200,000 Million CFU"` both shipped silently.
Digit/word parity, so this was a **pack-DATA gap, not an engine regression**. The
exotic string was not the worst of it: a canonical `facts.potency` of
`"500 Million CFU"` parsed to **nothing**, which switched the potency comparison
**off for the whole listing** — the same failure mode N3's own header warns about
for word-form facts.

**DECIDED: add the COMPOUND `million cfu` to `units.dimensions.potency` and to
the `cfu` family; do NOT add the bare magnitude `million`.** The bare word is
ordinary listing prose, and adding it was measured, not guessed: with `million`
declared as a unit token, `"Two Million Happy Customers"` and `"Over One Million
Servings Sold"` are read as potency figures and **fail C12** against
`facts.potency`. The compound cannot do that, because `million` must be followed
by `cfu` to match at all. Pinned in both directions by *"Z3 (a): the gap is
closed in BOTH scripts, and the two agree"*, *"Z3 (a): a million-scale canonical
FACT is now readable, so the potency leg is armed at all"* and *"Z3 (a): the
OVER-BLOCK direction — ordinary `million` prose is untouched"*, the last of which
also asserts the pack contains `million cfu` and does **not** contain `million`.

The bare `billion` stays, because it is how probiotic copy actually writes the
hero figure. The asymmetry is deliberate and is recorded here rather than
smoothed over: `"Two Billion Happy Customers"` would be read as a potency figure
today, and that is a pre-existing bound of declaring a bare magnitude as a unit,
not something Z3 introduced.

**The family bound, stated.** Family membership makes two figures COMPARABLE; it
does not SCALE them. A listing that restates its hero figure across magnitudes
(`"50 Billion CFU"` and `"50,000 Million CFU"`) is reported as a disagreement.
That is the same bound the family already carried for `cfu` against
`billion cfu`, it is now noted in `_familiesComment` in `knowledge/rules.json`,
and closing it would mean giving units a scale — a larger change than this item
justifies.

**(b) The `unitTokens` lead-exclusion assumed a pack shape — CLOSED rather than
recorded.** `spelledOutRunSource` refuses to let an inert word lead a run in
front of a magnitude that the caller also appends as a unit, so `"a Billion CFU"`
stays the UNIT reading the digit scan gives `"1 Billion CFU"` instead of
composing 1,000,000,000. That comparison was an **exact match**, and it was safe
only because the shipped pack happens to declare the bare `billion` alongside the
compound `billion cfu`. For a pack whose only potency unit was the compound,
`billion` would have stayed leadable and `"A Billion CFU"` would have composed a
thousandfold reading of a string the digit scan reads as 1.

Not a live defect — but the fix is one line and is a pure **narrowing** (it can
only withdraw a reading, never manufacture one), so it is closed rather than
merely recorded: the test is now a whole-word **prefix** match, so a magnitude
that OPENS any appended unit token cannot lead. Adding `million cfu` in (a) made
this load-bearing immediately: without it, `"A Million CFU"` would have composed
1,000,000 while `"One Million CFU"` read 1 `million cfu`, from the same pack.
Pinned by *"Z3 (b): a compound-only pack reads the same figures as the shipped
one"* and *"Z3 (b): an inert lead is still allowed in front of a magnitude that
opens no unit token"*; the shipped pack's own shape is stated by *"Z3 (b): the
shipped pack does ship the bare magnitude — the assumption, stated"*.

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
  but **not the same value shape**: this app reads a spelled-out figure as well
  as a digit one, and so do `C12` (item 2, N2/N3) and `C10`/`A5` (item 2.4.6, Y2)

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
brief surfaces of item 1) — **§14.1 later scoped that sentence to what it was
always about: a rival brand. A `negative` row whose term IS a compliance-lexicon
term is deferred to the check that owns the lexicon and enforces it in context,
and it still fails the run there.** A `backend` row on a visible surface still fails; a
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
`negative` row.

**CORRECTION (AC-G2) — the previous wording UNDERSTATED the residual.** This
paragraph used to end: *"the one-word case is left to the model's `negative` row
(which still works, and still fails from every surface)."* Every word of that is
true and it is the wrong emphasis, because it reads as if the residual were "the
model has to remember". **The model is not obliged to write `negative` at all,
and nothing checks that it did.** An acceptance audit reproduced the larger
case: a one-word rival labelled **`not-targeted`** — a status C28 deliberately
does not scan — produces **zero** C28 failures and the brand ships in verified
copy.

**THE ESCAPE, STATED EXACTLY.** With competitors supplied and a one-word rival
brand present in the copy, C28 raises nothing when the keyword row carries
`not-targeted`, when it carries `placed` (the placement leg is *satisfied* by
the term really being in the copy, and a brand name is in none of the lexicons
the four-test screen reads), **or when there is no row at all**. The residual is
therefore the RESOLVER bound (`MIN_BRAND_WORDS` in `lib/audit/rivalBrands.ts`),
not the status word: the same `not-targeted` row on a MULTI-word rival brand
still fails, through the automatic leg. What survives of the original sentence
is narrower and is stated as such: *a `negative` row written on the one-word
brand still fails, from every surface* — it is a route that works, not a
guarantee that anything takes it.

`tests/rivalBrands.gate.test.ts` §(d) pins all six of those statements, in both
directions, including the bound's own justification (the "NOW" listing that must
stay green).

**THE BOUND STAYS — the merits, judged rather than assumed.** The obvious
widening is to admit a one-word competitor brand when it is an exact whole-token
match against an operator-supplied competitor's `brand_name` **and is not an
ordinary English word by some pack-declared test**. The first half is fine — it
is the same operator-supplied fact the multi-word leg already uses. **The second
half is the problem, and it is not a problem of effort.** No pack declares an
ordinary-word vocabulary, and one written for this purpose could not be
complete: English is open, brand names are drawn from all of it, and the list
would have to enumerate every ordinary word that any brand in any category might
also be. **An incomplete list fails in the OVER-BLOCKING direction** — a
one-word brand that IS an ordinary word but is missing from the list becomes an
automatic negative, and every lawful use of that word in our own copy becomes a
gate failure the operator cannot argue with. That is the "unwinnable run" defect
bound 3 exists to prevent, arriving through a different door, and it would be
introduced by a list whose incompleteness is guaranteed rather than accidental.
A bypass that requires an operator to have supplied that exact competitor is a
smaller harm than a wall that fires on ordinary prose, so the bound is kept.

**What was considered and NOT done, so the next reader does not re-derive it.**
A row-level leg (fail any keyword row whose term is an exact whole-string match
of an ingested competitor's brand and whose status is not one of
`negative`/`candidate`/`captured-via`) would close the audit's exact
reproduction without touching the copy scan, and it carries no lawful-copy
over-blocking risk because it can only fail a ROW. It is not implemented here
because it closes only the sub-case where the model wrote a row naming the
rival — the bare-brand-in-copy case above is untouched by it — and shipping a
partial close under this section would invite exactly the "reads better than it
is" error this correction exists to fix. It is recorded as available, not
rejected on the merits.

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

Both directions in `tests/rivalBrands.gate.test.ts` (30 cases): the mislabelled
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
untouched to the byte. (**§14.1 correction:** "untouched to the byte" is true of
the RIVAL-BRAND job the sentence is about, and that is the job R50 depends on.
The same status was also being used to record COMPLIANCE VOCABULARY, and that
half is now deferred to the checks that own it — never derived away, still
recorded, still counted, and still failing the run when the usage is a claim.)

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
No guidance array in the shipped packs qualifies — a sentence of guidance is not
a lexicon entry and satisfies none of (1)-(3) — so `promptRules.compliance`
stays fully scanned at any length. That is a property of the three exemption
tests plus the shipped pack data, verified by the canary rather than asserted
about all possible packs. (Z2 — this used to read *"A guidance array can never
qualify"*.)

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
same ASIN verified on its other run). C4 routing was re-read and is correct on
every path the routing tests exercise —
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

### 13.1 ARCHITECTURE CHANGE — a PROPERTY OF THE PRODUCT is not carried as a rival-exclusion term.

*(Z2 — this heading used to read "can never be a rival-exclusion term". It is a
RULE the derivation applies, and what is verified is the derivation's behaviour
on the cases in `tests/keywordDerivation.productProperty.test.ts` and
`tests/keywordDerivation.ownBrand.test.ts`, not an unbounded property.)*

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

> **SUPERSEDED (§17.1).** This verdict was wrong. The same shape recurred on
> ASIN B00IO89MYA (`2019 chars (1861 written + 158 appended)`) once the §13.1
> C28 defect that had been consuming the rounds was fixed and the C4 finding was
> the only one left. The facts above are correct and the 88-character figure is
> used in §17.1's sizing; what was wrong was concluding that a correctly-stated
> number needs no margin. The prompts and the repair line now state a **target**
> a derived 6% below the cliff. C4's trigger is unchanged in both directions.

---

## 14. ROUND S — `negative` was doing two jobs, and C28 owned only one of them.

### 14.1 ARCHITECTURE CHANGE — compliance vocabulary on the negative list is DEFERRED to the check that owns it.

**The live defect.** Production, ASIN B00WNDG7V8 (a dental probiotic). One
failure, and the run ended `verified: false`:

```
C28 | keywords[26] | negative term 'cavity' appears on 'attributes'
```

The attribute was
`recommended_uses_for_product = "General wellness support for oral cavity function"`.

**"Oral cavity" is anatomy — the mouth — not dental caries.** The copy is lawful,
and **C6 correctly did not fire on it**: `cavity` is a disease noun in the pack's
`oral` subcategory list, `oral cavity` is a `benignContextPhrases` entry, and C6
subtracts the benign span. Only C28 fired, because its `negative` leg was a plain
whole-term match with none of C6's de-obfuscation, negation guard or
benign-context subtraction. The only fix the failure asked for was *"delete a
lawful anatomical phrase from your own attributes"*, so no repair round could
clear it.

**The root cause is not the term — it is that one status carried two jobs.**

1. **Rival-brand exclusion (R50/AM-9)** — the actual purpose of `negative`, and
   the reason C28 scans every surface. A rival brand is in **no lexicon** (a
   brand name is not a lexicon item, it is a fact about the market — §7 is built
   on exactly that), so C28 is the only thing in this system that can enforce it.
2. **"Compliance terms to avoid"** — which the compliance checks already enforce,
   properly and in context: **C6** (customer copy, attributes, `facts.*`) and
   **A2** (every A+ field, FAQ included) over the cross-pack disease and
   action-paired lexicons, with de-obfuscation, the strict negation guard and
   pack-declared benign-context subtraction; **C19** over `superlativeBans` on
   every surface `rules.prohibitedMarketing.surfaces` lists, with no negation
   guard at all. C28 duplicating job 2 as a blunt substring match is **strictly
   less accurate than the check that owns it**, and this false positive is the
   bill for the duplication.

**The fix.** A model-declared `negative` row whose term **IS** a term of the
compliance lexicon **keeps its row** — it is useful documentation, it still
steers generation, and it still counts toward `minNegatives` — but it **raises no
C28 failure of its own**. The compliance checks are the authority on whether that
word's *usage* is a violation; if the usage is genuinely a claim, they fire and
the run fails there.

**Why deference and not "share C6's context machinery with C28's scan".** Both
were on the table. Sharing it would have been the wrong one, for a reason about
R50: C6's suppression is not a filter that can be bolted onto a term-vs-surface
match — it is a per-match-index reading of negation cues, meta-phrases and benign
spans — and running it over this leg would apply it **to rival brand names too**.
A rival's name parked inside a pack benign phrase, or behind a negation cue,
would stop failing. That is a direct weakening of the one thing that must not
weaken, and it would leave the duplication (the root cause) exactly where it was.
**The deference cannot reach R50 at all, because its gate is membership of the
compliance lexicon and no brand name is in it.**

**Four bounds, each one keeping job 1 at full strength.**

1. **Equality, never containment.** The whole term, normalised, must EQUAL a
   lexicon term — the `identityKey` discipline of §8/§13 applied here: sharing a
   word is not being the thing. A rival brand that merely CONTAINS a disease noun
   (`Cavity Guard Labs`) is not deferred, and neither is a claim phrase built
   around one (`cavity prevention`).
2. **Only what the owning checks actually enforce FOR THIS PACK.** C6/A2
   early-return without a compliance module and C19's superlative leg reads the
   ROUTED pack's own list, so **with no `compliancePack` nothing is deferred** and
   the leg behaves byte-for-byte as before. That is why `complianceOwnedTerms` is
   built separately from `bannedLexicon`, which is deliberately WIDER (cross-pack
   superlatives): a wider set only makes the four-test SCREEN stricter, but it
   would make this DEFERENCE looser.
3. **The automatic competitor-derived rival set (§7) is not touched.** It reads no
   status and no lexicon. Belt and braces: a deferred row no longer counts as
   "already reported", so it cannot silence that leg either — a rival brand string
   that collided with a lexicon term is still reported by the operator-supplied
   signal.
4. **The floor is unmoved.** `negatives` is incremented for a deferred row,
   because the row IS recorded on the negative list — which is exactly what
   `minNegatives` counts and exactly what its own failure text asks for ("the
   banned vocabulary and every rival brand name belong on it").

**Both directions, asserted.** `tests/complianceNegatives.deference.test.ts`:
(a) the live shape is C28-clean, `runGate().pass === true`, **and C6 is silent
too** — the copy really is lawful, not merely unreported; (b) a genuine claim
built on the same word (`Prevents cavities and reverses tooth decay`) still fails
the run from **twelve** surfaces, via C6/A2/C19; (c) **R50 unweakened** — a rival
brand marked `negative` planted in title / bullet / description / backend /
attributes / A+ `bannerAltText` / `videoBrief` / imagePlan `altText` still fails
every one; (d) the automatic set still fires from all eight and its resolver is
unchanged, including the colliding-brand case of bound 3; (e) the floor counts
deferred rows and still fails one row short; (f) the golden fixture gates with
zero failures; (g) with no compliance module nothing is deferred.
`tests/keywordPlacement.gate.test.ts` was updated in one place: the `disease`
case now asserts the division of labour — C28 silent, **C6 firing, run still
failing** — instead of asserting the C28 leg.

**Prevention, from pack data.** `rules.keywordRules.negativeScopeNote` now states
the split (a rival brand must appear nowhere in any context; compliance
vocabulary is enforced by the compliance rules, which read the word in context),
and `sheetNote` no longer claims that *every* negative term "was verified to
appear nowhere at all" — it says which negatives that is true of and who enforces
the rest. Both are prompt/report strings, not `REQUIRED_PACK_PIECES` rows.

**DECLINED, and why.** The keywords prompt was **not** changed to stop the model
recording compliance vocabulary as `negative`. That list is the record of the
vocabulary this copy avoids — C28's own `minNegatives` failure text says so — and
`minNegatives: 3` counts those rows; removing the class would make the floor
harder to reach for no gain, and the row still steers generation. The model did
nothing wrong here in any case: it recorded `cavity` exactly as the compliance
rules name it.

**STATED RESIDUAL RISK.** A rival brand whose whole normalised name is EQUAL to a
compliance-lexicon term would not raise the model-declared C28 leg. Three things
bound it: the match is whole-term equality against a lexicon that contains no
brand names; the operator-supplied competitor set is unaffected and still fails
the run (asserted); and the owning compliance check still scans that string on
every surface.

**A future change to this must also change:** `complianceOwnedTerms`, `termKey`,
the `negative` case and the `declaredNegatives` filter in
`lib/gate/checks/c-keywords.ts`, `negativeScopeNote` / `sheetNote` in
`knowledge/rules.json`, §5 and §10.3 above, and
`tests/complianceNegatives.deference.test.ts` +
`tests/keywordPlacement.gate.test.ts`.

---

## 15. ROUND V — a proven false-notice exploit, two defects it rode in on, and three factual errors in the record.

### 15.1 THE EXPLOIT — U1's banner could be raised on a run that did not degrade.

**Proven at runtime against the real composition**, on both trigger paths, before
anything was changed:

```
VERIFIED= true  DEGRADED= null
FIRSTFAILURE= {"class":"APIError","status":529,"apiType":"overloaded_error",
               "summary":"Generation failed: the upstream model API returned a server error (status 529, overloaded_error)."}
```

**The mechanism.** `recordUpstreamFailures` latched the FIRST call failure of a
run and never let go, on the reasoning that `withTransientRetry` sits inside it
and therefore only ESCAPED failures are ever seen. The reasoning had a hole and
the hole was reachable: `generateGroup`'s reparse retry sits **above**
`withTransientRetry` and re-attempted **any** error, so a call failure that
escaped the retry wrapper was followed by a SECOND call — and when that call
succeeded, **the group succeeded**. The run came back `verified: true` with zero
degraded groups, `firstFailure()` was still latched, `/api/optimize` attached it
**unconditionally** (no cross-check against `optimized.degradedGroups`), U1's
banner rendered *"generation never ran — the failures below are NOT a judgement
of your listing"*, and `saveRun`/`updateRun` persisted it — where `updateRun` was
**set-only and could never clear it**.

Two paths, both demonstrated:

1. a one-shot `"LLM returned no text content"` blip. Classified **non-transient**
   (fails closed — it is not an SDK error), so `withTransientRetry` passes it
   straight through to the reparse retry, which recovers it.
2. a 529 persisting through all three wrapper attempts, then succeeding on the
   reparse call.

**Why this is the dangerous direction, not merely an over-report.** On a run with
GENUINE compliance failures plus one recovered blip, the operator is told those
failures are not a judgement of their listing. That is precisely the
operator-conditioning hazard U1 was built to prevent — a false "the upstream API
failed" caption teaches operators that gate failures are noise, and the next real
one gets waved through — printed in U1's own words and colours. And one blip
during a regenerate branded a healthy stored run amber in History **permanently**.

### 15.2 THE RULE, and why it is truthful in the PARTIAL case.

Two changes, both required, neither sufficient alone.

**(1) The recorder un-latches per group.** `recordUpstreamFailures` now holds a
failure open **per group** and **clears it when that same group later returns a
value**. What survives is exactly "this group's copy could not be fetched" — the
claim the notice makes and the claim `degradedGroups` makes. The two agree by
construction rather than by hope.

**(2) The route cross-checks against `degradedGroups`.**
`recordedGenerationFailure(recorder, optimized.degradedGroups, ALL_GROUPS.length)`
intersects the unrecovered call failures with the run's own record of what is
missing. The intersection is the notice's **SCOPE**.

Neither side alone is right. `degradedGroups` alone would caption a purely
schema-degraded group "the upstream model API could not be reached" — a second
false statement of cause. The recorder alone is *nearly* right after the
un-latch, and "nearly" is what the exploit was made of; `degradedGroups` is what
`GEN` and therefore `verified` are computed from, so intersecting with it makes
the notice a subset of the verdict's own evidence no matter what composition is
built around this later.

**THE PARTIAL CASE — some groups degraded, others recovered.** Silence would be
wrong: there is a real, unexplained hole in the copy and the operator has to know
about it. So the notice is still raised, and it is **scoped**. `GenerationFailure`
gains `groups` and `groupsTotal`, and `lib/shared/generationFailure.ts` derives
the wording from them:

| scope | caveat |
|---|---|
| whole run (`groups.length === groupsTotal`) | *"The failures shown below are NOT a judgement of your listing."* — unchanged, byte for byte |
| partial | *"The failures shown below that come from `bullets, qa` are NOT a judgement of your listing. **Every other failure below IS**: those surfaces generated normally and the gate graded real copy."* |
| unknown (`groups` absent) | the whole-run wording |

The second row is the whole point. An unqualified caveat on a partially degraded
run tells the operator that compliance failures on copy the model really wrote
are not about their listing — the exact hazard, one case narrower.

**UNKNOWN scope is the LEGACY case only.** Every writer sets scope. A stored row
without it was written by the code that attached the notice unconditionally;
rendering it with the whole-run wording is byte-for-byte what it rendered
yesterday. This change stops false notices being **written**; it does not
retroactively re-caption stored ones, because there is nothing in the row to
re-caption them from. Half a record (`groups` with no total, or the reverse)
degrades to unknown rather than to a guess.

### 15.3 `updateRun` IS NO LONGER SET-ONLY — it is SCOPED.

U3 made the column write-only-upward and the reason was right: *a regeneration
rewrites ONE group of nine, so a notice that vanished on the first good group
would announce a recovery that did not happen.* The **rule** was blunter than its
**reason**. A run whose only degraded group was successfully regenerated stayed
amber forever, and once §15.1 could brand a healthy run amber at all, "can never
be cleared" made that permanent.

The rule is now: **a notice covers a set of groups and survives exactly as long
as any of them is still degraded.**

* recovering **one of several** → narrowed (`['bullets','qa','images']` →
  `['qa','images']`), and the wording follows the narrowed scope;
* recovering **all of them** → cleared (`generation_failure` written as `null`);
* recovering **none** → untouched;
* a **single-group regenerate** narrows by at most that one group — the other
  eight are still in `degradedGroups` and hold the notice open on their own. U3's
  reason is preserved as a **consequence** of the rule rather than as a separate
  prohibition.

`updateRun` reads the stored value first, and **fails toward set-only**: a read
error that is not "the column is not there" is logged and answered with
"unknown", which never clears anything. A legacy notice with no scope is never
narrowed and never cleared, exactly as under U3. The identical two-step
(`narrowGenerationFailure` → `mergeGenerationFailure`) runs in `ResultsPanel`
against the live session, out of the same module, so the panel and History cannot
disagree.

### 15.4 CORRECTED RECORD — "a 400 is sent EXACTLY ONCE" was FALSE when written.

U2's commit message ends: *"§4's call-count assertion is the one that matters
most: a 400 is sent EXACTLY ONCE, because 'it degraded' is equally true of a
policy that burned three calls against an unpayable account first."*

**That was false when it was written, and U2's own test said so.** The test it
points at pinned:

```ts
expect(calls).toHaveLength(ALL_GROUPS.length * 2);
```

Nine groups × **two** calls. The second was `generateGroup`'s reparse retry,
which re-attempted **any** error including a transport one. During the
credit-balance outage the run made **18 calls, not 9**, against an account that
could not pay for the first nine. The claim was true of
`withTransientRetry` in isolation — which is all §4's unit assertions covered —
and false of the pipeline, which is what the sentence claimed.

**It becomes true only after V2.** `generateGroup` now scopes the reparse retry
to the classes `classify` calls model-derived (`ZodError`, `SyntaxError`, and the
module's own no-JSON-found error), asked as `classify(e) !== 'transport'` so it
is a consequence of the existing taxonomy rather than a second list beside it. A
transport failure goes straight to the degrade path with the reason it always had.
The test now pins `ALL_GROUPS.length`, and
`tests/reparseScope.deadline.v2v3.test.ts` §1 asserts the same thing directly at
both the `generateGroup` and the pipeline level.

The second harm was as bad as the wasted call: `detail` is fed to the **model**
as *"your previous output was invalid: 400 {...credit balance too low...}"*. The
model produced no previous output, there is nothing for it to correct, and a
redacted SDK error was being sent back upstream to be read as a description of
the model's own work.

### 15.5 CORRECTED RECORD — "the reparse path … is not reached from here and must not be" was FALSE.

`lib/engine/llm.ts`, in `withTransientRetry`'s policy note, under `NOT SEEN`.
Call failures **did** flow into the reparse retry — that is the same defect as
§15.4 and it is the mechanism of the §15.1 exploit. The comment now records what
it got wrong, and the sentence is true as a **property of `generateGroup`**
rather than as an assertion in a comment about a function that could not enforce
it.

### 15.6 CORRECTED RECORD — U3's "72 assertions" is 72 TEST CASES.

U3's commit message says *"tests/generationFailure.history.u3.test.ts, 72
assertions"*. `vitest run` on that file at `6b33550` reports `Tests 72 passed
(72)` — that is **72 test cases**, and they contain many times 72 `expect`
calls. Test cases, not assertions.

### 15.7 V3 — the deadline projection could UNDER-project by 90 seconds.

`withTransientRetry` approved a retry when `now() + backoff + longestAttemptMs <=
deadline`, where `longestAttemptMs` is the longest attempt **measured** so far.
Measured attempts here are **failures**, and the cheapest failure is the fastest:
a 529 from the edge returns in single-digit milliseconds. After three of them the
check reserved ~5ms for a call the transport is willing to spend **90 seconds** on
(`CLIENT_TIMEOUT_MS`, the SDK client's `timeout`). A retry approved at 239.9s of
the 240s mark could therefore run 90 seconds past it — into the platform kill at
`maxDuration`, into the 502 that loses every surface and every gate finding. The
deadline's own check was approving the overrun it exists to prevent.

**The fix:** project the un-happened attempt as its **worst case** —
`max(longestAttemptMs, CLIENT_TIMEOUT_MS)`. A measured attempt that beat the
timeout still wins, because it is evidence and the constant is only a bound. The
timeout is now a named export used by both the client construction and the
projection, so a 90s transport and a 60s reservation cannot drift apart.

**THE ARITHMETIC, for an ordinary run** (`tests/reparseScope.deadline.v2v3.test.ts`
pins all three numbers). `/api/optimize`: `maxDuration` 300s × 0.8 = a **240s**
mark. A retry at elapsed `t` is approved while `t + backoff + 90_000 ≤ 240_000`:

| backoff | latest elapsed time at which a retry is still approved |
|---|---|
| 500ms (first retry) | **149.5s** |
| 1000ms (second retry) | **149.0s** |
| 30s (the longest server-advised wait this layer will obey) | **120.0s** |

So retries stay available for the first ~62% of the budget. The nine group calls
and the repair rounds all start well inside that window on any run that is not
already doomed, so ordinary retries are unaffected — the arithmetic only removes
the retries that were being approved in the last ninety seconds, which are exactly
the ones that could not have finished.

### 15.8 NO VERDICT MOVES.

`verified` is still computed only in `lib/audit/buildAudit.ts`, from the gate.
Everything in this round reads `degradedGroups` and writes nothing the gate sees:
the recorder still records-and-rethrows; V2 changes only how many times a failed
call is repeated and wraps the outcome in the `GroupGenerationError` with the
**same** `classify` reason and the **same** safe fields the second attempt would
have produced; V3 can only DECLINE retries, and a declined retry is the degrade
path that already existed. The golden fixture still gates with zero failures,
`tests/falsePositives.gate.test.ts` (206) is untouched and green, and
`tests/llmErrorDiagnosability.test.ts` §(e) — which pins that `verified`,
`degradedGroups` and the `GEN` failures are byte-identical across every failure
class — is unchanged and green.

**A future change to this must also change:** `recordUpstreamFailures`,
`recordedGenerationFailure`, `isReparseable` and the projection in
`withTransientRetry` (`lib/engine/llm.ts`); `narrowGenerationFailure`,
`mergeGenerationFailure` and the three wording functions
(`lib/shared/generationFailure.ts`); `updateRun` (`lib/store/runs.ts`); the two
routes; `GenerationFailureBanner` and the regenerate merge (`app/ResultsPanel.tsx`);
the notice blocks in `lib/export/markdown.ts` and `lib/export/shipSheet.ts`; and
`tests/generationFailure.scope.v1.test.ts` +
`tests/reparseScope.deadline.v2v3.test.ts`.

---

## 16. ROUND AC — three unrecorded compliance misses, one understated residual, and two scope calls.

An independent acceptance audit ran claims through the real `runGate` and found
three that shipped with **zero** failures, found that §7.4 understated its own
residual, and raised two amendments the record never resolved. §16.1–§16.4 are
the scope calls and the corrections that do not already live in §1.4 (AM-10d)
and §7.4 (the one-word rival escape).

### 16.1 THREE PROHIBITED-MARKETING CLAIMS SHIPPED CLEAN — closed in PACK DATA.

All three were **pack-data gaps, not engine defects**, and all three are closed
in `knowledge/rules.json` → `prohibitedMarketing.patterns`, which every category
pack shares:

| the claim | why it shipped | what closed it |
| --- | --- | --- |
| `"Rated 4.8 stars by our customers"` | the pattern ended `star\b`, so only the SINGULAR spelling matched | `stars?` |
| `"Over 4000 five star reviews"` / `"Over four thousand five star reviews"` | `star reviews` is not `reviews`, and `four thousand` is not `[\d,]+` | a context-anchored word-form rating pattern + a word-form review-count pattern |
| `"Amazon's Choice for probiotics"` | no pattern, and not in `superlativeBans` | a marketplace-badge pattern, plus `Editor's Choice` and the three Amazon deal-event names |

**THE NUMBER VOCABULARY IS REUSED, NOT FORKED.** The word-form patterns write
`{{numberWord}}` where a spelled-out number belongs, and
`prohibitedMarketingPatterns` (`lib/gate/checks/shared.ts`) substitutes the run
compiled by `spelledOutRunSource` from `rules.attributeGuard.spelledOutNumbers`
— the same vocabulary C24/C12/C10/A5 read (item 2). **The engine holds the token
name, never a number word**, so `tests/category.literals.test.ts` is unaffected.
C19 **and** A8 read the list through that one helper, so the A+ half of the same
lexicon cannot fall behind.

**OVER-BLOCKING WAS THE BINDING CONSTRAINT**, because `star` and `review` are
ordinary words in lawful supplement copy. The word-form rating pattern is
therefore **context-anchored on both sides** (`rated <word> stars` /
`<word> star review|rating|average`) rather than matching a bare `<word> star`:
`five star anise` is an ingredient, `star ingredient` and `the star of the
formula` are prose, and `our review process` / `peer-reviewed research` /
`third-party reviewed` carry no count at all. The sibling badge claims were
checked before anything was added, and most were **already covered** —
`Best Seller badge` by `best[- ]?sell(?:er|ing)`, `#1 New Release` by `#\s?1`,
`top-rated` by the ranking pattern — so only the genuinely uncovered ones were
added.

**BOTH DIRECTIONS:** `tests/prohibitedMarketing.badges.gate.test.ts` (159
cases) — the four reported strings on three surfaces, a 20-form matrix
(singular/plural, spaced/hyphenated, digit/word), the 11-case badge family, the
A8 half on A+ module bodies, a **32-string lawful battery on three surfaces
plus all of it in one listing**, the cosmetics pack in both directions, and the
disarmament assertions below. The golden fixture stays at **zero** gate failures
and `tests/falsePositives.gate.test.ts` (206) is untouched and green.

**`REQUIRED_PACK_PIECES`: no new row, deliberately.**
`rules.prohibitedMarketing.patterns` is **already** a manifest row and these are
entries in that list, so emptying it still fails the pack closed exactly as
before. The vocabulary the macro reads
(`rules.attributeGuard.spelledOutNumbers`) is **not** made a row, on the
reasoning that list already carries for C24/C12/C10/A5: emptying it **restores
exact digit-anchored behaviour** rather than disarming a check. That is asserted,
not asserted-about — with the vocabulary emptied or deleted the three word-form
patterns withdraw and every digit-anchored pattern in the same list keeps
working.

**COSMETICS NEEDED NO SECOND EDIT**, and that is a property of where the fix
went: `prohibitedMarketing.patterns` lives in `knowledge/rules.json`, which every
pack loads; only `superlativeBans` is per-category. The badge and rating claims
were put in the shared file **for that reason** — putting them in
`superlativeBans` would have forked the same rule into two compliance files and
would additionally have enrolled them in the C28 deference set, which is a
different rule with different consequences. `tests/prohibitedMarketing.badges.gate.test.ts`
asserts the cosmetics pack in both directions so a future move cannot silently
drop it.

**A future change to this must also change:** `prohibitedMarketing.patterns` and
`_ratingBadgeNote` in `knowledge/rules.json`, `prohibitedMarketingPatterns` /
`NUMBER_WORD_MACRO` in `lib/gate/checks/shared.ts`, its two callers
(`c19ProhibitedMarketing`, `a8AplusProhibitedMarketing`), and
`tests/prohibitedMarketing.badges.gate.test.ts`.

### 16.2 SCOPE CALL — WS2.1's launch-date field is ADDED, as an operator field.

WS2.1 named a launch date alongside price / GTIN / SKU and
`knowledge/attribute-schema.supplements.json` had **no field for it**. Added as
`launch_date`, `source: "operator"`, with the same treatment as the other four:
withheld from the attributes prompt, deleted from generated output if the model
volunteers one, exempt from C23 completeness, `required: false`,
`filterFacet: false`, `pendingTemplateConfirm: true` (it sits outside the 24-key
confirmed census, like every other operator key except `standard_price`).

**Why operator and not generated.** It is an **offer** fact, not a product-copy
fact: the date a seller wants an ASIN to become buyable lives in the seller
account and cannot be read from a detail page. A date this tool invented would
be a wrong date on a live listing for exactly the reason an invented price is,
and that is the rule `standard_price` already states.

**It cannot fail a run that would otherwise pass** — operator fields are exempt
from C23 by construction, which is what makes adding one safe.

**A correction rides along.** `tests/knowledge.test.ts` asserted
`attributeSchema.length === 39` with the comment *"35 generated + 4
operator-owned"*. The split was **34 generated + 5 operator**; the count was
right and the comment was wrong. It now asserts the operator subset by size as
well as the total (34 + 6 = 40), so the two cannot disagree again.
`tests/attributeSchema.test.ts` asserts the operator set by **equality**, so a
seventh cannot be added without that line changing, and pins `launch_date`'s
three properties directly.

**Cosmetics is deliberately NOT changed.** That schema is a narrower pack — it
ships four operator fields and no `standard_price` at all — and WS2.1 specified
the supplements template. Adding a key to a schema this app has not confirmed
against a shipped cosmetics listing would be inventing template surface, which
is the failure `pendingTemplateConfirm` exists to flag rather than to license.

### 16.3 SCOPE CALL — AM-10c's m7-CLOSE module is NOT made a required id.

**THE AMENDMENT.** AM-10c specifies A+ as m1–m5 **+ an m7-close + FAQ**.
`rules.aplusModuleIds` names five ids (`brand-story`, `hero`, `ingredients`,
`how-to-use`, `who-its-for`), the prompt asks for **5–7 modules** and the group
schema enforces `min(5).max(7)`. **No close module is required and none is
checked.** That difference was unrecorded; it is recorded here.

**THE DECISION: the current scope is right, and the close module stays
optional.** Three reasons, in order of weight.

1. **AN OBLIGATION WITHOUT A CHECK IS PROSE — this record's founding lesson
   (§1).** Every other required A+ element in this app is required *because a
   check can verify it*: A4 verifies the canonical name in the brand-story and
   hero modules, A9 verifies an audience cue drawn from pack data, the schema
   verifies comparison rows and FAQ count. "Close" is a **rhetorical function,
   not a checkable property**. Requiring the id and nothing else buys exactly one
   thing: the model emits `{"id": "close", …}` and every real question — does it
   close anything? — is still unanswered, while the record would now claim
   AM-10c was implemented.
2. **THE DIRECTION OF RISK IS WRONG.** A close module's natural content is the
   prohibited-marketing family: a CTA, urgency, a guarantee, a reassurance
   promise. That is precisely what C19/A8 ban and what §16.1 just widened. Making
   it **required** would push the generator toward the one content class most
   likely to fail the gate, in exchange for a module nothing verifies.
3. **THE CLOSE'S JOB IS ALREADY DONE BY TWO CHECKED BLOCKS.** The A+ payload is
   not five modules — it is five modules **plus** `comparison` (≥3 rows, keys
   fixed) **plus** a 5–10 pair `faq`. Differentiation and objection handling are
   what a close does, and both blocks do it under deterministic checks (row
   count, key names, FAQ bounds, `claimBearing`, and the A2/A8 content scans).

**WHAT THIS COSTS, STATED.** A+ ships with no summarising module, and a model
that wants one must use one of the two optional slots the 5–7 range already
leaves open — nothing forbids a close, it is simply not compulsory.

**IF THIS IS EVER REVERSED** it must arrive as a package: a new id in
`rules.aplusModuleIds`, the skeleton and the "required module ids" line in
`lib/engine/prompts/aplus.ts` (both render FROM that list, so they follow
automatically), a cue in `rules.aplusModuleCues` plus an A-check that verifies
something about the module's CONTENT, and the schema's `min(5)` raised in step.
An id added without the check is the move this entry declines.

### 16.4 NO VERDICT MOVES.

`verified` is still computed only in `lib/audit/buildAudit.ts`, from the gate.
§16.1 adds pattern rows and one macro substitution to a check that already ran;
§16.2 adds an operator field that is exempt from the only check that could fail
it; §16.3, §1.4 and the §7.4 correction are record entries and tests. The golden
fixture keeps **zero** gate failures with nothing weakened, and
`tests/falsePositives.gate.test.ts` (206) is green.

---

## 17. ROUND H — a correct number stated at the wrong place, and a floor that punished the engine's own corrections.

Both defects come from the same live run, **ASIN B00IO89MYA**, and both are the
same shape: a rule that was *arithmetically right* and *operationally
unwinnable*.

### 17.1 ARCHITECTURE CHANGE — the STATED description target now sits a derived margin below the C4 cap. This SUPERSEDES §13.2.

    C4 | description | 2019 chars (1861 written + 158 appended)

Every number in the system was already correct when this fired. §12.4 gave the
arithmetic one home (`descriptionBudget`), and both the generation prompt and
the C4 repair line stated **1842** from it. The model wrote **1861** — nineteen
characters past a correctly-stated ceiling — and the appended disclaimer carried
the assembled field nineteen characters past the hard cap.

So this is **not** an arithmetic defect, and §13.2 was right that far. What it
got wrong was the conclusion. Telling a language model to write "≤1842
characters" and enforcing failure at exactly 1842 leaves **zero** tolerance for
the ordinary variance of the thing doing the writing. The number the run was
told to hit was the number at which failure begins.

**THE FIX.** `descriptionBudget` now derives two more values from the same one
arithmetic:

    budget = max - reserve            the CLIFF   (1842) — never stated anywhere
    margin = ceil(budget * 0.06)      the MARGIN  (111)
    target = budget - margin          the TARGET  (1731) — what every prompt and
                                                   every fix line states

**C4's trigger is untouched**, to the byte: empty, or assembled length over
`rules.descriptionMax`. `target` is an instruction, not a limit. Nothing
operator-facing moved either — the ship sheet, the diff and the UI still show
the real 2000-character field limit, because that is the operator's constraint,
not the generator's.

**WHY 6%, AND WHY THIS SUPERSEDES §13.2.** There are **two** overshoots in this
record, and a margin sized to one of them leaves the other failing:

| run | written | stated | overshoot | as % of stated |
|---|---|---|---|---|
| §13.2 | 1930 | 1842 | 88 | 4.78% |
| §17.1 | 1861 | 1842 | 19 | 1.03% |

6% is **111 characters** on the supplements pack — 1.26x the worst observed and
5.8x the most recent. A **fraction** rather than a fixed count because a fixed
count would be a fourth hand-copied constant of exactly the kind §12.4 abolished
and would scale wrongly against any other `descriptionMax`.

**WHY NOT MORE.** The margin is paid for in description length on every run. At
6% the target keeps **94%** of the writable budget and **87%** of the hard cap;
1731 characters is still a full-length description that covers what the product
is, who it is for, how to use it and quality/safety. Trading a length failure for
a thin-content one would be the same defect facing the other way. And the margin
no longer has to cover the tail alone: an overshoot that *does* clear it now
produces a repair line stating `target`, a number **below** the cliff, so the
next round has room too — which is exactly what the pre-§12.4 repair line
lacked.

**§13.2 IS SUPERSEDED, NOT DELETED.** Its facts were correct and its numbers are
used above. Its verdict — "nothing was changed" — was wrong, and the reason it
looked right at the time is instructive: the run it examined also carried a C28
failure of the §13.1 class, which is what consumed the rounds, so the C4 finding
read as incidental. It was not; it recurred.

**THE OTHER CAPPED SURFACES — ASKED, AND ANSWERED WITH TESTS** (the new
`H1 — the other capped surfaces` block in `tests/c4.descriptionBudget.test.ts`):

* **bullets (C2)** and **backend bytes (C3)** — **no margin, because code already
  CLAMPS them.** `sanitizeBullets` truncates each bullet to `bulletMax` (less one
  for the claim marker) and `sanitizeBackendSearchTerms` truncates at a word
  boundary to `backendMaxBytes`, both before the gate sees the listing. An
  overshoot cannot reach those checks from a generated run at all — a stronger
  guarantee than a margin. Backend is where the "the model cannot count what the
  check counts" argument is sharpest (the cap is UTF-8 **bytes** and the prompt
  asks for other-language variants) and it is precisely the clamped one.
* **title (C1), title75 and itemHighlights (C15)** — **no margin, deliberately.**
  C4 was unwinnable because the measured quantity is *not* the written string:
  the engine appends afterwards, so a run could obey the stated number exactly
  and fail on a number it never wrote. On the title surfaces the measured
  quantity **is** the written string, the failure quotes the model's own length
  and the fix quotes the same cap the trigger uses, so a repair round is a
  straight edit. Spending title characters — the scarcest keyword real estate on
  the page — to pre-empt a failure the loop already repairs would cost ranking
  surface for nothing. Both properties are asserted in both directions.
* **PRECEDENT:** this is the shape `keywordsGroupSchemaFor` already uses for the
  keyword artifact's `why` field — the prompt states a shorter limit than the
  schema enforces, so an ordinary overshoot never costs a reparse round.

**Status: FIXED.** `DESCRIPTION_MARGIN_FRACTION` and the derivation live in
`lib/gate/checks/c-length.ts`; `lib/engine/prompts/system.ts` and
`lib/engine/prompts/description.ts` render `target`.
`tests/c4.descriptionBudget.test.ts` pins, per pack: the margin and target are
**derived** from `budget` (not duplicated); a model writing exactly the target
passes with the disclaimer appended; a model overshooting the target by the
**whole margin** still passes; each recorded overshoot (19 and 88) passes now and
still fails against the old stated number; one character past the **hard cap**
still fails; and every prompt and the repair line state `target`, state
`reserve`, and **never** state the cliff.

### 17.2 ARCHITECTURE CHANGE — `minNegatives` counts what the model PROPOSED, and the anti-gaming property became a leg of its own.

    C28 | keywords | 2 negative term(s)

`rules.keywordRules.minNegatives` is 3 and the model had supplied **three**
exclusions. The floor counted two because `deriveKeywordPlacement` had
reclassified one out of `negative` — correctly, for one of the reasons §8 and
§13.1 built that boundary: the term was the subject product's **own brand**
(`ownBrandIdentity`) or a **property the ingested snapshot's structured
attributes declare about it** (`productPropertyIdentity`). The run was failed for
**code's own correction**.

*(A third cause is sometimes named alongside those two — a compliance-lexicon
term **deferred** to the check that owns it, §14.1. It never cost the floor
anything: THE DEFERENCE keeps the row saying `negative` and increments the count
before deferring, bound 4 of §14.1. `tests/minNegativesFloor.h2.test.ts` (a)
asserts that beside the other two, so the record is measured rather than
assumed.)*

This is the §13.1 incoherence class one level up: a rule asserting something
about **the model's effort** while measuring the artifact **after the engine
legitimately edited it**. And no repair round clears it honestly — the only move
the message asks for is "record another negative", i.e. invent a rival brand to
pad the list.

**THE CONFLICT, STATED.** Two requirements point in opposite directions:

1. a run must converge when the model proposed enough exclusions and code
   corrected one of them;
2. §8/§13.1 established, **with tests pinning it**
   (`keywordDerivation.ownBrand.test.ts` (e),
   `keywordDerivation.productProperty.test.ts` (e)), that a reference whose
   negatives are **all** self-references must **not** clear the floor.

They conflict only while **one number** serves both. So the two jobs are split,
and **neither pinned test needed a line changed**:

* **THE FLOOR COUNTS PROPOSALS** — surviving `negative` rows **plus** rows the
  derivation reclassified out of `negative`, which it now records on
  `proposedStatus`. That is what the floor's own failure text has always asked
  for: that the **reference record** the exclusions. A reclassified row still
  does — it is in the artifact, with the correction on `note`, on the ship sheet
  where an operator reads it.
* **THE ANTI-GAMING PROPERTY IS ITS OWN LEG** — a reference that records
  exclusions but has **not one surviving `negative` row** fails, whatever its row
  count, with a failure that **names** the defect ("every exclusion you recorded
  names this product") instead of reporting a count the operator has to
  reverse-engineer. It is gated on `min > 0` because it is a property *of the
  floor*, and `minNegatives` is a `REQUIRED_PACK_PIECES` row, so emptying it
  fails at PACK rather than quietly here.

**`proposedStatus` IS DERIVATION-ONLY**, exactly like `surfaces`:
`keywordsGroupSchemaFor` does not declare it (the boundary strips it) and
`normalizeKeywords` builds each row from a fixed allowlist (a volunteered one is
dropped). A run cannot mark its own rows corrected — asserted end to end.

**THE RESIDUE, STATED RATHER THAN HIDDEN.** A reference with **one** genuine
rival plus self-reference padding can reach the count. Zero genuine rivals never
can. That is the deliberate trade: the alternative is failing otherwise-clean
runs for a correction the model was never told about, with no honest repair
available, and every padded row carries its derivation note into the artifact and
the ship sheet. A count of rows was never proof of effort; what it can be is
proof that **at least one real exclusion** was made, and that is now enforced
explicitly rather than as a side-effect of arithmetic.

**R50 IS UNTOUCHED.** `negative` is still never derived away for a genuine
rival, C28 still scans every surface for it, the automatic competitor-derived
rival set (§7) still reads no label at all, and the floor being satisfied does
not silence any of it.

**Status: FIXED.** `lib/gate/checks/c-keywords.ts` (THE FLOOR),
`lib/engine/keywordPlacement.ts` (`proposedStatus`), `lib/types.ts`.
`tests/minNegativesFloor.h2.test.ts` holds it in both directions: the live shape
converges for each reclassification cause and end to end through `optimize()`;
fewer proposals than the floor still fails; all-self-reference still fails;
a genuine rival is unaffected in every direction; `proposedStatus` cannot be
model-supplied; only a row proposed as `negative` is credited; and the golden
fixture still gates with zero failures. `keywords[].proposedStatus` is enrolled
in the §P2 field-closure oracle.

---

## 18. ROUND J � a mandated warning the gate could not read as one, and a floor nobody was told about.

### 18.1 ARCHITECTURE CHANGE � the consult-a-professional SAFETY WARNING is recognised as a CONSTRUCTION, not as a list of wordings.

**THE LIVE DEFECT, FOR THE THIRD TIME.** Production, ASIN B00IO89MYA:

```
C22 | description | "before use if pregnant, nursing, taking medication, or managing a medical condition, and keep out of reach"
fix: Abnormality marker 'medical condition' next to the natural state 'nursing' � �
```

`safety_warning` is a **REQUIRED** field of the supplements attribute template, so
C23 forces the listing to carry the consult-a-professional warning and C22's R1
then failed the text C23 demanded. That is an **unsatisfiable pair**: no repair
round can clear it without deleting text the template requires.

**WHY THE TWO EARLIER FIXES DID NOT HOLD.** Both were enumerative. The original
forensic round added an R3 ADVISORY escape for
`"Women who are pregnant or nursing � managing a health concern, should talk with
a physician"`; ROUND M added the literal `"have a known medical condition"` to
`compliancePack.naturalStateSafePhrases` beside `"have a diagnosed medical
condition"`. Each covered one wording of the same warning, and the next ordinary
paraphrase � `"managing a medical condition"` � walked straight past both. An
enumeration of phrasings always loses to paraphrase; the pack comment on that
list said the qualifier slot was "ENUMERATED, NEVER WILDCARDED", which is exactly
the property that kept costing.

**THE FIX IS STRUCTURAL.** The warning is one grammatical SHAPE, not an open set
of strings: a **CONDITION clause enumerating states the READER may be in**,
governed by a **RECOMMENDATION to consult a professional**. Both legs are pack
data:

* the RECOMMENDATION � `advisoryCueVerbs` followed within the adjacency gap by
  `advisoryProfessionalNouns`, the same pairing test R3's escape already used;
* the CONDITION � `advisoryConditionCues`, **new**, a CLOSED GRAMMATICAL CLASS of
  conditional subordinators (`if`, `when`, `unless`, `in the event`) and
  generic-addressee relative heads (`anyone who`, `those who`, `women who`).

Inside a sentence carrying both legs the abnormality markers describe the
READER'S condition rather than the product's target, so **R2** (two markers) does
not fire, and **R1** (marker beside a natural state) does not fire when the
marker and the state sit in **different items of the enumeration**
(`sameEnumerationItem` � clause punctuation or a coordinating conjunction).
`lib/gate/checks/c-natural-state.ts` holds the sentence arithmetic and not one
word of vocabulary; `tests/category.literals.test.ts` is green.

**THE ANTI-LAUNDERING HALF, STATED EXACTLY.** A marker that MODIFIES its
neighbour shares its enumeration item and R1 still fires however the sentence is
dressed � `"Consult your doctor if you want relief from severe menopause
symptoms"` and `"Anyone who has chronic menopause should talk with a physician"`
both still FAIL. A sentence with no condition cue is not the construction at all,
so `"Ask your doctor about our formula for severe menopause symptoms"` fails on
both legs, and the relative heads carry `who`/`with` on purpose so that
`"Anyone can ask their doctor about our chronic disorder formula"` is not a
construction either. R3, the C6 disease-noun scan and the C6 action-paired tier
never consult the rule: a named disease inside a perfectly-formed warning is
still failed by C6.

**THE RESIDUE, STATED RATHER THAN HIDDEN.** The condition class is closed, so a
warning that uses a REDUCED relative clause with no relative pronoun � "�and
those managing any medical condition, should seek the advice of a physician" �
is not recognised and still fails R1. Widening the class to the bare pronoun was
rejected because it exempts `"Anyone can ask their doctor about our chronic
disorder formula"`, which is a claim. `compliance.cosmetics.json` still ships no
advisory lists of its own; it reaches these through the cross-check union, which
is why the cosmetics pack behaves identically.

**Status: FIXED.** `knowledge/compliance.supplements.json`
(`advisoryConditionCues` + comment), `lib/types.ts`,
`lib/gate/checks/c-natural-state.ts`.
`tests/safetyWarning.construction.c22.test.ts` holds it in both directions: the
live string, the two previously-fixed wordings and **seven ordinary paraphrases
no pack list contains** are clean on three surfaces each and green through the
whole gate; every one of those paraphrases FAILS AGAIN with
`advisoryConditionCues` emptied and every other list untouched, which is the
proof that the construction and not the enumerated safe-phrase list is doing the
work; fifteen genuine abnormality claims � bare and dressed in a warning � still
fail; C6 and R3 are asserted unreachable from the rule.

### 18.2 CORRECTED RECORD � the `minNegatives` floor was enforced by a number the writer was never shown, drawn from a source it could not honestly have.

**THE LIVE DEFECT.** Same run: `C28 | keywords | 0 negative term(s)`. The ROUND H
change had already re-aimed the floor at PROPOSALS, so this was **not** the
reclassification defect � the model wrote no negative rows at all.

**THE FINDING, both halves.** `rules.keywordRules.minNegatives` was pack data
**only the gate read**. `maxTerms` and `whyMaxChars` were both rendered into the
keyword prompt; the floor was not, so the one number a keyword artifact can FAIL
on was the one number its writer was never given. And the only SOURCE the
instructions led with was "every rival brand name" � with no operator competitor
ASINs supplied the model has no rival-brand knowledge, so that instruction asks
it to **invent companies**, which cannot converge honestly.

**THE FLOOR IS NOT MIS-SPECIFIED AND IS NOT LOWERED.** A source exists on every
run: the vocabulary the compliance rules rule out, printed in the same prompt,
which C28 already credits toward the floor (a compliance-owned negative row is
DEFERRED to the check that owns it and still counts, �14). What was missing was
that anybody said so.

**Status: FIXED.** `lib/engine/prompts/keywords.ts` renders the floor from the
same pack number the gate enforces and renders
`rules.keywordRules.negativeSourceNote` (**new** pack data) beside it � naming
the always-available source and refusing the invention of a rival outright.
`lib/gate/checks/c-keywords.ts` states the same source in the failure text at
repair time. `lib/types.ts` documents the field.
`tests/negativeSource.j2.test.ts` holds it in both directions: the prompt states
the minimum and the source and renders neither when the pack sets no floor; a
reference whose negatives are only the avoided compliance vocabulary converges,
in isolation and end to end through `optimize()`; zero rows and one-short-of-the
floor still fail, with a message that names a source the run can draw on; a
genuine rival is unaffected and still enforced from the copy; and the anti-gaming
leg still fails a reference whose every negative names this product.
`tests/minNegativesFloor.h2.test.ts` is green **unedited**.

## 19. ROUND K - the third C4 overshoot, settled structurally rather than with a fourth constant; and the C28 floor's second live shape.

### 19.1 RESOLVED, NOT DEVIATED - the description is now CLAMPED, like every other capped surface.

**THE RECORD, three live observations** against a canonical `descriptionMax` of
2000 and a disclaimer reserve of 158:

| build | stated target | model wrote | over target | verdict |
|---|---|---|---|---|
| pre-margin | 1842 (the cliff) | 1930 | +88 | C4 FAILED |
| pre-margin | 1842 (the cliff) | 1861 | +19 | C4 FAILED |
| post-margin (`60823bc`, margin 111) | 1731 | 1851 | +120 | C4 FAILED |

**THE FINDING.** `DESCRIPTION_MARGIN_FRACTION` (6%, 111 characters) was sized
against the first two observations - 1.26x the worst then on record. The third
observation beat it. A percentage fitted to past overshoots is a prediction
about a tail nobody has measured, and this was already the second fix of the
same defect; a fourth constant would have been the third.

**THE STRUCTURAL ANSWER WAS IN ROUND H'S OWN REPORT.** H1 asked whether the other
capped surfaces share this failure mode and found that they do not, because CODE
CLAMPS THEM: `sanitizeBullets` truncates each bullet to `bulletMax` (less one for
the claim marker) at a word boundary, and `sanitizeBackendSearchTerms` truncates
at a word boundary to `backendMaxBytes` - both in the deterministic assembly
step, before the gate exists. An overshoot cannot reach C2 or C3 from a generated
run at all. The description was the ONLY capped surface with no clamp and the
ONLY capped surface that kept failing.

**THE GUARDRAIL, ADDRESSED EXPLICITLY.** "Never mutate content to force a gate
pass" prohibits one move: seeing a failure and editing the copy until it goes
away. Four properties separate this clamp from that move. (1) It is
UNCONDITIONAL - it runs on every run in the same assembly step as the other two
clamps, and never reads a `Failure`, a `GateResult` or a repair context; none of
those are in scope where it is called. (2) It acts on a string the ENGINE ALREADY
OWNS: `optimize()` appends the compliance disclaimer the model is forbidden to
write, so the field C4 measures was never the model's text alone and its length
was never a quantity the model controlled. (3) The CHECKER IS UNCHANGED - C4's
trigger does not move by one character (empty, or assembled length over
`rules.descriptionMax`), the whole gate re-validates the clamped listing from
scratch, and shortening cannot manufacture a substantiated claim, a present
disclaimer or a missing declaration out of nothing. (4) It FAILS CLOSED where it
cannot act cleanly. **Verdict: not a violation.**

**Status: FIXED.** `lib/engine/descriptionClamp.ts` (new) clamps the written body
to `descriptionBudget(pack).budget` - the ONE arithmetic - preferring the latest
paragraph or sentence boundary, falling back to a word boundary, and DECLINING
entirely when no boundary exists inside the budget or when the only boundary is
shallower than `KEEP_FLOOR_FRACTION` (0.6) of it. It never cuts mid-word, it is
idempotent, and text already inside the budget is returned BYTE-IDENTICALLY.
`lib/engine/optimize.ts` calls it BEFORE the disclaimer is appended, so the
disclaimer can never be truncated by it; it logs `optimize.description_clamped`
(lengths only, never copy) and records `descriptionClamped` on the listing,
ABSENT when nothing was cut so an ordinary run is byte-for-byte the object it
was. `lib/export/shipSheet.ts` prints both lengths beside the description, so the
operator can see the field was shortened before pasting it.
`lib/engine/prompts/description.ts` now states the consequence in words - and
still never names the cliff, because naming it is what B00IO89MYA obeyed.

**THE MARGIN IS KEPT.** It is what stops the clamp firing on ordinary work: the
prompt still asks for `target`, so the clamp only ever meets a description that
already ignored the number it was given. Two of the three recorded overshoots
(+19, +88) never reach it.

`tests/descriptionClamp.k1.test.ts` (43 tests, both shipped packs): all three
recorded overshoots converge; the +120 case is shown to be the one the margin
could not absorb; an in-budget description is emitted byte-identically with no
marker (identity asserted, not merely a pass); a boundary-less over-budget body
is NOT clamped and C4 still fails; C4's empty leg and its fix line are unmoved;
the disclaimer survives whole and exactly once on the end; a clamped listing has
NO gate failure its unclamped baseline lacks (asserted by comparing full
`runGate` failure sets, including a case constructed so the cut lands exactly on
the baseline body); and the operator-facing note appears on a clamped run and on
no other. `tests/c4.descriptionBudget.test.ts` is green **unedited** - the
boundary-less `'a'.repeat(n)` fixtures it uses are precisely the case in which
the clamp declines to act, so every pre-existing assertion still measures what it
measured.

### 19.2 CORRECTED RECORD - C28's floor has TWO live shapes, and J2 covers both; what was missing was the pin.

**THE TWO SHAPES.** `0 negative term(s)` (the model wrote none) and
`2 negative term(s)` (it wrote some and fell short of the floor of 3). Section
18.2 was written against the first.

**THE FINDING: J2 ALREADY COVERS THE SECOND, AND STATES THE NUMBER RATHER THAN
IMPLYING IT.** The keyword prompt renders `minNegatives` verbatim ("at least 3
rows must carry the ... status") from the same pack number the gate enforces, and
the C28 failure text states the floor AND the count the artifact recorded ("must
record at least 3 negative terms and records 2"). A model that wrote two is told
the target and its own shortfall. **No behaviour needed changing.**

**WHAT WAS MISSING WAS THE PIN**, in three places: nothing asserted that the
prompt the ENGINE assembles (through `buildGroupPrompts`, from
`pack.rules.keywordRules`) carries the floor - a floor rendered only when a test
passes the rules by hand is a floor no live run ever sees; nothing asserted the
`and records N` half, which is the only part that distinguishes the two shapes;
and the end-to-end shortfall was untested.

**Status: PINNED.** `tests/negativesFloorShortfall.k2.test.ts` (14 tests) holds
all three in both directions, plus the pack-data direction (no floor in the pack,
no floor line and no floor failure; the same reference still fails under the
shipped pack). The H2 x J2 interaction was checked and is ALREADY pinned in
`tests/minNegativesFloor.h2.test.ts` - "OWN BRAND: the row really is reclassified,
only 2 survive, and the run CONVERGES" (3 proposed, 1 reclassified) and "FAILS:
two genuine negatives" / "FAILS: one genuine plus one reclassified is still only
TWO proposals" (2 proposed) - and section (d) of the new file re-states that pair
as the single property the two rounds have to agree on, because it is the one
that would break silently if either round moved. No production file changed for
19.2.
