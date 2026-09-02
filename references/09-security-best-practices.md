# Security and Best Practices

An mSpace `applicationId` + `password` pair can send SMS to your entire subscriber base and debit
real money from real people's mobile accounts. It deserves the handling you would give a
production payment key, because that is what it is. For CaaS the documentation says as much
plainly: the password is *"the API key sent to your registered email address on the platform upon
application approval"*.

---

## 1. Credentials

### Never hardcode. Ever.

```
# ❌ Never — in source, in a test fixture, in application.yml / appsettings.json / settings.py
APP_ID   = "APP_001807"
PASSWORD = "<a real password>"

# ❌ Never — a "default" is a hardcoded credential with extra steps
password = env("MSPACE_PASSWORD") or "<a real password>"

# ❌ Never — client-side, whatever the framework calls it
APP_ID = env("NEXT_PUBLIC_MSPACE_APP_ID")     # or VITE_ / REACT_APP_ / PUBLIC_ / EXPO_PUBLIC_

# ✅ Environment variable, validated at startup, server-side only
password = require_env("MSPACE_PASSWORD")
```

### The rules

| Rule | Why |
|---|---|
| Credentials come from environment variables only | The only mechanism every host supports without putting secrets in the repo |
| `.env` is in `.gitignore`; `.env.example` holds **placeholder** values only | The example file is committed; it must never contain a real value |
| Validate at startup and **crash loudly** if missing | A silent `undefined` becomes an `E1313` at 3am instead of a clear boot error |
| One config module; nothing else reads the environment | One place to audit, one place to change |
| Never a browser-exposed prefix — `NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`, `PUBLIC_`, `EXPO_PUBLIC_` — and never served through a client-facing config endpoint | Those are compiled into the browser bundle, or fetched by it, and are world-readable |
| Never in logs, error messages, stack traces, or crash reports | Redact by key name, not by value matching |
| Never in a URL or query string | Proxies, browser history and access logs capture URLs |
| Never in a Docker `ENV` line or a committed compose file | Image layers are readable by anyone who pulls the image |
| Separate credentials per environment | A leaked development key must not touch production subscribers |
| Rotate through the platform after any suspected exposure | Rotation is only useful if you can do it fast |

Note that the CaaS API key arrives **by email**. An inbox is not a secret store: move it into your
secret manager and delete the mail.

### Where secrets actually live, per host

| Environment | Mechanism |
|---|---|
| Local development | `.env`, git-ignored (dotenv, python-dotenv, godotenv, `spring.config.import`, `DotNetEnv` — same file, different loader) |
| Docker / Compose | `env_file:` or Docker secrets — **not** `ENV` in the Dockerfile |
| Kubernetes | `Secret` mounted as env, ideally via External Secrets or Sealed Secrets |
| Vercel / Netlify / Railway / Render | Project environment variables, marked secret, **server-side scope** |
| AWS | Secrets Manager or SSM Parameter Store (SecureString), injected at runtime |
| GCP | Secret Manager |
| Azure | Key Vault |
| CI (GitHub Actions etc.) | Repository or environment secrets — never in workflow YAML |

### If a credential leaks

Assume it is compromised the moment it lands anywhere shared — a commit, a chat message, a
screenshot, a log aggregator, a pasted stack trace, an AI prompt.

1. Rotate the password on the platform **first**.
2. Deploy the new value.
3. Review your application's reports for unexpected SMS volume or charges.
4. Purge from git history (`git filter-repo`) — and understand that anything pushed to a public
   remote must be treated as permanently public regardless.
5. Tell mSpace if you see unauthorised usage.

### Startup validation

```
function require_env(name):
    value = env(name)
    if value is empty:
        fail("Missing required environment variable " + name +
             ". Copy .env.example to .env and fill in your mSpace credentials.")
    return trim(value)
```

Fail at boot, not at first use. A misconfigured deployment should refuse to start rather than
accept traffic it cannot serve. Where the framework has a mechanism for this, use it:
`ValidateOnStart()` in .NET, `@Validated` `@ConfigurationProperties` in Spring, a module-level
factory in Python, `LoadConfig` before `ListenAndServe` in Go, a container binding in PHP.

