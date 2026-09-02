---
name: mspace-golive
description: Run the mSpace pre-production checklist before taking an application to full production — credentials, network, correctness, callbacks, charging, consent, privacy, operations and testing. Use before going live, or when asked whether an mSpace integration is production-ready.
---

# mSpace go-live check

```bash
node tools/mspace.mjs checklist          # the full list
node tools/mspace.mjs checklist --json   # machine-readable, for automation
```

Work through every item against the actual project. For each, state **PASS**, **FAIL** or
**CANNOT VERIFY**, with the evidence — a file path, a config value, a test run. Never mark PASS on
the assumption that something is probably fine; on this platform the cost of a wrong assumption is
charged to a real person's phone bill.

## The nine sections

1. **Credentials and configuration** — nothing in source or git history, secrets in the host's
   secret manager, the CaaS API key moved out of the email it arrived in, startup validation that
   fails loudly, separate development and production credentials, secret scanning in CI.
2. **Network** — production egress IP confirmed *on the production server* and listed under
   *Allowed Host Address*, callback URLs stable and publicly reachable over HTTPS with a complete
   chain, TLS verification on.
3. **Correctness** — branch on `statusCode`; `P1003` accepted as success on CaaS OTP generation and
   `S1001` on Subscriber List; `statusDescription` read on CaaS OTP verification; all six
   subscription statuses handled; `tel:` normalised in one helper with SMS `sourceAddress`
   excluded; `destinationAddresses` an array; `version` sent where mandatory; per-recipient
   `destinationResponses` checked; LBS `requesterId` and `subscriberId` not swapped; USSD
   `sessionId` echoed and flows terminated with `mt-fin`; explicit timeouts.
4. **Callbacks** — all five configured URLs implemented, acknowledging before doing work,
   idempotent with a dedupe key, schema-validated, tested with a duplicate payload, and the
   subscription notification handler tolerant of fields beyond the documented vocabulary.
5. **Charging** — modelled as three exchanges over a persisted ledger; `externalTrxId` persisted
   before the generation call and reused on retry; `requestCorrelator` and `internalTrxId` stored;
   `E1852` and `E1405` never retried automatically; timeouts settled from the charging
   notification; `TotalAmount`, `paidAmount` and `balanceDue` all read; decimal money in `LKR`; a
   reconciliation job.
6. **Consent and compliance** — opt-in recorded with evidence, the charge disclosed before
   subscribing for prepaid and postpaid, opt-out available in every channel and honoured
   immediately including queued messages, `tel:all` behind a deliberate path.
7. **Privacy** — Mobile Number Masking used where the real MSISDN is not needed, `subscriberId`
   masked in logs, message bodies not logged, bulk subscriber data from Charging Info and
   Subscriber List not exported to analytics tools, retention defined and enforced.
8. **Operations** — identifiers logged on every operation, alerting on configuration-class errors
   (`E1303`/`E1313`/`E1309`/`E1104`), a throttle for `E1318`/`E1319`/`E1105`, a dead-letter queue,
   a runbook, and a named owner who can log in to rotate credentials.
9. **Testing** — handlers exercised against the local simulator, end to end in Limited Production
   with whitelisted numbers, the three-step charge tested including the OTP the subscriber has to
   read, failure paths included (`E1313`, `E1303`, `E1308`, `E1850`, `E1852`, timeout), and tested
   **from the production egress IP**.

## Verdict

Finish with the FAIL items ordered by risk, and a plain statement: is this safe to put in front of
real subscribers who can be charged real money?

Full list: `references/11-production-checklist.md`.
