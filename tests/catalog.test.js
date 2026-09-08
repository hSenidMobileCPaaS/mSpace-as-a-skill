import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  allEntries,
  buildPayload,
  catalog,
  coerceValue,
  coerceValues,
  diagnose,
  findEntry,
  lookupStatusCode,
  readResponse,
  repoRoot,
  search,
  successCodesFor,
  toCurl,
  urlFor,
  validatePayload,
} from "../tools/catalog.mjs";

/* ── Catalog integrity ───────────────────────────────────────────────────── */

test("the catalog describes mSpace on Mobitel, in Sri Lanka", () => {
  assert.equal(catalog.platform.name, "mSpace");
  assert.equal(catalog.platform.operator, "Mobitel");
  assert.equal(catalog.platform.market, "Sri Lanka");
  assert.deepEqual(catalog.operators.map((o) => o.name), ["Mobitel"]);
  assert.equal(catalog.baseUrls.primary, "https://api.mspace.lk");
});

/**
 * mSpace has two tracks and only one of them is an API. An agent that does not
 * know Xpand exists will build an integration where a template would do.
 */
test("both platform tracks are described", () => {
  const tracks = catalog.platform.tracks.map((t) => t.name);
  assert.deepEqual(tracks.sort(), ["Inzpire", "Xpand"]);
  for (const track of catalog.platform.tracks) {
    assert.ok(track.url?.startsWith("https://mspace.lk"), `${track.name} has no mSpace URL`);
    assert.ok(track.summary?.length > 40, `${track.name} summary is too short`);
  }
});

test("every service has a unique id, path, parameters and a sample", () => {
  const ids = new Set();
  for (const s of catalog.services) {
    assert.ok(s.id, "service missing id");
    assert.ok(!ids.has(s.id), `duplicate service id ${s.id}`);
    ids.add(s.id);
    assert.ok(s.path, `${s.id} missing path`);
    assert.equal(s.method, "POST", `${s.id} should be POST`);
    assert.ok(s.parameters?.length, `${s.id} has no parameters`);
    assert.ok(s.sampleRequest, `${s.id} has no sampleRequest`);
    assert.ok(s.sampleResponse, `${s.id} has no sampleResponse`);
    assert.ok(s.summary, `${s.id} has no summary`);
    assert.ok(s.envVar?.startsWith("MSPACE_"), `${s.id} has no MSPACE_ endpoint variable`);
  }
});

test("every outbound service requires applicationId and password", () => {
  for (const s of catalog.services) {
    const names = s.parameters.map((p) => p.name);
    assert.ok(names.includes("applicationId"), `${s.id} missing applicationId`);
    assert.ok(names.includes("password"), `${s.id} missing password`);
    for (const field of ["applicationId", "password"]) {
      const p = s.parameters.find((x) => x.name === field);
      assert.equal(p.required, true, `${s.id}.${field} should be required`);
    }
  }
});

/**
 * Provisioning defines five callback URLs across four configuration sections,
 * and every other surface in this repo says so. The catalog carried four, so
 * the subscription notification — the only place you learn a subscriber left —
 * was absent from the CLI and from the curl reference that the callbacks skill
 * promises documents all of them.
 */
test("all five provisioned callback URLs are in the catalog", () => {
  assert.deepEqual(
    catalog.callbacks.map((c) => c.id),
    [
      "sms-mo",
      "sms-dlr",
      "ussd-receive",
      "subscription-notification",
      "charging-notification",
    ]
  );

  const configuredIn = catalog.callbacks.map((c) => c.configuredIn);
  for (const section of ["SMS", "USSD", "CaaS", "Subscription"]) {
    assert.ok(
      configuredIn.some((c) => c.startsWith(section)),
      `no callback is configured under ${section}`
    );
  }
});

/**
 * mSpace publishes no payload for the subscription notification URL. Recording
 * that alongside the fields is what stops a handler from being written as if
 * the shape were guaranteed.
 */
test("the subscription notification is marked as having no published payload", () => {
  const cb = findEntry("subscription-notification");
  assert.equal(cb.direction, "inbound");
  assert.equal(cb.payloadPublished, false);
  assert.match(cb.payloadNote, /do not invent fields/i);
  assert.equal(cb.dedupeKey, "subscriberId + status + timeStamp");

  // Only what a handler genuinely needs is promised to be present.
  const required = cb.fields.filter((f) => f.required).map((f) => f.name);
  assert.deepEqual(required.sort(), ["status", "subscriberId"]);

  // It is not the outbound notify service, and the rules have to say so.
  assert.ok(cb.rules.some((r) => r.includes("/subscription/notify")));
  assert.ok(cb.rules.some((r) => r.includes("getSubscriberList")));
});

test("every callback declares a dedupe key and a route", () => {
  assert.ok(catalog.callbacks.length >= 4, "expected at least four published callbacks");
  for (const cb of catalog.callbacks) {
    assert.ok(cb.dedupeKey, `${cb.id} missing dedupeKey — callbacks must be idempotent`);
    assert.ok(cb.suggestedPath?.startsWith("/"), `${cb.id} suggestedPath must be a route`);
    assert.ok(cb.configuredIn, `${cb.id} does not say where its URL is configured`);
  }
});

/**
 * Every callback must be implementable from the catalog alone: fields, a sample
 * payload, and a dedupe key. A handler cannot be generated from a shrug.
 */
