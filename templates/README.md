# Templates

Working reference implementations of an mSpace integration. **They are a specification, not a
framework to impose.** Read the one closest to the host project, port the structure, and keep
that project's own conventions.

mSpace is JSON over HTTPS: no language, framework or runtime is privileged. Pick by what the
project already uses — introducing a second runtime because a sample was in another language is a
worse outcome than any template mismatch.

| Stack | Files | Notes |
|---|---|---|
| **Any** | [.env.example](.env.example) | The environment surface, identical everywhere: two credentials plus one URL per provisioned service |
| **TypeScript / Node** | [typescript/](typescript/) — `mspace-config.ts`, `mspace-client.ts`, `mspace-types.ts`, `callbacks-nextjs.ts`, `ussd-session.ts` | The most complete set, with the fullest commentary. Callback routes are Next.js App Router; the logic ports to Express, Fastify, Hono or NestJS unchanged |
| **Python** | [python/](python/) — `mspace_config.py`, `mspace_client.py`, `callbacks_fastapi.py`, `ussd_session.py` | Standard library only; `httpx`/`requests` swap noted inline. Callbacks are FastAPI; Django and Flask notes at the foot of the file |
| **Java** | [java/](java/) — `MspaceConfig.java`, `MspaceClient.java`, `MspaceCallbackController.java` | Java 17 `HttpClient` + Jackson. Callbacks are Spring Boot with `@Async` |
| **Go** | [go/](go/) — `config.go`, `client.go`, `callbacks.go` | Standard library only. Handlers are `http.HandlerFunc`, so they mount on chi/gin/echo unchanged |
| **PHP** | [php/](php/) — `MspaceConfig.php`, `MspaceClient.php`, `callbacks.php` | cURL extension, no Composer dependency. Framework-neutral callbacks with Laravel notes inline |
| **C# / .NET** | [csharp/](csharp/) — `MspaceOptions.cs`, `MspaceClient.cs`, `MspaceCallbacks.cs` | `IHttpClientFactory` + `System.Text.Json`. Callbacks are minimal APIs with a `BackgroundService` worker |

Every port implements the same seven components and the same environment variable names. The
language-neutral specification — including an acceptance checklist for stacks with no template
here (Ruby, Rust, Kotlin, Elixir, …) — is
[references/12-any-stack.md](../references/12-any-stack.md).

**No template for your stack?** Nothing is missing. Take the calls from
[references/14-curl-reference.md](../references/14-curl-reference.md) — every endpoint as a
runnable curl, with every parameter and response field defined — and build the seven components
around them. Every template on this page is that same contract, already ported.

## What every template does the same way

- **One config module** reads the environment, validates at startup, and refuses to resolve an
  endpoint that was never provisioned.
- **One `post()` helper** injects `applicationId` + `password`, sets a 15-second timeout, and
  decides success on `statusCode` — never on the HTTP status.
- **Success is per service, not global**: `S1000` by default, `P1003` on CaaS OTP generation,
  and `S1001` also accepted on Subscriber List.
- **The detail field is read from `statusDetail` or `statusDescription`**, because CaaS OTP
  verification uses the second one.
- **One `tel:` normaliser** and one `maskAddress()` for logs — with SMS `sourceAddress`
  deliberately excluded, since that is a sender alias rather than a subscriber address.
- **Charging is three exchanges**, not one: `startCharge()` sends the OTP and returns `P1003`
  with a `requestCorrelator`, `confirmCharge()` moves the money, and the charging notification
  settles it. Nothing retries automatically.
- **Broadcast (`tel:all`) is a separate function** guarded by an explicit confirmation token.
- **Local limits are enforced before the wire**: 10 subscriber ids on Charging Info, a
  `requestPage` of 1 or greater on Subscriber List.
- **Callbacks acknowledge `S1000` first**, deduplicate, and process out of band.

## What each template deliberately leaves to you

The persistence layers, because they belong to your architecture rather than to mSpace:

| Store | Shipped as | Production answer |
|---|---|---|
| USSD sessions | in-process, TTL 2 min | Redis or equivalent, shared across instances |
| Callback dedupe | in-process set/map | Redis `SETNX` + TTL, or a unique database constraint |
| Charge ledger (`externalTrxId`, `requestCorrelator`, `internalTrxId`, state) | not shipped | Your database, written **before** the OTP generation call |

## Testing a port

Both scripts are plain curl and work against any language:

```bash
./scripts/test-callbacks.sh http://localhost:3000   # valid, malformed, wrong-app, duplicate
./scripts/smoke-test.sh                             # every outbound endpoint
```

The mSpace developer bundle also ships a local simulator (`http://localhost:10001/`), which
exercises the whole integration without a provisioned application — see
[references/01-getting-started.md](../references/01-getting-started.md#testing-before-provisioning).

Then walk the acceptance checklist in
[references/12-any-stack.md](../references/12-any-stack.md#acceptance-checklist-for-a-port).
