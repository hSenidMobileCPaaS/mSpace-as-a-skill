<!-- Generated from catalog/mspace-api.json by scripts/build-curl-reference.mjs. Do not edit directly. -->

# Every Endpoint as curl

The whole mSpace contract at the wire: each endpoint, each parameter defined, a request you can
run, and the response it returns. No SDK, no generated code, no tooling of any kind between you
and the platform.

**Write the integration from this page, in whatever language the project already uses.** There
is deliberately no code generator in this skill: a generator would privilege a handful of
languages and rot as their idioms move, while the request below is the same call in all of
them. The body, the headers and the branching are identical whether it goes out through
`requests` in Python, `HttpClient` in Java or .NET, `net/http` in Go, Guzzle in PHP,
`Net::HTTP` in Ruby, `reqwest` in Rust, `HTTPoison` in Elixir or `fetch` in Node. Translate the
curl into the project's own HTTP client and idiom; keep everything else exactly as specified.

Run these against a real application to confirm provisioning and credentials before writing a
line of code — a working curl removes half the possible causes when the integration then fails.

---

## The shape of every call

```
POST  https://api.mspace.lk/<service-path>
Content-Type: application/json;charset=utf-8
```

- **Credentials travel in the JSON body**, as `applicationId` and `password`. There are no
  headers, no tokens, no signatures and no OAuth on this platform.
- **Every response is HTTP 200**, including failures. mSpace returns HTTP 200 for application-level failures. Branch on statusCode, never on the HTTP status alone. S1000 is success — except on CaaS OTP generation, where the documented success code is P1003, and on Subscriber List, where S1001 means the request succeeded and matched nobody.
- Every response carries `statusCode` and `statusDetail`; most also carry
  `version` and `requestId`. CaaS OTP Verification is the exception:
  it returns `statusDescription` and a boolean `status` instead of `statusDetail`.
- Subscriber addresses are always `tel:<msisdn>` — no `+`, no spaces.
  An application with Mobile Number Masking enabled receives a masked number instead; it is
  opaque, so send back exactly what you received.

## Before you run anything

Export your credentials and the endpoints your application is provisioned for. Every command on
this page reads them from the environment, so nothing here contains a credential and nothing you
copy can commit one.

```bash
export MSPACE_APP_ID='APP_XXXXXX'
export MSPACE_PASSWORD='…'                   # from the application record — never commit it
export MSPACE_SMS_SEND_URL='https://api.mspace.lk/sms/send'
export MSPACE_USSD_SEND_URL='https://api.mspace.lk/ussd/send'
export MSPACE_SUBSCRIPTION_SEND_URL='https://api.mspace.lk/subscription/send'
export MSPACE_SUBSCRIPTION_STATUS_URL='https://api.mspace.lk/subscription/getStatus'
export MSPACE_SUBSCRIPTION_QUERY_BASE_URL='https://api.mspace.lk/subscription/query-base'
export MSPACE_SUBSCRIPTION_CHARGING_INFO_URL='https://api.mspace.lk/subscription/getSubscriberChargingInfo'
export MSPACE_SUBSCRIPTION_LIST_URL='https://api.mspace.lk/subscription/getSubscriberList'
export MSPACE_SUBSCRIPTION_NOTIFY_URL='https://api.mspace.lk/subscription/notify'
export MSPACE_OTP_REQUEST_URL='https://api.mspace.lk/otp/request'
export MSPACE_OTP_VERIFY_URL='https://api.mspace.lk/otp/verify'
export MSPACE_CAAS_DEBIT_URL='https://api.mspace.lk/caas/direct/debit'
export MSPACE_CAAS_OTP_VERIFY_URL='https://api.mspace.lk/caas/otp/verify'
export MSPACE_LBS_REQUEST_URL='https://api.mspace.lk/lbs/request'
```

One variable per provisioned service, never one shared base URL: an application can only call
the APIs it was provisioned for, so an endpoint you have no variable for is one you must not
call.

Windows PowerShell, where `curl` is an alias for `Invoke-WebRequest` and the syntax differs:

```powershell
$body = @{ applicationId = $env:MSPACE_APP_ID; password = $env:MSPACE_PASSWORD } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri $env:MSPACE_SUBSCRIPTION_QUERY_BASE_URL `
  -ContentType 'application/json' -Body $body
