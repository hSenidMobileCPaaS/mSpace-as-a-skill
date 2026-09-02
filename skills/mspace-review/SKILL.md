---
name: mspace-review
description: Review mSpace integration code for the mistakes that cost money, leak credentials, or get an application suspended. Use when asked to review, audit, or check mSpace code, or before merging a pull request that touches mSpace.
---

# Review an mSpace integration

Run `node tools/mspace.mjs practices` first, then check each one against the code. Report findings
with `file:line`, most severe first. Do not report style opinions — only these.

## Critical — stop the merge

| Check | How it looks in code |
|---|---|
| Hardcoded credentials | An `APP_` id or a long alphanumeric password in source, tests, fixtures, a config file (`application.yml`, `appsettings.json`, `settings.py`) or git history |
| Credentials in a client bundle | A browser-exposed prefix (`NEXT_PUBLIC_`/`VITE_`/`REACT_APP_`/`PUBLIC_`/`EXPO_PUBLIC_`) on an mSpace variable, a config endpoint that serves them, or any mSpace call in browser or mobile code |
| HTTP status treated as success | `res.ok`, `res.status === 200`, `raise_for_status()`, `EnsureSuccessStatusCode()`, `response.IsSuccessStatusCode`, Guzzle `http_errors` — with no `statusCode` check |
| `S1000` hard-coded as the only success | Reports every successful CaaS OTP generation (`P1003`) as a failure, and an empty subscriber base (`S1001`) as an error. The success set must be per service. |
| Charging modelled as one call | `POST /caas/direct/debit` treated as "the charge". It only sends an OTP; the money moves on `/caas/otp/verify`, and the charging notification settles it. |
| `externalTrxId` sent as `referenceNo` to CaaS OTP verification | It wants the `requestCorrelator` from the generation response. Gives `E1855`, and hides a broken charge flow. |
| Non-idempotent charging | `externalTrxId` generated inside a retry, or after the API call rather than before |
| Charge retried with a new ID | Any generic retry wrapper (Polly, tenacity, Spring Retry, an interceptor) around the charging calls |
| Charging without consent evidence | No stored record of who agreed, when, and to what amount |
| Disabled TLS verification | `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `verify=False`, `InsecureSkipVerify: true`, `CURLOPT_SSL_VERIFYPEER => false`, a trust-all `TrustManager`, or a certificate callback returning `true` — outside a gated development path |

## High

- Only `statusDetail` read on the CaaS OTP verification response, which returns
  `statusDescription` and a boolean `status`.
- `destinationAddresses` passed as a string rather than an array.
- `version` omitted on SMS Send or USSD Send, where it is mandatory.
- Subscription status treated as two-valued. There are six: `INITIAL`, `REG_PENDING`, `TRIAL`,
  `REGISTERED`, `UNREGISTERED`, `TEMPORARY_BLOCKED`.
- A top-level `messageId` expected on an SMS send response — the identifiers are per recipient,
  inside `destinationResponses`, and per-recipient `statusCode` values ignored on a multi-recipient
  send.
- LBS `requesterId` and `subscriberId` swapped or conflated, or `messageID`/`timestamp` read with
  the wrong casing.
- `tel:` concatenated inline instead of through one normalising helper — or SMS `sourceAddress`
  pushed through that helper, when it is a sender alias rather than a subscriber address.
- `subscriberId` parsed, trimmed, or assumed to be a phone number.
- Callback handler doing work before returning `S1000` — including an inline `await` or blocking
  call where the stack has a real background mechanism.
- Callback handler with no deduplication key, or one that could double-count a repeated charging
  notification.
- Callback handler that trusts the body, or has no schema validation.
- A callback returning non-200 on a malformed payload, which just triggers redelivery.
- `tel:all` reachable from an ordinary code path.
- Secrets, OTPs, `referenceNo`, `requestCorrelator` or unmasked `subscriberId` in logs.

## Medium

- No explicit timeout on outbound calls.
- Retries on definitive codes, or retries without backoff.
- More than 10 `subscriberIds` sent to Subscriber Charging Info; `requestPage` below 1 on
  Subscriber List.
- Subscriber List paging that stops on `S1001` as an error, or ignores `nextPageNumber: -1`.
- USSD `sessionId` generated locally instead of echoed from the platform.
- USSD flow ending in `mt-cont` instead of `mt-fin`.
- An in-process USSD session store (`Map`, `dict`, `HashMap`, package-level `map`, `MemoryCache`)
  where more than one instance or worker runs.
- `getStatus` polled per request instead of mirroring the Subscription Notification URL.
- Money held in a binary float (`number`, `float`, `double`) rather than a decimal type, or a
  currency other than `LKR`.
- A new runtime or sidecar introduced purely to call mSpace from a non-JS project.
- Amount or currency taken from client input.
- A call to an endpoint mSpace does not publish — an IVR route, or a balance-query path.

## Output

For each finding give the rule, the evidence, and the specific fix. Finish with a plain verdict on
whether this is safe to put in front of real subscribers who can be charged real money.
