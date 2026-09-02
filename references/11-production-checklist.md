# Production Checklist

Work through this before taking an application to full production. Each item has cost a service
provider something real.

## Credentials and configuration

- [ ] No `applicationId` or `password` anywhere in source, tests, fixtures, or git history
- [ ] `.env` is git-ignored; `.env.example` contains **only placeholders**
- [ ] Secrets stored in the host's secret manager, not in plaintext config
- [ ] The CaaS API key has been moved out of the email inbox it arrived in
- [ ] Separate credentials for development and production
- [ ] Startup validation fails loudly on any missing variable
- [ ] No `NEXT_PUBLIC_` / `VITE_` / `REACT_APP_` prefix on any mSpace variable
- [ ] Endpoint URLs read from config, not inlined
- [ ] Secret scanning enabled in CI
- [ ] Credential rotation procedure written down and tested at least once

## Network

- [ ] Production egress IP confirmed **on the production server**
- [ ] That IP added to *Allowed Host Address* on the application record
- [ ] Egress IP is static and will survive scaling, redeploys and restarts
- [ ] Callback URLs are HTTPS with a valid, complete certificate chain
- [ ] Callback URLs are stable — not a preview or tunnel URL
- [ ] Callback endpoints restricted to the platform's source IPs
- [ ] Callback endpoints exempt from CSRF and auth middleware, but IP-restricted
- [ ] Bot protection or a WAF does not challenge the callback paths
- [ ] TLS verification is **on**; any chain problem solved with an explicit CA bundle, not by
      disabling validation

## Correctness

- [ ] All responses branch on `statusCode`, never on the HTTP status alone
- [ ] `P1003` treated as **success** on CaaS OTP generation
- [ ] `S1001` treated as **success** on Subscriber List
- [ ] `statusDescription` (not `statusDetail`) read on the CaaS OTP verification response
- [ ] All six subscription statuses handled — `INITIAL`, `REG_PENDING`, `TRIAL`, `REGISTERED`,
      `UNREGISTERED`, `TEMPORARY_BLOCKED` — not just registered/unregistered
- [ ] All subscriber addresses normalised through one `tel:` helper
- [ ] `destinationAddresses` is always an array
- [ ] `version` sent on SMS Send and USSD Send, where it is mandatory
- [ ] `subscriberId` treated as opaque — masking-safe
- [ ] LBS `requesterId` and `subscriberId` are populated correctly and not swapped
- [ ] LBS `messageID` and `timestamp` read with their actual casing
- [ ] Per-recipient `destinationResponses` entries checked on multi-recipient sends
- [ ] Subscriber Charging Info requests never exceed 10 MSISDNs
- [ ] Subscriber List pages until `moreDataAvailable` is false, and stops on `nextPageNumber: -1`
- [ ] USSD `sessionId` echoed, never regenerated
- [ ] USSD sessions terminated with `mt-fin`
- [ ] USSD session store is shared across instances (not an in-process map) and has a TTL
- [ ] USSD screens are plain ASCII and under about 160 characters
- [ ] Explicit timeout on every outbound call
- [ ] Retries only on transport errors and transient codes, with backoff and a cap

## Callbacks

- [ ] All five configured URLs are implemented: MO SMS, delivery report, USSD, subscription
      notification, charging notification
- [ ] Every handler returns `{"statusCode":"S1000","statusDetail":"Success"}`
- [ ] Every handler acknowledges **before** doing real work
- [ ] Every handler is idempotent, with a dedupe key
- [ ] Every handler validates the payload schema
- [ ] Every handler verifies `applicationId` where the payload carries it
- [ ] Malformed payloads acknowledged and discarded, not 500'd
- [ ] Duplicate-delivery test exists and passes
- [ ] The subscription notification handler tolerates fields beyond the documented vocabulary, and
      logged its first real payload

## Charging (if using CaaS)

- [ ] `externalTrxId` unique and persisted **before** the OTP generation call
- [ ] Transaction row written before, and updated after each of the three exchanges
- [ ] `requestCorrelator` stored and passed as `referenceNo` to OTP verification
- [ ] `internalTrxId` stored for support
- [ ] Retries reuse the same `externalTrxId`; nothing generates a fresh one on retry
- [ ] `E1852` (attempts exhausted) and `E1405` (timed out) never retried automatically
- [ ] Timeouts resolved by reconciliation against the charging notification, never by re-charging
- [ ] `TotalAmount`, `paidAmount` and `balanceDue` all read before marking a charge complete
- [ ] Amounts use a decimal type
- [ ] Amount and currency sourced server-side, never from client input
- [ ] Currency is `LKR`
- [ ] Charged amount matches exactly what was disclosed before subscription
- [ ] Reconciliation job compares your ledger against charging notifications
- [ ] No code path calls an undocumented balance-query endpoint

