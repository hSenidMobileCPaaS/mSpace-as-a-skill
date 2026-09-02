# Status Codes

## The single most important rule

**mSpace returns HTTP 200 for application-level failures.** The real outcome is the `statusCode`
field in the response body.

```
# WRONG — reports failures as successes
response = http_post(url, body)
if response.ok: return "sent"

# RIGHT
response = http_post(url, body)
data = parse_json(response.body)
if data.statusCode not in success_codes_for(service):
    raise MspaceError(data.statusCode, data.statusDetail)
```

Every stack spells the wrong version differently — `res.ok`, `raise_for_status()`,
`EnsureSuccessStatusCode()`, `response.IsSuccessStatusCode`, Guzzle's `http_errors`,
`resp.StatusCode == 200`. All of them are the same bug.

## The second most important rule: success is not always `S1000`

Three codes mean "this worked", and which one you get depends on the call:

| Code | Where | Meaning |
|---|---|---|
| `S1000` | Everywhere else | Process completed successfully |
| `P1003` | **CaaS OTP generation** (`POST /caas/direct/debit`) | The OTP was sent to the subscriber. The charge request succeeded; nothing has been charged yet. |
| `S1001` | **Subscriber List** (`POST /subscription/getSubscriberList`) | The request succeeded and matched no subscribers |

A client hard-coded to `statusCode === "S1000"` reports every successful charge request as a
failure, and an empty subscriber base as a broken integration. Make the success set a property of
the service wrapper, not a global constant.

One more envelope irregularity: **CaaS OTP Verification returns `statusDescription`, not
`statusDetail`**, plus a boolean `status`. See [06-caas.md](06-caas.md).

Codes starting `S` are success; `P` is provisional; `E` is an error.

| Prefix | Meaning |
|---|---|
| `S1000` / `S1001` | Success |
| `P1003` | Accepted, not yet complete |
| `E11xx` | Subscriber List's own family — service-provider and application state, request validity, TPS |
| `E13xx` | Application, authentication, routing, delivery and charging errors |
| `E14xx` | Charging outcome errors |
| `E16xx` | Platform-side system and configuration errors |
| `E18xx` | OTP errors |
| `E9999` | System error on CaaS OTP verification |

---

## Handling classes

Map codes to behaviour, not to strings. Six classes drive six different actions:

| Class | Retry? | What it means |
|---|---|---|
| **Success** | — | Proceed. |
| **Pending** | **Never** | Accepted, not complete. The outcome arrives later — on the charging notification, or after the subscriber acts. Do not treat it as finished, and do not re-send. |
| **Configuration** | **Never** | Your provisioning or credentials are wrong. Code changes will not help. Fix the application record. |
| **Client** | **Never** | Your payload is wrong, or the user gave bad input. Fix the request or prompt the user. |
| **User state** | **Only after user action** | The subscriber is not eligible right now. Communicate, do not retry in a loop. |
| **Transient** | **Yes, backoff** | Platform-side. Exponential backoff with jitter, capped attempts, then dead-letter. |

