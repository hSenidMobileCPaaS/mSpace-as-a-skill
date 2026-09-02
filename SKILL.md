---
name: mspace
description: Build and integrate mSpace (Mobitel's Sri Lankan application platform) services into any application — SMS, USSD, Subscription (register, unregister, status, base size, charging info, subscriber list, notifications), OTP, CaaS charging (OTP-authorised mobile-account debit) and LBS. Use this whenever the user mentions mSpace, Inzpire, Xpand, api.mspace.lk, MSISDN/`tel:` addressing, short code and keyword routing, USSD menus, subscriber base size, mobile-account charging, or telco SMS/USSD in Sri Lanka. Covers request/response contracts, callback (webhook) handlers, status codes, credential handling and go-live requirements.
---

# mSpace Integration Skill

mSpace is Mobitel's application platform for **Sri Lanka**. It exposes carrier capabilities — SMS,
USSD, subscription lifecycle, mobile-account charging, OTP verification, location — as
JSON-over-HTTPS APIs that any application can call.

It has two tracks. **Inzpire** is the API track and is what this skill is about. **Xpand** is the
no-code track: Contact, Vote, Alert and Scheduled Messages applications created and managed
through the platform without writing anything. If a user's requirement is fully covered by an
Xpand template, say so rather than building an integration.

This skill makes you able to build a correct, production-shaped mSpace integration from scratch,
or add mSpace to an existing product, **in any language**. The platform is JSON over HTTPS with a
shared-secret credential pair; nothing about it privileges a particular runtime or framework.
Build in whatever the host project already uses.

**Every call comes from one place: [references/14-curl-reference.md](references/14-curl-reference.md).**
It writes out every endpoint as a runnable curl, with every parameter defined, the response it
returns and every response field explained — plus all the inbound callbacks. Translate the request
into the host project's own HTTP client and idiom, and that is the call. There is no code
generator here on purpose: a generator would serve a handful of languages and go stale as their
idioms move, while a curl is the same call in every language and never expires.

[references/12-any-stack.md](references/12-any-stack.md) specifies what surrounds those calls —
the seven components — language-neutrally. [templates/](templates/README.md) shows the whole thing
already built in TypeScript/Node, Python, Java, Go, PHP and C#: worked examples to read for shape
when one matches the project, never a reason to introduce one of those runtimes.

---

## The rules you must never break

These are the mistakes that cost service providers their application approval, their subscribers,
or real money. Apply them without being asked.

1. **Never hardcode `applicationId` or `password`.** They go in environment variables, read
   through one config module that validates at startup. Never in source, never in a client bundle,
   never in a committed file, never in a log line, never in git history. The CaaS password arrives
   by email on application approval — move it into a secret store and delete the mail. See
   [references/10-security-best-practices.md](references/10-security-best-practices.md).

2. **Never call mSpace from client-side code.** Browser JS, mobile apps, and Flutter or React
   Native code must call *your* backend, which calls mSpace. The credentials are a shared secret;
   anything that ships to a device leaks them. The platform also enforces the *Allowed Host
   Address* list, which a mobile client cannot satisfy.

3. **Never charge or subscribe a user without explicit consent, and never without telling them the
   amount and frequency first.** Both are provisioning-level settings on the application, set
   separately for prepaid and postpaid. Consent must be captured and stored with a timestamp.

4. **Never assume the MSISDN is real.** Applications with Mobile Number Masking enabled receive a
   masked value instead of `tel:94702725777`. Treat `subscriberId` as an opaque string, store it as
   given, and send back exactly what you received.

5. **Always make charging idempotent.** Generate a unique `externalTrxId` per charge, persist it
   *before* the call, and never retry with a fresh one — a retry with a new ID can charge a real
   person twice.

6. **`S1000` is not the only success code.** CaaS OTP generation succeeds with **`P1003`**, and
   Subscriber List treats **`S1001`** as a success. A client hard-coded to `S1000` reports working
   flows as broken. See [references/09-status-codes.md](references/09-status-codes.md).

---

## Query the contract, do not recall it

The complete mSpace contract ships as structured data
([`catalog/mspace-api.json`](catalog/mspace-api.json)) with a zero-dependency CLI over it. Run it
instead of reconstructing parameter names from memory — it is offline, read-only, needs no
install, and never sees credentials.

```bash
node tools/mspace.mjs list [category]              # every service and callback
node tools/mspace.mjs show <id>                    # full contract: params, response, rules
node tools/mspace.mjs search "<query>"             # find by intent, e.g. "base size"
node tools/mspace.mjs curl <id> [key=value ...]    # runnable request + param/response defs
node tools/mspace.mjs validate <id> '<json>'       # check a payload against the spec
node tools/mspace.mjs code <statusCode>            # decode a status code + the fix
node tools/mspace.mjs diagnose "<symptom>"         # cause and fix from a symptom
node tools/mspace.mjs practices [severity]         # security and reliability rules
node tools/mspace.mjs checklist                    # go-live checklist
node tools/mspace.mjs reference <doc>              # print a reference document
node tools/mspace.mjs platform                     # base URL, tracks, operator, conventions
```

`--json` on any command for machine-readable output. If you cannot run commands — or Node is not
available — read `catalog/mspace-api.json` directly; it is plain JSON and holds the same data, and
[references/14-curl-reference.md](references/14-curl-reference.md) is the same contract in prose.
The CLI is a documentation reader, not part of the integration: it makes no network calls, never
sees a credential, and puts no constraint on the stack you build in.

## Write the call, do not hand-roll it

**[references/14-curl-reference.md](references/14-curl-reference.md) is where every call comes
from.** Each endpoint is written out at the wire: the request as a runnable curl, every parameter
defined with its type and whether it is required, the exact response, every response field
explained, and that endpoint's status codes with their handling class — plus the same for the
inbound callbacks, each with a command that replays it against your own handler.

Translate the request into the host project's HTTP client and idiom. That is the whole job for the
call itself: the body, the headers and the branching are identical in every language, so Ruby,
Rust, Kotlin and Elixir are exactly as well served as TypeScript. What surrounds the call differs
by stack, and that is [references/12-any-stack.md](references/12-any-stack.md).

`node tools/mspace.mjs curl <id> key=value …` prints the same thing for one service, filled in
with your values and validated as it builds.

Run the curl by hand before writing code, and again first thing when a call fails — it separates
"my payload is wrong" from "my code is wrong" in one step, and it is the fastest way to prove
credentials, provisioning and the egress IP at the same time.

**This skill deliberately has no code generator.** An emitter can only cover the languages someone
wrote emitters for, and it ages with each of those languages' idioms rather than with the mSpace
contract — which is why the contract, the curl reference and the templates are the things kept
current. Write the code in the project's own conventions, from the contract.

**Working order:** `search`/`list` to find the service → `show` for the exact contract → the curl
reference for the call → `validate` the payload → `code`/`diagnose` when something fails.

**Whole-integration order:**
[references/13-implementation-playbook.md](references/13-implementation-playbook.md) takes a
project from nothing to production, and covers the three starting points — greenfield, mid-build,
and retrofitting mSpace into a live application.

## How to approach an mSpace task

**Step 1 — Establish what already exists.** Ask (or check the code for) which of these the user
has:

- An mSpace account and a provisioned application (`APP_00XXXX` + password)?
- Which APIs were provisioned? An application can only call services it was provisioned for —
  otherwise you get `E1309`.
- Publicly reachable HTTPS URLs for callbacks? Required for MO SMS, USSD, delivery reports,
  subscription notifications and charging notifications. Without them, inbound flows cannot work
  at all.
- A static egress IP for *Allowed Host Address*? Required — see rule below.

If they have none of this, they are pre-provisioning. Read
[references/01-getting-started.md](references/01-getting-started.md) and walk them through it; you
can still build and exercise the whole integration against the **mSpace simulator** from the
developer bundle, which runs locally at `http://localhost:10001/`.

**Step 2 — Pick the services.** Map the product requirement to APIs using the table below. Most
real applications need *Subscription + SMS* at minimum; paid one-off flows add *CaaS*;
feature-phone reach adds *USSD*; web or app sign-up adds *OTP*.

**Step 3 — Pick the stack, then scaffold config before code.** The stack is the host project's,
not the template's: a Django codebase gets Python, a Spring service gets Java, a Laravel app gets
PHP. Create `.env` / `.env.example` and the config module first, so no credential ever has a
chance to land in a source file. Copy from [templates/.env.example](templates/.env.example) — the
variable names are identical in every language — and the config file from the matching directory
in [templates/](templates/README.md).

**Step 4 — Build the client, then the callbacks.** Outbound calls (`send`, `startCharge`) and
inbound callbacks (MO SMS, USSD, notifications) are two separate halves. Both are required for
most services. See [references/08-callbacks.md](references/08-callbacks.md) — the callback contract
has hard rules (respond `S1000` fast, be idempotent, never trust the body).

**Step 5 — Handle status codes properly.** mSpace returns HTTP 200 with an application-level
`statusCode` in the body, and the success code depends on the call. Checking only the HTTP status
is a bug; so is accepting only `S1000`. See
[references/09-status-codes.md](references/09-status-codes.md).

**Step 6 — Run the go-live checklist** in
[references/11-production-checklist.md](references/11-production-checklist.md) before the user
takes the application to full production.

---

## The six Inzpire APIs

mSpace publishes six APIs on its Inzpire services page, and this skill covers every one:

| API | What mSpace says it does | Reference |
|---|---|---|
| **SMS API** | Send messages to your subscriber base and receive messages from your subscribers, plus delivery reporting to track the status of the delivery | [02-sms](references/02-sms.md) |
| **USSD API** | Initiate USSD sessions over a HTTP-based API — menu-driven applications, monetised per menu request, with an active session | [03-ussd](references/03-ussd.md) |
| **Subscription API** | Register or unregister a subscriber, send subscription notifications, query subscription status and query subscriber base size | [04-subscription](references/04-subscription.md) |
| **OTP API** | Incorporate a One Time Password verification process to enable subscription in the mobile application you develop | [05-otp](references/05-otp.md) |
| **CaaS API** | Monetise your app with micro-payments — charge a specific amount from a subscriber's account | [06-caas](references/06-caas.md) |
| **LBS API** | Request the location of a subscriber, returned if they have granted permission | [07-lbs](references/07-lbs.md) |

`node tools/mspace.mjs platform` prints this list with the endpoint count for each, and
`node tools/mspace.mjs list <category>` — `sms`, `ussd`, `subscription`, `otp`, `caas`, `lbs` —
lists one API's services and callbacks.

The CaaS description on that page also mentions retrieving account balance. The API documentation
defines a `queryBalance` schema but publishes **no endpoint path** for it, so there is nothing to
call — see [06-caas](references/06-caas.md). Voice and IVR are not in the documentation at all.

---

## Service map

| Need | Service | Endpoint | Reference |
|---|---|---|---|
| Send an SMS to a subscriber (MT) | SMS Send | `POST /sms/send` | [02-sms](references/02-sms.md) |
| Send to the whole subscribed base | SMS Send with `tel:all` | `POST /sms/send` | [02-sms](references/02-sms.md) |
| Receive an SMS from a subscriber (MO) | SMS Receive | *your Message Receiving URL* | [02-sms](references/02-sms.md) |
| Know whether an SMS was delivered | Delivery Status Report | *your Delivery Report URL* | [02-sms](references/02-sms.md) |
| Interactive menu on any phone | USSD Send | `POST /ussd/send` | [03-ussd](references/03-ussd.md) |
| React to a subscriber dialling your code | USSD Receive | *your USSD Connection URL* | [03-ussd](references/03-ussd.md) |
| Opt a subscriber in | Subscription Register | `POST /subscription/send` (`action:"1"`) | [04-subscription](references/04-subscription.md) |
| Opt a subscriber out (**unsub**) | Subscription Unregister | `POST /subscription/send` (`action:"0"`) | [04-subscription](references/04-subscription.md) |
| Check one subscriber's state | Subscriber Status | `POST /subscription/getStatus` | [04-subscription](references/04-subscription.md) |
| **Subscriber base size** | Query Base | `POST /subscription/query-base` | [04-subscription](references/04-subscription.md) |
| Last-charge details for up to 10 subscribers | Subscriber Charging Info | `POST /subscription/getSubscriberChargingInfo` | [04-subscription](references/04-subscription.md) |
| Catch up on missed subscription notifications | Subscriber List | `POST /subscription/getSubscriberList` | [04-subscription](references/04-subscription.md) |
| Send a subscription notification | Subscriber Notification | `POST /subscription/notify` | [04-subscription](references/04-subscription.md) |
| Be told when a subscriber subs or unsubs | Subscription Notification | *your Subscription Notification URL* | [08-callbacks](references/08-callbacks.md) |
| Register a subscriber from a web or app form | OTP Request → Verify | `POST /otp/request`, `POST /otp/verify` | [04-subscription](references/04-subscription.md) |
| **Start a charge** — sends an OTP, returns `P1003` | CaaS OTP Generation | `POST /caas/direct/debit` | [06-caas](references/06-caas.md) |
| **Complete the charge** — verifies the OTP, moves the money | CaaS OTP Verification | `POST /caas/otp/verify` | [06-caas](references/06-caas.md) |
| Be told the outcome of a charge | Charging Notification | *your Charging Notification URL* | [06-caas](references/06-caas.md), [08-callbacks](references/08-callbacks.md) |
| Locate a subscriber | LBS Request Location | `POST /lbs/request` | [07-lbs](references/07-lbs.md) |
| Voice / IVR, balance query | Not in the public documentation | — | [07-lbs](references/07-lbs.md) |

Production host: `https://api.mspace.lk`. Every row above as a runnable request with its
parameters and response defined: [references/14-curl-reference.md](references/14-curl-reference.md).

**Configure one environment variable per provisioned service** — `MSPACE_SMS_SEND_URL`,
`MSPACE_USSD_SEND_URL`, and so on — never one shared base URL. An application can only call the
APIs it was provisioned for, so an unset endpoint means that service is not enabled and the client
should refuse to call it rather than fail with `E1309` at the platform. Never inline a URL. See
[templates/.env.example](templates/.env.example).

---

## The shape of every mSpace call

Every outbound API is the same shape. Learn it once:

```
POST https://api.mspace.lk/<service-path>
Content-Type: application/json;charset=utf-8

{ "applicationId": "APP_001807", "password": "…", "version": "1.0", …service fields… }
```

Every response is HTTP 200 with:

```json
{ "statusCode": "S1000", "statusDetail": "Success", "version": "1.0", … }
```

So the correct client, in every language, is one `post(path, payload, successCodes)` helper that
injects credentials from config, plus per-service wrappers. Do not write bespoke HTTP calls per
endpoint. [templates/](templates/README.md) has complete working implementations of exactly this
in six languages — read the closest one for shape rather than inventing a new structure — and
[references/12-any-stack.md](references/12-any-stack.md) specifies the same thing
language-neutrally when the project's stack is not among them.

### Two exceptions to the envelope, both worth coding for

- **Success is per service.** `S1000` almost everywhere, **`P1003`** on CaaS OTP generation,
  **`S1001`** also accepted on Subscriber List. Make the success set an argument to `post()`, not
  a global constant.
- **CaaS OTP verification returns `statusDescription`, not `statusDetail`**, plus a boolean
  `status`. Read both fields, or the one call that took someone's money is the one with no message.

### Addressing

Subscriber addresses are **always** prefixed `tel:` with no `+` and no spaces:

```
tel:94702725777          plain MSISDN (unmasked application)
tel:hu3b84346f63899a…    masked value (Mobile Number Masking) — opaque, use as-is
tel:all                  the subscribed base of the application (SMS send only)
```

Normalise once, in one function, at the boundary. Never string-concatenate `tel:` inline. SMS
`sourceAddress` is the exception: it is the Default Sender Address or a configured alias, not a
subscriber address, and it carries no prefix.

---

## Non-obvious things that will bite you

- **The *Allowed Host Address* list is enforced.** The platform rejects calls from any IP not on
  it with `E1303`. Determine the egress IP **on the server that will make the calls** — not on a
  laptop. Serverless and autoscaling platforms with rotating egress IPs need a static NAT or a
  fixed-IP proxy; decide this before choosing a host.
- **Limited Production is where you test.** Only the numbers listed under *Whitelisted Numbers* can
  use the application (`E1343`), and `E1104` means the application is not in Active or Limited
  Production status at all. If a test number "does nothing", check that list before debugging code.
- **HTTP 200 ≠ success**, and **`S1000` is not the only success.** Branch on `statusCode`, per
  service.
- **A charge is three exchanges, not one.** `POST /caas/direct/debit` only sends an OTP and answers
  `P1003`; the money moves on `POST /caas/otp/verify` with the `requestCorrelator` as
  `referenceNo`; the charging notification settles it. Never model it as a single call.
- **`E1309` means not provisioned, not a code bug.** Calling a service the application was not
  provisioned for fails no matter how correct the payload is.
- **Callback URLs are configured on the application record, not in code.** Changing your route path
  means updating that record too. `E1607` on the outbound path means your handler returned
  something the platform could not parse.
- **Subscription status has six values**, and `INITIAL`, `REG_PENDING` and `TEMPORARY_BLOCKED` are
  live subscribers in trouble rather than absent ones.
- **LBS is the odd one out**: `requesterId` and `subscriberId` are two separate mandatory fields,
  and the response uses `messageID` (capital D) and `timestamp` (lower-case s) where every other
  service uses different casing.
- **TLS:** if a host serves an incomplete certificate chain, strict clients fail where a browser
  papers over it — Node, Python, Java, Go and .NET all reject it. Disabling verification
  (`rejectUnauthorized: false`, `verify=False`, `InsecureSkipVerify`,
  `CURLOPT_SSL_VERIFYPEER => false`, a trust-all `TrustManager`) is **not** an acceptable
  production fix in any of them — it opens you to interception of your own credentials. Supply the
  intermediate CA explicitly instead. See
  [references/10-security-best-practices.md](references/10-security-best-practices.md#3-tls-verification).

---

## Reference files

Read the one that matches the task. Do not guess parameter names — they are all here.

| File | Contents |
|---|---|
| [01-getting-started.md](references/01-getting-started.md) | Account, Inzpire provisioning, credentials, environments, the local simulator, first call |
| [02-sms.md](references/02-sms.md) | Send / receive / delivery report, full parameter tables |
| [03-ussd.md](references/03-ussd.md) | Session model, `ussdOperation` state machine, menu building |
| [04-subscription.md](references/04-subscription.md) | Register, **unregister**, status, **base size**, charging info, subscriber list, notifications |
| [05-otp.md](references/05-otp.md) | **OTP API** — request and verify, to activate a subscription from a web or app sign-up |
| [06-caas.md](references/06-caas.md) | The three-step OTP-authorised charge, idempotency, reconciliation |
| [07-lbs.md](references/07-lbs.md) | LBS full spec; what is not published; the extension pattern |
| [08-callbacks.md](references/08-callbacks.md) | All inbound webhooks, contract, security, idempotency |
| [09-status-codes.md](references/09-status-codes.md) | Complete published code list + how to handle each class |
| [10-security-best-practices.md](references/10-security-best-practices.md) | Secrets, TLS, personal data, logging, consent, rate limits |
| [11-production-checklist.md](references/11-production-checklist.md) | Pre-go-live verification |
| [12-any-stack.md](references/12-any-stack.md) | The integration specified language-neutrally: the seven components, per-language notes, port acceptance checklist |
| [13-implementation-playbook.md](references/13-implementation-playbook.md) | A to Z: greenfield / mid-build / retrofit, the four flow recipes, testing without an account, go-live |
| [14-curl-reference.md](references/14-curl-reference.md) | **Every endpoint as a runnable curl** — request, parameter definitions, response, response-field definitions, per-endpoint status codes, and the same for every callback |

Templates in [templates/](templates/README.md) are working reference implementations of the same
integration — config, client, callback handlers and session store — in **TypeScript/Node, Python,
Java, Go, PHP and C#**, plus a shared `.env.example`. Scripts in [scripts/](scripts/) are curl
smoke tests, so they exercise a handler written in any language.

---

## When generating code

- **Write it in the host project's language and idiom.** Never introduce a new runtime, a Node
  sidecar, or a second service just to reach mSpace — a plain HTTPS POST is all it takes, and
  every stack can make one.
- Put every mSpace call behind a service module. No endpoint URLs or credentials scattered through
  controllers.
- Type or schema-validate both directions with whatever the stack uses (types, pydantic, Bean
  Validation, struct tags, data annotations). Inbound callback bodies come from outside your trust
  boundary.
- Log `requestId` / `externalTrxId` / `internalTrxId` / `sessionId` on every operation — they are
  how a support trace is built. Log the `statusCode`. **Never** log `password`, the OTP,
  `referenceNo` or `requestCorrelator`, and mask `subscriberId` in logs.
- Persist subscription state locally from the Subscription Notification URL; do not call
  `getStatus` on every request, and use Subscriber List to catch up on anything missed.
- Make outbound calls retry-safe: retry only on transport errors and transient codes, never on a
  definitive one, and never a charge with a new `externalTrxId`.
- Model charging as a persisted state machine across the three exchanges, storing
  `requestCorrelator` and `internalTrxId` from the generation response.
- Match the host project's stack and conventions. These templates are a specification, not a
  framework to impose.
