# Implementing in Any Stack

mSpace is JSON over HTTPS with a shared-secret credential pair. **Nothing about it requires a
particular language, framework or runtime.** Any stack that can make an HTTPS POST and serve an
HTTPS POST endpoint can run a complete, production-grade integration.

This document is the language-neutral specification. Build the seven components below in whatever
the host project already uses. The files in [templates/](../templates/) are the same seven
components written out in several languages — read the one closest to your stack, but treat *this*
page as the contract.

**The calls themselves are in [13-curl-reference.md](13-curl-reference.md)** — every endpoint as a
runnable curl, with every parameter defined, the response, and every response field explained,
plus all the callbacks. That page and this one are together a complete integration in a language
nobody here has written a template for: it gives you the wire, this gives you what surrounds it.

> Rule of thumb: **match the host project.** A Django codebase gets Python, a Spring service gets
> Java, a Laravel app gets PHP. Introducing a second runtime "because the sample was in
> TypeScript" is a worse outcome than any template mismatch.

---

## The seven components

Every correct integration, in every language, is these seven things. Nothing more is required and
nothing here is optional.

| # | Component | Responsibility |
|---|---|---|
| 1 | **Config module** | The only place that reads the environment. Validates at startup, fails loudly, exposes one URL per provisioned service. |
| 2 | **Address normaliser** | The only place `tel:` is added. One function, applied at the boundary. |
| 3 | **Transport helper** | One `post(service, url, body, successCodes)`: injects credentials, sets a timeout, parses JSON, branches on `statusCode`, raises a typed error. |
| 4 | **Status-code classifier** | Maps a code to one of six classes — success, pending, configuration, client, user-state, transient — plus the **per-service success set**. |
| 5 | **Service wrappers** | One thin function per API (`sendSms`, `register`, `startCharge`, …). No call site builds a payload itself. |
| 6 | **Callback endpoints** | Five HTTPS POST routes that acknowledge with `S1000` first and process out of band. |
| 7 | **State stores** | A USSD session store (shared, TTL about 2 minutes) and a charge ledger keyed by `externalTrxId`. Both must survive a restart and work across instances. |

