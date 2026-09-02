# Subscription API

The Subscription API manages the lifecycle that binds a subscriber to your service, and —
critically — records their **consent**. Registering subscribers without it is a compliance
problem, and the charging amount and frequency are set per application in provisioning precisely
so they can be disclosed up front.

Seven things live here:

| Operation | Endpoint |
|---|---|
| **Register** (opt-in) | `POST /subscription/send` with `action: "1"` |
| **Unregister** (opt-out / unsub) | `POST /subscription/send` with `action: "0"` |
| **Subscriber Status** | `POST /subscription/getStatus` |
| **Query Base** (subscriber base size) | `POST /subscription/query-base` |
| **Subscriber Charging Info** | `POST /subscription/getSubscriberChargingInfo` |
| **Subscriber List** | `POST /subscription/getSubscriberList` |
| **Subscriber Notification** | `POST /subscription/notify` |

Plus **OTP**, the registration flow for web and app users — documented at the end of this file —
and the inbound **Subscription Notification URL**, in [07-callbacks.md](07-callbacks.md).

---

## The six subscription statuses

mSpace does not have two states. It has six, and the Subscriber Charging Info documentation
spells out what each one means and which fields come back with it:

| Status | Meaning | Fields returned |
|---|---|---|
| `INITIAL` | The subscription request reached the system but may not have completed, possibly due to a system error. **Not even the charging call was made.** | `subscriberId`, `subscriptionStatus`, `numberType`, `statusCode`, `statusDetail` |
| `REG_PENDING` | The subscription request was made and the charging request was sent, but charging has not yet succeeded — for example the charging response has not come back, or there was insufficient balance. | as `INITIAL` |
| `TRIAL` | The subscription request was made and the platform allows the subscriber to use the service without charging, because a free trial period is enabled. | as `INITIAL` |
| `REGISTERED` | The subscription request was made, charging succeeded, and the subscriber can receive the service. | adds `lastChargedDate`, `lastChargedAmount` |
| `UNREGISTERED` | The subscription request was made and the subscriber has since unsubscribed from the service. | adds `lastChargedDate`, `lastChargedAmount` |
| `TEMPORARY_BLOCKED` | The subscription was registered once — initial charging succeeded — but recursive charging has since failed, for example due to insufficient balance, and the service is temporarily blocked for this subscriber. | adds `lastChargedDate`, `lastChargedAmount` |

For a **free application**, `lastChargedDate` is omitted and `lastChargedAmount` is sent as
`0.00 LKR`.

Two consequences for your code:

- **Do not treat "not REGISTERED" as "UNREGISTERED".** `INITIAL`, `REG_PENDING` and
  `TEMPORARY_BLOCKED` are all live subscribers in some state of trouble, and each needs a
  different response from your product.
- **Do not start delivering the service on `INITIAL` or `REG_PENDING`.** Wait for the
  subscription notification.

---

## Register / Unregister

```
POST /subscription/send
Content-Type: application/json;charset=utf-8
```

One endpoint handles both directions. Note there is **no `version` parameter** on this call.

### Register (opt-in)

```json
{
  "applicationId": "APP_999999",
  "password": "…",
  "subscriberId": "tel:94716177301",
  "action": "1"
}
```

```json
{
  "version": "1.0",
  "statusCode": "S1000",
  "statusDetail": "Request was successfully processed",
  "subscriptionStatus": "REGISTERED"
}
```

### Unregister (opt-out)

Identical, with `action: "0"`:

```json
{
  "applicationId": "APP_999999",
  "password": "…",
  "subscriberId": "tel:94716177301",
  "action": "0"
}
```

```json
{
  "version": "1.0",
  "statusCode": "S1000",
  "statusDetail": "not registered",
  "subscriptionStatus": "UNREGISTERED"
}
```

### Request parameters

| Parameter | Description | Type | Mandatory |
|---|---|---|---|
| `applicationId` | Application ID from provisioning. Single value per request. | String | **Mandatory** |
| `password` | Password from provisioning. Encoded, single value. | String | **Mandatory** |
| `subscriberId` | `tel:`-prefixed subscriber address, for example `tel:94716177301`. May be a masked number depending on the type of application. Single value per request. | String | **Mandatory** |
| `action` | `1` = user subscription, `0` = user unsubscription | Enum | **Mandatory** |

