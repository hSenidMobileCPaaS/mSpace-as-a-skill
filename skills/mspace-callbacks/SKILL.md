---
name: mspace-callbacks
description: Implement mSpace inbound webhooks — SMS receive (MO), SMS delivery reports, USSD receive, subscription notifications and charging notifications. Use when building or debugging mSpace callback handlers, notification URLs, or webhook endpoints.
---

# mSpace callbacks

mSpace POSTs to URLs you register during provisioning — five of them, across four configuration
sections. Skip these and MO SMS never arrives, USSD does not work, and you never learn that a
subscriber left or a charge failed.

```bash
node tools/mspace.mjs list --direction=inbound            # the published callbacks
node tools/mspace.mjs show ussd-receive                   # payload + rules
node tools/mspace.mjs curl sms-mo                         # fields, plus a command that
                                                          # replays it against your handler
```

| Callback | Configured under |
|---|---|
| SMS Receive (MO) | SMS configuration — *Message Receiving URL* |
| SMS Delivery Report | SMS configuration — *Delivery Report URL* |
| USSD Receive | USSD configuration — *Connection URL* |
| Charging Notification | CaaS configuration — *Charging Notification URL* |
| Subscription Notification | Subscription configuration — *Subscription Notification URL* |

Four of the five have a published payload in the mSpace API documentation. **The subscription
notification does not** — the documented `POST /subscription/notify` service defines the same field
vocabulary (`timeStamp`, `version`, `applicationId`, `subscriberId`, `frequency`, `status`), so
accept those and tolerate anything else. Log the raw body on the first delivery in Limited
Production and widen from there. Do not invent fields for it.

All of them are written out in `references/14-curl-reference.md`: what arrives, every field
defined, what you must respond, the dedupe key, and a curl that replays the exact payload against
your own route. Write the handlers from that, in the project's own framework.

## The contract — identical for all five

**In:** `POST`, JSON. The SMS receive, USSD and subscription payloads carry your `applicationId`;
the delivery report and charging notification do not, so those rely on the source-IP control.
**Out:** HTTP 200 with `{"statusCode":"S1000","statusDetail":"Success"}`.

The response is an **acknowledgement, not a reply**. For USSD, the screen the subscriber sees comes
from a separate `POST /ussd/send`.

If you return something the platform cannot parse, it reports `E1607` — *Unable to read application
response* — back on the outbound path. A mysterious `E1607` on the charging path is a bug in your
callback's response, not in your request.

## Five rules

1. **Acknowledge first, work second.** Queue the payload, return `S1000`, process out of band —
   through the stack's real background mechanism (a queue, `BackgroundTasks`, `@Async`, a worker
   goroutine, a hosted service), never a bare `await`. USSD sessions time out in seconds.
2. **Be idempotent.** Every callback can arrive twice. Dedupe on the documented key —
   `node tools/mspace.mjs show <id>` gives it. The charging notification's key is
   `externalTrxId` + `statusCode`, and a duplicate that double-counts revenue is a real bug.
3. **Never trust the body.** Unauthenticated JSON from the internet. Validate the schema, verify
   `applicationId` where it is present, restrict by source IP, rate-limit.
4. **Always return 200**, even for payloads you reject — a 4xx or 5xx just triggers redelivery.
5. **Log for tracing, not surveillance.** `requestId` / `sessionId` / `externalTrxId` /
   `internalTrxId` yes; message bodies, OTPs and unmasked `subscriberId` no.

## The charging notification is the one that settles money

It is the only place a charge is finally confirmed. Match on `externalTrxId`, read `TotalAmount`,
`paidAmount` and `balanceDue` together, and only then mark the transaction complete. Every charge
your code left in an unknown state after a timeout gets resolved here — never by charging again.

## If the subscription notification is missed

`POST /subscription/getSubscriberList` exists precisely to catch up on subscription notifications
you did not receive. Page it rather than losing the changes. See `references/04-subscription.md`.

## Test without an mSpace account

The payloads are fully specified, so post them yourself:

```bash
./scripts/test-callbacks.sh http://localhost:3000
```

It covers valid, malformed, wrong-application, missing-field, oversized **and duplicate** payloads —
the duplicate test is the one people skip. It is plain curl, so it tests a handler written in any
language. The mSpace simulator from the developer bundle drives the same handlers locally.

Every payload, field by field, with its replay command: `references/14-curl-reference.md`.

Working handlers, in the language of the host project:
`templates/typescript/callbacks-nextjs.ts` (Next.js), `templates/python/callbacks_fastapi.py`,
`templates/java/MspaceCallbackController.java` (Spring), `templates/go/callbacks.go`,
`templates/php/callbacks.php`, `templates/csharp/MspaceCallbacks.cs` (ASP.NET Core). For any other
stack, the per-language acknowledge-first table is in `references/12-any-stack.md`.

Full contract: `references/08-callbacks.md`.
