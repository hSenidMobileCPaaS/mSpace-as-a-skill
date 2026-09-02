# USSD API

USSD gives you an interactive session-based menu that works on **any** handset, including feature
phones, with no app and no data connection. The subscriber dials a code (`*141#`), the platform
opens a session and pushes each keypress to your Connection URL; you reply with the next screen.

| Service | Direction | Where |
|---|---|---|
| **Send** | App → subscriber (a screen) | `POST /ussd/send` |
| **Receive** | Subscriber → app (a keypress) | Your USSD Connection URL |

---

## The session model — read this before writing any code

A USSD session is short-lived (tens of seconds), stateful, and identified by `sessionId`. The
`ussdOperation` field is the state machine, and **who sets which value matters**:

| Value | Set by | Meaning |
|---|---|---|
| `mo-init` | **Platform** | Subscriber dialled your code — session start |
| `mo-cont` | **Platform** | A USSD message originated from the subscriber that comes after an init |
| `mt-init` | **Your app** | Your application is initiating a USSD session |
| `mt-cont` | **Your app** | Any USSD message originated from the application that comes after an init |
| `mt-fin` | **Your app** | Final message; **ends the session** |

The normal flow:

```
subscriber dials *141#
   → platform POSTs your Connection URL:  ussdOperation = mo-init,  sessionId = S
   → you POST /ussd/send:                 ussdOperation = mt-cont,  sessionId = S   (show menu)
subscriber presses 2
   → platform POSTs your Connection URL:  ussdOperation = mo-cont,  sessionId = S
   → you POST /ussd/send:                 ussdOperation = mt-fin,   sessionId = S   (result, close)
```

Hard rules:

1. **Echo the `sessionId` you were given.** The USSD Gateway assigns it and maintains it through
   the whole session. Never generate one for a session the platform started — a wrong `sessionId`
   orphans the session and the subscriber sees nothing.
2. **`mt-fin` closes the session.** Send it for terminal screens. If you keep sending `mt-cont`
   the session hangs until the network times it out — a bad experience and a leaked session in
   your store.
3. **You must reply fast.** USSD sessions time out in seconds. Do the minimum inline; defer
   anything slow (charging, third-party calls) and tell the subscriber you will SMS the result.
4. **Session state lives on your side**, keyed by `sessionId`, with a TTL. The platform sends you
   the keypress, not the path the subscriber took to get there.

---

## Send Service

```
POST /ussd/send
Content-Type: application/json;charset=utf-8
```

### Request

```json
{
  "version": "1.0",
  "applicationId": "APP_000001",
  "password": "…",
  "message": "1. Press One\n2. Press two\n3. Press three\n4. Exit",
  "sessionId": "1330929317043",
  "ussdOperation": "mt-cont",
  "destinationAddress": "tel:94702725777",
  "encoding": "440"
}
```

| Parameter | Description | Type | Mandatory |
|---|---|---|---|
| `version` | API version | String | **Mandatory** |
| `applicationId` | Application ID from provisioning | String | **Mandatory** |
| `password` | Password from provisioning. Encoded, single value. | String | **Mandatory** |
| `message` | Content of the message sent by the application — the screen text | String | **Mandatory** |
| `sessionId` | Unique number the USSD Gateway assigns to the application for the duration of the session, maintained in all messages throughout it | String | **Mandatory** |
| `ussdOperation` | `mt-init` / `mt-cont` / `mt-fin` for outbound | Enum (string) | **Mandatory** |
| `destinationAddress` | Subscriber address, `tel:` prefixed; may be a masked number | String | **Mandatory** |
| `encoding` | `440` = plain ASCII characters | Enum | Optional |

### Response

```json
{
  "version": "1.0",
  "requestId": "101901031657410007",
  "timeStamp": "20190103165801",
  "statusCode": "S1000",
  "statusDetail": "Success."
}
```

| Parameter | Description |
|---|---|
| `version` | API version |
| `requestId` | Uniquely identifies the request within the platform |
| `timeStamp` | Processed timestamp |
| `statusCode` / `statusDetail` | Outcome — check this, not the HTTP status |

---

## Receive Service

The platform delivers MO messages to your **Connection URL** over HTTP. The flow is initiated by
an MO request from the subscriber; the platform delivers it to the application as a delivery
request, and the exchange is either request-response or request-exception.

