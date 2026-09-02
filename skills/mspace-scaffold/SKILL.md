---
name: mspace-scaffold
description: Scaffold a new mSpace integration from scratch — environment config, credential handling, the API client, and typed request/response models. Use when adding mSpace to a project for the first time, or when the user asks to set up, bootstrap, or start an mSpace integration.
---

# Scaffold an mSpace integration

Build in this order. The order matters: config first means no credential ever has a chance to land
in a source file.

## 1. Establish what exists

Ask, or find in the code:

- A provisioned application? (`APP_00XXXX` + password) — if not, they are pre-provisioning; read
  `references/01-getting-started.md` and walk them through it. You can still build everything
  against the mSpace simulator from the developer bundle (`http://localhost:10001/`).
- Which APIs were provisioned? Calling an unprovisioned service fails `E1309` no matter how
  correct the payload.
- Public HTTPS URLs for callbacks? Required for MO SMS, USSD, delivery reports and all
  notifications — five separate URL fields across four provisioning sections.
- A **static egress IP** for *Allowed Host Address*? Required, and determined on the server that
  will make the calls.

## 2. Pick the stack — the host project's, not the template's

mSpace is JSON over HTTPS, so build in whatever the project already uses. `templates/` ships config
+ client + callbacks for **TypeScript/Node, Python, Java, Go, PHP and C#**
(`templates/README.md` indexes them); for anything else, take the calls from
`references/13-curl-reference.md` and follow the seven components and the acceptance checklist in
`references/11-any-stack.md`. Never add a second runtime for this.

## 3. Config before code

Copy `templates/.env.example` — the variable names are identical in every language — and the config
file from your language's directory. Requirements:

- One module reads the environment; nothing else does.
- Validate at startup and **fail loudly** on anything missing.
- `.env` git-ignored; `.env.example` placeholders only.
- One URL variable per provisioned service. An unset one means the client refuses the call locally
  rather than failing with `E1309` at the platform.

## 4. One client, one `post()` helper

Every mSpace call is the same HTTPS POST, so the client is one `post()` that injects credentials,
sets a timeout, and raises a typed error when the response is not a success — plus a thin wrapper
per service.

**Take the success set as a parameter, not a constant.** `S1000` is the default; CaaS OTP
generation succeeds with `P1003`; Subscriber List also accepts `S1001`. And read the detail from
`statusDetail` *or* `statusDescription`, because CaaS OTP verification uses the second.

Write it from `references/13-curl-reference.md`. Each endpoint is there as a runnable curl with
every parameter defined and every response field explained: translate the request into the
project's own HTTP client, one wrapper per service, and put the seven components from
`references/11-any-stack.md` around them. Run the curl first — a payload proven by hand is one you
cannot get wrong in code.

The error module is `references/08-status-codes.md`: every published code with its handling class,
the six classes, and the per-service success sets. Build the sets from the Class column, or
straight from `catalog/mspace-api.json`.

If the project is in TypeScript/Node, Python, Java, Go, PHP or C#, read the matching `templates/`
implementation for shape and port its structure — but write in this project's conventions, with its
HTTP client, logger and config loader. Keep the `statusCode` branching and the per-service success
codes exactly as specified.

Never recall parameter names; `show <id>` and the curl reference have the exact contract.

## 5. Charging is a state machine, not a function

If CaaS is in scope, model it as three exchanges over a persisted ledger row keyed by
`externalTrxId`:

```
persist externalTrxId (PENDING)
  → startCharge()   → P1003 + requestCorrelator + internalTrxId   (OTP sent, nothing charged)
  → subscriber enters the OTP
  → confirmCharge(requestCorrelator, otp, sourceAddress)          (the money moves)
  → charging notification settles it
```

Never generate a fresh `externalTrxId` on a retry. See `references/05-caas.md`.

## 6. Callbacks

Half the integration is inbound. Use the `mspace-callbacks` skill.

## 7. Verify

```bash
node tools/mspace.mjs validate <id> '<payload you generated>'
./scripts/smoke-test.sh          # or .\scripts\smoke-test.ps1
```

Both scripts are plain curl, so they verify a handler in any language. For a port into a stack with
no template, finish with the acceptance checklist in `references/11-any-stack.md`.

No provisioned application yet? Everything above still works against the mSpace simulator from the
developer bundle. Point the `MSPACE_*_URL` variables at `http://localhost:10001/…`; it needs Java
1.6.0 or above. See `references/01-getting-started.md`.

Match the host project's stack and conventions. The templates are a specification, not a framework
to impose.