test("every callback carries fields and a sample payload", () => {
  for (const cb of catalog.callbacks) {
    assert.ok(cb.fields?.length, `${cb.id} has no fields`);
    assert.ok(cb.samplePayload, `${cb.id} has no samplePayload`);
    for (const field of cb.fields) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(cb.samplePayload, field.name) || !field.required,
        `${cb.id}.${field.name} is required but missing from samplePayload`
      );
    }
  }
});

test("every status code referenced by a service exists in the code table", () => {
  for (const e of allEntries()) {
    for (const code of e.statusCodes || []) {
      assert.ok(catalog.statusCodes[code], `${e.id} references unknown status code ${code}`);
    }
  }
});

test("every status code has a known handling class", () => {
  const classes = new Set(Object.keys(catalog.statusCodeClasses));
  for (const [code, meta] of Object.entries(catalog.statusCodes)) {
    assert.ok(classes.has(meta.class), `${code} has unknown class "${meta.class}"`);
    assert.ok(meta.description, `${code} has no description`);
  }
});

test("every parameter is fully specified", () => {
  for (const e of allEntries()) {
    for (const p of e.parameters || e.fields || []) {
      assert.ok(p.name, `${e.id} has an unnamed parameter`);
      assert.ok(p.type, `${e.id}.${p.name} has no type`);
      assert.equal(typeof p.required, "boolean", `${e.id}.${p.name} has no required flag`);
      assert.ok(p.description, `${e.id}.${p.name} has no description`);
    }
  }
});

test("every reference path in the catalog points at a real file", () => {
  const refs = new Set();
  for (const e of allEntries()) if (e.reference) refs.add(e.reference);
  for (const p of catalog.practices) refs.add(p.reference);
  for (const ref of refs) {
    assert.ok(existsSync(join(repoRoot, ref)), `missing referenced file: ${ref}`);
  }
});

/* ── The three envelope irregularities ───────────────────────────────────── */

/**
 * These three are the load-bearing facts of this platform. A client that folds
 * success back into a single global S1000 constant breaks charging, and a
 * response reader that only knows statusDetail loses the message on the one
 * call that took someone's money.
 */
test("P1003 is the documented success of CaaS OTP generation, not an error", () => {
  const code = lookupStatusCode("P1003");
  assert.equal(code.class, "pending");
  assert.deepEqual(code.benignFor, ["caas-otp-generation"]);
  assert.equal(code.retry, false);

  const service = findEntry("caas-otp-generation");
  assert.ok(service.statusCodes.includes("P1003"));
  assert.ok(!service.statusCodes.includes("S1000"), "S1000 is not this endpoint's success code");
  assert.equal(service.sampleResponse.statusCode, "P1003");
});

test("S1001 is a success on Subscriber List", () => {
  const code = lookupStatusCode("S1001");
  assert.equal(code.class, "success");
  assert.deepEqual(code.benignFor, ["subscription-list"]);
  const service = findEntry("subscription-list");
  assert.ok(service.statusCodes.includes("S1001"));
});

test("CaaS OTP verification is documented as returning statusDescription", () => {
  const service = findEntry("caas-otp-verify");
  const fields = service.responseFields.map((f) => f.name);
  assert.ok(fields.includes("statusDescription"), "the response field is statusDescription");
  assert.ok(!fields.includes("statusDetail"), "this endpoint does not return statusDetail");
  assert.ok(fields.includes("status"), "the boolean status field is missing");
});

/**
 * A charge is three exchanges. The catalog has to make that unmistakable, or an
 * agent models it as one call and never takes the money.
 */
test("the charging flow is modelled as generation, verification and notification", () => {
  const generate = findEntry("caas-otp-generation");
  const verify = findEntry("caas-otp-verify");
  const notify = findEntry("charging-notification");

  assert.equal(generate.movesMoney, true);
  assert.equal(generate.idempotencyKey, "externalTrxId");
  assert.equal(verify.movesMoney, true);
  assert.equal(notify.direction, "inbound");
  assert.equal(notify.dedupeKey, "externalTrxId + statusCode");

  const correlator = generate.responseFields.find((f) => f.name === "requestCorrelator");
  assert.ok(correlator, "OTP generation must return requestCorrelator");
  assert.match(correlator.description, /referenceNo/i);

  const referenceNo = verify.parameters.find((p) => p.name === "referenceNo");
  assert.match(referenceNo.description, /requestCorrelator/i);
});

test("E1303 and E1313 are configuration-class and never retryable", () => {
  for (const code of ["E1303", "E1313", "E1309", "E1104"]) {
    const info = lookupStatusCode(code);
    assert.equal(info.class, "configuration", `${code} should be configuration-class`);
    assert.equal(info.retry, false, `${code} must never be retried`);
  }
});

/**
 * The mSpace documentation gives E1856 and E1857 two meanings each. Recording
 * only one would send someone's retry logic the wrong way on the charging path.
 */
test("the two doubly-documented codes record both meanings", () => {
  for (const code of ["E1856", "E1857"]) {
    const info = lookupStatusCode(code);
    assert.match(info.description, /Documented as/i, `${code} does not record both meanings`);
  }
});

test("no real credential-shaped string appears in the catalog", () => {
  const raw = readFileSync(join(repoRoot, "catalog", "mspace-api.json"), "utf8");
  const hexSecret = /"password"\s*:\s*"[0-9a-f]{16,}"/i;
  assert.equal(hexSecret.test(raw), false, "catalog contains a credential-shaped password value");
});

