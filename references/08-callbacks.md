# Callbacks (Inbound Webhooks)

Half of mSpace is inbound. The platform `POST`s JSON to URLs you register during provisioning. If
you only build outbound calls, MO SMS never arrives, USSD never works, and you never learn that a
subscriber left or a charge failed.

## The callback URLs

Provisioning defines five URLs, in four different configuration sections:

| Callback | Fires when | Configured under | Payload spec |
|---|---|---|---|
| **SMS Receive (MO)** | A subscriber texts your short code with your keyword | SMS configuration — *Message Receiving URL* | [02-sms.md](02-sms.md) |
| **SMS Delivery Report** | An MT SMS sent with `deliveryStatusRequest: "1"` reaches a final state | SMS configuration — *Delivery Report URL* | [02-sms.md](02-sms.md) |
| **USSD Receive** | A subscriber dials your service code or presses a key | USSD configuration — *Connection URL* | [03-ussd.md](03-ussd.md) |
| **Charging Notification** | A charging request completes | CaaS configuration — *Charging Notification URL* | [06-caas.md](06-caas.md) |
| **Subscription Notification** | A subscription is created or removed | Subscription configuration — *Subscription Notification URL* | see below |

> Four of these five have a published payload in the mSpace API documentation. **The subscription
> notification does not.** The documentation publishes `POST /subscription/notify` — *Subscriber
> Notifications*, "This service sends notifications to the users" — with the field vocabulary
> `timeStamp`, `version`, `applicationId`, `password`, `subscriberId`, `frequency` and `status`,
> and provisioning separately defines a *Subscription Notification URL*. Write that handler
> tolerantly: accept those fields, log the raw body on the first delivery in Limited Production,
> and widen it to whatever actually arrives. Do not invent fields for it.

