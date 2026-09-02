# SMS API

Three distinct services, two directions:

| Service | Direction | Who initiates | Where it happens |
|---|---|---|---|
| **Send** (MT — Mobile Terminated) | App → subscriber | You | `POST /sms/send` |
| **Receive** (MO — Mobile Originated) | Subscriber → app | Subscriber | Your Message Receiving URL |
| **Delivery Status Report** | Platform → app | Platform | Your Delivery Report URL |

Endpoint from `MSPACE_SMS_SEND_URL` (production `https://api.mspace.lk/sms/send`). If that
variable is unset, the SMS API is not enabled on your application.

---

## Send Service (MT)

```
POST /sms/send
Content-Type: application/json;charset=utf-8
```

This service sends SMS to one or more terminals — phones, or any SMS-enabled device — from your
application. It supports only POST.

### Minimal request

```json
{
  "version": "1.0",
  "applicationId": "APP_999999",
  "password": "…",
  "message": "Hello",
  "destinationAddresses": ["tel:94702725777"]
}
```

### Response

```json
{
  "version": "1.0",
  "requestId": "101901031657410007",
  "destinationResponses": [
    {
      "timeStamp": "20190103165801",
      "address": "tel:94702725777",
      "messageId": "101901031657410007",
      "statusCode": "S1000",
      "statusDetail": "Success"
    }
  ],
  "statusCode": "S1000",
  "statusDetail": "Success."
}
```

**There is no top-level `messageId`.** Per-recipient identifiers live in `destinationResponses`,
one entry per address in the request. A multi-recipient send can partially succeed, so read each
entry's own `statusCode` rather than only the top-level one — and store `messageId` per recipient
if you want delivery reports to be matchable.

### Request parameters

| Parameter | Description | Type | Mandatory |
|---|---|---|---|
| `version` | API version (`1.0`, `2.0`…). If specified, the same version is returned in the response; if not, the latest is. | String | **Mandatory** |
| `applicationId` | Application ID from provisioning. Single value per request. | String | **Mandatory** |
| `password` | Authenticates the application-originated message. Encoded, single value. | String | **Mandatory** |
| `message` | Content of the message. Messages over the limit are broken up by the platform before sending. | String | **Mandatory** |
| `destinationAddresses` | **Array** of addresses, which should be telephone numbers (`tel:` for MSISDN), for example `tel:94702725777`. `tel:all` sends to the subscribed base of the application. May be a masked number depending on the type of application. | String[] | **At least one** |
| `sourceAddress` | Address of the source shown to the subscriber. | String | Optional |
| `deliveryStatusRequest` | `0` = delivery report not required, `1` = required | Enum | Optional |
| `encoding` | `0` = Text, `240` = Flash SMS, `245` = Binary. If not specified, taken as Text. With Binary the message content is hex encoded. | Enum | Optional |
| `binaryHeader` | Hexadecimal. For advanced messages where the binary header is sent from the application. | String | Optional |

### Rules

- **`destinationAddresses` is an array, always** — even for one recipient. Sending a bare string
  is the single most common SMS integration bug.