/* ── Lookup ──────────────────────────────────────────────────────────────── */

test("services resolve by id, name and alias", () => {
  assert.equal(findEntry("subscription-unregister").id, "subscription-unregister");
  assert.equal(findEntry("unsub").id, "subscription-unregister");
  assert.equal(findEntry("UNSUB").id, "subscription-unregister");
  assert.equal(findEntry("Query Base (subscriber base size)").id, "subscription-query-base");
  assert.equal(findEntry("debit").id, "caas-otp-generation");
  assert.equal(findEntry("nope"), null);
});

test("every service resolves to a URL on the mSpace host", () => {
  for (const s of catalog.services) {
    assert.equal(urlFor(s), `https://api.mspace.lk${s.path}`);
  }
});

test("unknown status codes degrade gracefully", () => {
  const unknown = lookupStatusCode("E9998");
  assert.equal(unknown.known, false);
  assert.equal(unknown.class, "unknown");
  assert.equal(lookupStatusCode("S9999").class, "success");
});

test("search finds services by intent, not just by id", () => {
  assert.ok(search("base size").some((r) => r.id === "subscription-query-base"));
  assert.ok(search("opt out").some((r) => r.id === "subscription-unregister"));
  assert.ok(search("charge").some((r) => r.id === "caas-otp-generation"));
  assert.ok(search("E1303").some((r) => r.id === "E1303"));
  assert.equal(search("").length, 0);
});

/* ── Validation ──────────────────────────────────────────────────────────── */

test("validation catches destinationAddresses sent as a string", () => {
  const result = validatePayload(findEntry("sms-send"), {
    version: "1.0",
    applicationId: "APP_000001",
    password: "x",
    message: "hi",
    destinationAddresses: "tel:94702725777",
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("must be an ARRAY")));
});

test("validation catches a missing tel: prefix", () => {
  const result = validatePayload(findEntry("subscription-register"), {
    applicationId: "APP_000001",
    password: "x",
    action: "1",
    subscriberId: "94702725777",
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("tel:")));
});

/**
 * SMS sourceAddress is the Default Sender Address or an alias — a short code or
 * a name, not a subscriber. Requiring tel: on it would reject every valid send.
 */
test("validation does not demand tel: on an SMS sender alias", () => {
  const result = validatePayload(findEntry("sms-send"), {
    version: "1.0",
    applicationId: "APP_000001",
    password: "x",
    message: "hi",
    destinationAddresses: ["tel:94702725777"],
    sourceAddress: "77000",
  });
  assert.equal(result.valid, true, result.errors.join("; "));
});

test("validation catches a bad enum value", () => {
  const result = validatePayload(findEntry("subscription-register"), {
    applicationId: "APP_000001",
    password: "x",
    action: "yes",
    subscriberId: "tel:94702725777",
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("must be one of")));
});

test("validation enforces the documented local limits", () => {
  const tooMany = validatePayload(findEntry("subscription-charging-info"), {
    applicationId: "APP_000001",
    password: "x",
    subscriberIds: Array.from({ length: 11 }, (_, i) => `tel:9470272577${i}`),
  });
  assert.equal(tooMany.valid, false);
  assert.ok(tooMany.errors.some((e) => e.includes("maximum is 10")));

  const badPage = validatePayload(findEntry("subscription-list"), {
    applicationId: "APP_000001",
    password: "x",
    requestPage: 0,
  });
  assert.equal(badPage.valid, false);
  assert.ok(badPage.errors.some((e) => e.includes("E1106")));
});

test("validation warns loudly about a broadcast", () => {
  const result = validatePayload(findEntry("sms-send"), {
    version: "1.0",
    applicationId: "APP_000001",
    password: "x",
    message: "hi",
    destinationAddresses: ["tel:all"],
  });
  assert.equal(result.valid, true, result.errors.join("; "));
  assert.ok(result.warnings.some((w) => w.includes("ENTIRE subscribed base")));
});

test("validation warns that charging moves money and succeeds with P1003", () => {
  const result = validatePayload(findEntry("caas-otp-generation"), {
    applicationId: "APP_000001",
    password: "x",
    externalTrxId: "abc",
    subscriberId: "tel:94702725777",
    paymentInstrumentName: "Mobile Account",
    amount: "5.00",
    currency: "LKR",
  });
  assert.equal(result.valid, true, result.errors.join("; "));
  assert.ok(result.warnings.some((w) => w.includes("real money")));
  assert.ok(result.warnings.some((w) => w.includes("P1003")));
});

test("a well-formed payload validates", () => {
  const result = validatePayload(findEntry("sms-send"), {
    version: "1.0",
    applicationId: "APP_000001",
    password: "x",
    message: "hi",
    destinationAddresses: ["tel:94702725777"],
  });
  assert.equal(result.valid, true, result.errors.join("; "));
});

test("every documented sample request validates against its own spec", () => {
  for (const s of catalog.services) {
    const payload = { ...s.sampleRequest, applicationId: "APP_000001", password: "x" };
    const result = validatePayload(s, payload);
    assert.equal(result.valid, true, `${s.id} sample is invalid: ${result.errors.join("; ")}`);
  }
});

