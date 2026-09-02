# Contributing

This skill is proprietary software owned by hSenid Mobile Solutions (Pvt) Ltd. See
[LICENSE](LICENSE).

**External pull requests and forks are not accepted.** The licence does not permit modifying or
redistributing the skill, so there is no contribution path that would be lawful to merge from
outside hSenid Mobile.

That does not mean feedback is unwelcome — it is the most valuable thing you can send.

## What to report

Open an issue. Accuracy reports are the highest-value contribution, because a wrong parameter name
in this skill becomes a wrong parameter name in someone's production integration.

- **The API contract has changed** — a parameter that is now required, a new enum value, a changed
  endpoint. Include the documentation page or the observed response.
- **A status code** you have seen that is not in the table, or one documented under two meanings.
- **Bad guidance** — the skill led an agent to write incorrect, insecure or non-compliant code.
- **Agent support** — a platform that should load the skill but does not.
- **New services**, such as voice/IVR or a balance-query endpoint, once they are published.

Anything factual needs a source: a link to
<https://mspace.lk/API_Documentation/mobitel_tap_api.html>, to
<https://mspace.lk/API_Documentation/openapi.json>, or a real request/response pair with
credentials and MSISDNs redacted.

## Never include in an issue

- A real `applicationId` or `password`. If you have already pasted one anywhere, rotate it on the
  platform first — see [SECURITY.md](SECURITY.md).
- A real subscriber MSISDN. Use `tel:94702725777`.
- Anything copied from a production log.

## For hSenid Mobile maintainers

The catalog is the source of truth. `catalog/mspace-api.json` drives the CLI, the curl reference,
the tests and much of the documentation. When a contract changes:

1. Edit `catalog/mspace-api.json`.
2. Run `node scripts/build-curl-reference.mjs` to regenerate `references/13-curl-reference.md`.
3. Update the matching `references/*.md` so prose and data agree.
4. Run `npm test` — the suite checks that every referenced status code exists, every parameter is
   fully specified, every documented sample validates against its own schema, every callback has
   fields and a sample payload, every referenced file is present, and every endpoint, parameter and
   response field appears in the curl reference.

`references/13-curl-reference.md` is generated from the catalog and carries a banner saying so;
`scripts/build-curl-reference.mjs --check` fails the build if it drifts. Never hand-edit it — fix
the catalog or the builder.

**This repo ships no code generator, and should not grow one.** An emitter encodes language idiom
rather than the mSpace contract, so it ages with every ecosystem it covers while the contract barely
moves — and it makes every uncovered language second-class. The curl reference is the delivery
mechanism for an implementation, in every language equally. If a request for "a Kotlin client"
arrives, the answer is a correct contract plus the seven components in `references/11-any-stack.md`,
not an emitter.

**Do not invent anything the mSpace documentation does not publish.** Two rules follow from that:

- Where an endpoint publishes no status-code table, the catalog lists only the codes that *are*
  documented, and the reference says the list is not published rather than borrowing a neighbour's.
- Where the documentation gives one code two meanings — `E1856` and `E1857` do — record both and
  say which endpoint each applies to. Do not pick one.

The three envelope irregularities are load-bearing and must survive any refactor:

- **`P1003`** is the documented success of CaaS OTP generation, not an error.
- **`S1001`** is a success on Subscriber List.
- **`statusDescription`** replaces `statusDetail` on CaaS OTP verification.

Anything that folds success back into a single global `S1000` constant breaks charging.

Agent rule files are generated. `AGENTS.md` is the single source; the Cursor, Windsurf, Cline,
Kiro, Qoder, Copilot and `.agents` copies come from it:

```bash
node scripts/sync-rules.mjs          # regenerate
node scripts/sync-rules.mjs --check  # CI check
```

Edit `AGENTS.md`, never a generated copy. CI fails if they drift.

Templates are per-language ports of one specification. Adding a language means: a directory under
`templates/` with config, client and callback handlers; the same `MSPACE_*` variable names as every
other port; a row in `templates/README.md` and in the shipped-templates table in
`references/11-any-stack.md`; and an entry in `TEMPLATE_LANGUAGES` in `tests/packaging.test.js`,
which enforces all of the above. mSpace is JSON over HTTPS — no guidance in this repo may assume a
particular runtime.

Before pushing:

```bash
npm test                                       # catalog, tooling and packaging tests
node scripts/sync-rules.mjs --check            # rule copies in sync
node scripts/build-curl-reference.mjs --check  # curl reference in sync with the catalog
bash -n scripts/*.sh                           # shell scripts parse
node tools/mspace.mjs list                     # CLI still works
```

Or `npm run check`, which runs both sync checks and the tests.

### Style

- Write for someone integrating at 2am with a failing call. Lead with what to do.
- State the consequence, not just the rule — "never retry with a new `externalTrxId`" lands because
  the next clause says it can charge a real person twice.
- When the official documentation is inconsistent, say so and tell the reader to handle both cases.
  Do not silently pick one.
- No invented endpoints, parameters or status codes. If it is not documented or observed, say it is
  not documented.
