# Working in this repo

Read `README.md` first — it carries the cost model, the prompt-engineering
findings, and the two load-bearing non-obvious mechanisms. This file is only
about how to work here.

## Build and test

There is no watch-everything command; the two halves are separate.

```bash
cd server && npm run typecheck && npm test    # 67 tests, no API keys needed
cd web    && npm run typecheck && npm run build
```

`docker build --target server .` and `--target web .` each run the real `tsc`,
which is the reliable way to typecheck without a local toolchain.

**The web typecheck genuinely checks endpoint calls here.** In the repo this was
extracted from it did not: `zite-endpoints-sdk` was mapped in `vite.config.ts`
only, so `tsc` resolved nothing for it and every endpoint call silently became
`any`. `tsconfig.json` here maps it too. That is not cosmetic — it immediately
caught a field the page reads and the client type never declared.

## The shape of the thing

The UI calls endpoints by name: `web/src/shims/endpoints.ts` POSTs to
`/api/fn/<name>`, and `server/src/routes/fn.ts` dispatches to the `HANDLERS` map
in `server/src/zite/handlers.ts`. **Adding an endpoint means touching both
ends** — a handler in the map, and a typed `endpoint<Input, Output>()` in the
shim. The shim's types are hand-written, not generated, so they can drift from
what the handler actually returns; when you change a handler's response, change
the shim's type in the same edit.

## Rules worth keeping

**Never return an API key in a response.** `settings/secrets.ts` is server-only.
The UI asks `avatarStatus` which providers are configured and gets booleans.
Keep it that way.

**Only provider inputs go in `publicAssets`.** That route is unauthenticated by
design (see README). It is for a portrait and a TTS clip that are about to
become a public video anyway. Nothing else.

**Renders cost real money and take real time** (~20s of wall clock per 1s of
720p output). Prefer resuming to restarting; `retryVideo` deliberately reuses
narration already paid for and keeps accepted provider job ids. When changing
the pipeline, think about what happens to an in-flight render on restart —
`resumeInterrupted()` is what makes that survivable.

**The prompts are the product.** Most of `look.ts` / `rooms.ts` /
`characterSheet.ts` encodes a specific failure someone hit and fixed. Several
lines look redundant and are not: the explicit no-rim-light negative, the
"take NOTHING else from the sheet" clause, pinning the room before describing
the person. If a line seems pointless, check the tests before deleting it —
many are asserted, and the reasons are in the README.

**Verify image changes by generating and looking.** Prompt work cannot be
checked by reading. The tests assert that instructions are *present*, never that
the output is good.

## Provenance

Extracted from a larger internal tool. The `avatar/` modules, the page and its
components are unchanged from the original, which is why the page still imports
its backend as `zite-endpoints-sdk` — keeping that specifier is what let the UI
come across untouched. Dropped in extraction: a Google Sign-In gate, a
UI-managed secrets store (now environment only), a Claude-backed prompt
optimizer nothing called, and the Thumbnail Designer modules that
`imagechat/geminiImage.ts` replaces.