`action` is documented as a **string** (`"1"` / `"0"`). Send the string form.

### Response parameters

| Parameter | Description |
|---|---|
| `version` | API version |
| `statusCode` / `statusDetail` | Outcome |
| `subscriptionStatus` | One of the six statuses above |

### Rules that matter

- **Consent before Register, always.** A subscriber tapping "Subscribe", replying to a USSD
  prompt, or verifying an OTP is consent. Importing a list of numbers is not. Store *what* the
  subscriber agreed to, *when*, and *through which channel*.
- **Disclose the charge before registering** — amount, currency and frequency, which provisioning
  sets separately for prepaid and postpaid customer bases.
- **Unregister must be as easy as register.** Provide it in every channel the subscriber can
  reach: an `UNSUB` / `STOP` keyword over MO SMS, a USSD menu option, and a control in-app.
  Honour it immediately, including cancelling messages you have already queued.
- **Mirror subscription state in your own database.** Do not call `getStatus` on every request —
  consume the Subscription Notification URL instead, and use Subscriber List to catch up on
  notifications you missed.

---

## Subscriber Status

Returns the current state of one subscriber.

```
POST /subscription/getStatus
Content-Type: application/json;charset=utf-8
```

```json
{
  "applicationId": "APP_999999",
  "password": "…",
  "subscriberId": "tel:94716177301"
}
```

```json
{
  "version": "1.0",
  "statusCode": "S1000",
  "statusDetail": "Request was successfully processed",
  "subscriptionStatus": "REGISTERED"
}
```

| Request parameter | Description | Mandatory |
|---|---|---|
| `applicationId` | Unique identification of the application within the platform | **Mandatory** |
| `password` | Password given when provisioning the application | **Mandatory** |
| `subscriberId` | Subscriber address, `tel:` prefixed, possibly masked | **Mandatory** |

`subscriptionStatus` is one of `INITIAL`, `REG_PENDING`, `TRIAL`, `REGISTERED`, `UNREGISTERED`,
`TEMPORARY_BLOCKED`.

Use it for reconciliation — a nightly sweep, or when a subscriber disputes their state — not as a
per-request gate.

---

## Query Base — subscriber base size

Returns the number of subscribers currently registered to the application. Needs no subscriber
and costs nothing, which also makes it the ideal connectivity smoke test.

```
POST /subscription/query-base
Content-Type: application/json;charset=utf-8
```

```json
{
  "applicationId": "APP_000201",
  "password": "…"
}
```

```json
{
  "baseSize": "0",
  "version": "1.0",
  "statusCode": "S1000",
  "statusDetail": "Success."
}
```

| Response parameter | Description |
|---|---|
| `baseSize` | Number of registered users — **a string, parse it** |
| `version` | API version |
| `statusCode` / `statusDetail` | Outcome |

Notes:

- `baseSize` comes back as a **string**. Coerce before arithmetic or charting.
- It is a point-in-time count for the whole application.
- Poll it on a schedule (hourly or daily) into your own metrics store rather than per page load.
  Use it to sanity-check a broadcast before sending to `tel:all` — if `baseSize` is far larger
  than you expect, stop.

---

## Subscriber Charging Info

Returns subscription status and last-charge details for **up to ten subscribers** in one request.

```
POST /subscription/getSubscriberChargingInfo
Content-Type: application/json;charset=utf-8
```

```json
{
  "applicationId": "APP_102672",
  "password": "…",
  "subscriberIds": ["tel:94712342345", "tel:94712678845", "tel:9471982563"]
}
```

```json
{
  "version": "1.0",
  "destinationResponses": [
    {
      "subscriberId": "tel:94712342345",
      "subscriptionStatus": "REGISTERED",
      "lastChargedDate": "2020-01-23 22:03:22",
      "lastChargedAmount": "30.00 LKR",
      "numberType": "postpaid",
      "statusCode": "S1000",
      "statusDetail": "Request was successfully processed"
    }
  ],
  "statusCode": "S1000",
  "statusDetail": "Success."
}
```

