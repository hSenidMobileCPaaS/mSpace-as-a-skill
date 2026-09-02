# OTP API

> *"OTP API allows you to incorporate a One Time Password (OTP) verification process to enable
> subscription in the mobile application developed by you."* — mSpace Inzpire services

One of the six Inzpire APIs, and the one that gets a subscriber onto your service when they start
on a **screen** rather than on the network. A website form or an app sign-up cannot get the MSISDN
from the carrier; OTP solves that. The subscriber types their number, mSpace sends an OTP to it,
and on successful verification the mSpace subscription process is activated and you receive the
**masked `subscriberId`** to use with every other API.

| Service | Direction | Endpoint |
|---|---|---|
| **OTP Request** | You → mSpace | `POST /otp/request` |
| **OTP Verify** | You → mSpace | `POST /otp/verify` |

Endpoints from `MSPACE_OTP_REQUEST_URL` and `MSPACE_OTP_VERIFY_URL`. If those variables are unset,
the OTP API is not enabled on your application.

> **This is not the CaaS OTP.** mSpace has two OTP flows and they are not interchangeable. This one
> activates a **subscription**. The CaaS one authorises a **charge**, uses different endpoints, and
> its reference value is a `requestCorrelator` rather than a `referenceNo`. See
> [06-caas.md](06-caas.md), and the [comparison](#the-two-otp-flows-are-not-interchangeable) at the
> end of this page.

---

## The flow

```
subscriber types their mobile number in your UI
  → POST /otp/request          → mSpace generates and sends the OTP to that MSISDN
     ← S1000 + referenceNo        store referenceNo SERVER-SIDE against the session

subscriber reads the OTP and types it into your UI
  → POST /otp/verify           with referenceNo + otp
     ← S1000 + subscriptionStatus + masked subscriberId

store the MASKED subscriberId — it is the identity for every later mSpace call
```

**Always call these from a backend with an IP in the *Allowed Host Address* list**, never from the
browser or the mobile app.

---

## OTP Request

```
POST /otp/request
Content-Type: application/json;charset=utf-8
```

This service requests an OTP for a subscriber's MSISDN. On the request, mSpace generates and sends
an OTP to the subscriber's MSISDN, which must be entered into your mobile or web application to
activate a subscription.

### Request

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

| Parameter | Description | Type | Mandatory |
|---|---|---|---|
| `applicationId` | ID of the application | String | **Mandatory** |
| `password` | Password or API key given to uniquely identify the application | String | **Mandatory** |
| `subscriberId` | Mobile number of the end consumer, `tel:`-prefixed | String | **Mandatory** |
| `applicationHash` | Hash string to determine which verification messages to send to your app | String | Optional |
| `applicationMetaData` | Client details for the request — see below | Object | Optional |

#### `applicationMetaData`

| Field | What mSpace documents |
|---|---|
| `client` | Client type. The values will be a web browser or a mobile app. |
| `device` | Type or OS of device — iPhone 6, Galaxy S5, PC, and so on |
| `os` | OS or device version — Android 6, iOS 5, Windows 10 |
| `appCode` | If you use an app in a store, your app identifier. If you use the web browser, the web link. |

Derive `device` and `os` from the User-Agent for web, and from the platform SDK for an app. Do not
put anything identifying the subscriber in here.

### Response

```json
{
  "version": "1.0",
  "statusCode": "S1000",
  "referenceNo": "213561321321613",
  "statusDetail": "Success"
}
```

| Parameter | Description |
|---|---|
| `version` | API version |
| `statusCode` | The status code for the entire request. When the request is successful, `statusCode` is `S1000`. |
| `referenceNo` | Reference key that uniquely identifies the request. **Keep it server-side** and pass it to OTP Verify. |
| `statusDetail` | The status detail for the entire request |

### Documented status codes

| Code | Meaning |
|---|---|
| `S1000` | Successfully sent the OTP challenge to the MSISDN or sender ID |
| `E1853` | Maximum number of OTP requests reached for the MSISDN or sender ID |
| `E1856` | Invalid Request |
| `E1857` | Internal Server Error Occur |
| `E1301` | Requested ApplicationID is not allowed within the System for the operator |

---

## OTP Verify

```
POST /otp/verify
Content-Type: application/json;charset=utf-8
```

This service verifies an OTP entered by a subscriber into the application. On successful
verification the subscription process of mSpace is activated.

### Request

```json
{
  "applicationId": "APP_000375",
  "password": "…",
  "referenceNo": "213561321321613",
  "otp": "123564"
}
```

| Parameter | Description | Type | Mandatory |
|---|---|---|---|
| `applicationId` | ID of the application | String | **Mandatory** |
| `password` | Password or API key given to uniquely identify the application | String | **Mandatory** |
| `referenceNo` | Reference number returned with the OTP Request API | String | **Mandatory** |
| `otp` | The one time password to be used for MSISDN verification for the application | String | **Mandatory** |

### Response

```json
{
  "version": "1.0",
  "statusCode": "S1000",
  "subscriptionStatus": "REGISTERED",
  "statusDetail": "Success",
  "subscriberId": "tel:hu3b84346f63899a32ec742a666503a02a4dffe4f5"
}
```

| Parameter | Description |
|---|---|
| `version` | API version |
| `statusCode` | The status code for the entire request. When the request is successful, `statusCode` is `S1000`. |
| `subscriptionStatus` | Subscription status of the user — one of the six statuses in [04-subscription.md](04-subscription.md#the-six-subscription-statuses) |
| `statusDetail` | The status detail for the entire request |
| `subscriberId` | **Masked** mobile number of the end consumer. The documentation is explicit: the application has to use this for any subsequent request sent to the platform. |

### Documented status codes

| Code | Meaning |
|---|---|
| `S1000` | Successfully validated the OTP for the MSISDN or sender ID |
| `E1850` | Invalid OTP |
| `E1851` | The OTP request has expired |
| `E1852` | Maximum number of OTP attempts had reached |
| `E1854` | Could not find OTP |
| `E1855` | Invalid reference number |
| `E1857` | Internal Server Error Occur |
| `E1301` | Requested ApplicationID is not allowed within the System for the operator |

---

## Rules

- **`referenceNo` lives server-side, in the session.** Never send it to the client, never put it in
  a URL, never let the client choose it — that would let an attacker verify against someone else's
  OTP request.
- **Rate-limit OTP requests yourself**, per number and per IP. Without that, your application is an
  SMS-bombing tool aimed at arbitrary Sri Lankan phone numbers, at your expense. `E1853` tells you
  when the platform's own limit is reached; it is not your rate limiter.
- **mSpace does not publish the OTP validity window or the attempt count.** `E1851` (expired) and
  `E1852` (maximum attempts) are what you get when either is reached. Enforce your own limits as
  well rather than assuming a number, and do not display a countdown you cannot substantiate.
- **The `subscriberId` you get back is the masked identifier.** Store it as the subscriber's
  identity for all later mSpace calls. Do not store the raw MSISDN the subscriber typed unless you
  genuinely need it, and if you do, protect it as personal data.
- **Distinguish the failure classes when you prompt.** `E1850` (wrong OTP) invites another attempt;
  `E1851` and `E1852` mean start again with a fresh request; `E1854` and `E1855` mean your
  `referenceNo` is wrong, which is a bug in your session handling, not something the subscriber can
  fix.
- **Never log the OTP or the `referenceNo`.**
- **Verifying an OTP activates a subscription.** That makes it a consent event: record who agreed,
  when, and to what — the amount and frequency your application is provisioned for — exactly as you
  would for a Register call. See
  [10-security-best-practices.md](10-security-best-practices.md#5-consent).

---

## The two OTP flows are not interchangeable

mSpace has two OTP mechanisms. They look alike and do different things:

| | **OTP API** (this page) | **CaaS OTP** ([06-caas.md](06-caas.md)) |
|---|---|---|
| Purpose | Activate a **subscription** | Authorise a one-time **charge** |
| Request endpoint | `POST /otp/request` | `POST /caas/direct/debit` |
| Verify endpoint | `POST /otp/verify` | `POST /caas/otp/verify` |
| Success on the first call | `S1000` | **`P1003`** |
| The reference you carry forward | `referenceNo` | `requestCorrelator` |
| Verify sends | `referenceNo`, `otp` | `referenceNo` (= the `requestCorrelator`), `otp`, `sourceAddress` |
| Verify returns | `subscriptionStatus`, masked `subscriberId`, `statusDetail` | `status` (boolean), `statusDescription` |
| What success means | The subscriber is subscribed | Money has moved |
| Settled by | Nothing further | The charging notification callback |

Sending an OTP-API `referenceNo` to the CaaS verify endpoint, or a `requestCorrelator` to this one,
gives `E1855`. Keep them in separate fields on separate records; do not build one shared
"otpReference" column.

---

`POST /otp/request` and `POST /otp/verify` as runnable curls — every parameter, response and
response field defined: [14-curl-reference.md](14-curl-reference.md).