Every published code carries its class in the [complete list](#complete-status-code-list) below —
build your sets from that column, not from a remembered range. `E1308`, for instance, sits among
configuration-class neighbours but is user-state.

---

## Codes you will actually hit, and what to do

| Code | Meaning | Action |
|---|---|---|
| `S1000` | Success | Proceed |
| `P1003` | OTP sent to the subscriber | **Success** on CaaS OTP generation. Store `requestCorrelator`, collect the OTP, then verify. |
| `S1001` | No subscribers found | **Success** on Subscriber List. Stop paging. |
| `E1303` | **Source IP not in the allowed-host-address list** | Determine the egress IP on the calling server and add it to *Allowed Host Address* |
| `E1309` | Requested service is not allowed for this application | The API was not provisioned. Application-record fix, not a code fix. |
| `E1313` | **Authentication failure** — no active application, no active SP, or wrong password | Check `MSPACE_APP_ID` / `MSPACE_PASSWORD`; check the application is active |
| `E1104` | Application is not in Active or Limited Production status | The application record, not your code |
| `E1317` | MSISDN in the request is invalid or not allowed | Validate the number; do not retry |
| `E1325` | Format of the address is invalid | Missing `tel:` prefix, or a `+` or space slipped in |
| `E1331` | `sourceAddress` is not allowed | Use the Default Sender Address or a configured alias, or omit it |
| `E1334` / `E1335` | Message too long (normal / advertisement) | Shorten or split |
| `E1343` | Number is not whitelisted | Add it under *Whitelisted Numbers* while in Limited Production |
| `E1308` | Permanent charging error, for example insufficient balance | Tell the subscriber; do not blind-retry |
| `E1850`–`E1857` | OTP invalid, expired, attempts or requests exceeded, or a bad reference | Prompt the subscriber; enforce your own rate limits too |
| `E1607` | Unable to read application response | Your callback returned something unparseable. Return `{"statusCode":"S1000","statusDetail":"Success"}`. |

---

## Complete status code list

Every code the mSpace documentation publishes, across the SMS, USSD, CaaS, Subscription, OTP and
LBS services. The **Class** column is the one to build your error handling from: it maps each code
to one of the six behaviours above, and it is the same classification
`node tools/mspace.mjs code <statusCode>` returns and
[`catalog/mspace-api.json`](../catalog/mspace-api.json) stores.

| Code | Class | Description |
|---|---|---|
| `S1000` | success | Process completed successfully. On Subscriber List it reads "Request Was Successfully Processed"; on SMS send, "Process completed successfully for all the available destination numbers". |
| `S1001` | success | No Subscribers Found. |
| `P1003` | pending | Successfully sent OTP to user. |
| `E1100` | transient | System Experienced an Unexpected Error. |
| `E1102` | configuration | Service Provider Is Not In Active Status. |
| `E1103` | client | Request Parameters are Invalid. Refer the API documentation. |
| `E1104` | configuration | Application is Not in Active or Limited Production Status. |
| `E1105` | transient | TPS Exceeded. |
| `E1106` | client | Invalid Request Page. Page Number Should Be 1 Or Greater. |
| `E1107` | client | Request Is Invalid. Refer the API documentation for the mandatory fields and correct format of the request. |
| `E1300` | transient | Unknown or unclassified error. |
| `E1301` | configuration | Requested ApplicationID is not allowed within the System for the operator. |
| `E1302` | configuration | Requested SP is not allowed within the System. |
| `E1303` | configuration | IP address, which the request originates from, is not listed within the allowed-host-address list. |
| `E1308` | user-state | Permanent charging error, for example insufficient balance. |
| `E1309` | configuration | Requested SMS service is not allowed for this application. |
| `E1311` | configuration | Mobile terminated SMS messages are not enabled. Check the NCS configuration in provisioning. |
| `E1312` | client | Request is invalid. |
| `E1313` | configuration | Authentication failed. There is no active application with the given applicationId, or no active service provider, or the password in the request is invalid. |
| `E1315` | configuration | Cannot find the requested service, or it is not active. On the CaaS path this is reported as "NCS system unavailable". |
| `E1316` | transient | Connection to app refused. |
| `E1317` | user-state | The MSISDN in the request is invalid or not allowed. |
| `E1318` | transient | Transaction limit per second has exceeded. |
| `E1319` | transient | Transaction limit for today has exceeded. |
| `E1325` | client | Format of the address is invalid. The expected format is tel:94702725777. |
| `E1329` | configuration | Charging amount too high. Check the NCS configuration. |
| `E1330` | configuration | Charging amount too low. Check the NCS configuration. |
| `E1331` | configuration | The sourceAddress is not allowed. |
| `E1334` | client | Message length is too long. |
| `E1335` | client | Advertisement message length is too long. |
| `E1337` | user-state | Subscriber authentication failed. |
| `E1341` | transient | Request failed. Errors occurred while sending the request for all the destinations. |
| `E1342` | user-state | The MSISDN is blacklisted and is not authorised to use this application. |
| `E1343` | user-state | The MSISDN is not whitelisted. Only whitelisted numbers are allowed at this state. |
| `E1371` | configuration | The application does not accept payments from the given payment instrument. |
| `E1404` | client | Charging request failed. |
| `E1405` | user-state | Charging request timed out. No payments done. |
| `E1601` | transient | System experienced an unexpected error. |
| `E1603` | transient | Temporary system error occurred while delivering your request. |
| `E1604` | configuration | Endpoint configuration missing. |
| `E1607` | configuration | Unable to read application response. |
| `E1608` | configuration | SLA configuration error. |
| `E1850` | client | Invalid OTP. |
| `E1851` | client | The OTP request has expired. |
| `E1852` | user-state | Maximum number of OTP attempts has been reached. |
| `E1853` | user-state | Maximum number of OTP requests reached for this MSISDN or sender ID. |
| `E1854` | client | Could not find OTP. |
| `E1855` | client | Invalid OTP reference number. |
| `E1856` | client | Documented as "Invalid Request" on OTP Request, and as "OTP Not Found" on CaaS OTP verification and the charging notification. |
| `E1857` | transient | Documented as "Internal Server Error Occur" on the OTP API, and as "Invalid Reference Number" on the charging notification. |
| `E9999` | transient | System error, reported by CaaS OTP verification. |

### Codes documented under two meanings

Two codes appear in the mSpace documentation with different descriptions on different endpoints.
Both meanings are reproduced above; handle them by endpoint, not by code alone:

| Code | On the OTP API | On CaaS and the charging notification |
|---|---|---|
| `E1856` | Invalid Request | OTP Not Found |
| `E1857` | Internal Server Error Occur — retryable | Invalid Reference Number — terminal; reconcile and do not re-charge |

---

## Per-endpoint code lists

The documentation publishes a code table for some endpoints and not others. Where it publishes
none, this skill does not invent one: treat any non-success code as a failure and decode it
against the table above.

| Endpoint | Documented codes |
|---|---|
| SMS Send / Receive / Delivery Report | `S1000`, `E1303`, `E1308`, `E1309`, `E1311`, `E1312`, `E1313`, `E1315`, `E1317`, `E1318`, `E1319`, `E1325`, `E1331`, `E1334`, `E1335`, `E1341`, `E1342`, `E1343`, `E1601`, `E1603` |
| USSD Send / Receive | the same list, without `E1311`, `E1331` and `E1335` |
| CaaS OTP Generation | `P1003`, `E1300`, `E1301`, `E1302`, `E1303`, `E1312`, `E1313`, `E1315`, `E1316`, `E1325`, `E1329`, `E1330`, `E1337`, `E1342`, `E1343`, `E1371`, `E1601`, `E1603`, `E1604`, `E1607`, `E1608`, `E1852` |
| CaaS OTP Verification | `S1000`, `E1312`, `E1337`, `E1850`, `E1852`, `E1854`, `E1855`, `E1856`, `E9999` |
| Charging Notification | `S1000`, `E1404`, `E1405`, `E1852`, `E1854`, `E1855`, `E1856`, `E1857` |
| Subscriber Charging Info | `S1000`, `E1303`, `E1312`, `E1313`, `E1317`, `E1325`, `E1601`, `E1603` |
| Subscriber List | `S1000`, `S1001`, `E1100`, `E1102`, `E1103`, `E1104`, `E1105`, `E1106`, `E1107` |
| OTP Request | `S1000`, `E1301`, `E1853`, `E1856`, `E1857` |
| OTP Verify | `S1000`, `E1301`, `E1850`, `E1851`, `E1852`, `E1854`, `E1855`, `E1857` |
| Register / Unregister / Status / Query Base / Notify | `S1000`. No further table is published. |
| LBS Request Location | `S1000`, and `E1303` in the documented failure sample. No further table is published. |

`node tools/mspace.mjs show <id>` prints the list for one endpoint with each code's class.

---

## Reference implementation

Whatever your language calls an error — exception, error struct, result variant — it needs the
code, the detail, and two questions answerable from the sets below:

```
TRANSIENT = { E1100, E1105, E1300, E1316, E1318, E1319, E1341,
              E1601, E1603, E1857, E9999 }

CONFIGURATION = { E1102, E1104, E1301, E1302, E1303, E1309, E1311,
                  E1313, E1315, E1329, E1330, E1331, E1371,
                  E1604, E1607, E1608 }

# Success is per-service, not global.
SUCCESS = {
    default:              { S1000 },
    caas-otp-generation:  { P1003 },
    subscription-list:    { S1000, S1001 },
}

error MspaceError(statusCode, statusDetail, service):
    retryable       = statusCode in TRANSIENT
    isConfiguration = statusCode in CONFIGURATION
```

These sets are machine-readable in [`catalog/mspace-api.json`](../catalog/mspace-api.json) under
`statusCodes` (each code carries its `class`), so you can generate them rather than retyping them.

Working versions: [templates/](../templates/README.md) — TypeScript, Python, Java, Go, PHP and C#
all express exactly this.

Alerting rule of thumb: any **configuration**-class code in production is a page — the whole
integration is down, not one request. Transient codes belong on a rate dashboard.