## Consent and compliance

- [ ] Explicit opt-in captured before every Register
- [ ] Charge amount, currency and frequency disclosed before subscribing, for prepaid and
      postpaid
- [ ] Consent evidence stored: subscriber, timestamp, channel, wording shown
- [ ] Opt-out available in every channel the subscriber can reach
- [ ] `STOP` / `UNSUB` / `OFF` handled in MO SMS
- [ ] Opt-out stops queued and scheduled messages, not just new ones
- [ ] Opted-out subscribers are never re-subscribed without fresh consent
- [ ] `tel:all` broadcast behind a deliberate, separately-authorised path
- [ ] Broadcast volume sanity-checked against Query Base before sending

## Privacy

- [ ] Mobile Number Masking used where the real MSISDN is not needed
- [ ] `subscriberId` masked in all logs
- [ ] Message bodies not logged, or logged with a stated reason and retention period
- [ ] OTP, `referenceNo`, `requestCorrelator` and password never logged
- [ ] MSISDNs encrypted at rest if stored
- [ ] Retention policy defined and enforced
- [ ] Location data (if using LBS) minimised, short-retention, consent-recorded
- [ ] Bulk subscriber data from Charging Info and Subscriber List is not exported to analytics
      tools or spreadsheets
- [ ] Subscriber data deleted or anonymised on unsubscribe

## Operations

- [ ] `requestId` / `sessionId` / `externalTrxId` / `internalTrxId` / `statusCode` logged on every
      operation
- [ ] Alert on configuration-class errors (`E1303`, `E1313`, `E1309`, `E1104`) — the integration
      is down
- [ ] Dashboard for send volume, delivery rate, charge success rate, base size
- [ ] Query Base polled on a schedule into metrics, not per request
- [ ] Dead-letter queue for failed callback processing
- [ ] Throttling in place for `E1318` / `E1319` / `E1105`
- [ ] Runbook: what to do on `E1303`, on `E1313`, on a charging dispute
- [ ] Someone owns the mSpace account and can log in to rotate credentials

## Testing

- [ ] Handlers exercised against the local simulator from the developer bundle
- [ ] Every endpoint smoke-tested in Limited Production with whitelisted numbers
- [ ] Full end to end tested: register → receive SMS → USSD session → OTP-authorised charge →
      unregister
- [ ] The three-step charge tested including the OTP the subscriber has to read
- [ ] Opt-out path tested end to end
- [ ] Callback handlers tested with valid, malformed, wrong-application and duplicate payloads
- [ ] Failure paths tested: `E1313`, `E1303`, `E1308`, `E1850`, `E1852`, and a timeout
- [ ] Load tested to the transaction ceiling
- [ ] Tested from the production egress IP, not from a laptop

## Before going live

- [ ] Application description on the record accurately states what the application does
- [ ] Charging amounts are defensible
- [ ] Terms of service and privacy policy exist and are reachable by subscribers
- [ ] Support contact published to end users
- [ ] Limited Production testing completed with whitelisted numbers
- [ ] Content governance and advertisement settings match expectations
- [ ] Application start and expiry dates are what you intended

---

## Common failure signatures

| Symptom | Almost always |
|---|---|
| Everything returns `E1303` | Calling from an IP not in *Allowed Host Address* — a laptop, a CI runner, or a serverless function with rotating egress |
| Everything returns `E1313` | Wrong credentials, the wrong environment's credentials, or the application is not active |
| Everything returns `E1104` | The application is not in Active or Limited Production status |
| One API returns `E1309`, others work | That API was not provisioned |
| Test number gets nothing, no errors | Number not in *Whitelisted Numbers* while in Limited Production (`E1343`) |
| Every charge "fails" but subscribers get an OTP | The client rejects `P1003`. It is the success code for OTP generation. |
| Subscriber List "fails" on a new application | `S1001` treated as an error. It means no subscribers found. |
| The verification response has no message | Reading `statusDetail` on `/caas/otp/verify`, which returns `statusDescription` |
| `E1855` on every verification | Sending `externalTrxId` as `referenceNo` instead of `requestCorrelator` |
| USSD session dies mid-flow | Session store not shared across instances, no `mt-fin`, or a slow handler |
| Callbacks never arrive | URL not publicly reachable, wrong on the application record, WAF challenge, or auth middleware in front |
| `E1607` on the charging path | Your callback returned something the platform could not parse |
| Duplicate charges | Retrying with a fresh `externalTrxId` after a timeout |
| Works locally, fails deployed | Egress IP changed, or secrets not set in the host's environment |
