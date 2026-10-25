# Official quotes (verbatim citations)

An agent can quote official text as `<citation src="SOURCE_URL">exact text</citation>`. Before the
medical-advice check, the Worker verifies each quote (`worker/citations.ts`):

- `src` must be an official source URL that is in `public/kb/index.json`.
- The quote, normalized, must be in the text of that source. `[…]` can join exact fragments in order
  (each fragment has at least 20 characters). The normalization (`shared/kb.ts`) removes Markdown
  syntax, applies NFKC, unifies apostrophes, quotes and dashes, collapses spaces and folds the case.
- A quote that holds dosing text does not verify, so the medical-advice check sees it. That covers an
  amount ("15 mg", "1 à 2 comprimés", "one tablet"), an intake frequency ("toutes les 4 à 6 heures",
  "twice a day"), a number per day or per 24 hours ("maximum 8 in 24 hours") and an intake verb with a
  number ("prendre 2", "take two"), in French and in English (`hasDose` in `shared/kb.ts`).
- At most 3 quotes verify in one reply.

A verified quote shows as a card ("Extrait officiel"). The medical-advice check sees a
placeholder in its place, so it judges only the agent's own words. A quote that does not verify
loses its tags and stays as ordinary agent text, so the check sees it. The Worker logs
`citation_unverified` with the host and the reason only, never the text.

`public/kb/` holds the normalized text of each knowledge file. It is public government text. Run
`pnpm sync:kb [path/to/knowledge]` after each knowledge change in the Run repo (default
`../agent-sante-agents/knowledge`) and commit the result. `pnpm build` runs the same script with `--if-present`:
it rebuilds `public/kb/` when the knowledge folder is there, and keeps the committed files when not.

## Quotes in the other language

An agent searches its own language first, then the other language. So an English agent can quote a
French-only page. The quote stays in the language of the source, word for word. `sync:kb` writes the
language of each text file (front matter `lang`) to `index.json` (`langs`). When a verified quote is
in the other language of the conversation, the Worker translates it (`worker/translate.ts`):

- The translator gets only the verified official text of the quote, never the agent's own words.
- The translation is trusted like the original. The medical-advice check never sees it: the check
  text already holds the placeholder. The translation runs at the same time as the check.
- Model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` on Workers AI, temperature 0, with a strict
  "translate only, output only the translation" system prompt. An output check refuses an empty
  text, markup, a preamble, a length far from the source, or dosing text (the same `hasDose` rule).
- Budget: 3 seconds for all the quotes of one reply. On a failure or a timeout, the card shows the
  original only, with the note "Text available in French only" (or the French equivalent).
- Cache: by (model, target language, SHA-256 of the text), in memory and in the Cache API (30 days).
- The card shows the translation first ("Machine translation of official text"), then the original in
  an accordion ("Original text (French)"). Each block has its own `lang` attribute.

Why this model: it translates the full text, keeps names such as "Info-Santé 811" and keeps the meaning
of each instruction, within the 3 second budget.

Tests inject a fake translator (`translator` in the pipeline deps), so no test calls Workers AI.
With `FAKE_UPSTREAMS=1`, the Worker uses a local fake that adds `[EN]` or `[FR]` before the text.

## Leaflet quotes (non-prescription drugs)

The medication agents can quote the consumer part of the leaflet of a non-prescription product. The
source of such a quote is the Health Canada product page of the product:
`https://pmps.hpfb-dgpsa.ca/dhpp/resource/<drug code>` (French) or
`https://dhpp.hpfb-dgpsa.ca/dhpp/resource/<drug code>` (English). The tool `drug_info` gives it as `cite_src`.

- The Worker reads the leaflet of that product from the directory API (`worker/drugs.ts`) and verifies
  the quote against it, with the same normalization and fragment rules.
- Only a non-prescription (OTC) product verifies. A prescription product never gives a leaflet quote.
- A leaflet quote may hold a dose: it is the product's own text. A dose in the agent's own words, or in a
  quote of an official page, still does not verify.
- The card says "Extrait de la notice du produit" ("Excerpt from the product leaflet") and adds: "Ces
  informations proviennent de la notice du produit pharmaceutique. Demandez toujours conseil à votre
  pharmacien."
