# LBS — Location Based Services

The LBS API requests the location of a subscriber. Upon the request, mSpace communicates the
location **if the subscriber has granted the permission**. This is a network-derived location, so
treat the position as a region rather than a point.

```
POST /lbs/request
Content-Type: application/json;charset=utf-8
```

Endpoint from `MSPACE_LBS_REQUEST_URL`. If that variable is unset, LBS is not enabled on your
application.

---

## Request

```json
{
  "applicationId": "APP_001768",
  "password": "…",
  "version": "2.0",
  "requesterId": "tel:94711275563",
  "subscriberId": "tel:94711275563",
  "serviceType": "IMMEDIATE"
}
```

| Parameter | Description | Type | Mandatory |
|---|---|---|---|
| `applicationId` | Application identification within the platform | String | **Mandatory** |
| `password` | Password of the application | String | **Mandatory** |
| `requesterId` | MSISDN of the subscriber **who is requesting** the location updates. May be a masked number depending on the type of application. | String | **Mandatory** |
| `subscriberId` | MSISDN of the subscriber **whose location is needed**. May be a masked number depending on the type of application. | String | **Mandatory** |
| `version` | API version | String | Optional |
| `serviceType` | Required MLP service type. Currently supports `IMMEDIATE`. | Enum | Optional |

**`requesterId` and `subscriberId` are two different fields and both are mandatory.** The
requester is who asked; the subscriber is who is being located. In a self-location flow they hold
the same value, and in a "find my family" flow they do not — which is exactly the case where
getting them the wrong way round locates the wrong person.

---

## Response

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

| Parameter | Description | Type | Mandatory |
|---|---|---|---|
| `version` | API version | String | Mandatory |
| `messageID` | Uniquely identifies the request within the platform. **Note the capital `D`** — it is `messageID` here, not `messageId`. | String | Optional |
| `latitude` | Latitude coordinate of the location of the subscriber | String | Optional |
| `longitude` | Longitude coordinate of the location of the subscriber | String | Optional |
| `subscriberState` | Power on/off state of the target subscriber's mobile phone. `true` = power on, `false` = power off. | Boolean | Optional |
| `timestamp` | System date and time of the successful or failed transaction. **Note the lower-case `s`** — it is `timestamp` here, where every other service uses `timeStamp`. | String | Optional |
| `statusCode` / `statusDetail` | Outcome | String | Mandatory |

Failure response — note there are no coordinates:

```json
{
  "version": "1.0",
  "messageID": "101304051248020083",
  "statusCode": "E1303",
  "statusDetail": "IP address, which the request originates from, is not listed within the allowed-host-address list"
}
```

---

## Implementation notes

- **`latitude` and `longitude` are strings, and both are optional.** Check they exist before
  reading them; they are absent on every failure. Parse them, then range-check before use — Sri
  Lanka spans roughly latitude 5.9–9.9 and longitude 79.5–81.9, so anything well outside that is a
  bad fix or a swapped pair. Log it and discard rather than plotting it. One validation helper at
  the parse boundary is all this takes.
- **`subscriberState: false`** means the handset is powered off. Whatever location came back, if
  any, is not a live fix.
- **Watch the two field-name irregularities** — `messageID` with a capital D, and `timestamp`
  with a lower-case s. A shared response mapper written against the rest of the platform will
  read both as undefined.
- **One subscriber per request.** Batch by looping with rate limiting, not by passing an array.
- **`serviceType` currently supports `IMMEDIATE`.** Do not send anything else, and do not invent
  quality-of-service parameters — mSpace publishes none for this endpoint.

### Documented status codes

The mSpace documentation publishes no per-code table for LBS beyond `S1000` for success and the
`E1303` shown in the failure sample. Treat any other code as a failure and decode it against the
complete table in [09-status-codes.md](09-status-codes.md).

---

## Privacy — treat location as the most sensitive data you handle

The service only returns a location **if the subscriber has granted the permission**, but that
permission is not a licence to query without limit. Location history reveals home, workplace and
movement patterns, so standards higher than for other fields apply:

- **Obtain and record explicit, purpose-specific consent** before locating anyone. Consent to
  receive SMS is not consent to be located.
- **Query only when there is a live user-facing reason** — never poll on a timer "just in case".
- **Store the minimum for the minimum time.** Prefer deriving the answer (inside or outside a
  zone) and storing that, rather than storing coordinates.
- **Set a short, enforced retention period** and actually delete.
- **Never log raw coordinates alongside an identifier** in application logs.
- **Never expose a location endpoint to your own client apps** without authorisation checks. The
  classic failure is an endpoint that locates any MSISDN the caller supplies — with `requesterId`
  and `subscriberId` being separate fields, that mistake is one unchecked parameter away.

---

## Services that are not in the public documentation

Do not invent endpoints, parameter names or status codes for anything mSpace does not publish. As
of this catalog, that includes:

- **Voice / IVR.** Not in the mSpace API documentation. If a user asks, say so, point them at
  <https://mspace.lk>, and offer what actually solves the requirement: **USSD** covers interactive
  menus on any handset without voice, and **SMS** covers notification delivery.
- **Balance query.** The OpenAPI document defines a `queryBalance` schema, but publishes no
  endpoint path for it. See [06-caas.md](06-caas.md#balance-query-is-not-published).

### Extension pattern — adding a new service without restructuring

This skill is built so a new service drops in without touching existing code. When a
specification arrives:

1. **Add a reference file** — with the same sections as the others: endpoint, request table,
   response table, callbacks, status codes, rules.
2. **Add the endpoint variable to config**, not to code — `MSPACE_<SERVICE>_URL` in
   `.env.example` and in the endpoint map of whichever config module your stack uses
   (`endpoints` in TypeScript, `_ENDPOINT_VARS` in Python, `ENDPOINT_VARS` in Java/PHP,
   `endpointVars` in Go, `EndpointVariables` in C#).
3. **Add request/response types** where your template keeps them.
4. **Add one wrapper function** to the client. It reuses the same `post()` helper, so it inherits
   credential injection, timeouts, retries, error mapping and logging for free:
   ```
   function newThing(input):
       return post("new-thing", requireEndpoint("newThing"), input)
   ```
5. **Add a callback route** if the service pushes notifications, following the shape in
   [08-callbacks.md](08-callbacks.md).
6. **Add an entry to `catalog/mspace-api.json`**, regenerate
   [14-curl-reference.md](14-curl-reference.md), and add a smoke test in `scripts/`.

Every mSpace API shares one envelope — `applicationId` + `password` in, `statusCode` +
`statusDetail` out. Any new service will too. Do not build a parallel client for it.