| Field | Description |
|---|---|
| `subscriberId` | MSISDN of the subscriber. If the application accepts masked numbers, masked numbers are what you send and receive. Always present. |
| `subscriptionStatus` | One of the six statuses |
| `lastChargedDate` | Successful last charged date, `YYYY-MM-DD hh:mm:ss`. Omitted for a free application, and for `INITIAL`, `REG_PENDING` and `TRIAL`. |
| `lastChargedAmount` | Successful last charged amount with the currency code, e.g. `30.00 LKR`. `0.00 LKR` for a free application. |
| `numberType` | Whether the subscriber is prepaid or postpaid |
| `statusCode` / `statusDetail` | Outcome **for this subscriber** |

Rules:

- **Maximum 10 MSISDNs per request.** Batch larger sets by looping with your own rate limiting.
- **Every entry carries its own `statusCode`.** One subscriber failing does not fail the request —
  read the per-entry code, not only the top-level one.
- **Check `lastChargedDate` and `lastChargedAmount` exist before reading them.** Which fields
  come back depends on the subscription status.

Documented codes for this endpoint: `S1000`, `E1303`, `E1312`, `E1313`, `E1317`, `E1325`,
`E1601`, `E1603`.

---

## Subscriber List

Retrieves the subscriber list a page at a time. Its stated purpose is to let you **stay updated
with the subscription notifications you missed receiving** — a catch-up mechanism, not a
replacement for handling the Subscription Notification URL.

```
POST /subscription/getSubscriberList
Content-Type: application/json;charset=utf-8
```

```json
{
  "applicationId": "APP_102672",
  "password": "…",
  "version": "1.0",
  "requestPage": 1
}
```

```json
{
  "version": "1.0",
  "statusCode": "S1000",
  "statusDetail": "Request was successfully processed",
  "nextPageNumber": 3,
  "moreDataAvailable": true,
  "subscribers": {
    "subscriberId": "tel:94712342345",
    "subscriptionStatus": "REGISTERED",
    "lastChargedDate": "2020-01-23 22:03:22",
    "lastChargedAmount": "30.00 LKR"
  }
}
```

| Field | Description |
|---|---|
| `requestPage` | **Mandatory.** The page number. Must be 1 or greater, or you get `E1106`. |
| `nextPageNumber` | The next page available. **`-1` when there is no next page.** |
| `moreDataAvailable` | Whether more data is available |
| `subscribers` | Subscriber data for this page |

### This endpoint has its own status-code family

Subscriber List does **not** use the `E13xx` codes the rest of the platform uses:

| Code | Meaning |
|---|---|
| `S1000` | Request Was Successfully Processed |
| `S1001` | **No Subscribers Found — this is a success, not an error** |
| `E1100` | System Experienced an Unexpected Error |
| `E1102` | Service Provider Is Not In Active Status |
| `E1103` | Request Parameters are Invalid |
| `E1104` | Application is Not in Active or Limited Production Status |
| `E1105` | TPS Exceeded |
| `E1106` | Invalid Request Page. Page Number Should Be 1 Or Greater |
| `E1107` | Request Is Invalid |

A client that treats every non-`S1000` code as a failure reports an empty subscriber base as a
broken integration. Accept `S1001` and stop paging.

---

## Subscriber Notification

```
POST /subscription/notify
Content-Type: application/json;charset=utf-8
```

This service sends subscription notifications to users.

```json
{
  "timeStamp": "20120113082110",
  "version": "1.0",
  "applicationId": "APP_999999",
  "password": "…",
  "subscriberId": "tel:94716177301",
  "frequency": "monthly",
  "status": "REGISTERED"
}
```

| Parameter | Description | Mandatory |
|---|---|---|
| `timeStamp` | `yyMMddHHmm` — yy last two digits of the year, MM month, dd day, HH hour, mm minute | **Mandatory** |
| `version` | API version | **Mandatory** |
| `applicationId` | Application ID from provisioning | **Mandatory** |
| `password` | Password from provisioning | **Mandatory** |
| `subscriberId` | Subscriber address, `tel:` prefixed, possibly masked | **Mandatory** |
| `frequency` | `daily`, `weekly`, `monthly` or `yearly` | **Mandatory** |
| `status` | Status of the subscription, e.g. `UNREGISTERED`, `REGISTERED` | **Mandatory** |

```json
{ "statusCode": "S1000", "statusDetail": "Request was successfully processed" }
```

This is the same field vocabulary the **Subscription Notification URL** uses. That URL is
configured separately, under Subscription configuration in provisioning, and is what tells you
about subscription changes you did not initiate — see [07-callbacks.md](07-callbacks.md).

---

## OTP — registering users from web and mobile apps