test("every documented callback sample validates against its own spec", () => {
  for (const cb of catalog.callbacks) {
    const result = validatePayload(cb, cb.samplePayload);
    assert.equal(result.valid, true, `${cb.id} sample is invalid: ${result.errors.join("; ")}`);
  }
});

/* ── Building ────────────────────────────────────────────────────────────── */

test("built payloads never contain a literal credential", () => {
  for (const s of catalog.services) {
    const payload = buildPayload(s, {});
    assert.equal(payload.applicationId, "$MSPACE_APP_ID");
    assert.equal(payload.password, "$MSPACE_PASSWORD");
  }
});

/**
 * The body is the deliverable. An agent translates what this prints into the
 * host project's HTTP client verbatim, so a field the builder drops is a field
 * missing from someone's production request.
 */
test("a built payload carries every field the documented sample carries", () => {
  for (const s of catalog.services) {
    const payload = buildPayload(s, {});
    for (const name of Object.keys(s.sampleRequest || {})) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(payload, name),
        `${s.id} builds a body without ${name}, which its own documented sample sends`
      );
    }
    for (const p of s.parameters) {
      if (!p.required) continue;
      assert.ok(
        Object.prototype.hasOwnProperty.call(payload, p.name),
        `${s.id} builds a body without the required ${p.name}`
      );
    }
  }
});

/** The declared order is the order mSpace publishes, credentials included. */
test("a built payload follows the contract's own field order", () => {
  for (const s of catalog.services) {
    const built = Object.keys(buildPayload(s, {}));
    const declared = s.parameters.map((p) => p.name).filter((n) => built.includes(n));
    assert.deepEqual(built, declared, `${s.id} emits its fields out of contract order`);
  }
});

/**
 * The reference document and the CLI used to build bodies with two separate
 * functions, and they drifted: the page sent sourceAddress and encoding on an
 * SMS, the CLI did not. One builder, one body.
 */
test("the CLI and the curl reference build the same body", () => {
  const service = findEntry("sms-send");
  const doc = readFileSync(join(repoRoot, "references", "14-curl-reference.md"), "utf8");
  const body = JSON.stringify(buildPayload(service), null, 2);
  assert.ok(
    doc.includes(body),
    "the SMS Send body in 14-curl-reference.md is not what buildPayload produces"
  );
});

/* ── Typing: a value that looks numeric is still a string on the wire ────── */

/**
 * These are the bugs that shipped. Parsing a command-line value as JSON turned
 * amount=5.00 into 5, action=1 into 1, and a 31-digit referenceNo into
 * 8.8e+30 — a corrupted body on the call that moves money, and every one of
 * them still looked plausible in the printed request.
 */
test("command-line values are typed by the contract, not by their shape", () => {
  const charge = findEntry("caas-otp-generation");
  const values = coerceValues(charge, { amount: "5.00", externalTrxId: "256091232" });
  assert.equal(values.amount, "5.00", "an amount must not become a JSON number");
  assert.equal(values.externalTrxId, "256091232");

  const verify = findEntry("caas-otp-verify");
  const referenceNo = "8801442233146169943053700500040";
  assert.equal(
    coerceValues(verify, { referenceNo, otp: "012345" }).referenceNo,
    referenceNo,
    "a long referenceNo must survive intact — as a number it loses precision"
  );
  assert.equal(coerceValues(verify, { otp: "012345" }).otp, "012345", "leading zero lost");

  // The one documented integer stays an integer, and enums stay strings.
  assert.equal(coerceValues(findEntry("subscription-list"), { requestPage: "2" }).requestPage, 2);
  assert.equal(coerceValues(findEntry("subscription-register"), { action: "1" }).action, "1");

  // Arrays accept both JSON and the comma-separated form people type.
  const sms = findEntry("sms-send");
  assert.deepEqual(coerceValues(sms, { destinationAddresses: '["tel:94702725777"]' }).destinationAddresses, [
    "tel:94702725777",
  ]);
  assert.deepEqual(
    coerceValues(sms, { destinationAddresses: "tel:94702725777,tel:94716177301" })
      .destinationAddresses,
    ["tel:94702725777", "tel:94716177301"]
  );

  // An object parameter is real JSON.
  const otp = findEntry("otp-request");
  assert.deepEqual(coerceValues(otp, { applicationMetaData: '{"client":"MOBILEAPP"}' }).applicationMetaData, {
    client: "MOBILEAPP",
  });

  // An undeclared parameter keeps its text; validation reports it separately.
  assert.equal(coerceValue(undefined, "123"), "123");
});

test("validation rejects a string field sent as a JSON number", () => {
  const result = validatePayload(findEntry("caas-otp-verify"), {
    applicationId: "APP_000001",
    password: "x",
    referenceNo: 8801442233146169943053700500040,
    otp: 123456,
    sourceAddress: "tel:94702725777",
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("referenceNo") && e.includes("STRING")));
  assert.ok(result.errors.some((e) => e.includes("otp") && e.includes("STRING")));
});

test("validation rejects an amount that is not a plain decimal string", () => {
  const charge = (amount) =>
    validatePayload(findEntry("caas-otp-generation"), {
      applicationId: "APP_000001",
      password: "x",
      externalTrxId: "abc",
      subscriberId: "tel:94702725777",
      paymentInstrumentName: "Mobile Account",
      amount,
      currency: "LKR",
    });

  assert.equal(charge("LKR 5.00").valid, false);
  assert.equal(charge(5).valid, false, "an amount must never be a JSON number");
  assert.equal(charge("5.00").valid, true);
  assert.ok(charge("5").warnings.some((w) => w.includes("two-decimal")));
});

