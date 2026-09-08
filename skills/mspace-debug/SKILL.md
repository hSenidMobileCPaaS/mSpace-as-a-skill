---
name: mspace-debug
description: Diagnose a failing mSpace integration from a status code or a symptom — E1303, E1313, E1309, E1104, P1003 rejected as a failure, callbacks not arriving, USSD sessions dying, double charges, works-locally-fails-deployed. Use when an mSpace call or callback is not behaving.
---

# Debug an mSpace integration

Start with the tool, not with guesses. Every mSpace bug is in one of three
places — the request body you sent, the response body you got back, or the
application record — and there is a command for each:

```bash
node tools/mspace.mjs validate <id> '<the exact body you sent>'      # is the request right?
node tools/mspace.mjs response <id> '<the exact body you got>'       # what does the answer mean?
node tools/mspace.mjs code E1303                                     # decode one code
node tools/mspace.mjs diagnose "callbacks never arrive"              # from a symptom
node tools/mspace.mjs curl <id> [key=value ...]   # reproduce the call outside your code
```

`validate` and `response` take `@file` or `-` (stdin), so a captured body goes
straight in without being retyped or quoted by hand.

## The two commands to reach for first

**`validate <id> '<body>'`** checks the request you actually sent against the
contract: missing fields, enum values, `tel:` prefixes, array-vs-string, the
documented limits, and — the one that produces the strangest bugs — **fields
typed as JSON numbers that mSpace expects as strings**. `amount`, `otp`,
`referenceNo`, `externalTrxId`, `action`, `encoding` and `deliveryStatusRequest`
are all strings on the wire; `requestPage` is the only documented integer. A
JSON encoder that receives a numeric variable turns `"5.00"` into `5`, drops the
leading zero from an OTP, and reduces a 31-digit `referenceNo` to `8.8e+30` — on
the one call that moves money. The platform answers `E1103`, `E1107` or `E1312`
and the body looks fine at a glance.

**`response <id> '<body>'`** reads the answer against the contract of the call
that produced it: whether that code is *this* endpoint's success, which field
the message is in, which documented fields are missing, per-recipient failures
hiding under a top-level `S1000`, and what to do next. It exits non-zero on a
failure, so it drops into a script.

```bash
$ node tools/mspace.mjs response caas-otp-generation '{"statusCode":"P1003", …}'
  ✓ success  P1003   success for this call: P1003
  Next · Persist requestCorrelator … it is what goes to OTP Verification as referenceNo
```

## Get the real error first

mSpace returns **HTTP 200 for failures**. If the code decides on the HTTP status — `res.ok`,
`raise_for_status()`, `EnsureSuccessStatusCode()`, Guzzle's `http_errors`, a `2xx` check — it is
swallowing the error. Log `statusCode` and `statusDetail` before investigating anything else — most
"mysterious" mSpace bugs are a clear code that nothing was reading.

Then check the opposite failure: **the code may be rejecting a success**. `P1003` on CaaS OTP
generation and `S1001` on Subscriber List are documented successes, and CaaS OTP verification puts
its message in `statusDescription` rather than `statusDetail`.

## Failure signatures