---

## 2. Network position

**All mSpace calls originate from your backend.** There is no supported client-side flow.

```
Browser / Mobile app  ──►  Your API  ──►  mSpace
        (your auth)          (static IP, credentials)
```

Consequences to design for:

- **A static egress IP is a hard requirement.** The *Allowed Host Address* list is enforced, and
  a request from anywhere else fails with `E1303`. Determine the egress IP **from the server that
  will make the calls**, not from a laptop.
- **Serverless needs planning.** Lambda, Cloud Run and Vercel functions have rotating egress IPs
  by default. Route through a NAT gateway with a fixed IP, a static-IP proxy, or a small
  always-on service. Decide before choosing the host — retrofitting is painful.
- **Whitelist the minimum.** Do not add a broad range "temporarily".
- **Restrict inbound too.** Your callback URLs should accept traffic only from the platform's
  egress addresses. mSpace signs nothing, so source IP is the strongest control available. See
  [07-callbacks.md](07-callbacks.md).

---

## 3. TLS verification

If a host in the chain serves an incomplete certificate chain — the leaf but not the intermediate
— browsers paper over it by fetching the missing certificate and strict clients do not, so the
handshake fails. Node, Python, Java, Go, PHP/cURL and .NET are all strict clients.

The workaround you will find in sample code is to turn verification off. Every stack spells it
differently and every spelling is the same mistake:

| Stack | ❌ Do not ship this |
|---|---|
| Node | `new https.Agent({ rejectUnauthorized: false })`, `NODE_TLS_REJECT_UNAUTHORIZED=0` |
| Python | `verify=False`, `ssl._create_unverified_context()` |
| Java | a `TrustManager` whose `checkServerTrusted` does nothing |
| Go | `tls.Config{ InsecureSkipVerify: true }` |
| PHP | `CURLOPT_SSL_VERIFYPEER => false` |
| .NET | `ServerCertificateCustomValidationCallback` returning `true` |

Each of them disables **all** certificate validation on that connection. Anyone able to intercept
the route can present their own certificate and read your `applicationId` and `password` in
plaintext — the exact credentials that can charge your subscribers. It converts a cosmetic chain
problem into a total compromise of the integration.

**Acceptable options, in order of preference:**

1. **Supply the missing intermediate CA explicitly.** Fetch the intermediate certificate, commit
   it as a `.pem` (it is public — it is not a secret), and point the HTTP client at it. Validation
   stays fully on:

   | Stack | ✅ How |
   |---|---|
   | Node | `new https.Agent({ ca: fs.readFileSync("certs/mspace-chain.pem") })` |
   | Python | `ssl.create_default_context(cafile="certs/mspace-chain.pem")` |
   | Java | import into a truststore (`keytool -importcert`) and build an `SSLContext` from it |
   | Go | `x509.NewCertPool()` + `AppendCertsFromPEM` → `tls.Config{RootCAs: pool}` |
   | PHP | `CURLOPT_CAINFO => 'certs/mspace-chain.pem'` |
   | .NET | `SocketsHttpHandler` with custom `SslClientAuthenticationOptions` |

2. **Update the system trust store** on the host or in the container image, and let the default
   client work. This fixes every language at once and is often the cleanest answer.
3. **Report it.** An incomplete chain is a server misconfiguration.
4. **If you must disable verification to unblock local development**, keep it a source-level
   constant that is obvious in code review and impossible to switch on by deployment
   configuration — never an environment variable or a config-file key, which are exactly the
   things that get copied into production by accident:
   ```
   # Development only. Never commit this as true.
   ALLOW_INSECURE_TLS = false
   ```

Never disable verification process-wide — `NODE_TLS_REJECT_UNAUTHORIZED=0`, `PYTHONHTTPSVERIFY=0`,
or a trust-all factory installed through `HttpsURLConnection.setDefaultSSLSocketFactory`. Those
strip TLS validation from every unrelated dependency in the process, not just from the mSpace
call.

---

## 4. Subscriber data

Mobile numbers are personal data. Location data is more sensitive still.