test("validation rejects a body that still holds a placeholder", () => {
  const result = validatePayload(findEntry("subscription-status"), {
    applicationId: "APP_000001",
    password: "x",
    subscriberId: "<subscriberId>",
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("placeholder")));
});

test("tel:all is rejected anywhere but the SMS destination list", () => {
  const result = validatePayload(findEntry("subscription-register"), {
    applicationId: "APP_000001",
    password: "x",
    subscriberId: "tel:all",
    action: "1",
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("tel:all")));
});

/**
 * The documentation's prose and its own sample disagree on this one field. The
 * sample is the wire, so 14 digits is what goes out — and both are accepted so
 * a caller following the prose is warned rather than blocked.
 */
test("the notification timestamp accepts both documented forms", () => {
  const notify = (timeStamp) =>
    validatePayload(findEntry("subscription-notify"), {
      timeStamp,
      version: "1.0",
      applicationId: "APP_000001",
      password: "x",
      subscriberId: "tel:94716177301",
      frequency: "monthly",
      status: "REGISTERED",
    });

  assert.equal(notify("20120113082110").valid, true);
  const short = notify("2601130821");
  assert.equal(short.valid, true);
  assert.ok(short.warnings.some((w) => w.includes("14 digits")));
  assert.equal(notify("2026-01-13").valid, false);
});

test("a generated body carries fresh per-request values, never the sample", () => {
  const charge = findEntry("caas-otp-generation");
  const first = buildPayload(charge, {}, { perRequest: "fresh" });
  const second = buildPayload(charge, {}, { perRequest: "fresh" });
  assert.notEqual(first.externalTrxId, charge.sampleRequest.externalTrxId);
  assert.notEqual(first.externalTrxId, second.externalTrxId, "an idempotency key must be unique");

  const notify = buildPayload(findEntry("subscription-notify"), {}, { perRequest: "fresh" });
  assert.match(notify.timeStamp, /^\d{14}$/);
  assert.notEqual(notify.timeStamp, "20120113082110");

  // The generated document stays reproducible: no fresh values by default.
  assert.equal(buildPayload(charge, {}).externalTrxId, charge.sampleRequest.externalTrxId);
});

/* ── Reading the response ────────────────────────────────────────────────── */

test("every service declares its success codes and its message field", () => {
  for (const s of catalog.services) {
    assert.ok(s.successCodes?.length, `${s.id} declares no successCodes`);
    for (const code of s.successCodes) {
      assert.ok(catalog.statusCodes[code], `${s.id} claims unknown success code ${code}`);
      assert.ok(
        (s.statusCodes || []).includes(code),
        `${s.id} lists ${code} as a success but not among its status codes`
      );
    }
    assert.ok(
      s.successCodes.includes(s.sampleResponse.statusCode),
      `${s.id} publishes a sample response its own success set rejects`
    );
    const field = s.responseMessageField;
    assert.ok(
      (s.responseFields || []).some((f) => f.name === field),
      `${s.id} names ${field} as its message field but does not document it`
    );
    assert.ok(s.responseHandling?.length, `${s.id} says nothing about reading its response`);
  }
});

test("the success set is per endpoint, and the irregular ones are recorded", () => {
  assert.deepEqual(successCodesFor(findEntry("caas-otp-generation")), ["P1003"]);
  assert.deepEqual(successCodesFor(findEntry("subscription-list")), ["S1000", "S1001"]);
  assert.deepEqual(successCodesFor(findEntry("sms-send")), ["S1000"]);
  assert.equal(findEntry("caas-otp-verify").responseMessageField, "statusDescription");
});

test("a response is read against the contract of the call that made it", () => {
  const generation = readResponse(findEntry("caas-otp-generation"), {
    statusCode: "P1003",
    statusDetail: "Successfully sent OTP to user.",
    requestCorrelator: "8801442233146169943053700500040",
    internalTrxId: "9110808020001876",
  });
  assert.equal(generation.ok, true, "P1003 is the success of this call");
  assert.ok(generation.nextSteps.some((s) => s.includes("referenceNo")));

  // The same code on a different call is a failure.
  assert.equal(readResponse(findEntry("sms-send"), { statusCode: "P1003" }).ok, false);

  // S1000 is not universal in the other direction either.
  assert.equal(readResponse(findEntry("caas-otp-generation"), { statusCode: "S1000" }).ok, false);
  assert.equal(readResponse(findEntry("subscription-list"), { statusCode: "S1001" }).ok, true);
});

test("reading a response points at the right message field", () => {
  const verify = readResponse(findEntry("caas-otp-verify"), {
    statusCode: "S1000",
    statusDetail: "Request was Successfully processed.",
    status: true,
  });
  assert.equal(verify.message, null, "statusDetail is not this endpoint's message field");
  assert.ok(verify.notes.some((n) => n.includes("statusDescription")));
});

test("a per-recipient failure is surfaced under a top-level success", () => {
  const result = readResponse(findEntry("sms-send"), {
    statusCode: "S1000",
    statusDetail: "Success.",
    destinationResponses: [
      { address: "tel:94702725777", statusCode: "S1000" },
      { address: "tel:94716177301", statusCode: "E1317" },
    ],
  });
  assert.equal(result.ok, true);
  assert.ok(result.problems.some((p) => p.includes("E1317") && p.includes("tel:94716177301")));
});

