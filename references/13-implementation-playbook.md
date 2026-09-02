# Implementation Playbook — A to Z

Everything from "we have an idea" to "real subscribers are being charged", for **any** language
and **any** starting point. Work top to bottom on a new project; jump to
[§2](#2-entry-point-b--mid-build) or [§3](#3-entry-point-c--retrofit-into-a-live-application) if
code already exists.

Every step below that says *write the call* means: take the endpoint from
[14-curl-reference.md](14-curl-reference.md) — a runnable curl with every parameter defined and
every response field explained — and translate the request into the project's own HTTP client.
That is the same instruction whatever the language is; nothing in this playbook assumes one.

```bash
node tools/mspace.mjs curl <id> [key=value ...]   # one endpoint, your values, validated
node tools/mspace.mjs reference 14-curl-reference # all of them
```

---

## 0. Establish the ground truth (all entry points)

Ask these five questions before writing anything. Each answer changes the plan, and guessing
wastes days.

| Question | If yes | If no |
|---|---|---|
| Provisioned application? (`APP_00XXXX` + password) | Note which APIs were enabled | Start at [01-getting-started](01-getting-started.md); you can build and exercise everything against the mSpace simulator first |
| Which APIs are enabled? | Configure exactly those URLs | An unprovisioned call fails `E1309` no matter how perfect the payload |
| Static egress IP? | Add it to *Allowed Host Address* | Decide the hosting story now — NAT gateway, static-IP proxy or a fixed host. Retrofitting this is painful |
| Public HTTPS URLs for callbacks? | Register the five paths | MO SMS, USSD and every notification cannot work at all until there are |
| Limited Production or full? | Only whitelisted numbers work | Full production means real subscribers and real money on every call |

Run `node tools/mspace.mjs platform` for the base URL and conventions, and
`node tools/mspace.mjs list` for what exists.

---

## 1. Entry point A — greenfield

You are building the application around mSpace.

**1. Choose the stack.** Whatever you would use anyway — mSpace is JSON over HTTPS. See
[12-any-stack](12-any-stack.md).

**2. Config first, so no credential can ever land in source.**

```bash
cp templates/.env.example .env          # then fill in APP_ID + password
```

One module reads those variables, validates at startup and fails loudly — see
[12-any-stack §1](12-any-stack.md#1-config). Nothing else in the codebase touches the
environment.

**3. Write the client and the error module.**

The client is one `post()` — credential injection, a 15-second timeout, `statusCode` branching
with a **per-service success set** — plus a thin wrapper per service, each built from its entry in
[14-curl-reference.md](14-curl-reference.md). The error module is the six handling classes from
[09-status-codes](09-status-codes.md), whose complete table carries a class per code. Both are
specified language-neutrally in [12-any-stack](12-any-stack.md), and
[templates/](../templates/README.md) shows them already built in six languages if one matches your
stack.

**4. Prove the credentials before building features.** Query Base needs no subscriber and charges
nothing:

```bash
./scripts/smoke-test.sh    # or: node tools/mspace.mjs curl subscription-query-base
```

`S1000` means credentials, the allowed-host-address list and connectivity are all correct.
`E1313` is credentials, `E1303` is the egress IP, `E1309` is provisioning, `E1104` is the
application's state. Fix before continuing.

**5. Build the flow you actually need** — [§4](#4-flow-recipes).

**6. Callbacks** — [§5](#5-callbacks-half-the-integration).

**7. Error handling** — [§6](#6-error-handling-that-survives-production).

**8. Go live** — [§8](#8-go-live).

---

## 2. Entry point B — mid-build

An application exists; mSpace is a feature you are adding now.

1. **Find the seam.** mSpace is an outbound integration plus five inbound routes. It belongs
   beside your other third-party clients — `services/`, `integrations/`, `infrastructure/`,
   whatever this codebase already calls that layer. Do not scatter calls through controllers.
2. **Audit what exists first** if any mSpace code is already there:
   `node tools/mspace.mjs practices` and the `mspace-review` skill. Half-built integrations
   usually have a hardcoded credential and an `if (res.ok)`.
3. **Build into your own module** rather than pasting endpoint URLs into existing services — one
   client, one `post()`, one wrapper per service.
4. **Reuse what the project already has** — its HTTP client, its logger, its queue, its secret
   manager. Only the `statusCode` branching and the per-service success codes are non-negotiable;
   everything around them follows the project's conventions.
5. Continue at [§4](#4-flow-recipes).

---

## 3. Entry point C — retrofit into a live application

Users already depend on this application. The integration must land without disturbing them.

1. **Ship it dark.** Put every mSpace path behind a flag that defaults to off. Telco calls cost
   money and messages reach real phones; a half-finished flow that goes live by accident is a
   support incident.
2. **Callbacks are additive** — five new routes that return `S1000`. They can be deployed and
   registered before any user-facing feature exists, and they will simply log until you use them.
   Deploy them first: registering the URLs on the application record starts an approval clock, so
   start it early.
3. **The egress IP is the usual blocker.** A running production application may sit behind
   autoscaling or serverless egress. Check it on the real server before promising a date.
4. **Do not retrofit charging first.** Land SMS or subscription, watch it for a week, then add
   CaaS — its failure modes are the expensive ones, and the OTP round-trip adds a user-facing step
   you will want to design properly rather than bolt on.
5. **Map existing users to subscribers deliberately.** An existing account is not consent. You
   need a fresh opt-in, recorded, before Register or any charge — see
   [10-security-best-practices](10-security-best-practices.md#5-consent).
6. **Keep the blast radius visible:** log `statusCode` from day one and alert on the configuration
   class (`E1303`, `E1313`, `E1309`, `E1104`) before you enable anything for users.

---

## 4. Flow recipes

The four flows that cover almost every mSpace application. Each is a sequence of calls plus the
state you must keep.

### A. Keyword opt-in over SMS

```
subscriber texts JOIN to your short code
  → MO SMS callback fires             (sms-mo)
  → you record consent + timestamp
  → register(subscriberId)            (subscription-register, action "1")
  → sendSms(subscriberId, welcome)    (sms-send)
subscriber texts STOP
  → MO SMS callback fires
  → unregister(subscriberId)          (subscription-unregister, action "0")
  → stop every queued message for that subscriber
```

State to keep: a subscription mirror keyed by `subscriberId`, a consent record, dedupe on
`requestId`. Remember the six subscription statuses — do not treat "not REGISTERED" as
"UNREGISTERED".

### B. Web or app sign-up without SMS

```
subscriber types their number
  → requestOtp(subscriberId, metaData)   (otp-request) → referenceNo (server-side only)
subscriber types the OTP
  → verifyOtp(referenceNo, otp)          (otp-verify)  → masked subscriberId
  → store the MASKED id; it is the identifier for every later call
```

Rate-limit per number **and** per IP before `requestOtp`, or the application is an SMS-bombing
tool. `E1853` is the platform telling you its own limit was reached; it is not your rate limiter.

### C. USSD menu

```
subscriber dials *xxx#
  → USSD receive callback, ussdOperation "mo-init"   (ussd-receive)
  → acknowledge S1000 immediately
  → create session keyed by the platform's sessionId
  → sendUssd(sessionId, address, screen, "mt-cont")  (ussd-send)
subscriber presses a key
  → USSD receive callback, "mo-cont" → look up session → next screen
last screen
  → sendUssd(..., "mt-fin") and delete the session
```

The session store must be shared across instances and expire in about 2 minutes. Screens are plain
ASCII, about 160 characters. Never generate your own `sessionId`.

### D. Charging — three exchanges, one transaction

```
before anything
  → externalTrxId = generate();  PERSIST IT with state PENDING

1. startCharge(subscriberId, amount, externalTrxId)   (caas-otp-generation)
     P1003  → SUCCESS. Persist requestCorrelator + internalTrxId. State AWAITING_OTP.
              mSpace has SMSed an OTP to the subscriber. Nothing is charged yet.
     E-code → FAILED. Nothing charged. Investigate; do not blind-retry.
     timeout→ UNKNOWN. Settle from the charging notification.

2. subscriber reads the OTP and enters it in your application

3. verifyCharge(requestCorrelator, otp, sourceAddress)  (caas-otp-verify)
     S1000 + status true → CHARGED (pending confirmation)
     E1850 → invalid OTP: prompt again
     E1852 → attempts exhausted: FAILED, start a new charge only on a fresh user action
     Read statusDescription, not statusDetail.

4. charging notification arrives at your Charging Notification URL
     S1000 with balanceDue 0.00 → confirmed CHARGED
     E1404 / E1405 → FAILED
     Match on externalTrxId. Deduplicate on externalTrxId + statusCode.
```

Money is a decimal type end to end, and the currency is `LKR`. **Never** generate a fresh
`externalTrxId` on a retry.

---

## 5. Callbacks: half the integration

Five inbound routes, one contract. Write them from
[14-curl-reference.md](14-curl-reference.md), which gives each published payload field by field,
the response you must return, the dedupe key, and a curl that replays the exact payload against
your route.

| Callback | Fires when | Without it |
|---|---|---|
| SMS Receive (MO) | a subscriber texts your short code | keyword opt-in and STOP silently do nothing |
| Delivery report | an MT SMS reaches a final state | you cannot prove delivery |
| USSD receive | a subscriber dials or presses a key | USSD does not work at all |
| Subscription notification | anyone subscribes or unsubscribes | your local state drifts from the platform's |
| Charging notification | a charge reaches a final state | timed-out charges never settle |

Rules that are not negotiable: acknowledge `S1000` **before** doing work, always HTTP 200,
deduplicate on the documented key, never trust the body. Full detail in
[08-callbacks](08-callbacks.md).

Register the paths on the application record once and keep them stable — changing a path later
means editing that record.

---

## 6. Error handling that survives production

Build one error module: every published code, its handling class, and the per-service success
codes. The complete table in [09-status-codes](09-status-codes.md) carries a class per code, and
the same data is in `catalog/mspace-api.json` if you would rather generate the sets than retype
them. Wire it in like this:

| Class | Your behaviour |
|---|---|
| `success` | Proceed. |
| `pending` | Accepted, not finished. Persist the state and wait for the notification. Do not re-send. |
| `configuration` | **Page someone.** The integration is down, not one request. Never retry. |
| `client` | Fix the payload or prompt the user. Never retry unchanged. |
| `user-state` | Communicate. Retry only after the subscriber acts. |
| `transient` | Exponential backoff with jitter, capped attempts, then dead-letter. |

Three codes are successes that a naive client rejects: `P1003` on CaaS OTP generation, `S1001` on
Subscriber List, and — not a code but the same class of bug — `statusDescription` instead of
`statusDetail` on CaaS OTP verification.

Log `requestId` / `sessionId` / `externalTrxId` / `internalTrxId` / `statusCode` on every
operation — those are what a support trace is built from. Never log the password, the OTP,
`referenceNo`, `requestCorrelator`, or an unmasked subscriber address.

---

## 7. Testing before — and after — provisioning

| What | How |
|---|---|
| The whole integration, with no account | The **mSpace simulator** from the developer bundle: `sdp-simulator.bat console` (or `sh sdp-simulator console`), then `http://localhost:10001/`. Point your `MSPACE_*_URL` variables at it. Needs Java 1.6.0 or above. |
| Callback handlers | `./scripts/test-callbacks.sh http://localhost:3000` — valid, malformed, wrong-application, missing-field, oversized and duplicate payloads. Plain curl, so it works against any language |
| Outbound payloads | `node tools/mspace.mjs validate <service> '<json>'` before you ever send one |
| Credentials and network | `./scripts/smoke-test.sh` from the server that will make the calls |
| Failure paths | Force `E1313` (wrong password), `E1303` (call from an unlisted IP), `E1850` (wrong OTP) and a timeout. Handling code that has never run is not handling code |

---

## 8. Go live

```bash
node tools/mspace.mjs checklist          # every item, with evidence required
```

Run it against the real project and mark each item PASS / FAIL / CANNOT VERIFY with the evidence —
a file path, a config value, a test run. The full list is in
[11-production-checklist](11-production-checklist.md); the nine sections are credentials, network,
correctness, callbacks, charging, consent, privacy, operations and testing.

The last question is the only one that matters: **is this safe to put in front of real subscribers
who can be charged real money?**

---

## Quick command map

| You want to | Run |
|---|---|
| See what exists | `mspace list` |
| Get one contract exactly | `mspace show <service>` |
| Write a call, in any language | [14-curl-reference.md](14-curl-reference.md), or `mspace curl <service> key=value …` |
| Write the whole client | [12-any-stack](12-any-stack.md), the seven components |
| Wire up error codes | [09-status-codes](09-status-codes.md), the Class column |
| Write the webhooks | [14-curl-reference.md](14-curl-reference.md), the callbacks half |
| Check a payload | `mspace validate <service> '<json>'` |
| Decode a failure | `mspace code <statusCode>` |
| Diagnose a symptom | `mspace diagnose "<symptom>"` |
| Ship it | `mspace checklist` |