If your port has all seven and passes the [acceptance checklist](#acceptance-checklist-for-a-port),
it is as correct as any other language's version.

---

## 1. Config

```
MSPACE_APP_ID          required — fail to start without it
MSPACE_PASSWORD        required — fail to start without it
MSPACE_<SERVICE>_URL   optional — absent means "not provisioned, refuse to call"
```

Requirements, in any language:

- One module owns environment access. Nothing else reads it — not a controller, not a job.
- Validation runs **at startup**, not at first use. A missing credential must stop the process
  from accepting traffic, not surface as `E1313` at 3am.
- Resolving an unset endpoint raises a local error naming the missing variable. That is the guard
  that turns "the API was never provisioned" into a clear boot-time message instead of `E1309`
  from the platform.
- A redacted `describeConfig()`-style dump is worth having: application id, `***redacted***` for
  the password, and the list of enabled services.

The variable names are fixed across every language — see
[templates/.env.example](../templates/.env.example). Keep them identical so a polyglot estate has
one deployment story.

## 2. Address normalisation

```
input                        output
tel:94702725777          →   tel:94702725777     (already prefixed — return unchanged)
tel:hu3b84346f…          →   tel:hu3b84346f…     (masked number — opaque, never parse)
+94 70 272 5777          →   tel:94702725777
0094702725777            →   tel:94702725777
070 272 5777             →   tel:94702725777     (local form → country code)
""                       →   error
```

One function. Never concatenate `tel:` at a call site. A separate `maskAddress()` for logging that
keeps the first three and last three characters and stars the middle.

One exception to remember: **`sourceAddress` on SMS Send is a sender alias or short code, not a
subscriber address** — it is the Default Sender Address or one of the Send Address Aliases, and it
does not take a `tel:` prefix. Do not push it through the normaliser.

## 3. The transport helper

The whole platform is one request shape, so it is one function:

```
function post(service, url, body, successCodes = ["S1000"]):
    payload = { applicationId: config.appId, password: config.password } merged with body
    response = HTTP POST url
                 header Content-Type: application/json;charset=utf-8
                 body   json(payload)
                 timeout 15 seconds            # never unbounded
    data = json(response.body)                 # non-JSON body is a transport error

    if data.statusCode in successCodes: return data
    raise MspaceError(data.statusCode, data.statusDetail ?? data.statusDescription, service, data)
```

Four things this pseudocode says that are easy to get wrong in a port:

- **The HTTP status is never consulted.** mSpace returns 200 for application-level failures. If
  your HTTP library raises on non-2xx that is fine, but success is decided by `statusCode` alone.
- **`successCodes` is a parameter, not a constant.** `S1000` is the default; CaaS OTP generation
  passes `["P1003"]`; Subscriber List passes `["S1000", "S1001"]`. Hard-coding `S1000` breaks
  charging.
- **The detail field is not always `statusDetail`.** CaaS OTP Verification returns
  `statusDescription`. Fall back rather than losing the message.
- **The timeout is a constant, not configuration.** It is a property of the protocol.
- **Credentials are injected here, once.** No wrapper accepts them as an argument, so no call site
  can pass the wrong ones or log them.

## 4. Status-code classification

The six classes and their members are in [08-status-codes.md](08-status-codes.md) and, as
machine-readable data, in [`catalog/mspace-api.json`](../catalog/mspace-api.json) under
`statusCodes` — generate the sets from the catalog rather than retyping them.

The error type your language uses (exception, error struct, result variant) needs three things:
the code, the detail, and a way to ask `retryable?` and `configuration?`.

Per-service success codes:

| Operation | Success code(s) | Means |
|---|---|---|
| Everything by default | `S1000` | Process completed successfully |
| CaaS OTP generation | `P1003` | The OTP was sent. **Nothing is charged yet.** |
| Subscriber List | `S1000`, `S1001` | `S1001` = the request worked and matched nobody |

## 5. Service wrappers

One function per API, each a single `post()` call. Three carry extra local guards regardless of
language:

- **Broadcast** (`tel:all`) lives in its own function with an explicit confirmation argument, so
  it can never be reached by an ordinary code path.
- **Charge generation** validates that `externalTrxId` is present, and never retries internally.
  A timeout does not mean the charge failed.
- **Charging Info** rejects more than 10 subscriber ids locally rather than letting the platform
  do it.

The charging flow deserves its own note: it is three exchanges, not one — generation, verification
and the notification. Model it as a small state machine over a persisted ledger row, not as one
function call. See [05-caas.md](05-caas.md).

## 6. Callback endpoints

Five routes, one contract: respond HTTP 200 with
`{"statusCode":"S1000","statusDetail":"Success"}`, immediately, before doing any work. Full rules
in [07-callbacks.md](07-callbacks.md).

"Process out of band" means different things per stack, and picking the wrong one is the most
common porting mistake:

| Stack | Acknowledge-first mechanism |
|---|---|
| Node / TypeScript | Push to a queue, return the response; never `await` the work |
| Python (FastAPI/Django) | `BackgroundTasks`, Celery, RQ, or a thread pool — **not** a bare `await` |
| Java (Spring) | `@Async` method, or hand off to an `ExecutorService` or message broker |
| Go | Send to a buffered channel consumed by a worker goroutine (bounded, not a bare `go func`) |
| PHP | Queue the payload (Laravel queues, a Redis list, a database table) — PHP-FPM has no "after response" worker of its own |
| .NET | `IHostedService` + `Channel<T>`, or a background queue |
| Serverless | Write to SQS/PubSub and return; do not do the work in the request lifetime |

The USSD timeout is measured in seconds. Anything that does a database write chain or an outbound
HTTP call before responding will lose sessions in production.

## 7. State stores

| Store | Key | TTL | Must survive |
|---|---|---|---|
| USSD session | `sessionId` | about 2 minutes | Restart, deploy, and routing to another instance |
| Charge ledger | `externalTrxId` | Until reconciled | Everything — this one prevents double-charging |
| Callback dedupe | the documented key per callback | Hours | Redelivery |

An in-process map or dictionary is a development convenience in **every** language. Redis,
Memcached with persistence, or a database table are the production answers. The failure mode is
identical whether the map is a JS `Map`, a Python `dict`, a Go `map`, or a static `HashMap` — the
second instance cannot see it and the subscriber's menu dies mid-flow.

The charge ledger holds more than an id: `externalTrxId`, state, `requestCorrelator`,
`internalTrxId`, amount, currency, and the consent reference. `requestCorrelator` is what step 3
of the charge needs, and it exists only in the step 1 response.

---

## Per-language notes

The parts that genuinely differ between stacks, and the answer for each.

| Concern | Node / TS | Python | Java | Go | PHP | .NET |
|---|---|---|---|---|---|---|
| HTTP client | `https` / `fetch` / undici | `urllib.request`, `httpx`, `requests` | `java.net.http.HttpClient` | `net/http` | cURL extension, Guzzle | `HttpClient` (via `IHttpClientFactory`) |
| JSON | built in | `json` | Jackson / Gson | `encoding/json` | `json_encode` / `json_decode` | `System.Text.Json` |
| Env loading | `process.env` (+ dotenv in dev) | `os.environ` (+ python-dotenv) | `System.getenv` / Spring `@Value` | `os.Getenv` | `getenv` / `$_ENV` | `IConfiguration` + `IOptions<T>` |
| Startup validation | throw at module load | raise in a module-level factory | fail fast in a `@PostConstruct` or bean init | `panic` in `init()`/`LoadConfig` | throw in the container binding | `ValidateOnStart()` |
| Money | **not** `number` — decimal string or a decimal library | `decimal.Decimal` | `BigDecimal` | `shopspring/decimal` or minor-unit ints | `bcmath` / string | `decimal` |
| Schema validation of callbacks | zod / valibot | pydantic | Bean Validation / Jackson strict binding | struct tags + explicit checks | manual guards or a validator | data annotations / `System.Text.Json` strict |
| TLS chain fix | `https.Agent({ ca })` | `ssl.create_default_context(cafile=…)` | `KeyStore` / `SSLContext`, or `keytool -importcert` | `x509.CertPool` + `tls.Config.RootCAs` | `CURLOPT_CAINFO` | `SocketsHttpHandler` + custom root store |
| Never do this | `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0` | `verify=False` | trust-all `TrustManager` | `InsecureSkipVerify: true` | `CURLOPT_SSL_VERIFYPEER=0` | callback returning `true` unconditionally |

**Client-side prefixes to never use on an mSpace variable**, since every framework has one:
`NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`, `PUBLIC_` (SvelteKit), `EXPO_PUBLIC_`, `NG_` build-time
replacements, `@Value` injected into a browser-served config endpoint. They all publish the
password to the browser.

### Runtimes that need a decision before you build

- **Serverless functions** (Lambda, Cloud Run, Vercel, Azure Functions) have rotating egress IPs,
  and mSpace enforces the *Allowed Host Address* list (`E1303`). Route through a NAT gateway with
  a fixed IP, a static-IP proxy, or a small always-on service. This is a hosting decision, not a
  code one, and retrofitting it is painful.
- **Edge runtimes** (Cloudflare Workers, Deno Deploy, Vercel Edge) additionally give you no
  control over egress IP at all. Do not put mSpace calls there.
- **Mobile and desktop clients** never call mSpace directly, in any language. They call your
  backend.
- **Short-lived CLI or cron processes** are fine, provided they run on a whitelisted host and read
  credentials from the environment rather than a config file in the repo.

---

## Acceptance checklist for a port

A port in a language with no template is done when all of these hold. Check them against the code,
not against intent.

1. Exactly one module reads the environment, and the process refuses to start with
   `MSPACE_APP_ID` or `MSPACE_PASSWORD` missing.
2. Calling a service whose URL variable is unset raises a local error naming the variable — no
   request leaves the process.
3. Exactly one function produces a `tel:` address; a grep for `"tel:"` finds it and nothing else.
4. Success is decided by `statusCode`, never by the HTTP status.
5. The success set is per service: `P1003` on CaaS OTP generation and `S1001` on Subscriber List
   both return successfully.
6. The response reader falls back to `statusDescription` when `statusDetail` is absent.
7. Every outbound call has an explicit timeout.
8. Retries cover transport errors and transient codes only, with backoff — and the charging path
   has no automatic retry at all.
9. `externalTrxId` is generated and persisted **before** the OTP generation call, and reused
   unchanged on any resolution attempt; `requestCorrelator` and `internalTrxId` are persisted from
   the response.
10. All five callback routes return `{"statusCode":"S1000","statusDetail":"Success"}` with HTTP
    200 for valid, malformed, wrong-application and duplicate payloads alike.
11. Callback work happens after the response, through the stack's real background mechanism.
12. The USSD session store is shared across instances and expires entries.
13. Logs contain `requestId` / `sessionId` / `externalTrxId` / `internalTrxId` / `statusCode`, and
    never a password, an OTP, a `referenceNo`, a `requestCorrelator`, or an unmasked subscriber
    address.
14. TLS verification is on, with the intermediate CA supplied if the handshake needs it.

Verify 1–9 by reading the code; verify 10–12 with
[scripts/test-callbacks.sh](../scripts/test-callbacks.sh), which is plain curl and works against a
handler in any language. Verify the whole outbound path with
[scripts/smoke-test.sh](../scripts/smoke-test.sh) (or `smoke-test.ps1`), or against the local
simulator from the mSpace developer bundle.

---

## Shipped templates

| Directory | Contents | Notes |
|---|---|---|
| [templates/typescript/](../templates/typescript/) | config, client, types, Next.js callback routes, USSD session store + menu tree | The most complete set; read it for the full commentary |
| [templates/python/](../templates/python/) | config, client, FastAPI callback routes, USSD session store | Standard library only; `httpx`/`requests` notes inline |
| [templates/java/](../templates/java/) | config, client, Spring callback controller | Java 17 `HttpClient`, Jackson |
| [templates/go/](../templates/go/) | config, client, callback handlers | Standard library only |
| [templates/php/](../templates/php/) | config, client, callback front controller | cURL extension; Laravel notes inline |
| [templates/csharp/](../templates/csharp/) | options, typed client, ASP.NET Core callback endpoints | `IHttpClientFactory`, `System.Text.Json` |

No template for your stack — Ruby, Rust, Kotlin, Elixir, Scala, Dart on a server? Take the calls
from [13-curl-reference.md](13-curl-reference.md), implement the seven components above around
them, use the closest template for the shape, and run the acceptance checklist. The contract also
ships as [`catalog/mspace-api.json`](../catalog/mspace-api.json), plain JSON that every language
can read directly.

---

## Tooling versus stack

`tools/mspace.mjs` runs on Node. That is a property of the *documentation tool*, not of your
integration — it makes no network calls and never sees a credential. If Node is not available on
your machine, nothing is lost: [13-curl-reference.md](13-curl-reference.md) is the same contract
as prose, and the underlying data is in
[`catalog/mspace-api.json`](../catalog/mspace-api.json):

```bash
jq '.services[] | select(.id=="caas-otp-generation")' catalog/mspace-api.json
python -c "import json;print(json.load(open('catalog/mspace-api.json'))['statusCodes']['E1303'])"
```

Same contract, no runtime required.