test("a failure response carries the fix, not just the code", () => {
  const result = readResponse(findEntry("subscription-query-base"), {
    statusCode: "E1303",
    statusDetail: "IP not allowed",
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusClass, "configuration");
  assert.ok(result.nextSteps.some((s) => /Allowed Host Address/i.test(s)));
});

test("a body with no envelope is reported as such", () => {
  const result = readResponse(findEntry("sms-send"), { message: "sent" });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes("No statusCode")));
});

test("curl output is a single runnable POST with a JSON body", () => {
  const s = findEntry("subscription-query-base");
  const curl = toCurl(s, buildPayload(s, {}));
  assert.match(curl, /^curl -sS -X POST 'https:\/\/api\.mspace\.lk\/subscription\/query-base'/);
  assert.match(curl, /Content-Type: application\/json;charset=utf-8/);
  assert.match(curl, /--max-time \d+/);
  // The heredoc is unquoted on purpose: the credential variables must expand,
  // so the command runs as printed without a secret ever being written down.
  assert.match(curl, /--data @- <<REQUEST\n[\s\S]*\nREQUEST$/);
  assert.match(curl, /"applicationId": "\$MSPACE_APP_ID"/);
});

/* ── Diagnosis ───────────────────────────────────────────────────────────── */

test("diagnose extracts a status code from free text", () => {
  const d = diagnose("everything returns E1303 in production");
  assert.equal(d.matchedOn, "statusCode");
  assert.equal(d.code, "E1303");
});

test("diagnose recognises P1003 as a code, not a symptom", () => {
  const d = diagnose("the API keeps returning P1003");
  assert.equal(d.matchedOn, "statusCode");
  assert.equal(d.code, "P1003");
  assert.equal(d.class, "pending");
});

test("diagnose matches symptom signatures", () => {
  assert.equal(diagnose("callbacks never arrive").matchedOn, "symptom");
  assert.equal(diagnose("works locally but fails deployed").matchedOn, "symptom");
  assert.match(diagnose("we double charged a customer").fix, /externalTrxId/);
  assert.match(diagnose("statusDetail is undefined").fix, /statusDescription/);
});

/**
 * The two failure modes with no signature before: a body corrupted by JSON
 * number typing, and a subscription notification that never lands. Both look
 * like "it just does not work" from the outside.
 */
test("diagnose recognises a wrongly typed request body", () => {
  for (const symptom of [
    "the request body is not being generated as expected",
    "E1107 on every call",
    "the payload is invalid but it looks right",
  ]) {
    const d = diagnose(symptom);
    assert.notEqual(d.matchedOn, "none", `no diagnosis for "${symptom}"`);
    assert.match(
      `${d.cause ?? ""}${d.fix ?? ""}${d.action ?? ""}`,
      /string|validate/i,
      `"${symptom}" does not lead to the typing or validation check`
    );
  }
});

test("diagnose recognises a missing subscription notification", () => {
  for (const symptom of [
    "we never get told when a subscriber unsubscribes",
    "missed subscription notifications",
    "subscribers unsubscribe but our state is stale",
  ]) {
    const d = diagnose(symptom);
    assert.equal(d.matchedOn, "symptom", `no signature matched "${symptom}"`);
    assert.match(d.cause, /Subscription Notification URL/);
    assert.match(d.fix, /getSubscriberList/);
  }
});

test("diagnose degrades to search when nothing matches", () => {
  const d = diagnose("subscription");
  assert.equal(d.matchedOn, "none");
  assert.ok(Array.isArray(d.searchResults));
});

/* ── Repo consistency ────────────────────────────────────────────────────── */

test("all fourteen reference documents exist", () => {
  const files = readdirSync(join(repoRoot, "references")).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 14, `expected 14 reference docs, found ${files.length}`);
});

/**
 * mSpace presents six co-equal APIs on its Inzpire services page. Folding one
 * into another's document is how OTP ends up invisible to an agent scoping a
 * web sign-up, so each gets a reference of its own and the catalog says so.
 */
test("every published Inzpire API is declared and documented", () => {
  const apis = catalog.platform.apis;
  assert.equal(apis.length, 6, "mSpace publishes six Inzpire APIs");
  assert.deepEqual(
    apis.map((a) => a.name),
    ["SMS API", "USSD API", "Subscription API", "OTP API", "CaaS API", "LBS API"]
  );

  const categories = new Set(allEntries().map((e) => e.category));
  for (const api of apis) {
    assert.ok(api.summary?.length > 40, `${api.name} has no summary`);
    assert.ok(
      categories.has(api.category),
      `${api.name} declares category "${api.category}", which no service or callback uses`
    );
    assert.ok(
      existsSync(join(repoRoot, api.reference)),
      `${api.name} points at a missing reference: ${api.reference}`
    );
    assert.ok(
      catalog.services.some((s) => s.category === api.category),
      `${api.name} has no outbound service`
    );
  }

  // Nothing may be in the catalog that no declared API accounts for.
  const declared = new Set(apis.map((a) => a.category));
  for (const entry of allEntries()) {
    assert.ok(
      declared.has(entry.category),
      `${entry.id} is in category "${entry.category}", which no Inzpire API declares`
    );
  }
});

