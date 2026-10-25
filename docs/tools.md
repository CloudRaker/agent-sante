# Agent tools: places, appointments and drugs

## Places and appointments

The person can give a postal code to find places or appointments near them. It is the only personal
information that the site accepts, and only as a location.

1. Before the PII check, the Worker finds each full postal code in the message (`A1A 1A1`, `A1A-1A1`,
   `A1A1A1`). The PII check and the routing call see a neutral marker: `[code postal fourni, secteur H2X]`.
2. When the message passes, the Worker looks up the position (`worker/places/postal.ts`) and stores the
   place of the session in the `SessionPlaces` Durable Object: position, FSA, municipality, region and CLSC
   territory. It never stores the code. The object forgets the place 15 minutes after its last use, and
   `/api/end` deletes it.
3. Run gets the agent marker: `[code postal fourni, secteur H2X (Montréal), territoire de CLSC : Montréal–Centre-Ville, lieu : ref-abcdefghijkl]`.
   `ref-...` is the place reference of the session: HMAC of the session id, 12 letters. The model passes it
   as `near` to the tools. It never sees a position or the code. The transcript holds the marker too.
4. The agents call the tool API with `call_api` (`_apis/agent-sante-tools.yaml` in the Run repo). Run egress
   adds the header `x-agent-sante-tools` from the Run secret `TOOLS_SECRET`.
5. The tools keep their results in the session place. The final `result` event (and the JSON answer) carries
   them as `reply.attachments` (`shared/places.ts`). The model gets a summary only and writes 1 to 3 sentences.
6. Activity steps: `location` (the FSA only), `places` and `appointments`. Run sends `run.progress
   {text: "Called <operation>"}` after each `_apis` call.

Tool API (`worker/tools.ts`, `POST /tools/v1/<operation>`, JSON body, header `x-agent-sante-tools`):

| Operation | Input | What |
| --- | --- | --- |
| `places_search` | `near`, `kind` (pharmacy, clsc, clinic, hospital, vaccination, home_care, lab) or `query` or `service`, `radius_km` (1 to 50, default 10), `limit` (1 to 20) | Health directory places, nearest first, with the next opening. The directory has no type field: with `kind`, the Worker asks for 100 places and keeps those whose name (or services) match the kind (`KIND_RULES`) |
| `appointments_services` | `query`, `lang` | Clic Santé services that match the words (`shared/clicsante-catalog.json`) |
| `appointments_link` | `service`, `near`, `lang` | A link to the Clic Santé results page of the service around the position of the postal code |
| `appointments_search` | `service`, `near`, `radius_km` | Places with free slots and the same link. `404 disabled` when `CLICSANTE_API` is not `"on"` |
| `drug_search` | `name`, `otc_only`, `limit` (1 to 15), `lang` | Marketed drugs by brand name or ingredient (see "Drugs") |
| `drug_info` | `drug_code`, `lang`, `question` | The consumer part of the leaflet of a non-prescription product (see "Drugs") |

Rules:

- Clic Santé: we never book and never go past the portal results page. The link is
  `https://portal3.clicsante.ca/?serviceId=<id>&latitude=<lat>&longitude=<lng>&fees=0&performSearch=true`
  (`/en?` in English) with the position of the full postal code rounded to 3 decimals (about 100 m), or
  the FSA centroid when the code is not in the postal file. Never the code. The read API client
  (`worker/places/clicsante.ts`) uses the same position. It is on when `CLICSANTE_API` is `"on"`.
  It uses `User-Agent: AgentSante/1.0 (+https://agentsante.ca)`, GET only, Cache API for 10 minutes, about 1 request per second for the whole site, link-only fallback on any error.
- Directory: `GET /v1/resources?lat&lon&radius_km&service|q&limit` with the position rounded to 3 decimals,
  then the hours of the first 10 places. Answers stay 5 minutes in the Cache API.
- Postal database: D1 `agent-sante-postal` from the ISQ file "CP Territoires" (May 2026, CC BY 4.0, credited
  on the about page). One row per code (the row with the highest `PRC_REP`), and an `fsa` table with the
  centroid of each FSA (weighted by address units) for unknown codes. D1 has no Canadian location, so the
  Worker asks D1 for the whole FSA block and finds the code in memory: D1 never gets the full code.
  Build and load: `node scripts/build-postal-d1.mjs --load` (`--local` for `wrangler dev`).
- Map: Apple MapKit JS, only when a token matches the host (`/api/config` gives `mapkitToken`: `MAPKIT_JS_TOKEN_APEX` for `agentsante.ca`, `MAPKIT_JS_TOKEN` for `*.agentsante.ca`). The map gets
  the positions of the places only. The CSP allows `cdn.apple-mapkit.com`, `*.apple-mapkit.com`,
  `*.geo.apple.com`, `*.ls.apple.com` and `blob:` workers.
- Deploy check (not in the agents' OpenAPI file): `POST /tools/v1/check/place {fsa}` makes a
  place from an FSA centroid and gives its reference; `POST /tools/v1/check/results {ref}` reads the results.

## Drugs

The medication agents (`fr/medicaments`, `en/medications`) use two tools over the directory API, which
holds the Health Canada Drug Product Database (marketed products) and the product leaflets
(`worker/drugs.ts`).

- `drug_search` (`GET /v1/drugs?q=&limit=`, plus `dispensing=otc` with `otc_only`) finds any product by
  brand name or ingredient, prescription products included. Each product has `otc` and `prescription`
  flags. The agents only name a prescription product and never suggest it as an option. A search for a
  need (no product name) uses `otc_only`.
- `drug_info` (`GET /v1/drugs/{code}/consumer-info?language=`) answers `403 prescription_drug` with no text
  for a prescription product. For a non-prescription product it gives the leaflet text (12,000 characters
  at most; with `question`, the best passages of a long leaflet from `/v1/documents/{id}/query`), and
  `cite_src` for leaflet quotes (see [citations.md](citations.md)). When the leaflet is missing in the
  conversation language, it tries the other language. With no leaflet yet, it gives the status and the
  agent sends the person to their pharmacist.
- Activity step: `drugs`. Answers stay 5 minutes in the Cache API.