- **Mobile Number Masking is a provisioning setting**, and its advanced-page value is `yes`. When
  it is on, the platform gives you a masked number rather than the MSISDN — and you cannot leak
  what you never held.
- **Treat `subscriberId` as an opaque string.** Do not parse it, do not strip `tel:` for storage,
  do not assume a length. The OTP Verify documentation is explicit that the masked value it
  returns is what the application has to use for any subsequent request.
- **Mask in logs.** `tel:94702725777` → `tel:947*****777`. Apply it in the logger, not at each
  call site, so it cannot be forgotten.
- **Never log message bodies** containing user content without a stated reason and a retention
  period. MO SMS is private communication.
- **Never log the OTP, the `referenceNo`, the `requestCorrelator`, or the password.**
- **Encrypt at rest** if you store MSISDNs, and put an actual retention policy on them.
- **Delete on unsubscribe**, or anonymise, unless you have a documented legal reason to keep the
  record.
- **Do not export subscriber lists** to analytics tools, spreadsheets, or LLM prompts. Subscriber
  Charging Info and Subscriber List both return them in bulk, which makes this easy to do by
  accident.

---

## 5. Consent

- **Explicit opt-in before Register.** A pre-ticked checkbox is not consent. An imported list is
  not consent.
- **Disclose the charge before subscribing** — amount, currency and frequency, which provisioning
  sets separately for the prepaid and postpaid customer bases, plus what the subscriber gets.
- **Record the evidence**: subscriber identifier, timestamp, channel (USSD `sessionId`, OTP
  `referenceNo`, web session), and the exact wording shown.
- **Honour opt-out immediately and everywhere.** Support `STOP` / `UNSUB` / `OFF` over MO SMS, a
  USSD menu option, and an in-app control. Call Unregister and stop sending — including stopping
  any queued messages already scheduled.
- **Never re-subscribe a subscriber who opted out** without a fresh, separate opt-in.
- **Never charge outside what the subscriber agreed to.** Amount and currency come from
  server-side configuration or a server-side price lookup, never from client input.
- **The CaaS OTP is itself a consent step.** The subscriber authorises the one-time charge by
  entering it. Do not build a flow that captures the OTP for one purpose and spends it on another.

---

## 6. Application robustness

| Concern | Practice |
|---|---|
| **Timeouts** | Set an explicit timeout (10–15s) on every call. No default-infinite requests. |
| **Retries** | Only for transport errors and transient codes. Exponential backoff with jitter, capped attempts, then dead-letter. Never retry a charge with a new `externalTrxId`. |
| **Idempotency** | Callbacks in, charges out. Both need dedupe keys. |
| **Rate limiting** | `E1318` (per second), `E1319` (per day) and `E1105` (TPS on Subscriber List) mean the platform rejected the request rather than queueing it. Queue and throttle on your side. |
| **Circuit breaking** | Stop hammering the platform when it is failing; fail fast and recover. |
| **Observability** | Log `requestId`, `sessionId`, `externalTrxId`, `internalTrxId`, `statusCode` on every operation. These are what a support trace is built from. |
| **Alerting** | Page on configuration-class errors (`E1303`, `E1313`, `E1309`, `E1104`) — they mean the integration is fully down. |
| **Broadcast guard** | `tel:all` requires a deliberate, separately-authorised code path. Never reachable by accident. |
| **Money** | Decimal types, never binary floats. |
| **Config** | Endpoint URLs in config, not scattered through code. |
| **Secrets in AI tooling** | Never paste a real `password` into a prompt, an issue, or a shared notebook. Use the placeholder from `.env.example`. |

---

## 7. Pre-commit hygiene

```gitignore
.env
.env.*
!.env.example
*.pem
*.key
```

Add a secret scanner to CI — `gitleaks`, `trufflehog`, or GitHub push protection. An `APP_\d{6}`
pattern next to a long alphanumeric string is trivially detectable, and finding it before the push
is far cheaper than rotating after.

Review generated code specifically for hardcoded credentials before committing. Assistants
reproduce sample values from documentation, and the documented sample passwords look exactly like
real ones — because they are shaped exactly like real ones.