test("the OTP API has its own reference, and its services point at it", () => {
  const otp = catalog.services.filter((s) => s.category === "otp");
  assert.deepEqual(otp.map((s) => s.id).sort(), ["otp-request", "otp-verify"]);
  for (const service of otp) {
    assert.equal(service.reference, "references/05-otp.md");
  }

  const doc = readFileSync(join(repoRoot, "references", "05-otp.md"), "utf8");
  for (const fact of [
    "/otp/request",
    "/otp/verify",
    "referenceNo",
    "applicationMetaData",
    "E1853",
    "E1851",
  ]) {
    assert.ok(doc.includes(fact), `05-otp.md does not document ${fact}`);
  }
  // The two OTP flows are easy to conflate and expensive to conflate.
  assert.match(doc, /requestCorrelator/);
  assert.match(doc, /not interchangeable/i);
});

/**
 * Error handling is built from the complete table in 09-status-codes.md, so every
 * code there must carry the same handling class the catalog and `mspace code`
 * report. A class that disagrees sends someone's retry logic the wrong way.
 */
test("the status-code reference classifies every code exactly as the catalog does", () => {
  const doc = readFileSync(join(repoRoot, "references", "09-status-codes.md"), "utf8");
  const table = doc.slice(doc.indexOf("## Complete status code list"));
  const rows = [...table.matchAll(/^\| `([SEP]\d{4})` \| (\S+) \| /gm)];

  const documented = new Map(rows.map(([, code, cls]) => [code, cls]));
  const expected = Object.entries(catalog.statusCodes);

  assert.equal(documented.size, expected.length, "the complete list is missing codes");
  for (const [code, meta] of expected) {
    assert.equal(documented.get(code), meta.class, `09-status-codes.md misclassifies ${code}`);
  }
});

/**
 * The skill deliberately ships no code emitter: one encodes language idiom
 * rather than the mSpace contract, ages with every ecosystem it covers, and
 * makes every uncovered language second-class. The curl reference replaced it.
 * This keeps the docs from advertising a command that does not exist.
 */
test("no entry point advertises a code generator", () => {
  const surfaces = [
    "SKILL.md",
    "AGENTS.md",
    "README.md",
    ...readdirSync(join(repoRoot, "skills")).map((d) => `skills/${d}/SKILL.md`),
    ...readdirSync(join(repoRoot, "references")).map((f) => `references/${f}`),
  ];
  const offenders = surfaces.filter((file) =>
    /mspace(\.mjs)?\s+codegen|npm run codegen|--lang=/.test(readFileSync(join(repoRoot, file), "utf8"))
  );
  assert.deepEqual(offenders, [], `these still document a removed codegen command: ${offenders}`);
  assert.equal(existsSync(join(repoRoot, "tools", "codegen.mjs")), false);
});

/**
 * The curl reference is the tool-free path into the platform: an agent working
 * in Ruby, Rust or Kotlin gets no emitter, so this page is the whole contract it
 * has. It is generated from the catalog, and CI fails if it drifts.
 */
