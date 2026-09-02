## What changed

<!-- One or two sentences -->

## Source

<!-- For any factual change: link the mspace.lk API documentation page or openapi.json, or paste
     the observed request/response with credentials and MSISDNs redacted. -->

## Checklist

- [ ] `npm test` passes
- [ ] `node scripts/sync-rules.mjs --check` passes (edited `AGENTS.md`, not a generated copy)
- [ ] `node scripts/build-curl-reference.mjs --check` passes
- [ ] `catalog/mspace-api.json` and the matching `references/*.md` agree
- [ ] Nothing invented that the mSpace documentation does not publish
- [ ] No real credentials, no real subscriber MSISDNs, nothing from a production log
