---
name: mspace-debug
description: Diagnose a failing mSpace integration from a status code or a symptom — E1303, E1313, E1309, E1104, P1003 rejected as a failure, callbacks not arriving, USSD sessions dying, double charges, works-locally-fails-deployed. Use when an mSpace call or callback is not behaving.
---

# Debug an mSpace integration

Start with the tool, not with guesses:

```bash
node tools/mspace.mjs code E1303
node tools/mspace.mjs diagnose "callbacks never arrive"
node tools/mspace.mjs validate <id> '<payload>'
node tools/mspace.mjs curl <id> [key=value ...]   # reproduce the call outside your code
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
| Callbacks never arrive | URL not publicly reachable, wrong on the application record, a WAF challenge, auth middleware in front, or the handler is not returning 200 with `S1000`. |
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
   `statusCode` before anything interprets it.
3. **Is the payload even valid?** `node tools/mspace.mjs validate <id> '<json>'`.
4. **Take the code out of it.** Run the endpoint by hand from `references/13-curl-reference.md`
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

## Escalating

Quote the identifiers: `requestId`, `externalTrxId`, `internalTrxId`, `requestCorrelator`,
`sessionId`, and the `statusCode`. Those are what a trace is built from.
Platform and documentation: <https://mspace.lk> · <https://www.mobitel.lk/mspace>.

Detail: `references/08-status-codes.md` and the failure table in
`references/10-production-checklist.md`.