### What you receive

```json
{
  "version": "1.0",
  "applicationId": "APP_000029",
  "message": "*141#",
  "requestId": "1330933229901",
  "sessionId": "1330929317043",
  "ussdOperation": "mo-init",
  "sourceAddress": "tel:94702725777",
  "vlrAddress": "tel:94702725777",
  "encoding": "440"
}
```

| Parameter | Description | Mandatory |
|---|---|---|
| `version` | API version | Mandatory |
| `applicationId` | Your application ID | Mandatory |
| `message` | Content of the message sent by the user | Mandatory |
| `requestId` | Uniquely identifies a request within the platform | Mandatory |
| `sessionId` | Session identifier — **echo this back** | Mandatory |
| `ussdOperation` | `mo-init` (session start) or `mo-cont` (subsequent input) | Mandatory |
| `sourceAddress` | Address of the source, possibly masked | Mandatory |
| `vlrAddress` | VLR (Visitor Location Register) address of the sender | Optional |
| `encoding` | `440` = plain ASCII characters | Mandatory |

### What you must respond

```json
{ "statusCode": "S1000", "statusDetail": "Success" }
```

This is only an **acknowledgement** that you received the keypress. The screen the subscriber
sees comes from a *separate* `POST /ussd/send` call. Do not try to return menu text in the
acknowledgement body.

---

## Writing menus that work

USSD screens are tiny and the input is a single keypress. Constraints:

- **Keep a screen under about 160 characters.** The GSM USSD standard caps a message at 182
  septets, and real handsets truncate silently — the subscriber sees nothing telling them why.
- **Plain ASCII only** (`encoding: 440`). No emoji, no Sinhala or Tamil script, no smart quotes,
  no tabs. Sanitise generated text before sending.
- **Number your options `1..9`** and keep them one line each. Always give an explicit exit.
- Keep the tree **shallow** — 2 to 3 levels. Every extra level is another network round-trip
  inside a session that may time out.
- Handle invalid input explicitly: reshow the menu with a short "Invalid option" prefix rather
  than dropping the session.

### Session store requirements

Keyed by `sessionId`, holding at minimum: current node, `sourceAddress`, created-at.

- **TTL of about 2 minutes**, then evict. Sessions that are never closed must not accumulate.
- **Must be shared across instances** if you run more than one process — an in-process store (a
  JS `Map`, a Python `dict`, a Java `HashMap`, a Go `map`, a .NET `MemoryCache`) breaks the moment
  you scale horizontally, add a worker, or deploy. Use Redis or equivalent in production.
- Never store the raw MSISDN longer than the session needs it.

Worked in-memory implementations (fine for development, explicitly not for multi-instance
production) are in [templates/typescript/ussd-session.ts](../templates/typescript/ussd-session.ts)
and [templates/python/ussd_session.py](../templates/python/ussd_session.py); the Java, Go, PHP and
C# callback templates each carry the same store behind an interface, ready to swap for Redis.

### Worked example

```
mo-init  "*141#"     → mt-cont  "Welcome to Acme\n1. Balance\n2. Top up\n3. Support\n0. Exit"
mo-cont  "1"         → mt-fin   "Your balance is Rs. 300.00"
mo-cont  "3"         → mt-cont  "Support\n1. Call us\n2. SMS us\n0. Back"
mo-cont  "0"         → mt-fin   "Thank you."
mo-cont  "banana"    → mt-cont  "Invalid option\n1. Balance\n2. Top up\n3. Support\n0. Exit"
```

---

## Combining USSD with other services

USSD is frequently the *front door* to another API:

- **USSD → Subscription:** a menu option "Subscribe" calls `POST /subscription/send` with
  `action: "1"`. This is a clean consent capture — record the `sessionId` and timestamp as your
  consent evidence.
- **USSD → CaaS:** never charge inline. On mSpace a charge is *three* exchanges — OTP generation,
  OTP verification, then the charging notification — and the subscriber has to read an SMS in
  between. Acknowledge with `mt-fin` ("Processing, we'll SMS you"), then run the charge out of
  band. See [06-caas.md](06-caas.md).
- **USSD → SMS:** the standard pattern for delivering anything longer than one screen.

`POST /ussd/send` and the inbound USSD callback as runnable curls, with every parameter and
response field defined: [14-curl-reference.md](14-curl-reference.md).