- **`version` is mandatory on this endpoint.** Send `"1.0"` unless you have a reason not to.
- **`tel:all` sends to your whole subscribed base.** Guard it. It should never be reachable from
  an ordinary code path; require an explicit, separately-authorised call, and check the base size
  first with [Query Base](04-subscription.md#query-base--subscriber-base-size).
- **`sourceAddress` must be the Default Sender Address or one of the Send Address Aliases**
  configured on the application. An arbitrary value fails with `E1331`.
- **Set `deliveryStatusRequest: "1"` only if you actually consume delivery reports.** Otherwise
  you generate callback traffic you ignore.
- **Long messages are split and charged per part.** Keep under 160 GSM-7 characters (70 if the
  text contains non-Latin characters, which forces UCS-2) to stay at one part. Sinhala and Tamil
  are UCS-2 — budget 70 characters.
- `E1334` / `E1335` mean the message exceeded the configured maximum length, for a normal message
  and for an advertisement message respectively.
- **Never put a password, an OTP the subscriber did not request, or full personal data in an SMS
  body.**

### Broadcast example

```json
{
  "version": "1.0",
  "applicationId": "APP_999999",
  "password": "…",
  "destinationAddresses": ["tel:all"],
  "message": "Service update: …",
  "deliveryStatusRequest": "0"
}
```

---

## Receive Service (MO)

The platform delivers the SMS a subscriber sent to your short code with your keyword, to the
**Message Receiving URL** you configured in SMS provisioning. You do not call anything.

### What you receive

```json
{
  "version": "1.0",
  "applicationId": "APP_000029",
  "sourceAddress": "tel:94702725777",
  "message": "MYAPP hello",
  "requestId": "22607072011552911",
  "encoding": "0"
}
```

| Parameter | Description | Type | Mandatory |
|---|---|---|---|
| `version` | API version | String | Mandatory |
| `applicationId` | Your application ID — verify it matches | String | Mandatory |
| `sourceAddress` | Address of the source, masked if masking is enabled | String | Mandatory |
| `message` | Content of the message sent by the user | String | Mandatory |
| `requestId` | Uniquely identifies a request within the platform | String | Mandatory |
| `encoding` | `0` Text / `240` Flash / `245` Binary (hex-encoded) | Enum | Mandatory |

### What you must respond

```json
{ "statusCode": "S1000", "statusDetail": "Success." }
```

Respond **immediately**, before doing any real work. Full callback contract:
[08-callbacks.md](08-callbacks.md).

### Handling MO content

The subscriber's message arrives with the keyword included — someone texting `WEATHER Colombo` to
your short code gives you a `message` containing both the keyword and the argument. Parse
defensively:

- Trim, collapse whitespace, and compare the keyword case-insensitively.
- Treat anything after the keyword as free text; users send typos, emoji and empty strings.
- Recognise standard opt-out words (`STOP`, `UNSUB`, `OFF`) and honour them by calling
  [Subscription Unregister](04-subscription.md). Ignoring an opt-out word in an MO message is
  both a compliance problem and a support-cost problem.
- MO messages are **not** authenticated beyond the source address. Do not perform a destructive
  or chargeable action purely on the content of one MO SMS.

---

## Delivery Status Report Service

If you sent with `deliveryStatusRequest: "1"`, the platform delivers the outcome to your
**Delivery Report URL**. The `messageId` from the send response is what matches an MT response to
its delivery report.

### What you receive

```json
{
  "destinationAddress": "tel:94702725777",
  "timeStamp": "20120113082110",
  "requestId": "MSG_000111",
  "deliveryStatus": "DELIVERED"
}
```

| Parameter | Description | Mandatory |
|---|---|---|
| `destinationAddress` | Address of the subscriber | Mandatory |
| `timeStamp` | The timestamp sent from the SMS. Documented as `yyMMddHHmm`, and the documented sample is 14 digits — **parse on length**, and return null rather than guessing. | Mandatory |
| `requestId` | Uniquely identifies a request within the platform | Mandatory |
| `deliveryStatus` | See enum below | Mandatory |

### `deliveryStatus` values

Platform → your application:

`DELIVERED`, `EXPIRED`, `DELETED`, `UNDELIVERABLE`, `ACCEPTED`, `UNKNOWN`, `REJECTED`

The underlying SMPP layer commonly uses abbreviated forms (`DELIVRD`, `UNDELIV`, `ACCEPTD`,
`REJECTD`). Normalise on the way in rather than assuming one set — the templates in this repo all
do.

### Respond

```json
{ "statusCode": "S1000", "statusDetail": "Success." }
```

### Using delivery reports well

- `ACCEPTED` is not `DELIVERED` — it means the network took the message, nothing more.
- Repeated `UNDELIVERABLE` for one subscriber usually means a dead number; stop messaging it and
  consider unregistering to avoid paying for nothing.
- Reports can arrive out of order, late, more than once, or never. Store the latest status keyed
  by `requestId` and make the handler idempotent.

---

## Implementation notes

- One `sendSms(to, message, opts)` function; never build the payload at call sites.
- Normalise recipients through a single `toTelAddress()` helper.
- Persist the per-recipient `messageId` at send time if you want reports to be matchable.
- Rate-limit your own sending: `E1318` (per-second limit) and `E1319` (per-day limit) mean the
  platform rejected the request rather than queueing it.

Working `sendSms` and MO/DLR handlers in six languages: [templates/](../templates/README.md). Any
other stack: [12-any-stack.md](12-any-stack.md), with all three endpoints as runnable curls —
parameters, response and response fields defined — in
[14-curl-reference.md](14-curl-reference.md).