```

Three flags in every request below, all deliberate: `-sS` prints errors but not a progress bar,
`--max-time 15` stops a hung call holding a request thread, and `-d @- <<REQUEST` reads the body
from a heredoc so the credential variables expand and the JSON stays readable.

**Start with Query Base.** It needs no subscriber, costs nothing and touches no one, so it is
the safest way to prove that your credentials, your provisioning and your egress IP all work.

---

## Endpoint index

| Service | Endpoint | Environment variable |
|---|---|---|
| [SMS Send](#sms-send) | `POST https://api.mspace.lk/sms/send` | `MSPACE_SMS_SEND_URL` |
| [USSD Send](#ussd-send) | `POST https://api.mspace.lk/ussd/send` | `MSPACE_USSD_SEND_URL` |
| [Subscription Register (opt-in)](#subscription-register-opt-in) | `POST https://api.mspace.lk/subscription/send` | `MSPACE_SUBSCRIPTION_SEND_URL` |
| [Subscription Unregister (opt-out)](#subscription-unregister-opt-out) | `POST https://api.mspace.lk/subscription/send` | `MSPACE_SUBSCRIPTION_SEND_URL` |
| [Subscriber Status](#subscriber-status) | `POST https://api.mspace.lk/subscription/getStatus` | `MSPACE_SUBSCRIPTION_STATUS_URL` |
| [Query Base (subscriber base size)](#query-base-subscriber-base-size) | `POST https://api.mspace.lk/subscription/query-base` | `MSPACE_SUBSCRIPTION_QUERY_BASE_URL` |
| [Subscriber Charging Info](#subscriber-charging-info) | `POST https://api.mspace.lk/subscription/getSubscriberChargingInfo` | `MSPACE_SUBSCRIPTION_CHARGING_INFO_URL` |
| [Subscriber List](#subscriber-list) | `POST https://api.mspace.lk/subscription/getSubscriberList` | `MSPACE_SUBSCRIPTION_LIST_URL` |
| [Subscriber Notification](#subscriber-notification) | `POST https://api.mspace.lk/subscription/notify` | `MSPACE_SUBSCRIPTION_NOTIFY_URL` |
| [OTP Request](#otp-request) | `POST https://api.mspace.lk/otp/request` | `MSPACE_OTP_REQUEST_URL` |
| [OTP Verify](#otp-verify) | `POST https://api.mspace.lk/otp/verify` | `MSPACE_OTP_VERIFY_URL` |
| [CaaS OTP Generation (direct debit)](#caas-otp-generation-direct-debit) | `POST https://api.mspace.lk/caas/direct/debit` | `MSPACE_CAAS_DEBIT_URL` |
| [CaaS OTP Verification](#caas-otp-verification) | `POST https://api.mspace.lk/caas/otp/verify` | `MSPACE_CAAS_OTP_VERIFY_URL` |
| [LBS Request Location](#lbs-request-location) | `POST https://api.mspace.lk/lbs/request` | `MSPACE_LBS_REQUEST_URL` |

| Callback | mSpace calls | Configured in |
|---|---|---|
| [SMS Receive (MO)](#sms-receive-mo) | `POST <your-host>/api/mspace/sms/receive` | SMS configuration — Message Receiving URL |
| [SMS Delivery Report](#sms-delivery-report) | `POST <your-host>/api/mspace/sms/report` | SMS configuration — Delivery Report URL |
| [USSD Receive](#ussd-receive) | `POST <your-host>/api/mspace/ussd/receive` | USSD configuration — Connection URL |
| [Charging Notification](#charging-notification) | `POST <your-host>/api/mspace/charging/notification` | CaaS configuration — Charging Notification URL |

---

# Outbound services — you call mSpace

---

## SMS Send

Send an MT (Mobile Terminated) SMS to one or more terminals from your application.

| | |
|---|---|
| **Endpoint** | `POST https://api.mspace.lk/sms/send` |
| **Environment variable** | `MSPACE_SMS_SEND_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [02-sms.md](02-sms.md) |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `version` | string | **Required** | API version, numbered 1.0, 2.0 and so on. If a version is specified in the request the same version is returned in the response; if it is not, the latest version is returned. |
| `applicationId` | string | **Required** | Identifies the application. A unique identifier generated while provisioning. Only a single value per request. |
| `password` | string | **Required** | Authenticates the application-originated message against the credentials of the service provider. Encoded, single value. |
| `message` | string | **Required** | Content of the message to send. Messages over the limit are broken up by the platform before sending. |
| `destinationAddresses` | string[] | **Required** | List of destination addresses, which should be telephone numbers (tel: for MSISDN), for example tel:94702725777. Always an array, even for one recipient. The value tel:all sends the message to the subscribed base of the application. tel may be a masked number depending on the type of application. |
| `sourceAddress` | string | Optional | Address of the source shown to the subscriber. Must be the default sender address or one of the send address aliases configured in provisioning, or the send fails with E1331. |
| `deliveryStatusRequest` | enum | Optional | Indicates the need of a Delivery Status Report for the message. 0 = not required, 1 = required. One of `0`, `1`. |
| `encoding` | enum | Optional | Encoding scheme used in the message: 0 = Text, 240 = Flash SMS, 245 = Binary. If not specified it is taken as Text. With Binary the message content is represented hex encoded. One of `0`, `240`, `245`. |
| `binaryHeader` | string | Optional | Hexadecimal. For advanced types of message where the binary header is sent from the application. |

### Request

```bash
curl -sS -X POST "$MSPACE_SMS_SEND_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$MSPACE_APP_ID",
  "password": "$MSPACE_PASSWORD",
  "version": "1.0",
  "message": "Hello",
  "destinationAddresses": [
    "tel:94702725777"
  ],
  "sourceAddress": "77000",
  "deliveryStatusRequest": "1",
  "encoding": "0"
}
REQUEST
```

### Response

HTTP 200. Success is `statusCode: "S1000"` — nothing else.

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

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `version` | string | API version. |
| `requestId` | string | Uniquely identifies a request within the platform. |
| `destinationResponses` | object[] | The list of responses for the full list of addresses, with one entry for each element in the address list of the request. A multi-recipient send can partially succeed, so branch on each entry's statusCode, not only the top-level one. |
| `destinationResponses[].address` | string | The tel:-prefixed recipient this entry reports on. |
| `destinationResponses[].messageId` | string | Message identifier for this recipient. Store it to match delivery reports. |
| `destinationResponses[].statusCode` | string | Outcome for this recipient alone. |
| `destinationResponses[].statusDetail` | string | Human-readable outcome for this recipient. |
| `destinationResponses[].timeStamp` | string | Processed timestamp for this recipient. |
| `statusCode` | string | The status code for the entire request. S1000 on success. |
| `statusDetail` | string | Description of the status for the entire request. |

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully. On Subscriber List it reads "Request Was Successfully Processed"; on SMS send, "Process completed successfully for all the available destination numbers". |
| `E1303` | configuration | IP address, which the request originates from, is not listed within the allowed-host-address list. → Add the calling server's egress IP to Allowed Host Address on the application record. Determine it from the server that makes the calls, not from a laptop. |
| `E1308` | user-state | Permanent charging error, for example insufficient balance. → Tell the subscriber. Do not blind-retry. |
| `E1309` | configuration | Requested SMS service is not allowed for this application. → The API was not provisioned for this application. Fix the application record; no payload change helps. |
| `E1311` | configuration | Mobile terminated SMS messages are not enabled. Check the NCS configuration in provisioning. |
| `E1312` | client | Request is invalid. → Check the mandatory fields and the format of the request against the endpoint's parameter table. |
| `E1313` | configuration | Authentication failed. There is no active application with the given applicationId, or no active service provider, or the password in the request is invalid. → Check MSPACE_APP_ID and MSPACE_PASSWORD, and that the application is active. |
| `E1315` | configuration | Cannot find the requested service, or it is not active. On the CaaS path this is reported as "NCS system unavailable". |
| `E1317` | user-state | The MSISDN in the request is invalid or not allowed. → Validate the number. Do not retry. |
| `E1318` | transient | Transaction limit per second has exceeded. → Throttle requests so they stay under the transaction limit. |
| `E1319` | transient | Transaction limit for today has exceeded. → Try again tomorrow, or have the per-day transaction limit raised. |
| `E1325` | client | Format of the address is invalid. The expected format is tel:94702725777. → A missing tel: prefix, or a + or a space that slipped in. |
| `E1331` | configuration | The sourceAddress is not allowed. → Use the default sender address or one of the send address aliases configured on the application, or omit sourceAddress so the platform uses the default. |
| `E1334` | client | Message length is too long. → Shorten or split the message. |
| `E1335` | client | Advertisement message length is too long. → Shorten the advertisement content. |
| `E1341` | transient | Request failed. Errors occurred while sending the request for all the destinations. |
| `E1342` | user-state | The MSISDN is blacklisted and is not authorised to use this application. → Check Blacklisted Numbers on the application record. |
| `E1343` | user-state | The MSISDN is not whitelisted. Only whitelisted numbers are allowed at this state. → Add the test number under Whitelisted Numbers while the application is in Limited Production. |
| `E1601` | transient | System experienced an unexpected error. |
| `E1603` | transient | Temporary system error occurred while delivering your request. |

`success` proceed · `pending` accepted but not finished — the outcome arrives later · `configuration` fix the application record, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the subscriber is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- destinationAddresses is always an array, even for a single recipient.
- Guard tel:all behind a deliberate, separately-authorised code path — it reaches the whole subscribed base.
- sourceAddress must be the default sender address or a configured alias, or the send fails with E1331.
- Only set deliveryStatusRequest to 1 if you actually consume the delivery report callback.
- There is no top-level messageId: per-recipient identifiers live in destinationResponses.

---

## USSD Send

Send a USSD message (a screen) to a mobile phone from your application.

| | |
|---|---|
| **Endpoint** | `POST https://api.mspace.lk/ussd/send` |
| **Environment variable** | `MSPACE_USSD_SEND_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [03-ussd.md](03-ussd.md) |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `version` | string | **Required** | API version, numbered 1.0, 2.0 and so on. If a version is specified in the request the same version is returned in the response. |
| `applicationId` | string | **Required** | Identifies the application. A unique identifier generated while provisioning. Only a single value per request. |
| `password` | string | **Required** | Authenticates the application-originated message against the credentials of the service provider. Encoded, single value. |
| `message` | string | **Required** | Content of the message sent by the application — the screen text the subscriber sees. |
| `sessionId` | string | **Required** | Unique number the USSD Gateway assigns to the application for the duration of the session. It is maintained in all the messages throughout a single session, so echo the one you were given rather than generating your own. |
| `ussdOperation` | enum | **Required** | The USSD operation. An application assigns mt-init when it initiates a session, mt-cont for any message that comes after an init, and mt-fin when the session ends in a final message. mo-init and mo-cont are assigned by the platform for messages originated by the subscriber. One of `mo-init`, `mo-cont`, `mt-init`, `mt-cont`, `mt-fin`. |
| `destinationAddress` | string | **Required** | Destination address, which should be a telephone number (tel: for MSISDN). May be a masked number depending on the type of application. |
| `encoding` | enum | Optional | Encoding scheme used in the message. 440 = plain ASCII characters. One of `440`. |

### Request

```bash
curl -sS -X POST "$MSPACE_USSD_SEND_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$MSPACE_APP_ID",
  "password": "$MSPACE_PASSWORD",
  "version": "1.0",
  "message": "1. Press One\n2. Press two\n3. Press three\n4. Exit",
  "sessionId": "1330929317043",
  "ussdOperation": "mt-cont",
  "destinationAddress": "tel:94702725777",
  "encoding": "440"
}
REQUEST
```

### Response

HTTP 200. Success is `statusCode: "S1000"` — nothing else.

```json
{
  "version": "1.0",
  "requestId": "101901031657410007",
  "timeStamp": "20190103165801",
  "statusCode": "S1000",
  "statusDetail": "Success."
}
```

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `version` | string | API version. |
| `requestId` | string | Uniquely identifies the request within the platform. |
| `timeStamp` | string | Processed timestamp. |
| `statusCode` | string | The status code for the entire request. S1000 on success. |
| `statusDetail` | string | Description of the status for the entire request. |

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully. On Subscriber List it reads "Request Was Successfully Processed"; on SMS send, "Process completed successfully for all the available destination numbers". |
| `E1303` | configuration | IP address, which the request originates from, is not listed within the allowed-host-address list. → Add the calling server's egress IP to Allowed Host Address on the application record. Determine it from the server that makes the calls, not from a laptop. |
| `E1308` | user-state | Permanent charging error, for example insufficient balance. → Tell the subscriber. Do not blind-retry. |
| `E1309` | configuration | Requested SMS service is not allowed for this application. → The API was not provisioned for this application. Fix the application record; no payload change helps. |
| `E1312` | client | Request is invalid. → Check the mandatory fields and the format of the request against the endpoint's parameter table. |
| `E1313` | configuration | Authentication failed. There is no active application with the given applicationId, or no active service provider, or the password in the request is invalid. → Check MSPACE_APP_ID and MSPACE_PASSWORD, and that the application is active. |
| `E1315` | configuration | Cannot find the requested service, or it is not active. On the CaaS path this is reported as "NCS system unavailable". |
| `E1317` | user-state | The MSISDN in the request is invalid or not allowed. → Validate the number. Do not retry. |
| `E1318` | transient | Transaction limit per second has exceeded. → Throttle requests so they stay under the transaction limit. |
| `E1319` | transient | Transaction limit for today has exceeded. → Try again tomorrow, or have the per-day transaction limit raised. |
| `E1325` | client | Format of the address is invalid. The expected format is tel:94702725777. → A missing tel: prefix, or a + or a space that slipped in. |
| `E1334` | client | Message length is too long. → Shorten or split the message. |
| `E1341` | transient | Request failed. Errors occurred while sending the request for all the destinations. |
| `E1342` | user-state | The MSISDN is blacklisted and is not authorised to use this application. → Check Blacklisted Numbers on the application record. |
| `E1343` | user-state | The MSISDN is not whitelisted. Only whitelisted numbers are allowed at this state. → Add the test number under Whitelisted Numbers while the application is in Limited Production. |
| `E1601` | transient | System experienced an unexpected error. |
| `E1603` | transient | Temporary system error occurred while delivering your request. |

`success` proceed · `pending` accepted but not finished — the outcome arrives later · `configuration` fix the application record, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the subscriber is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- Echo the sessionId the platform gave you. Never generate one for a session the platform started.
- mt-fin closes the session. Terminal screens must use it, or the session hangs until the network times it out.
- encoding 440 is plain ASCII: no emoji, no Sinhala or Tamil script, no smart quotes.
- Reply fast. Do the minimum inline and defer anything slow to an out-of-band job.

---

## Subscription Register (opt-in)

Opt a subscriber in to the application. The same endpoint handles unsubscription with action 0.

| | |
|---|---|
| **Endpoint** | `POST https://api.mspace.lk/subscription/send` |
| **Environment variable** | `MSPACE_SUBSCRIPTION_SEND_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [04-subscription.md](04-subscription.md) |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | Identifies the application. A unique identifier generated while provisioning. Only a single value per request. |
| `password` | string | **Required** | Authenticates the application-originated message against the credentials of the service provider. Encoded, single value. |
| `subscriberId` | string | **Required** | The MSISDN of the subscriber, tel:-prefixed — for example tel:94716177301. May be a masked number depending on the type of application. Only a single value per request. |
| `action` | enum | **Required** | 1 = user subscription, 0 = user unsubscription. One of `1`, `0`. |

### Request

```bash
curl -sS -X POST "$MSPACE_SUBSCRIPTION_SEND_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$MSPACE_APP_ID",
  "password": "$MSPACE_PASSWORD",
  "subscriberId": "tel:94716177301",
  "action": "1"
}
REQUEST
```

### Response

HTTP 200. Success is `statusCode: "S1000"` — nothing else.

```json
{
  "version": "1.0",
  "statusCode": "S1000",
  "statusDetail": "Request was successfully processed",
  "subscriptionStatus": "REGISTERED"
}
```

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `version` | string | API version. |
| `statusCode` | string | The status code for the entire request. |
| `statusDetail` | string | Description of the status for the entire request. |
| `subscriptionStatus` | string | Status of the subscription, for example REGISTERED or UNREGISTERED. |

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully. On Subscriber List it reads "Request Was Successfully Processed"; on SMS send, "Process completed successfully for all the available destination numbers". |

The mSpace documentation publishes no further per-code table for this endpoint. Treat any
other code as a failure and decode it against the complete table in
[08-status-codes.md](08-status-codes.md).

`success` proceed · `pending` accepted but not finished — the outcome arrives later · `configuration` fix the application record, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the subscriber is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- Capture explicit consent before calling this, and record what the user agreed to, when, and through which channel.
- Disclose the charging amount and frequency before subscribing — both are set per application in provisioning.
- Registration may land in INITIAL or REG_PENDING rather than REGISTERED. Do not start delivering the service until the subscription is active.
- Mirror subscription state in your own database rather than calling getStatus on every request.

---

## Subscription Unregister (opt-out)

Opt a subscriber out of the application. The same endpoint as register, with action 0.

| | |
|---|---|
| **Endpoint** | `POST https://api.mspace.lk/subscription/send` |
| **Environment variable** | `MSPACE_SUBSCRIPTION_SEND_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [04-subscription.md](04-subscription.md) |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | Identifies the application. A unique identifier generated while provisioning. Only a single value per request. |
| `password` | string | **Required** | Authenticates the application-originated message against the credentials of the service provider. Encoded, single value. |
| `subscriberId` | string | **Required** | The MSISDN of the subscriber, tel:-prefixed. May be a masked number depending on the type of application. Only a single value per request. |
| `action` | enum | **Required** | 1 = user subscription, 0 = user unsubscription. One of `1`, `0`. |

### Request

```bash
curl -sS -X POST "$MSPACE_SUBSCRIPTION_SEND_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$MSPACE_APP_ID",
  "password": "$MSPACE_PASSWORD",
  "subscriberId": "tel:94716177301",
  "action": "0"
}
REQUEST
```

### Response

HTTP 200. Success is `statusCode: "S1000"` — nothing else.

```json
{
  "version": "1.0",
  "statusCode": "S1000",
  "statusDetail": "not registered",
  "subscriptionStatus": "UNREGISTERED"
}
```

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `version` | string | API version. |
| `statusCode` | string | The status code for the entire request. |
| `statusDetail` | string | Description of the status for the entire request. |
| `subscriptionStatus` | string | Status of the subscription, for example REGISTERED or UNREGISTERED. |

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully. On Subscriber List it reads "Request Was Successfully Processed"; on SMS send, "Process completed successfully for all the available destination numbers". |

The mSpace documentation publishes no further per-code table for this endpoint. Treat any
other code as a failure and decode it against the complete table in
[08-status-codes.md](08-status-codes.md).

`success` proceed · `pending` accepted but not finished — the outcome arrives later · `configuration` fix the application record, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the subscriber is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- Unregister must be as easy to reach as register: an opt-out keyword over MO SMS, a USSD menu option, and an in-app control.
- Honour an opt-out immediately, including cancelling messages you have already queued for that subscriber.
- Never re-subscribe a subscriber who opted out without a fresh, separate opt-in.

---

## Subscriber Status

Return the subscription status of one subscriber.

| | |
|---|---|
| **Endpoint** | `POST https://api.mspace.lk/subscription/getStatus` |
| **Environment variable** | `MSPACE_SUBSCRIPTION_STATUS_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [04-subscription.md](04-subscription.md) |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | Unique identification of the application within the platform. |
| `password` | string | **Required** | Password given when provisioning the application. |
| `subscriberId` | string | **Required** | The MSISDN of the subscriber, tel:-prefixed. May be a masked number depending on the type of application. |

### Request

```bash
curl -sS -X POST "$MSPACE_SUBSCRIPTION_STATUS_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$MSPACE_APP_ID",
  "password": "$MSPACE_PASSWORD",
  "subscriberId": "tel:94716177301"
}
REQUEST
```

### Response

HTTP 200. Success is `statusCode: "S1000"` — nothing else.

```json
{
  "version": "1.0",
  "statusCode": "S1000",
  "statusDetail": "Request was successfully processed",
  "subscriptionStatus": "REGISTERED"
}
```

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `version` | string | API version. |
| `statusCode` | string | The status code for the entire request. |
| `statusDetail` | string | Description of the status for the entire request. |
| `subscriptionStatus` | string | Status of the subscription: INITIAL, REG_PENDING, TRIAL, REGISTERED, UNREGISTERED or TEMPORARY_BLOCKED. |

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully. On Subscriber List it reads "Request Was Successfully Processed"; on SMS send, "Process completed successfully for all the available destination numbers". |

The mSpace documentation publishes no further per-code table for this endpoint. Treat any
other code as a failure and decode it against the complete table in
[08-status-codes.md](08-status-codes.md).

`success` proceed · `pending` accepted but not finished — the outcome arrives later · `configuration` fix the application record, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the subscriber is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- Use it for reconciliation — a nightly sweep, or when a subscriber disputes their state — not as a per-request gate.
- There are six documented statuses, not two. Handle INITIAL, REG_PENDING, TRIAL and TEMPORARY_BLOCKED explicitly.

---

## Query Base (subscriber base size)

Return the number of subscribers currently registered to the application.

| | |
|---|---|
| **Endpoint** | `POST https://api.mspace.lk/subscription/query-base` |
| **Environment variable** | `MSPACE_SUBSCRIPTION_QUERY_BASE_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [04-subscription.md](04-subscription.md) |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | Identifies the application. A unique identifier generated while provisioning. Only a single value per request. |
| `password` | string | **Required** | Authenticates the application-originated message against the credentials of the service provider. Encoded, single value. |

### Request

```bash
curl -sS -X POST "$MSPACE_SUBSCRIPTION_QUERY_BASE_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$MSPACE_APP_ID",
  "password": "$MSPACE_PASSWORD"
}
REQUEST
```

### Response

HTTP 200. Success is `statusCode: "S1000"` — nothing else.

```json
{
  "baseSize": "0",
  "version": "1.0",
  "statusCode": "S1000",
  "statusDetail": "Success."
}
```

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `baseSize` | string | Number of registered users. Arrives as a string — coerce it before arithmetic. |
| `version` | string | API version. |
| `statusCode` | string | The status code for the entire request. |
| `statusDetail` | string | Description of the status for the entire request. |

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully. On Subscriber List it reads "Request Was Successfully Processed"; on SMS send, "Process completed successfully for all the available destination numbers". |

The mSpace documentation publishes no further per-code table for this endpoint. Treat any
other code as a failure and decode it against the complete table in
[08-status-codes.md](08-status-codes.md).

`success` proceed · `pending` accepted but not finished — the outcome arrives later · `configuration` fix the application record, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the subscriber is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- Needs no subscriber and charges nothing, which makes it the safest call for proving credentials, provisioning and the egress IP.
- baseSize is a string. Parse it before charting or comparing.
- Poll it on a schedule into your own metrics store rather than per page load, and sanity-check it before any tel:all broadcast.

---

## Subscriber Charging Info

Return subscription status and last-charge details for up to ten subscribers in one request.

| | |
|---|---|
| **Endpoint** | `POST https://api.mspace.lk/subscription/getSubscriberChargingInfo` |
| **Environment variable** | `MSPACE_SUBSCRIPTION_CHARGING_INFO_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [04-subscription.md](04-subscription.md) |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | Unique identification of the application within the platform. |
| `password` | string | **Required** | Password given when provisioning the application. |
| `subscriberIds` | string[] | Optional | MSISDNs of the list of subscribers, for example ["tel:94712342345", "tel:94712678845"]. If the application accepts masked numbers, the masked numbers must be sent here. The list can contain a maximum of 10 MSISDNs per request. |

### Request

```bash
curl -sS -X POST "$MSPACE_SUBSCRIPTION_CHARGING_INFO_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$MSPACE_APP_ID",
  "password": "$MSPACE_PASSWORD",
  "subscriberIds": [
    "tel:94712342345",
    "tel:94712678845",
    "tel:9471982563"
  ]
}
REQUEST
```

### Response

HTTP 200. Success is `statusCode: "S1000"` — nothing else.

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

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `version` | string | API version. |
| `destinationResponses` | object[] | One entry per subscriber in the request. Which fields are populated depends on the subscription status, so read defensively. |
| `destinationResponses[].subscriberId` | string | MSISDN of the subscriber, masked if the application accepts masked numbers. Always present. |
| `destinationResponses[].subscriptionStatus` | string | INITIAL, REG_PENDING, TRIAL, REGISTERED, UNREGISTERED or TEMPORARY_BLOCKED. |
| `destinationResponses[].lastChargedDate` | string | The successful last charged date of the subscriber, in the format YYYY-MM-DD hh:mm:ss. Omitted for a free application. |
| `destinationResponses[].lastChargedAmount` | string | The successful last charged amount for the subscriber with the currency code, for example 30.00 LKR. Sent as 0.00 LKR for a free application. |
| `destinationResponses[].numberType` | string | Denotes whether the subscriber is prepaid or postpaid. |
| `destinationResponses[].statusCode` | string | Success or error code for this subscriber. |
| `destinationResponses[].statusDetail` | string | Description of the status for this subscriber. |
| `statusCode` | string | The status code for the entire request. |
| `statusDetail` | string | Description of the status for the entire request. |

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully. On Subscriber List it reads "Request Was Successfully Processed"; on SMS send, "Process completed successfully for all the available destination numbers". |
| `E1303` | configuration | IP address, which the request originates from, is not listed within the allowed-host-address list. → Add the calling server's egress IP to Allowed Host Address on the application record. Determine it from the server that makes the calls, not from a laptop. |
| `E1312` | client | Request is invalid. → Check the mandatory fields and the format of the request against the endpoint's parameter table. |
| `E1313` | configuration | Authentication failed. There is no active application with the given applicationId, or no active service provider, or the password in the request is invalid. → Check MSPACE_APP_ID and MSPACE_PASSWORD, and that the application is active. |
| `E1317` | user-state | The MSISDN in the request is invalid or not allowed. → Validate the number. Do not retry. |
| `E1325` | client | Format of the address is invalid. The expected format is tel:94702725777. → A missing tel: prefix, or a + or a space that slipped in. |
| `E1601` | transient | System experienced an unexpected error. |
| `E1603` | transient | Temporary system error occurred while delivering your request. |

`success` proceed · `pending` accepted but not finished — the outcome arrives later · `configuration` fix the application record, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the subscriber is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- Maximum 10 MSISDNs per request. Batch larger sets by looping with your own rate limiting.
- lastChargedDate and lastChargedAmount are absent for INITIAL, REG_PENDING and TRIAL subscribers — check before reading them.
- Every entry carries its own statusCode. One subscriber failing does not fail the request.

---

## Subscriber List

Retrieve the subscriber list a page at a time, so you can catch up on subscription notifications you missed.

| | |
|---|---|
| **Endpoint** | `POST https://api.mspace.lk/subscription/getSubscriberList` |
| **Environment variable** | `MSPACE_SUBSCRIPTION_LIST_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [04-subscription.md](04-subscription.md) |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | Unique identification of the application within the platform. |
| `password` | string | **Required** | Password given when provisioning the application. |
| `version` | string | Optional | API version. |
| `requestPage` | integer | **Required** | The specific page number from a list of pages containing subscription notifications. Must be 1 or greater, or the request fails with E1106. |

### Request

```bash
curl -sS -X POST "$MSPACE_SUBSCRIPTION_LIST_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$MSPACE_APP_ID",
  "password": "$MSPACE_PASSWORD",
  "version": "1.0",
  "requestPage": 1
}
REQUEST
```

### Response

HTTP 200. Success is `statusCode: "S1000"` — nothing else.

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

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `version` | string | API version. |
| `statusCode` | string | Success or error code for each subscriber and for the entire request. |
| `statusDetail` | string | Description corresponding to the status code. |
| `nextPageNumber` | integer | The next page number available. If there is no page available next, -1 is returned. |
| `moreDataAvailable` | boolean | Indicates whether there is more data available. |
| `subscribers` | object | Subscriber data for this page. |
| `subscribers[].subscriberId` | string | MSISDN of the subscriber, masked if the application accepts masked numbers. |
| `subscribers[].subscriptionStatus` | string | Status of the subscription, for example TRIAL, REGISTERED or TEMPORARY_BLOCKED. |
| `subscribers[].lastChargedDate` | string | The successful last charged date of the subscriber, in the format YYYY-MM-DD hh:mm:ss. |
| `subscribers[].lastChargedAmount` | string | The successful last charged amount for the subscriber with the currency code. |

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully. On Subscriber List it reads "Request Was Successfully Processed"; on SMS send, "Process completed successfully for all the available destination numbers". |
| `S1001` | success | No Subscribers Found. → The request succeeded and matched nobody. Treat it as success and stop paging. **This is the documented success outcome for this call.** |
| `E1100` | transient | System Experienced an Unexpected Error. |
| `E1102` | configuration | Service Provider Is Not In Active Status. |
| `E1103` | client | Request Parameters are Invalid. Refer the API documentation. |
| `E1104` | configuration | Application is Not in Active or Limited Production Status. |
| `E1105` | transient | TPS Exceeded. → Throttle your own request rate and retry with backoff. |
| `E1106` | client | Invalid Request Page. Page Number Should Be 1 Or Greater. |
| `E1107` | client | Request Is Invalid. Refer the API documentation for the mandatory fields and correct format of the request. |

`success` proceed · `pending` accepted but not finished — the outcome arrives later · `configuration` fix the application record, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the subscriber is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- S1001 (No Subscribers Found) is not a failure. The request worked and matched nobody — treat it as success.
- Page until moreDataAvailable is false; nextPageNumber is -1 when there is no next page.
- This endpoint has its own E11xx status-code family, not the E13xx one the other services use.
- It is a catch-up mechanism for missed notifications, not a substitute for handling the Subscription Notification URL.

---

## Subscriber Notification

Send subscription notifications to users.

| | |
|---|---|
| **Endpoint** | `POST https://api.mspace.lk/subscription/notify` |
| **Environment variable** | `MSPACE_SUBSCRIPTION_NOTIFY_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [04-subscription.md](04-subscription.md) |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `timeStamp` | string | **Required** | The timestamp, in the format yyMMddHHmm: yy last two digits of the year (00-99), MM month (01-12), dd day (01-31), HH hour (00-23), mm minute (00-59). |
| `version` | string | **Required** | API version, numbered 1.0, 2.0 and so on. |
| `applicationId` | string | **Required** | Identifies the application. A unique identifier generated while provisioning. Only a single value per request. |
| `password` | string | **Required** | Authenticates the application-originated message against the credentials of the service provider. Encoded, single value. |
| `subscriberId` | string | **Required** | The MSISDN of the subscriber, tel:-prefixed. May be a masked number depending on the type of application. Only a single value per request. |
| `frequency` | enum | **Required** | Frequency of notifications being sent. One of `daily`, `weekly`, `monthly`, `yearly`. |
| `status` | string | **Required** | Status of the subscription, for example UNREGISTERED or REGISTERED. |

### Request

```bash
curl -sS -X POST "$MSPACE_SUBSCRIPTION_NOTIFY_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$MSPACE_APP_ID",
  "password": "$MSPACE_PASSWORD",
  "timeStamp": "20120113082110",
  "version": "1.0",
  "subscriberId": "tel:94716177301",
  "frequency": "monthly",
  "status": "REGISTERED"
}
REQUEST
```

### Response

HTTP 200. Success is `statusCode: "S1000"` — nothing else.

```json
{
  "statusCode": "S1000",
  "statusDetail": "Request was successfully processed"
}
```

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `statusCode` | string | The status code for the entire request. |
| `statusDetail` | string | Description of the status for the entire request. |

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully. On Subscriber List it reads "Request Was Successfully Processed"; on SMS send, "Process completed successfully for all the available destination numbers". |

The mSpace documentation publishes no further per-code table for this endpoint. Treat any
other code as a failure and decode it against the complete table in
[08-status-codes.md](08-status-codes.md).

`success` proceed · `pending` accepted but not finished — the outcome arrives later · `configuration` fix the application record, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the subscriber is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- This is the same field vocabulary the Subscription Notification URL uses. Provisioning configures that URL separately, under Subscription configuration.
- Do not use it to reconstruct state you should be mirroring from the Subscription Notification URL.

---

## OTP Request

Request an OTP for a subscriber's MSISDN. mSpace generates and sends the OTP; the subscriber enters it in your application to activate a subscription.

| | |
|---|---|
| **Endpoint** | `POST https://api.mspace.lk/otp/request` |
| **Environment variable** | `MSPACE_OTP_REQUEST_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [04-subscription.md](04-subscription.md) |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | ID of the application. |
| `password` | string | **Required** | Password or API key given to uniquely identify the application. |
| `subscriberId` | string | **Required** | Mobile number of the end consumer, tel:-prefixed. |
| `applicationHash` | string | Optional | Hash string to determine which verification messages to send to your app. |
| `applicationMetaData` | object | Optional | Client details for the request: client (client type — web browser or mobile app), device (type or OS of device, e.g. iPhone 6, Galaxy S5, PC), os (OS or device version, e.g. Android 6, iOS 5, Windows 10) and appCode (your app identifier in the store, or the web link if you use a browser). |

### Request

```bash
curl -sS -X POST "$MSPACE_OTP_REQUEST_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$MSPACE_APP_ID",
  "password": "$MSPACE_PASSWORD",
  "subscriberId": "tel:94716177301",
  "applicationHash": "abcdefgh",
  "applicationMetaData": {
    "client": "MOBILEAPP",
    "device": "Samsung S10",
    "os": "android 8",
    "appCode": "https://play.google.com/store/apps/details?id=lk"
  }
}
REQUEST
```

### Response

HTTP 200. Success is `statusCode: "S1000"` — nothing else.

```json
{
  "version": "1.0",
  "statusCode": "S1000",
  "referenceNo": "213561321321613",
  "statusDetail": "Success"
}
```

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `version` | string | API version. |
| `statusCode` | string | The status code for the entire request. When the request is successful, statusCode is S1000. |
| `referenceNo` | string | Reference key that uniquely identifies the request. Keep it server-side and pass it to OTP Verify. |
| `statusDetail` | string | The status detail for the entire request. |

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully. On Subscriber List it reads "Request Was Successfully Processed"; on SMS send, "Process completed successfully for all the available destination numbers". |
| `E1301` | configuration | Requested ApplicationID is not allowed within the System for the operator. |
| `E1853` | user-state | Maximum number of OTP requests reached for this MSISDN or sender ID. → Back off for this subscriber. Enforce your own per-number and per-IP rate limit as well. |
| `E1856` | client | Documented as "Invalid Request" on OTP Request, and as "OTP Not Found" on CaaS OTP verification and the charging notification. |
| `E1857` | transient | Documented as "Internal Server Error Occur" on the OTP API, and as "Invalid Reference Number" on the charging notification. → Retry only on the OTP API path. On a charging notification it is terminal — reconcile the transaction and do not re-charge. |

`success` proceed · `pending` accepted but not finished — the outcome arrives later · `configuration` fix the application record, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the subscriber is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- Call it from a backend with a whitelisted IP, never from the browser or the mobile app.
- Keep referenceNo server-side, in the session. Never send it to the client and never put it in a URL.
- Rate-limit per number and per IP yourself. Without that the application is an SMS-bombing tool aimed at arbitrary numbers, at your expense.
- Never log the OTP or the referenceNo.

---

## OTP Verify

Verify the OTP a subscriber entered. On success the mSpace subscription process is activated and the masked subscriberId is returned.

| | |
|---|---|
| **Endpoint** | `POST https://api.mspace.lk/otp/verify` |
| **Environment variable** | `MSPACE_OTP_VERIFY_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [04-subscription.md](04-subscription.md) |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | ID of the application. |
| `password` | string | **Required** | Password or API key given to uniquely identify the application. |
| `referenceNo` | string | **Required** | Reference number returned with the OTP Request API. |
| `otp` | string | **Required** | The one time password to be used for MSISDN verification for the application. |

### Request

```bash
curl -sS -X POST "$MSPACE_OTP_VERIFY_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$MSPACE_APP_ID",
  "password": "$MSPACE_PASSWORD",
  "referenceNo": "213561321321613",
  "otp": "123564"
}
REQUEST
```

### Response

HTTP 200. Success is `statusCode: "S1000"` — nothing else.

```json
{
  "version": "1.0",
  "statusCode": "S1000",
  "subscriptionStatus": "REGISTERED",
  "statusDetail": "Success",
  "subscriberId": "tel:hu3b84346f63899a32ec742a666503a02a4dffe4f5"
}
```

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `version` | string | API version. |
| `statusCode` | string | The status code for the entire request. When the request is successful, statusCode is S1000. |
| `subscriptionStatus` | string | Subscription status of the user. |
| `statusDetail` | string | The status detail for the entire request. |
| `subscriberId` | string | Masked mobile number of the end consumer. The application has to use this for any subsequent request sent to the platform. |

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully. On Subscriber List it reads "Request Was Successfully Processed"; on SMS send, "Process completed successfully for all the available destination numbers". |
| `E1301` | configuration | Requested ApplicationID is not allowed within the System for the operator. |
| `E1850` | client | Invalid OTP. → Prompt the subscriber to re-enter it. |
| `E1851` | client | The OTP request has expired. → Request a fresh OTP. mSpace does not publish the validity window. |
| `E1852` | user-state | Maximum number of OTP attempts has been reached. → Stop accepting attempts against this reference and start a new OTP request. |
| `E1854` | client | Could not find OTP. |
| `E1855` | client | Invalid OTP reference number. → On CaaS, referenceNo must be the requestCorrelator returned by OTP generation; on the OTP API it must be the referenceNo returned by OTP Request. |
| `E1857` | transient | Documented as "Internal Server Error Occur" on the OTP API, and as "Invalid Reference Number" on the charging notification. → Retry only on the OTP API path. On a charging notification it is terminal — reconcile the transaction and do not re-charge. |

`success` proceed · `pending` accepted but not finished — the outcome arrives later · `configuration` fix the application record, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the subscriber is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- The subscriberId returned here is the masked identifier. Store it as the subscriber's identity for every later mSpace call.
- E1851 (expired) and E1852 (maximum attempts reached) are the documented limits. mSpace does not publish the validity window or the attempt count, so enforce your own limits as well.
- Never log the OTP.

---

## CaaS OTP Generation (direct debit)

Start a one-time charge on the subscriber's mobile account. mSpace generates and sends an OTP to the subscriber's MSISDN, which they must enter in your application to authorise the charge.

| | |
|---|---|
| **Endpoint** | `POST https://api.mspace.lk/caas/direct/debit` |
| **Environment variable** | `MSPACE_CAAS_DEBIT_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [05-caas.md](05-caas.md) |

> **This call moves real money.** `externalTrxId` is the idempotency key: generate it,
> persist it *before* sending, and reuse it unchanged on every resolution attempt. A retry with
> a fresh one can charge a real person twice.

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | Identifies the application. A unique identifier generated while provisioning. Only a single value per request. |
| `password` | string | **Required** | The API key sent to your registered email address on the platform upon application approval. |
| `externalTrxId` | string | **Required** | The transaction ID generated by the application to map the request with the response. It is needed to provide information when there are inquiries related to a transaction. Only a single value per request. Persist it BEFORE calling — it is the idempotency key. |
| `subscriberId` | string | **Required** | The MSISDN of the subscriber to be charged, tel:-prefixed. May be a masked number depending on the type of application. Only a single value per request. |
| `paymentInstrumentName` | enum | **Required** | The name of the payment instrument. Only a single value per request. One of `Mobile Account`. |
| `amount` | string | **Required** | Amount to be reserved for charging, sent as a string. Only a single value per request. Hold it as a decimal type in your own code. |
| `currency` | string | **Required** | Currency unit of the amount. Only LKR is allowed. Only a single value per request. |
| `applicationHash` | string | Optional | A unique hash value generated by the service provider application to ensure request integrity and authenticity, using a mutually agreed hashing algorithm (for example SHA-256) over agreed request parameters. Only a single value per request. |

### Request

```bash
curl -sS -X POST "$MSPACE_CAAS_DEBIT_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$MSPACE_APP_ID",
  "password": "$MSPACE_PASSWORD",
  "externalTrxId": "256091232",
  "subscriberId": "tel:94702725777",
  "paymentInstrumentName": "Mobile Account",
  "amount": "5.00",
  "currency": "LKR"
}
REQUEST
```

### Response

HTTP 200. Success is `statusCode: "P1003"` — nothing else.

```json
{
  "timeStamp": "2026-11-08T08:02:16.913Z",
  "externalTrxId": "256091232",
  "statusDetail": "Successfully sent OTP to user.",
  "requestCorrelator": "8801442233146169943053700500040",
  "internalTrxId": "9110808020001876",
  "statusCode": "P1003"
}
```

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `timeStamp` | string | The time that the request was sent. |
| `externalTrxId` | string | Echo of the transaction ID you generated. Assert it matches what you sent. |
| `requestCorrelator` | string | The unique identifier used internally within the system to identify the transaction. Pass it as referenceNo to CaaS OTP Verification. |
| `internalTrxId` | string | The transaction ID generated by the service provider which can be used to track the transaction. Persist it — this is what support traces with. |
| `statusCode` | string | The status of the request. P1003 means the OTP was sent successfully; it is the success code for this call, not S1000. |
| `statusDetail` | string | Detailed description explaining the status of the entire request. |

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `P1003` | pending | Successfully sent OTP to user. → This is the success code for CaaS OTP generation — nothing has been charged yet. Store requestCorrelator, collect the OTP from the subscriber, and call CaaS OTP Verification. **This is the documented success outcome for this call.** |
| `E1300` | transient | Unknown or unclassified error. → Log the full response and escalate with the externalTrxId if it persists. |
| `E1301` | configuration | Requested ApplicationID is not allowed within the System for the operator. |
| `E1302` | configuration | Requested SP is not allowed within the System. |
| `E1303` | configuration | IP address, which the request originates from, is not listed within the allowed-host-address list. → Add the calling server's egress IP to Allowed Host Address on the application record. Determine it from the server that makes the calls, not from a laptop. |
| `E1312` | client | Request is invalid. → Check the mandatory fields and the format of the request against the endpoint's parameter table. |
| `E1313` | configuration | Authentication failed. There is no active application with the given applicationId, or no active service provider, or the password in the request is invalid. → Check MSPACE_APP_ID and MSPACE_PASSWORD, and that the application is active. |
| `E1315` | configuration | Cannot find the requested service, or it is not active. On the CaaS path this is reported as "NCS system unavailable". |
| `E1316` | transient | Connection to app refused. |
| `E1325` | client | Format of the address is invalid. The expected format is tel:94702725777. → A missing tel: prefix, or a + or a space that slipped in. |
| `E1329` | configuration | Charging amount too high. Check the NCS configuration. |
| `E1330` | configuration | Charging amount too low. Check the NCS configuration. |
| `E1337` | user-state | Subscriber authentication failed. → The subscriber did not confirm. Prompt them again rather than retrying automatically. |
| `E1342` | user-state | The MSISDN is blacklisted and is not authorised to use this application. → Check Blacklisted Numbers on the application record. |
| `E1343` | user-state | The MSISDN is not whitelisted. Only whitelisted numbers are allowed at this state. → Add the test number under Whitelisted Numbers while the application is in Limited Production. |
| `E1371` | configuration | The application does not accept payments from the given payment instrument. → Check the payment instruments enabled in CaaS configuration. |
| `E1601` | transient | System experienced an unexpected error. |
| `E1603` | transient | Temporary system error occurred while delivering your request. |
| `E1604` | configuration | Endpoint configuration missing. → A URL the platform needs — such as the charging notification URL — is not configured on the application record. |
| `E1607` | configuration | Unable to read application response. → Your endpoint returned something the platform could not parse. Return HTTP 200 with {"statusCode":"S1000","statusDetail":"Success"}. |
| `E1608` | configuration | SLA configuration error. |
| `E1852` | user-state | Maximum number of OTP attempts has been reached. → Stop accepting attempts against this reference and start a new OTP request. |

`success` proceed · `pending` accepted but not finished — the outcome arrives later · `configuration` fix the application record, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the subscriber is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- The success code is P1003, not S1000. Code that only accepts S1000 reports every successful charge request as a failure.
- P1003 means the OTP was sent — nothing has been charged yet. The charge happens on CaaS OTP Verification and settles on the charging notification.
- externalTrxId is your idempotency key. Generate it once, persist it BEFORE the call, and reuse the same value for any retry of that same logical charge.
- Never retry a charge with a fresh externalTrxId. A timeout does not mean the charge did not happen.
- Amount and currency come from server-side configuration or a server-side price lookup, never from client input.

---

## CaaS OTP Verification

Verify the OTP the subscriber entered. On successful verification the one-time charge is deducted from the subscriber's mobile account.

| | |
|---|---|
| **Endpoint** | `POST https://api.mspace.lk/caas/otp/verify` |
| **Environment variable** | `MSPACE_CAAS_OTP_VERIFY_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [05-caas.md](05-caas.md) |

> **This call moves real money.** Settle the outcome from the charging notification rather than by calling again.

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | Identifies the application. A unique identifier generated while provisioning. Only a single value per request. |
| `password` | string | **Required** | The API key sent to your registered email address on the platform upon application approval. |
| `referenceNo` | string | **Required** | The value returned for requestCorrelator in the response of the CaaS OTP generation request. It is the reference of the transaction. |
| `otp` | string | **Required** | The OTP entered by the subscriber on the developer application. |
| `sourceAddress` | string | **Required** | The MSISDN that requested the OTP, tel:-prefixed. |

### Request

```bash
curl -sS -X POST "$MSPACE_CAAS_OTP_VERIFY_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$MSPACE_APP_ID",
  "password": "$MSPACE_PASSWORD",
  "referenceNo": "8801442233146169943053700500040",
  "otp": "123456",
  "sourceAddress": "tel:94702725777"
}
REQUEST
```

### Response

HTTP 200. Success is `statusCode: "S1000"` — nothing else.

```json
{
  "statusCode": "S1000",
  "statusDescription": "Request was Successfully processed.",
  "status": true
}
```

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `statusCode` | string | The status of the request. S1000 means it was successfully processed. |
| `statusDescription` | string | Human-readable description of the outcome. Note the field is statusDescription here, not statusDetail. |
| `status` | boolean | true if the OTP was valid and charging proceeded; false otherwise. |

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully. On Subscriber List it reads "Request Was Successfully Processed"; on SMS send, "Process completed successfully for all the available destination numbers". |
| `E1312` | client | Request is invalid. → Check the mandatory fields and the format of the request against the endpoint's parameter table. |
| `E1337` | user-state | Subscriber authentication failed. → The subscriber did not confirm. Prompt them again rather than retrying automatically. |
| `E1850` | client | Invalid OTP. → Prompt the subscriber to re-enter it. |
| `E1852` | user-state | Maximum number of OTP attempts has been reached. → Stop accepting attempts against this reference and start a new OTP request. |
| `E1854` | client | Could not find OTP. |
| `E1855` | client | Invalid OTP reference number. → On CaaS, referenceNo must be the requestCorrelator returned by OTP generation; on the OTP API it must be the referenceNo returned by OTP Request. |
| `E1856` | client | Documented as "Invalid Request" on OTP Request, and as "OTP Not Found" on CaaS OTP verification and the charging notification. |
| `E9999` | transient | System error, reported by CaaS OTP verification. |

`success` proceed · `pending` accepted but not finished — the outcome arrives later · `configuration` fix the application record, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the subscriber is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- referenceNo is the requestCorrelator from the OTP generation response, not your externalTrxId.
- The description field is statusDescription on this endpoint, not statusDetail. A shared response parser that only reads statusDetail loses the message.
- Read both statusCode and status: the boolean is the plain answer to whether charging proceeded.
- The final outcome still arrives on the charging notification. Reconcile against that, not against this response alone.
- Never log the OTP or the referenceNo.

---

## LBS Request Location

Request the location of a subscriber. mSpace returns the location if the subscriber has granted permission.

| | |
|---|---|
| **Endpoint** | `POST https://api.mspace.lk/lbs/request` |
| **Environment variable** | `MSPACE_LBS_REQUEST_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [06-lbs.md](06-lbs.md) |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | Application identification within the platform. |
| `password` | string | **Required** | Password of the application. |
| `version` | string | Optional | API version. |
| `requesterId` | string | **Required** | MSISDN of the subscriber who is requesting the location updates, tel:-prefixed. May be a masked number depending on the type of application. |
| `subscriberId` | string | **Required** | MSISDN of the subscriber whose location is needed, tel:-prefixed. May be a masked number depending on the type of application. |
| `serviceType` | enum | Optional | Required MLP service type. Currently supports IMMEDIATE. One of `IMMEDIATE`. |

### Request

```bash
curl -sS -X POST "$MSPACE_LBS_REQUEST_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$MSPACE_APP_ID",
  "password": "$MSPACE_PASSWORD",
  "version": "2.0",
  "requesterId": "tel:94711275563",
  "subscriberId": "tel:94711275563",
  "serviceType": "IMMEDIATE"
}
REQUEST
```

### Response

HTTP 200. Success is `statusCode: "S1000"` — nothing else.

```json
{
  "version": "1.0",
  "messageID": "101304051248020083",
  "latitude": "6.927079",
  "longitude": "79.861244",
  "subscriberState": true,
  "timestamp": "2022-01-20'T'13:20:10",
  "statusCode": "S1000",
  "statusDetail": "Success"
}
```

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `version` | string | API version. |
| `messageID` | string | Message identifier that uniquely identifies the request within the platform. Note the capital D. |
| `latitude` | string | Latitude coordinate of the location of the subscriber. A string, and absent on failure. |
| `longitude` | string | Longitude coordinate of the location of the subscriber. A string, and absent on failure. |
| `subscriberState` | boolean | Power on/off state of the target subscriber's mobile phone. true = power on, false = power off. |
| `timestamp` | string | System date and time of the successful or failed transaction. Note the lower-case s. |
| `statusCode` | string | The status code for the request. |
| `statusDetail` | string | The status detail for the request. |

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully. On Subscriber List it reads "Request Was Successfully Processed"; on SMS send, "Process completed successfully for all the available destination numbers". |
| `E1303` | configuration | IP address, which the request originates from, is not listed within the allowed-host-address list. → Add the calling server's egress IP to Allowed Host Address on the application record. Determine it from the server that makes the calls, not from a laptop. |

The mSpace documentation publishes no further per-code table for this endpoint. Treat any
other code as a failure and decode it against the complete table in
[08-status-codes.md](08-status-codes.md).

`success` proceed · `pending` accepted but not finished — the outcome arrives later · `configuration` fix the application record, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the subscriber is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- requesterId is mandatory and separate from subscriberId — the requester and the located subscriber are two different fields.
- latitude and longitude are strings, and absent on failure. Check they exist before reading them.
- One subscriber per request. Batch by looping with rate limiting, not by passing an array.
- Obtain and record explicit, purpose-specific consent before locating anyone. Consent to receive SMS is not consent to be located.

---

# Inbound callbacks — mSpace calls you

---

## SMS Receive (MO)

Fires when a subscriber sends an SMS to your short code with your keyword. The platform delivers it to the Message Receiving URL you configured.

| | |
|---|---|
| **Direction** | mSpace → you. There is nothing to call. |
| **Your route** | `POST <your-host>/api/mspace/sms/receive` (the path is yours; register it on the application record) |
| **Configured in** | SMS configuration — Message Receiving URL |
| **Deduplicate on** | `requestId` |
| **Full guide** | [02-sms.md](02-sms.md) |

### Payload fields

| Field | Type | | Definition |
|---|---|---|---|
| `version` | string | **Always sent** | API version, numbered 1.0, 2.0 and so on. |
| `applicationId` | string | **Always sent** | Your application ID — verify it matches yours. |
| `sourceAddress` | string | **Always sent** | Address of the source, tel:-prefixed. Masked if Mobile Number Masking is enabled. |
| `message` | string | **Always sent** | Content of the message sent by the user, including the keyword. |
| `requestId` | string | **Always sent** | Uniquely identifies a request within the platform. |
| `encoding` | enum | **Always sent** | Encoding scheme used in the message: 0 = Text, 240 = Flash SMS, 245 = Binary. With Binary the message content is hex encoded. One of `0`, `240`, `245`. |

### What arrives

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

### What you must respond

HTTP 200, immediately, before doing any work:

```json
{
  "statusCode": "S1000",
  "statusDetail": "Success"
}
```

### Replay it against your own handler

```bash
curl -sS -X POST "http://localhost:3000/api/mspace/sms/receive" \
  -H 'Content-Type: application/json' \
  -d @- <<'PAYLOAD'
{
  "version": "1.0",
  "applicationId": "APP_000029",
  "sourceAddress": "tel:94702725777",
  "message": "MYAPP hello",
  "requestId": "22607072011552911",
  "encoding": "0"
}
PAYLOAD
```

### Status codes documented for this service

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully. On Subscriber List it reads "Request Was Successfully Processed"; on SMS send, "Process completed successfully for all the available destination numbers". |
| `E1303` | configuration | IP address, which the request originates from, is not listed within the allowed-host-address list. → Add the calling server's egress IP to Allowed Host Address on the application record. Determine it from the server that makes the calls, not from a laptop. |
| `E1308` | user-state | Permanent charging error, for example insufficient balance. → Tell the subscriber. Do not blind-retry. |
| `E1309` | configuration | Requested SMS service is not allowed for this application. → The API was not provisioned for this application. Fix the application record; no payload change helps. |
| `E1311` | configuration | Mobile terminated SMS messages are not enabled. Check the NCS configuration in provisioning. |
| `E1312` | client | Request is invalid. → Check the mandatory fields and the format of the request against the endpoint's parameter table. |
| `E1313` | configuration | Authentication failed. There is no active application with the given applicationId, or no active service provider, or the password in the request is invalid. → Check MSPACE_APP_ID and MSPACE_PASSWORD, and that the application is active. |
| `E1315` | configuration | Cannot find the requested service, or it is not active. On the CaaS path this is reported as "NCS system unavailable". |
| `E1317` | user-state | The MSISDN in the request is invalid or not allowed. → Validate the number. Do not retry. |
| `E1318` | transient | Transaction limit per second has exceeded. → Throttle requests so they stay under the transaction limit. |
| `E1319` | transient | Transaction limit for today has exceeded. → Try again tomorrow, or have the per-day transaction limit raised. |
| `E1325` | client | Format of the address is invalid. The expected format is tel:94702725777. → A missing tel: prefix, or a + or a space that slipped in. |
| `E1331` | configuration | The sourceAddress is not allowed. → Use the default sender address or one of the send address aliases configured on the application, or omit sourceAddress so the platform uses the default. |
| `E1334` | client | Message length is too long. → Shorten or split the message. |
| `E1335` | client | Advertisement message length is too long. → Shorten the advertisement content. |
| `E1341` | transient | Request failed. Errors occurred while sending the request for all the destinations. |
| `E1342` | user-state | The MSISDN is blacklisted and is not authorised to use this application. → Check Blacklisted Numbers on the application record. |
| `E1343` | user-state | The MSISDN is not whitelisted. Only whitelisted numbers are allowed at this state. → Add the test number under Whitelisted Numbers while the application is in Limited Production. |
| `E1601` | transient | System experienced an unexpected error. |
| `E1603` | transient | Temporary system error occurred while delivering your request. |

`success` proceed · `pending` accepted but not finished — the outcome arrives later · `configuration` fix the application record, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the subscriber is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- Recognise opt-out keywords such as STOP, UNSUB and OFF, and honour them by calling Subscription Unregister.
- Do not perform a destructive or chargeable action on the content of one MO SMS alone — it is unauthenticated beyond the source address.

---

## SMS Delivery Report

Fires when an MT SMS sent with deliveryStatusRequest 1 reaches a final state. Match it to the original send with messageId or requestId.

| | |
|---|---|
| **Direction** | mSpace → you. There is nothing to call. |
| **Your route** | `POST <your-host>/api/mspace/sms/report` (the path is yours; register it on the application record) |
| **Configured in** | SMS configuration — Delivery Report URL |
| **Deduplicate on** | `requestId + deliveryStatus` |
| **Full guide** | [02-sms.md](02-sms.md) |

### Payload fields

| Field | Type | | Definition |
|---|---|---|---|
| `destinationAddress` | string | **Always sent** | Address of the subscriber, tel:-prefixed. |
| `timeStamp` | string | **Always sent** | The timestamp sent from the SMS, in the format yyMMddHHmm: yy last two digits of the year (00-99), MM month (01-12), dd day (01-31), HH hour (00-23), mm minute (00-59). The documented sample is 14 digits, so parse on length. |
| `requestId` | string | **Always sent** | Uniquely identifies a request within the platform. Ties the report back to the original send. |
| `deliveryStatus` | enum | **Always sent** | The delivery outcome the platform reports to the application. One of `DELIVERED`, `EXPIRED`, `DELETED`, `UNDELIVERABLE`, `ACCEPTED`, `UNKNOWN`, `REJECTED`. |

### What arrives

```json
{
  "destinationAddress": "tel:94702725777",
  "timeStamp": "20120113082110",
  "requestId": "MSG_000111",
  "deliveryStatus": "DELIVERED"
}
```

### What you must respond

HTTP 200, immediately, before doing any work:

```json
{
  "statusCode": "S1000",
  "statusDetail": "Success"
}
```

### Replay it against your own handler

```bash
curl -sS -X POST "http://localhost:3000/api/mspace/sms/report" \
  -H 'Content-Type: application/json' \
  -d @- <<'PAYLOAD'
{
  "destinationAddress": "tel:94702725777",
  "timeStamp": "20120113082110",
  "requestId": "MSG_000111",
  "deliveryStatus": "DELIVERED"
}
PAYLOAD
```

### Status codes documented for this service

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully. On Subscriber List it reads "Request Was Successfully Processed"; on SMS send, "Process completed successfully for all the available destination numbers". |
| `E1303` | configuration | IP address, which the request originates from, is not listed within the allowed-host-address list. → Add the calling server's egress IP to Allowed Host Address on the application record. Determine it from the server that makes the calls, not from a laptop. |
| `E1308` | user-state | Permanent charging error, for example insufficient balance. → Tell the subscriber. Do not blind-retry. |
| `E1309` | configuration | Requested SMS service is not allowed for this application. → The API was not provisioned for this application. Fix the application record; no payload change helps. |
| `E1311` | configuration | Mobile terminated SMS messages are not enabled. Check the NCS configuration in provisioning. |
| `E1312` | client | Request is invalid. → Check the mandatory fields and the format of the request against the endpoint's parameter table. |
| `E1313` | configuration | Authentication failed. There is no active application with the given applicationId, or no active service provider, or the password in the request is invalid. → Check MSPACE_APP_ID and MSPACE_PASSWORD, and that the application is active. |
| `E1315` | configuration | Cannot find the requested service, or it is not active. On the CaaS path this is reported as "NCS system unavailable". |
| `E1317` | user-state | The MSISDN in the request is invalid or not allowed. → Validate the number. Do not retry. |
| `E1318` | transient | Transaction limit per second has exceeded. → Throttle requests so they stay under the transaction limit. |
| `E1319` | transient | Transaction limit for today has exceeded. → Try again tomorrow, or have the per-day transaction limit raised. |
| `E1325` | client | Format of the address is invalid. The expected format is tel:94702725777. → A missing tel: prefix, or a + or a space that slipped in. |
| `E1331` | configuration | The sourceAddress is not allowed. → Use the default sender address or one of the send address aliases configured on the application, or omit sourceAddress so the platform uses the default. |
| `E1334` | client | Message length is too long. → Shorten or split the message. |
| `E1335` | client | Advertisement message length is too long. → Shorten the advertisement content. |
| `E1341` | transient | Request failed. Errors occurred while sending the request for all the destinations. |
| `E1342` | user-state | The MSISDN is blacklisted and is not authorised to use this application. → Check Blacklisted Numbers on the application record. |
| `E1343` | user-state | The MSISDN is not whitelisted. Only whitelisted numbers are allowed at this state. → Add the test number under Whitelisted Numbers while the application is in Limited Production. |
| `E1601` | transient | System experienced an unexpected error. |
| `E1603` | transient | Temporary system error occurred while delivering your request. |

`success` proceed · `pending` accepted but not finished — the outcome arrives later · `configuration` fix the application record, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the subscriber is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- ACCEPTED is not DELIVERED — it means the network took the message, nothing more.
- Reports can arrive out of order, late, more than once, or never. Store the latest status keyed by requestId and keep the handler idempotent.

---

## USSD Receive

Fires when a subscriber dials your service code or presses a key in an open session. The platform delivers the MO message to your Connection URL as a delivery request.

| | |
|---|---|
| **Direction** | mSpace → you. There is nothing to call. |
| **Your route** | `POST <your-host>/api/mspace/ussd/receive` (the path is yours; register it on the application record) |
| **Configured in** | USSD configuration — Connection URL |
| **Deduplicate on** | `requestId` |
| **Full guide** | [03-ussd.md](03-ussd.md) |

### Payload fields

| Field | Type | | Definition |
|---|---|---|---|
| `version` | string | **Always sent** | API version, numbered 1.0, 2.0 and so on. |
| `applicationId` | string | **Always sent** | Your application ID — verify it matches yours. |
| `message` | string | **Always sent** | Content of the message sent by the user — what they dialled or typed. |
| `requestId` | string | **Always sent** | Uniquely identifies a request within the platform. |
| `sessionId` | string | **Always sent** | Unique number the USSD Gateway assigns to the application for the duration of the session. Echo it back on every screen you send. |
| `ussdOperation` | enum | **Always sent** | The USSD operation. Inbound it is mo-init when the subscriber starts a session, or mo-cont for a message that comes after an init. One of `mo-init`, `mo-cont`, `mt-init`, `mt-cont`, `mt-fin`. |
| `sourceAddress` | string | **Always sent** | Address of the source, tel:-prefixed. Masked if Mobile Number Masking is enabled. |
| `vlrAddress` | string | Optional | VLR (Visitor Location Register) address of the sender. |
| `encoding` | enum | **Always sent** | Encoding scheme used in the message. 440 = plain ASCII characters. One of `440`. |

### What arrives

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

### What you must respond

HTTP 200, immediately, before doing any work:

```json
{
  "statusCode": "S1000",
  "statusDetail": "Success"
}
```

### Replay it against your own handler

```bash
curl -sS -X POST "http://localhost:3000/api/mspace/ussd/receive" \
  -H 'Content-Type: application/json' \
  -d @- <<'PAYLOAD'
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
PAYLOAD
```

### Status codes documented for this service

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully. On Subscriber List it reads "Request Was Successfully Processed"; on SMS send, "Process completed successfully for all the available destination numbers". |
| `E1303` | configuration | IP address, which the request originates from, is not listed within the allowed-host-address list. → Add the calling server's egress IP to Allowed Host Address on the application record. Determine it from the server that makes the calls, not from a laptop. |
| `E1308` | user-state | Permanent charging error, for example insufficient balance. → Tell the subscriber. Do not blind-retry. |
| `E1309` | configuration | Requested SMS service is not allowed for this application. → The API was not provisioned for this application. Fix the application record; no payload change helps. |
| `E1312` | client | Request is invalid. → Check the mandatory fields and the format of the request against the endpoint's parameter table. |
| `E1313` | configuration | Authentication failed. There is no active application with the given applicationId, or no active service provider, or the password in the request is invalid. → Check MSPACE_APP_ID and MSPACE_PASSWORD, and that the application is active. |
| `E1315` | configuration | Cannot find the requested service, or it is not active. On the CaaS path this is reported as "NCS system unavailable". |
| `E1317` | user-state | The MSISDN in the request is invalid or not allowed. → Validate the number. Do not retry. |
| `E1318` | transient | Transaction limit per second has exceeded. → Throttle requests so they stay under the transaction limit. |
| `E1319` | transient | Transaction limit for today has exceeded. → Try again tomorrow, or have the per-day transaction limit raised. |
| `E1325` | client | Format of the address is invalid. The expected format is tel:94702725777. → A missing tel: prefix, or a + or a space that slipped in. |
| `E1334` | client | Message length is too long. → Shorten or split the message. |
| `E1341` | transient | Request failed. Errors occurred while sending the request for all the destinations. |
| `E1342` | user-state | The MSISDN is blacklisted and is not authorised to use this application. → Check Blacklisted Numbers on the application record. |
| `E1343` | user-state | The MSISDN is not whitelisted. Only whitelisted numbers are allowed at this state. → Add the test number under Whitelisted Numbers while the application is in Limited Production. |
| `E1601` | transient | System experienced an unexpected error. |
| `E1603` | transient | Temporary system error occurred while delivering your request. |

`success` proceed · `pending` accepted but not finished — the outcome arrives later · `configuration` fix the application record, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the subscriber is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- The response body is only an acknowledgement. The screen the subscriber sees comes from a separate POST /ussd/send.
- Acknowledge immediately — USSD sessions time out in seconds — then build the next screen out of band.

---

## Charging Notification

Returned to your application upon a charging attempt, saying whether the charging succeeded. There is nothing to trigger: it arrives automatically once the transaction completes within the system.

| | |
|---|---|
| **Direction** | mSpace → you. There is nothing to call. |
| **Your route** | `POST <your-host>/api/mspace/charging/notification` (the path is yours; register it on the application record) |
| **Configured in** | CaaS configuration — Charging Notification URL |
| **Deduplicate on** | `externalTrxId + statusCode` |
| **Full guide** | [05-caas.md](05-caas.md) |

### Payload fields

| Field | Type | | Definition |
|---|---|---|---|
| `timeStamp` | string | **Always sent** | The time at which the request was sent. |
| `version` | string | **Always sent** | API version, numbered 1.0, 2.0 and so on. |
| `externalTrxId` | string | **Always sent** | The transaction ID generated by the application to map the request with the response. This is the key to reconcile against your own ledger. |
| `internalTrxId` | string | **Always sent** | The unique identifier used to track the request at the developer application end. |
| `referenceId` | string | **Always sent** | The unique reference used to identify the transaction within the system. |
| `currency` | string | **Always sent** | Currency unit of the amount. Only LKR is allowed. |
| `TotalAmount` | string | **Always sent** | Amount deducted from the subscriber as the one time charge. Note the capital T. |
| `paidAmount` | string | **Always sent** | The amount that is paid by the subscriber. |
| `balanceDue` | string | **Always sent** | The amount that is due, if any; otherwise 0. |
| `statusCode` | string | **Always sent** | The status of the charging attempt. S1000 means the request was successfully processed and the due amount was fully paid. |
| `statusDetail` | string | **Always sent** | Detailed description explaining the status of the entire request. |

### What arrives

```json
{
  "timeStamp": "2026-10-02T14:59:00+05:30",
  "version": "1.0",
  "externalTrxId": "256091234",
  "internalTrxId": "125100214570415",
  "referenceId": "12526",
  "currency": "LKR",
  "TotalAmount": "5.00",
  "paidAmount": "5.00",
  "balanceDue": "0.00",
  "statusCode": "S1000",
  "statusDetail": "Request was Successfully processed, Due amount fully paid."
}
```

### What you must respond

HTTP 200, immediately, before doing any work:

```json
{
  "statusCode": "S1000",
  "statusDetail": "Success"
}
```

### Replay it against your own handler

```bash
curl -sS -X POST "http://localhost:3000/api/mspace/charging/notification" \
  -H 'Content-Type: application/json' \
  -d @- <<'PAYLOAD'
{
  "timeStamp": "2026-10-02T14:59:00+05:30",
  "version": "1.0",
  "externalTrxId": "256091234",
  "internalTrxId": "125100214570415",
  "referenceId": "12526",
  "currency": "LKR",
  "TotalAmount": "5.00",
  "paidAmount": "5.00",
  "balanceDue": "0.00",
  "statusCode": "S1000",
  "statusDetail": "Request was Successfully processed, Due amount fully paid."
}
PAYLOAD
```

### Status codes documented for this service

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully. On Subscriber List it reads "Request Was Successfully Processed"; on SMS send, "Process completed successfully for all the available destination numbers". |
| `E1404` | client | Charging request failed. → Investigate with the externalTrxId and internalTrxId. Do not blind-retry. |
| `E1405` | user-state | Charging request timed out. No payments done. → The subscriber did not confirm in time. Start a fresh charge only with a fresh, deliberate user action. |
| `E1852` | user-state | Maximum number of OTP attempts has been reached. → Stop accepting attempts against this reference and start a new OTP request. |
| `E1854` | client | Could not find OTP. |
| `E1855` | client | Invalid OTP reference number. → On CaaS, referenceNo must be the requestCorrelator returned by OTP generation; on the OTP API it must be the referenceNo returned by OTP Request. |
| `E1856` | client | Documented as "Invalid Request" on OTP Request, and as "OTP Not Found" on CaaS OTP verification and the charging notification. |
| `E1857` | transient | Documented as "Internal Server Error Occur" on the OTP API, and as "Invalid Reference Number" on the charging notification. → Retry only on the OTP API path. On a charging notification it is terminal — reconcile the transaction and do not re-charge. |

`success` proceed · `pending` accepted but not finished — the outcome arrives later · `configuration` fix the application record, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the subscriber is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- This is your reconciliation channel. Every charge your code left in an unknown state after a timeout gets settled here.
- Match on externalTrxId — the key you generated and persisted before the OTP generation call.
- Deduplicate on externalTrxId plus statusCode. A repeat notification for an already-charged transaction must not double-count revenue.
- The amount field is TotalAmount with a capital T, and it sits alongside paidAmount and balanceDue. Read all three before deciding the charge is complete.

---

## What a curl does not show

Every command above is one HTTPS POST, and that part ports to any language in a few lines. The
difference between a working call and a production integration is what surrounds it — none of
which is visible in a shell command:

| | Why the curl hides it |
|---|---|
| **Credentials from the environment, injected once** | A shell export becomes a config module that validates at startup and fails loudly. One place reads it; no call site passes credentials as arguments. |
| **`statusCode` branching** | You read the JSON yourself here. Code that checks `res.ok`, `raise_for_status()` or `EnsureSuccessStatusCode()` reports every mSpace failure as a success. |
| **Per-endpoint success codes** | `S1000` almost everywhere, `P1003` on CaaS OTP generation, `S1001` as a success on Subscriber List. Only your code can know which call it just made. |
| **Idempotency** | `externalTrxId` has to be generated, persisted before the call, and reused unchanged on retry. A shell loop cannot do this; a ledger row can. |
| **The two-step charge** | A charge is OTP generation, then OTP verification, then a notification that settles it. Three exchanges, one transaction, one `externalTrxId`. |
| **Timeouts and retries** | `--max-time 15` becomes an explicit client timeout, with backoff on transient codes only and no automatic retry at all on a charge. |
| **`tel:` normalisation** | Typed by hand here; in code it is one function at the boundary, never a concatenation at a call site. |
| **Acknowledge-first callbacks** | The replay commands return instantly. A real handler must respond `S1000` and then work out of band — USSD sessions time out in seconds. |

Those seven, plus a shared USSD session store, are the whole specification. They are written out
language-neutrally in [11-any-stack.md](11-any-stack.md), with an acceptance checklist for a
port. [templates/](../templates/README.md) shows the same seven already built in TypeScript/Node,
Python, Java, Go, PHP and C# — worked examples to read for shape, not output to paste.

## Related

| | |
|---|---|
| Machine-readable form of this page | [`catalog/mspace-api.json`](../catalog/mspace-api.json) |
| Build a request with your own values | `node tools/mspace.mjs curl <id> key=value …` |
| Check a payload before sending it | `node tools/mspace.mjs validate <id> '<json>'` |
| Decode a status code you received | `node tools/mspace.mjs code <statusCode>` |
| Smoke-test the outbound path | [`scripts/smoke-test.sh`](../scripts/smoke-test.sh) (or `smoke-test.ps1`) |
| Test every callback handler | [`scripts/test-callbacks.sh`](../scripts/test-callbacks.sh) |
| Every status code, classified | [08-status-codes.md](08-status-codes.md) |
