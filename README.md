# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/bayyubenjamin/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/bayyubenjamin/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar: a pre-token launch radar that ranks 198 protocols by expected implied value and tells you what to farm, for how much, and whether it is worth it. Original code, MIT licensed.

## What it does

`main.ts` (Node 22, standard library only, no network) reads the sealed DefiLlama snapshot (758 protocols, 14 Nov 2026), scores every pre-token protocol, and writes a ranked board plus a static dashboard:

- **198 rows ranked** — the 40 watchlist protocols plus every other pre-token protocol that passes the watchlist's own rule. Wrapped, staked and bridged products of tokens that already trade are set aside (144 of them): a wrapped product is not a token that does not exist yet, whatever its TVL.
- **Implied value = fitted comps × growth × maturity × launch odds.** The size curve (`ln mcap = 6.9646 + 0.5223 × ln TVL`) is fitted at run time from the 128 traded tokens in the snapshot (R² 0.19 — a weak fit, and the dashboard says so). It beats a flat 0.25× multiple out of sample on 5 of 5 held-out splits (mean log-RMSE 2.05 vs 2.22). Launch odds are a survival hazard (0.63 at day 0, 0.51 at one year, 0.24 at five years), stated in the dashboard as an assumption, not a measurement.
- **Costed farm verdicts.** Every row carries a 7-step farm plan with capital, gas and time, and a FARM / THIN / SKIP verdict: expected airdrop value (implied × 7% pool ÷ farmers) against the money at risk. Rank is the size of the implied value; the verdict is whether the expected airdrop earns its keep — so the biggest prizes are often SKIP, and the small, young ones are FARM. (159 FARM, 29 THIN, 10 SKIP.)
- **The model lives in the page.** `dashboard/app.js` refits the curve, reruns the held-out test, and recomputes all 198 rows from the raw figures — the integrity strip on the cover reports the match (198/198). The dashboard is sortable, searchable, filterable by category, with a detail view per protocol.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Reads the snapshot from `--input` (default `/input`), writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` to `MAKEFUN_OUTPUT_DIR` (default `/output`). Fully deterministic: two runs write byte-identical output — no clock, no unseeded randomness, fixed seeds for the held-out splits.

## Layout

- `main.ts` — the program: reads the snapshot, builds the board, writes the outputs and the dossier.
- `lib/model.ts` — the value model: fitted size curve, held-out test, launch odds, farm verdicts, farm plans.
- `dashboard/` — the static page (`index.html`, `app.css`, `app.js`): the model mirrored in-page, the integrity strip, the board, the detail view.
- `screenshots/` — the three screenshots the judge reads: the board, a detail view, a filtered view.
- `vendor/makefun-board.ts` — make.fun's dossier library, copied byte for byte from the kit.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ga8gqeqs&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