When the subscriber starts on a screen rather than on the network (a website form, an app
sign-up), you cannot get their MSISDN from the carrier. OTP solves that: the subscriber types
their number, mSpace generates and sends an OTP to that MSISDN, and on successful verification
the mSpace subscription process is activated and you receive the **masked `subscriberId`** to use
with every other API.

### Flow

1. Collect the mobile number in your UI.
2. `POST /otp/request` → mSpace sends the OTP to the subscriber.
3. Store the returned `referenceNo` **server-side** against the user's session.
4. Collect the OTP in your UI.
5. `POST /otp/verify` with `referenceNo` + `otp`.
6. Store the returned `subscriberId` — this is what you use for SMS, Subscription and Charging.

**Always call these from a backend with a whitelisted IP**, never from the browser or the app.

### OTP Request

```
POST /otp/request
```

```json
{
  "applicationId": "APP_000375",
  "password": "…",
  "subscriberId": "tel:94716177301",
  "applicationHash": "abcdefgh",
  "applicationMetaData": {
    "client": "MOBILEAPP",
    "device": "Samsung S10",
    "os": "android 8",
    "appCode": "https://play.google.com/store/apps/details?id=lk"
  }
}
```

| Field | What to put in it |
|---|---|
| `subscriberId` | Mobile number of the end consumer |
| `applicationHash` | Hash string to determine which verification messages to send to your app. Optional. |
| `applicationMetaData.client` | Client type: a web browser or a mobile app |
| `applicationMetaData.device` | Type or OS of device — iPhone 6, Galaxy S5, PC |
| `applicationMetaData.os` | OS or device version — Android 6, iOS 5, Windows 10 |
| `applicationMetaData.appCode` | Your app identifier in the store, or the web link if you use a browser |

Success:

```json
{
  "version": "1.0",
  "statusCode": "S1000",
  "referenceNo": "213561321321613",
  "statusDetail": "Success"
}
```

Documented codes: `S1000` (successfully sent the OTP challenge), `E1853` (maximum number of OTP
requests reached), `E1856` (invalid request), `E1857` (internal server error), `E1301` (the
application ID is not allowed within the system for the operator).

### OTP Verify

```
POST /otp/verify
```

```json
{
  "applicationId": "APP_000375",
  "password": "…",
  "referenceNo": "213561321321613",
  "otp": "123564"
}
```

Success:

```json
{
  "version": "1.0",
  "statusCode": "S1000",
  "subscriptionStatus": "REGISTERED",
  "statusDetail": "Success",
  "subscriberId": "tel:hu3b84346f63899a32ec742a666503a02a4dffe4f5"
}
```

Documented codes: `S1000` (successfully validated), `E1850` (invalid OTP), `E1851` (the OTP
request has expired), `E1852` (maximum number of OTP attempts reached), `E1854` (could not find
OTP), `E1855` (invalid reference number), `E1857` (internal server error), `E1301`.

### OTP rules

- **`referenceNo` lives server-side, in the session.** Never send it to the client, never put it
  in a URL, never let the client choose it — that would let an attacker verify against someone
  else's OTP request.
- **Rate-limit OTP requests yourself**, per number and per IP. Without that, your application is
  an SMS-bombing tool aimed at arbitrary Sri Lankan phone numbers, at your expense. `E1853` tells
  you when the platform's own limit is reached, but it is not your rate limiter.
- **mSpace does not publish the OTP validity window or the attempt count.** `E1851` (expired) and
  `E1852` (maximum attempts) are what you get when either is reached. Enforce your own limits as
  well rather than assuming a number.
- **The `subscriberId` you get back is the masked identifier.** The documentation is explicit:
  the application has to use it for any subsequent request sent to the platform. Do not store the
  raw MSISDN the user typed unless you genuinely need it, and if you do, protect it as personal
  data.
- **Never log the OTP or the `referenceNo`.**

> The OTP API here activates a **subscription**. Charging has a separate OTP flow with its own
> endpoints and its own reference value — see [05-caas.md](05-caas.md). They are not
> interchangeable: a CaaS `requestCorrelator` is not an OTP `referenceNo`.

---

Register, unregister, status, query base, charging info, subscriber list, notify, OTP request and
OTP verify as runnable curls — every parameter, response and response field defined:
[13-curl-reference.md](13-curl-reference.md).