**Subscriber List (`POST /subscription/getSubscriberList`) is the safety net.** Its documented
purpose is to let you catch up on the subscription notifications you missed receiving — so if
this callback is down for an hour, you can reconcile rather than lose the changes. See
[04-subscription.md](04-subscription.md#subscriber-list).

## The contract — same for all of them

**In:** `POST`, `Content-Type: application/json`, a flat JSON object. The SMS, USSD and
subscription payloads carry your `applicationId`.

**Out:** HTTP 200 with

```json
{ "statusCode": "S1000", "statusDetail": "Success" }
```

That is the whole contract. There is no other response shape, and — importantly — **the response
body is an acknowledgement, not a reply**. For USSD in particular, the screen the subscriber sees
comes from a separate `POST /ussd/send`, not from what you return here.

`E1607` — *Unable to read application response* — is what the platform reports when your handler
returns something it cannot parse. If you see it on the charging path, the bug is in your
callback's response, not in your request.

---

## Rules

### 1. Acknowledge first, work second

Respond `S1000` immediately, then process asynchronously. Never do a database write chain, a
third-party call, or an mSpace call *before* responding.

USSD sessions time out in seconds. Delivery reports arrive in bursts. A slow handler causes
retries, duplicates, and dropped sessions.

```
handler(request):
    body = parse_json(request)          # malformed → still acknowledge
    enqueue(body)                       # hand off; do NOT wait for the work
    return 200, { "statusCode": "S1000", "statusDetail": "Success" }
```

"Enqueue" means the stack's real background mechanism — a queue or broker, `BackgroundTasks` in
FastAPI, `@Async` in Spring, a worker goroutine, a hosted service in .NET, a queued job in
Laravel. Not a bare `await`, and not "it's fast enough". The per-stack table is in
[12-any-stack.md](12-any-stack.md#6-callback-endpoints).

### 2. Be idempotent

Every callback can arrive more than once. Deduplicate on the natural key:

| Callback | Dedupe key |
|---|---|
| SMS Receive (MO) | `requestId` |
| Delivery report | `requestId` + `deliveryStatus` |
| USSD Receive | `requestId` |
| Charging notification | `externalTrxId` + `statusCode` |
| Subscription notification | `subscriberId` + `status` + `timeStamp` |

A duplicate charging notification that double-counts revenue is a real bug with real
consequences. Design for redelivery from the start.

### 3. Never trust the body

The payload is unauthenticated JSON from the public internet. Anyone who learns your URL can post
to it.

- **Validate the schema** — types, required fields, enum values. Reject anything else with
  `S1000` (acknowledge, discard) rather than crashing.
- **Verify `applicationId` matches yours** where the payload carries it. Cheap, and it filters
  noise immediately. Note the delivery report and charging notification payloads do not include
  it, so those handlers need the source-IP control instead.
- **Restrict by source IP** at the firewall, load balancer or middleware. mSpace signs nothing,
  so there is no signature to verify — source IP is the strongest control available.
- **Never treat a callback as authorisation.** A subscription notification claiming a subscriber
  registered must not, by itself, unlock a paid feature — reconcile against your own state.
- **Never echo request content back** into an SMS or USSD screen without sanitising. That is how
  you become a spam relay.
- **Rate-limit the endpoint.** An unprotected callback URL is a free amplification target.

### 4. Always return 200

Return `S1000` even for payloads you reject. A 4xx or 5xx makes the platform retry, and you get
the same bad payload again. Log it, alert on the pattern, and acknowledge.

The exception: if your handler is genuinely broken (database down) and you *want* redelivery, a
5xx is correct — but only if you have verified the platform actually retries for that callback
type. Do not assume it does.

### 5. Log for traceability, not for surveillance

Log `requestId`, `sessionId`, `externalTrxId`, `internalTrxId`, `statusCode`, and a timestamp.
**Mask `subscriberId` / `sourceAddress`** to last-3-digits. **Never log message bodies containing
user content** unless you have a stated reason and a retention policy — MO SMS content is user
communication.

---

## URL design

Choose paths before provisioning; changing them later means editing the application record.

```
POST /api/mspace/sms/receive
POST /api/mspace/sms/report
POST /api/mspace/ussd/receive
POST /api/mspace/subscription/notification
POST /api/mspace/charging/notification
```

Requirements:

- **HTTPS with a valid, complete certificate chain.** Self-signed will not work.
- **Publicly reachable** — no VPN, no basic auth prompt, no bot-protection challenge page.
  Anything that interrogates the client will silently break these; allowlist the callback paths.
- **Stable.** Do not put them behind a preview URL that rotates per deployment.
- Add an unguessable path segment (`/api/mspace/x7f3k9/ussd`) as defence in depth — it is not
  authentication, but it stops opportunistic scanning.
- Exempt them from CSRF protection (they are machine-to-machine `POST`s with no cookie).
- Exempt them from any auth middleware — but then apply the IP restriction, or you have an open
  endpoint.

### Local development

Callbacks cannot reach `localhost` from the platform. Two options:

1. **The mSpace simulator** from the developer bundle, which runs locally at
   `http://localhost:10001/` and can drive your handlers without any tunnel. See
   [01-getting-started.md](01-getting-started.md#testing-before-provisioning).
2. **A tunnel**, for development only:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   # or
   ngrok http 3000
   ```
   Register the tunnel URL on the application record while testing, and remember it changes on
   restart with free tiers. **Never leave a tunnel URL configured in a production application
   record.**

---

## Reference handler

The same five steps in every language and framework:

```
ACK = { "statusCode": "S1000", "statusDetail": "Success" }

handler(request):
    if not from_mspace_ip(request):       return 200, ACK   # allowlist, if configured
    body = try_parse_json(request)
    if body is null:                      return 200, ACK   # malformed — acknowledge, discard
    if not schema_valid(body):            return 200, ACK   # log the pattern, do not crash
    if body.applicationId != config.applicationId:
                                          return 200, ACK   # someone else's payload
    if seen_before(dedupe_key(body)):     return 200, ACK   # redelivery
    enqueue("sms.mo", body)                                 # process out of band
    return 200, ACK
```

Note what never happens: no 4xx, no 5xx, no work before the response, no trust in the body.

Complete working routes for all five callbacks, per stack:

| Stack | File |
|---|---|
| TypeScript / Next.js | [templates/typescript/callbacks-nextjs.ts](../templates/typescript/callbacks-nextjs.ts) |
| Python / FastAPI | [templates/python/callbacks_fastapi.py](../templates/python/callbacks_fastapi.py) |
| Java / Spring | [templates/java/MspaceCallbackController.java](../templates/java/MspaceCallbackController.java) |
| Go / net/http | [templates/go/callbacks.go](../templates/go/callbacks.go) |
| PHP (framework-neutral, Laravel notes) | [templates/php/callbacks.php](../templates/php/callbacks.php) |
| C# / ASP.NET Core | [templates/csharp/MspaceCallbacks.cs](../templates/csharp/MspaceCallbacks.cs) |

Any other stack: [12-any-stack.md](12-any-stack.md).

---

## Testing callbacks

You do not need the platform to test a handler — the payloads are fully specified. Post them
yourself:

```bash
curl -X POST http://localhost:3000/api/mspace/ussd/receive \
  -H 'Content-Type: application/json' \
  -d '{"version":"1.0","applicationId":"APP_000029","message":"*141#",
       "requestId":"1330933229901","sessionId":"1330929317043",
       "ussdOperation":"mo-init","sourceAddress":"tel:94702725777","encoding":"440"}'
```

Build a test for each of: valid payload, malformed JSON, wrong `applicationId`, missing required
field, and **the same payload twice** (the idempotency test — the one people skip).

Ready-made payloads for every callback: [scripts/test-callbacks.sh](../scripts/test-callbacks.sh),
and all of them written out field by field — what arrives, what you must respond, the dedupe key,
and a command that replays the exact payload against your route — in
[14-curl-reference.md](14-curl-reference.md).
