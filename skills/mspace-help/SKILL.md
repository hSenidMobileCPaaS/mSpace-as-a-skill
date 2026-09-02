---
name: mspace-help
description: Quick reference for the mSpace skill — available commands, services covered, and which reference document covers what. Use when the user asks what the mSpace skill can do.
---

# mSpace skill — quick reference

## Tooling

```bash
node tools/mspace.mjs help        # every command
node tools/mspace.mjs list        # every service and callback
node tools/mspace.mjs platform    # base URL, tracks, operator, conventions
```

Offline, zero-dependency, read-only, and it never sees your credentials. Add `--json` to any
command for machine-readable output.

| Command | Answers |
|---|---|
| `list [category]` | What services exist? |
| `show <id>` | What exactly does this call take and return? |
| `search "<query>"` | Which service does the thing I want? |
| `curl <id> [k=v]` | Give me a runnable request, with the parameters and response defined. |
| `validate <id> '<json>'` | Is this payload correct? |
| `code <statusCode>` | What does this code mean and what do I do? |
| `diagnose "<symptom>"` | Why is this not working? |
| `practices [severity]` | What must I not get wrong? |
| `checklist` | Am I ready for production? |
| `reference <doc>` | Show me the full guide. |
| `platform` | Base URL, tracks, operator, conventions. |

## Skills

| Skill | Use it for |
|---|---|
| `mspace` | General mSpace work; the rules and the service map |
| `mspace-scaffold` | Starting a new integration |
| `mspace-callbacks` | Inbound webhooks |
| `mspace-review` | Auditing existing code |
| `mspace-debug` | A failing call or callback |
| `mspace-golive` | The pre-production checklist |

## Services covered

**SMS** — send (MT), send to the subscribed base, receive (MO), delivery reports
**USSD** — send screens, receive input, session handling
**Subscription** — register, unregister, status, query base size, subscriber charging info,
subscriber list, subscriber notifications
**OTP** — request, verify (subscription activation)
**CaaS** — OTP generation, OTP verification, charging notifications
**LBS** — request a subscriber's location
**Not published** — voice/IVR and balance query. Do not invent endpoints for either.

**Two tracks:** **Inzpire** is the API track this skill covers. **Xpand** is the no-code track —
Contact, Vote, Alert and Scheduled Messages applications. If a requirement is fully covered by an
Xpand template, an application there beats an integration.

## References

`01-getting-started` · `02-sms` · `03-ussd` · `04-subscription` · `05-caas` · `06-lbs` ·
`07-callbacks` · `08-status-codes` · `09-security-best-practices` · `10-production-checklist` ·
`11-any-stack` · `12-implementation-playbook` · `13-curl-reference`

## Writing the call

**`references/13-curl-reference.md`** is where every call comes from: each endpoint at the wire — a
runnable curl, every parameter defined, the response, every response field explained, that
endpoint's status codes — plus every callback with a replay command. Translate the request into the
project's own HTTP client; that is the integration.

```bash
node tools/mspace.mjs curl subscription-query-base              # the cheapest call to prove setup
node tools/mspace.mjs curl sms-send message="Hi" \
  destinationAddresses='["tel:94702725777"]'                    # filled in and validated
node tools/mspace.mjs reference 13-curl-reference               # the whole page
```

There is no code generator: an emitter would cover a few languages and age with their idioms, where
a curl is the same call in all of them and stays true.

## Languages

The integration can be written in **any** language — mSpace is JSON over HTTPS. The curl reference
covers every endpoint with no tooling at all; worked implementations ship for TypeScript/Node,
Python, Java, Go, PHP and C# (`templates/README.md`) to read for shape; and
`references/11-any-stack.md` specifies the same seven components language-neutrally for anything
else. The CLI above needs Node, but it is only a documentation reader.

## The things to remember

1. **HTTP 200 does not mean success** — branch on `statusCode`.
2. **`S1000` is not the only success** — `P1003` on CaaS OTP generation, `S1001` on Subscriber
   List, and `statusDescription` instead of `statusDetail` on CaaS OTP verification.
3. **A charge is three exchanges** — OTP generation, OTP verification, then the notification that
   settles it — and it is idempotent on `externalTrxId`, or you double-charge a real person.
4. **Credentials live in environment variables**, and mSpace is called from the backend only.

No provisioned application yet? The developer bundle's simulator runs the whole thing locally at
`http://localhost:10001/`.

Platform and documentation: <https://mspace.lk> · <https://www.mobitel.lk/mspace>
