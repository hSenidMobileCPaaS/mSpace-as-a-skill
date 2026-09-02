---
name: mspace
description: Build and integrate mSpace (Mobitel's Sri Lankan application platform) services — SMS, USSD, Subscription (register, unregister, status, base size, charging info, subscriber list), OTP, CaaS charging (OTP-authorised mobile-account debit) and LBS. Use whenever the user mentions mSpace, Inzpire, Xpand, api.mspace.lk, MSISDN/`tel:` addressing, short code and keyword routing, USSD menus, subscriber base size, mobile-account charging, or telco SMS/USSD in Sri Lanka.
---

# mSpace

mSpace is Mobitel's application platform for Sri Lanka. It exposes SMS, USSD, subscription
lifecycle, mobile-account charging, OTP verification and location as JSON-over-HTTPS APIs.

Two tracks: **Inzpire** (the API track — this skill) and **Xpand** (no-code Contact, Vote, Alert
and Scheduled Messages applications). If the requirement is fully covered by an Xpand template,
say so rather than building an integration.

## Do this first — do not recall parameter names, query them

```bash
node tools/mspace.mjs list                          # what exists
node tools/mspace.mjs show <id>                     # exact contract
node tools/mspace.mjs curl <id> [key=value ...]     # runnable request + param/response defs
node tools/mspace.mjs validate <id> '<json>'
node tools/mspace.mjs code <statusCode>
node tools/mspace.mjs platform                      # base URL, tracks, conventions
```

**`references/13-curl-reference.md` is where every call comes from** — every endpoint as a runnable
curl, every parameter defined, the response and every response field, the status codes that
endpoint returns, and every callback with a command that replays it against your handler.
Translate the request into the host project's HTTP client and idiom; that is the call, in any
language. It is also the first thing to run by hand when a call fails.

There is no code generator in this skill by design: an emitter would cover a handful of languages
and age with their idioms, while the contract and the curl above stay true for all of them. Write
the code in the project's own conventions.

Full command list: `node tools/mspace.mjs help`. Add `--json` for machine-readable output. If you
cannot run commands, or Node is not installed, read `catalog/mspace-api.json` — same data, plain
JSON. The CLI is a documentation reader; the integration itself can be in **any language**.

## Six rules that are never negotiable

1. **Credentials come from environment variables.** Never hardcoded, never in a client bundle,
   never logged, never committed. Never a browser-exposed prefix
   (`NEXT_PUBLIC_`/`VITE_`/`REACT_APP_`/`PUBLIC_`/`EXPO_PUBLIC_`).
2. **mSpace is called from the backend only.** The *Allowed Host Address* list is enforced; a
   client cannot satisfy it, and the credentials are a shared secret.
3. **Explicit, recorded consent before any Register or charge**, with the amount and frequency
   disclosed first — both are provisioning settings on the application.
4. **`subscriberId` is opaque** — with Mobile Number Masking it is a masked value, not a phone
   number.
5. **Charging is idempotent** on `externalTrxId`, persisted before the call, reused on retry.
6. **A charge is three exchanges**, not one: OTP generation (`P1003`), OTP verification (the money
   moves), then the charging notification (which settles it).

## The two things agents get wrong

**mSpace returns HTTP 200 for application-level failures.** Branch on `statusCode`.

**`S1000` is not the only success.** CaaS OTP generation succeeds with **`P1003`**; Subscriber List
also accepts **`S1001`** ("No Subscribers Found"). And CaaS OTP verification puts its message in
**`statusDescription`**, not `statusDetail`. A client hard-coded to `S1000` + `statusDetail`
reports every successful charge request as a failure.

## Build it in the project's own stack

mSpace is JSON over HTTPS: no runtime is privileged, and a Node sidecar for a Python, Java, Go, PHP
or .NET project is the wrong answer. Every call is one HTTPS POST with a JSON body —
`references/13-curl-reference.md` has all of them, so Ruby, Rust, Kotlin, Elixir or anything else
is a first-class target. Working implementations for six languages ship in `templates/` (see
`templates/README.md`); `references/11-any-stack.md` specifies the same seven components
language-neutrally, with an acceptance checklist for stacks with no template.

## Where the detail lives

`references/01-getting-started.md` through `13-curl-reference.md`, and the per-language
implementations in `templates/`. Read the reference for the service you are building before
writing code.

No provisioned application yet? The mSpace developer bundle ships a local simulator at
`http://localhost:10001/` — point the `MSPACE_*_URL` variables at it and the whole integration
runs. See `references/01-getting-started.md`.

Taking a project from nothing to production — or adding mSpace to an application that already has
users — is `references/12-implementation-playbook.md`.

Related skills: `mspace-scaffold`, `mspace-callbacks`, `mspace-review`, `mspace-debug`,
`mspace-golive`.
