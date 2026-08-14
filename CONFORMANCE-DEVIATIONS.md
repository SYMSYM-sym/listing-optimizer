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
directions — 14 of its 18 cases fail against the pre-fix reader.

**The record is corrected here rather than in the old commit message**, which is
immutable. The lesson is kept deliberately: *a coverage claim belongs in a test,
not in prose.* The closed-world rule was doing its job in one direction the whole
time (an unknown DECLARED surface fails) and could not help in the other, because
a surface that is never named is never checked.

---

## 2. KNOWN PARITY LIMITATION — C24 is digit-anchored; a spelled-out figure passes.

`c24DosageAttributeGuard` (`lib/gate/checks/c-attributes.ts`) fails a
dosage/strength/potency-keyed attribute whose value asserts a hero figure. Its
value pattern is a **digit** run followed by a hero unit:

```
new RegExp(`\\d[\\d,.]*\\s*(?:${unitSource})\\b`, 'i')
```

So `maximum_dosage: "50 Billion CFU"` fails and `maximum_dosage: "Fifty Billion
CFU"` **passes**. C12 does not catch it either — its scan is unit-anchored on
digits for the same reason, so a spelled-out figure is invisible to both.

**This is faithful to the source.** The check is a port of the harness kit's
`checkC24`, whose value shape is the same digit-anchored one, and the port is
documented as such in the check's own header. Widening it here would make the
app and the kit silently disagree about what C24 means.

**Deliberately NOT fixed.** Two reasons, in order of weight:

1. **Parity is the contract.** A ported check that quietly grows a rule the
   original does not have is a check nobody can reason about from the source.
2. **The fix is not obviously free.** A number-word scan runs across every
   attribute value in the pack's key pattern, and words like "one", "ten" and
   "hundred" appear in legitimate dose-form and direction strings. Over-blocking
   lawful copy is treated in this project as exactly as severe as a bypass, and
   an unmeasured widening is how that happens.

**Assessed exposure: low but real.** The generator writes attribute values, and
it is prompted with the canonical facts in digit form, so the spelled-out shape
is not a natural output. It is reachable through `/api/audit`, where the listing
is client-supplied — an operator pasting a hand-written attribute value.

**If this is ever fixed it must be a FLAGGED ADDITION, not a silent widening:**
recorded here as an intentional divergence from the kit, with both-direction
tests (spelled-out hero figure in a dosage-keyed attribute FAILS; a lawful
attribute containing an ordinary number word — "One Capsule Daily", "Take one
capsule" — still PASSES), and the number-word vocabulary held as **pack data**,
never as a literal in the gate.

**The WS5.5 panel confirmation does not change any of this.** An
operator-confirmed panel changes what the canonical **number** is (it is the
fact source C12 measures against — see `lib/knowledge/panelFacts.ts`); it cannot
license a claim, and it deliberately does not touch C24. C24's objection is to
stating a hero figure **as a dose** in filter-fed structured data, which is true
whether or not the figure is confirmed — the check has no fact source by design,
and giving it one would turn "you may not say this here" into "you may say it if
it happens to be true".

The boundary is pinned by a test so it cannot be rediscovered as a finding:
`tests/complianceCompletions.test.ts` → *"KNOWN LIMITATION (recorded): the guard
is digit-anchored, so a spelled-out figure passes"*. Widening the pattern breaks
that test, which forces this file to be updated in the same commit.

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

**What the model now owns:** `term`, `tier`, `why`, and the four
**intent-bearing** statuses only judgement can produce — `negative` (rival
brands and forbidden vocabulary, R50), `not-targeted`, `candidate`, and
`captured-via` (+ its `via`). None of those is a claim about the copy.

**What code now owns** (`lib/engine/keywordPlacement.ts`): `surfaces`, and the
placement status of every other row, read off the **finished** copy through
C28's own pack-driven surface readers (`keywordSurfaceText`) with the same
disclaimer subtraction the check applies — visible hit → `placed` with the
derived surface list, backend-only hit → `backend`, no hit anywhere →
**downgraded** to `candidate` with the downgrade recorded in `note`. It runs on
every round, so a repair round that regenerates copy but not the keyword group
still re-resolves the carried-forward rows against the strings that ship.

**`captured-via` is derived-exempt on purpose.** Its whole meaning is that the
term is deliberately ABSENT; deriving it would downgrade every lawfully
recaptured row and destroy K4. **Derivation-exempt is not gate-exempt** — the
gate scans that absence, which is item 6.

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

**A future change to this must also change:** the status list in C28's header,
`tests/capturedVia.gate.test.ts`, and item 5's claim about what C28 still does.

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

**COMPETITORS are still not sent, and that is a different case rather than the
same oversight:** they feed the BENCHMARK, a measurement of pages a single-group
regeneration does not re-ingest, and their absence changes no copy.

Both directions in `tests/regenerate.route.test.ts` → "WS9 review text (G4)":
present, the regenerated group's prompt carries the same `buyerLanguageBlock`
the optimize path renders and none of the fragments the filter rejected; absent
— including a whitespace-only value, because absence and emptiness are different
statements — the prompts are byte-identical and P11 stays `unknown`.