test("the curl reference is in sync with the catalog", () => {
  assert.doesNotThrow(() =>
    execFileSync("node", ["scripts/build-curl-reference.mjs", "--check"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
  );
});

test("the curl reference documents every endpoint, parameter and response field", () => {
  const doc = readFileSync(join(repoRoot, "references", "14-curl-reference.md"), "utf8");
  const missing = [];
  // Pipes are escaped in the generated tables, or they would split a cell.
  const documents = (text) => doc.includes(String(text).replace(/\|/g, "\\|"));

  for (const service of catalog.services) {
    const url = `${catalog.baseUrls.primary}${service.path}`;
    if (!doc.includes(`POST ${url}`)) missing.push(`endpoint ${url}`);
    if (!doc.includes(`curl -sS -X POST "$${service.envVar}"`)) {
      missing.push(`runnable request for ${service.id}`);
    }
    for (const p of service.parameters) {
      if (!doc.includes(`\`${p.name}\``)) missing.push(`${service.id}.${p.name}`);
      if (!documents(p.description)) missing.push(`definition of ${service.id}.${p.name}`);
    }
    for (const f of service.responseFields || []) {
      if (!documents(f.description)) missing.push(`response field ${service.id}.${f.name}`);
      for (const nested of f.fields || []) {
        if (!documents(nested.description)) {
          missing.push(`response field ${service.id}.${f.name}[].${nested.name}`);
        }
      }
    }
  }

  for (const cb of catalog.callbacks) {
    if (!doc.includes(cb.suggestedPath)) missing.push(`callback route ${cb.id}`);
    for (const f of cb.fields) {
      if (!documents(f.description)) missing.push(`definition of ${cb.id}.${f.name}`);
    }
  }

  assert.deepEqual(missing, [], `curl reference is missing:\n${missing.join("\n")}`);
});

test("the curl reference contains no credential, only environment placeholders", () => {
  const doc = readFileSync(join(repoRoot, "references", "14-curl-reference.md"), "utf8");
  assert.match(doc, /"password": "\$MSPACE_PASSWORD"/);
  assert.doesNotMatch(doc, /"password"\s*:\s*"(?!\$MSPACE_PASSWORD)[^"]{6,}"/);
});

/**
 * The CLI lists reference documents from a hardcoded array. A new file in
 * references/ that nobody registered is invisible to `mspace reference`.
 */
test("the CLI lists every reference document that exists", () => {
  const onDisk = readdirSync(join(repoRoot, "references"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
  const listed = JSON.parse(
    execFileSync("node", ["tools/mspace.mjs", "reference", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
  ).documents.sort();
  assert.deepEqual(listed, onDisk);
});

/**
 * The environment surface is deliberately tiny: two credentials, plus one URL
 * per provisionable service. Anything else (timeouts, encodings, retry counts)
 * belongs in code as a constant — it is a property of the protocol, not of the
 * deployment. This test stops that surface creeping back.
 */
test("the env example exposes only credentials and per-service endpoints", () => {
  const example = readFileSync(join(repoRoot, "templates", ".env.example"), "utf8");
  const declared = [...example.matchAll(/^#?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);

  const allowed = new Set([
    "MSPACE_APP_ID",
    "MSPACE_PASSWORD",
    ...catalog.services.map((s) => s.envVar),
  ]);

  const unexpected = declared.filter((v) => !allowed.has(v));
  assert.deepEqual(unexpected, [], `unexpected env vars in .env.example: ${unexpected.join(", ")}`);

  for (const required of ["MSPACE_APP_ID", "MSPACE_PASSWORD"]) {
    assert.ok(declared.includes(required), `.env.example is missing ${required}`);
  }
});

test("every catalog endpoint variable appears in the env example", () => {
  const example = readFileSync(join(repoRoot, "templates", ".env.example"), "utf8");
  for (const service of catalog.services) {
    assert.ok(
      example.includes(`${service.envVar}=`),
      `.env.example does not list ${service.envVar}`
    );
  }
});

test("every service endpoint variable maps to a real catalog service", () => {
  const example = readFileSync(join(repoRoot, "templates", ".env.example"), "utf8");
  const urls = [...example.matchAll(/^#?MSPACE_\w+_URL=(\S+)/gm)].map((m) => m[1]);
  const known = new Set(catalog.services.map((s) => `${catalog.baseUrls.primary}${s.path}`));
  for (const url of urls) {
    assert.ok(known.has(url), `.env.example lists ${url}, which is not a catalog endpoint`);
  }
});

/**
 * The same patterns the CI secrets job runs, so a leak fails locally before it
 * reaches a push. These detect what a real credential looks like rather than
 * allowlisting placeholder spellings — a real mSpace password is a long unbroken
 * alphanumeric run, which "replace-me", "…", "" and "$VAR" never are.
 */
test("no credential-shaped string is committed anywhere", () => {
  const patterns = [
    { name: "JSON password value", re: /"password"\s*:\s*"[A-Za-z0-9]{16,}"/ },
    { name: "env password value", re: /MSPACE_PASSWORD=[A-Za-z0-9]{12,}/ },
  ];

  // ci.yml is excluded because it contains the patterns as its own source text.
  // Nothing else is excluded — including this file, which is why the fixture
  // below is generated at runtime rather than written as a literal.
  const skipDirs = new Set([".git", "node_modules"]);
  const skipFiles = new Set(["ci.yml"]);
  const offenders = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(join(dir, entry.name));
        continue;
      }
      if (skipFiles.has(entry.name)) continue;
      const path = join(dir, entry.name);
      let content;
      try {
        content = readFileSync(path, "utf8");
      } catch {
        continue; // binary or unreadable
      }
      for (const { name, re } of patterns) {
        if (re.test(content)) {
          offenders.push(`${path.replace(repoRoot, ".")} — ${name}`);
        }
      }
    }
  };

  walk(repoRoot);
  assert.deepEqual(
    offenders,
    [],
    `credential-shaped strings found:\n${offenders.join("\n")}\n` +
      `Rotate the credential on the mSpace platform before anything else — see SECURITY.md.`
  );
});

test("documented placeholders do not trip the credential scan", () => {
  // Regression guard: these are the placeholder spellings actually used in the
  // repo. An earlier allowlist-based scan broke CI when "…" was introduced.
  const envRe = /MSPACE_PASSWORD=[A-Za-z0-9]{12,}/;
  for (const placeholder of [
    "MSPACE_PASSWORD=replace-me",
    "MSPACE_PASSWORD=…",
    "MSPACE_PASSWORD=",
    "MSPACE_PASSWORD=$MSPACE_PASSWORD",
    "MSPACE_PASSWORD=<your-password>",
  ]) {
    assert.equal(envRe.test(placeholder), false, `"${placeholder}" must not be flagged`);
  }
  // ...but a real one must still be caught.
  //
  // Generated at runtime, never written as a literal: a credential-shaped
  // string committed here would be flagged by the very scan it is testing.
  const credentialShaped = randomBytes(16).toString("hex"); // 32 hex chars
  assert.equal(envRe.test(`MSPACE_PASSWORD=${credentialShaped}`), true);
});

/**
 * mSpace publishes no support phone number, so none should appear. This also
 * catches a real MSISDN pasted into a document by accident.
 */
test("no local-format phone numbers appear in the documentation", () => {
  const docs = readdirSync(join(repoRoot, "references"))
    .map((f) => readFileSync(join(repoRoot, "references", f), "utf8"))
    .join("\n");
  const contactish = docs.match(/\b0\d{9}\b/g) || [];
  assert.deepEqual(contactish, [], `found local-format phone numbers: ${contactish.join(", ")}`);
});
