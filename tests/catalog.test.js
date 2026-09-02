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
  diagnose,
  findEntry,
  lookupStatusCode,
  repoRoot,
  search,
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