| Symptom | Almost always |
|---|---|
| Every charge "fails" but subscribers receive an OTP | The client rejects `P1003`. It is the success code for `/caas/direct/debit` — the OTP went out and nothing is charged yet. |
| `E1855` on every charge confirmation | `externalTrxId` is being sent as `referenceNo`. It must be the `requestCorrelator` from the generation response. |
| The verification response has no message | Reading `statusDetail` on `/caas/otp/verify`, which returns `statusDescription`. |
| Subscriber List "fails" on a new application | `S1001` ("No Subscribers Found") treated as an error. It is a success. |
| Everything returns `E1303` | Calling from an IP that is not in *Allowed Host Address* — a laptop, a CI runner, or a serverless function with rotating egress. Determine the egress IP **on the calling server**. |
| Everything returns `E1313` | Wrong credentials, the wrong environment's credentials, or the application is not active. |
| Everything returns `E1104` | The application is not in Active or Limited Production status. |
| One API returns `E1309`, others work | That API was not provisioned. An application-record fix, not a code fix. |
| Test number gets nothing, no error | The number is not in *Whitelisted Numbers* while the application is in Limited Production (`E1343`). |
| `E1103` / `E1107` / `E1312` on a call that looks right | The body does not match the contract. Nearly always a string field serialised as a JSON number (`amount`, `otp`, `referenceNo`, `externalTrxId`, `action`), `destinationAddresses` sent as a bare string, a missing mandatory field, or an address without `tel:`. `validate` finds all four. |
| A charge is rejected with a `referenceNo` that "looks right" | The value went through a JSON number. `8801442233146169943053700500040` becomes `8.8e+30` and no longer matches anything. Keep it a string end to end. |
| Callbacks never arrive | URL not publicly reachable, wrong on the application record, a WAF challenge, auth middleware in front, or the handler is not returning 200 with `S1000`. |
| You never learn a subscriber unsubscribed | The Subscription Notification URL is not configured, or its handler is failing. It is the only place a change you did not initiate shows up. Catch up with `POST /subscription/getSubscriberList`. |
| `E1607` on the charging path | Your callback returned something the platform could not parse. It must be `{"statusCode":"S1000","statusDetail":"Success"}`. |
| USSD dies mid-flow | Session store not shared across instances or workers (an in-process map, whatever the language), a self-generated `sessionId`, no `mt-fin`, or a handler too slow for the session timeout. |
| Duplicate charges | A charge retried with a fresh `externalTrxId` after a timeout. |
| Location comes back for the wrong person | LBS `requesterId` and `subscriberId` swapped — they are separate mandatory fields. |
| `latitude`/`longitude` undefined | They are absent on every LBS failure, and the response uses `messageID` (capital D) and `timestamp` (lower-case s). |
| `E1318` / `E1319` / `E1105` | Transaction limits, per second, per day, and TPS on Subscriber List. Throttle on your side. |
| Works locally, fails deployed | The egress IP changed, or secrets are not set in the host environment. |
| Certificate / TLS errors | Incomplete certificate chain — supply the intermediate CA, do **not** disable verification. |

## Narrowing it down

1. **Is it every call or one call?** Every call points at `E1303`/`E1313`/`E1104` — configuration.
   One call points at that service's provisioning or your payload.
2. **Is it actually failing, or is the client rejecting a success?** Print the raw
   `statusCode` before anything interprets it, then run the body through
   `node tools/mspace.mjs response <id> '<body>'` — it knows which codes are a success
   for that endpoint and which field the message is in.
3. **Is the payload even valid?** `node tools/mspace.mjs validate <id> '<json>'` —
   against the body your code actually sent, captured from a log or an HTTP recorder,
   not the one you meant to send. Types matter here as much as fields.
4. **Take the code out of it.** Run the endpoint by hand from `references/14-curl-reference.md`
   (or `node tools/mspace.mjs curl <id> key=value …`) **from the same server**. A curl that works
   proves the payload, the credentials, the provisioning and the egress IP are all fine, and the
   bug is in your code; a curl that fails gives you the real `statusCode` with nothing swallowing
   it.
5. **Is it environment-specific?** Compare the egress IP and the loaded config between the working
   and failing environments.
6. **For a charge, which of the three exchanges failed?** Generation, verification, or the
   notification. They fail differently and only the notification is authoritative.

## Reproducing without the platform

The mSpace developer bundle ships a local simulator (`sdp-simulator.bat console`, then
`http://localhost:10001/`; needs Java 1.6.0 or above). Point the `MSPACE_*_URL` variables at it to
reproduce a flow with no account and no live traffic. `./scripts/test-callbacks.sh` replays every
documented callback payload — including duplicates and malformed bodies — against your own handler.

## Debugging a callback

The inbound half fails differently: nothing arrives, or something arrives and your
handler answers wrongly. Both are testable without the platform.

```bash
node tools/mspace.mjs show <id>          # sms-mo, sms-dlr, ussd-receive,
                                         # subscription-notification, charging-notification
./scripts/test-callbacks.sh http://localhost:3000
```

Every handler must answer HTTP 200 with `{"statusCode":"S1000","statusDetail":"Success"}`
— for malformed and rejected payloads too, since a 4xx or 5xx just triggers redelivery.
Anything the platform cannot parse comes back as `E1607` on the *outbound* path, which
is why a mysterious `E1607` on a charge is a bug in your callback's response.

The subscription notification is the one to check when subscription state drifts: mSpace
publishes no payload for that URL, so a handler that hard-fails on a missing field
silently drops real changes. Accept what arrives, verify `applicationId` only when it is
present, and reconcile with `POST /subscription/getSubscriberList`.

## Escalating

Quote the identifiers: `requestId`, `externalTrxId`, `internalTrxId`, `requestCorrelator`,
`sessionId`, and the `statusCode`. Those are what a trace is built from.
Platform and documentation: <https://mspace.lk> · <https://www.mobitel.lk/mspace>.

Detail: `references/09-status-codes.md` and the failure table in
`references/11-production-checklist.md`.
