/**
 * Query library over catalog/mspace-api.json.
 *
 * Zero dependencies, Node 18+. Importable from your own code, and driven by
 * tools/mspace.mjs on the command line.
 *
 * This is the whole mSpace contract as structured data: every service, every
 * parameter, every status code, every callback, every practice.
 */

import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..");

export const catalog = JSON.parse(
  readFileSync(join(repoRoot, "catalog", "mspace-api.json"), "utf8")
);

/** Every service and callback in one list, tagged by kind. */
export function allEntries() {
  return [
    ...catalog.services.map((s) => ({ ...s, kind: "service" })),
    ...catalog.callbacks.map((c) => ({ ...c, kind: "callback" })),
  ];
}

/** Look up a service or callback by id, name or alias. Case-insensitive. */
export function findEntry(idOrName) {
  const needle = String(idOrName || "").toLowerCase().trim();
  return (
    allEntries().find(
      (e) =>
        e.id.toLowerCase() === needle ||
        e.name.toLowerCase() === needle ||
        (e.aliases || []).some((a) => a.toLowerCase() === needle)
    ) || null
  );
}

/** Resolve the full URL for a service. */
export function urlFor(service, baseUrl) {
  if (service.absoluteUrl) return service.absoluteUrl;
  const base = (baseUrl || catalog.baseUrls.primary).replace(/\/+$/, "");
  return `${base}${service.path}`;
}

/** Decode a status code into meaning, class, retryability and the fix. */
export function lookupStatusCode(code) {
  const key = String(code || "").toUpperCase().trim();
  const entry = catalog.statusCodes[key];
  if (!entry) {
    const isSuccess = key.startsWith("S");
    return {
      code: key,
      known: false,
      class: isSuccess ? "success" : "unknown",
      description: `Not in the published code list. Treat as ${isSuccess ? "success" : "a failure"} and check ${catalog.platform.docs}.`,
      retry: false,
      action: "Escalate with the requestId or externalTrxId if it persists.",
      benignFor: [],
      affects: [],
    };
  }
  const cls = catalog.statusCodeClasses[entry.class] || {};
  return {
    code: key,
    known: true,
    class: entry.class,
    description: entry.description,
    retry: cls.retry ?? false,
    action: entry.fix || cls.action,
    benignFor: entry.benignFor || [],
    affects: allEntries()
      .filter((e) => (e.statusCodes || []).includes(key))
      .map((e) => e.id),
  };
}

/** Read a reference document from the repo. */
export function readReference(name) {
  const safe = String(name || "").replace(/[^a-zA-Z0-9._-]/g, "");
  for (const path of [
    join(repoRoot, "references", safe),
    join(repoRoot, "references", `${safe}.md`),
  ]) {
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return null;
}

/** Values the caller has to produce fresh, never copy from a sample. */
const GENERATORS = {
  trxId: () => randomUUID().replace(/-/g, ""),
  timestamp: () => {
    const d = new Date();
    const p = (n, width = 2) => String(n).padStart(width, "0");
    return (
      p(d.getUTCFullYear(), 4) +
      p(d.getUTCMonth() + 1) +
      p(d.getUTCDate()) +
      p(d.getUTCHours()) +
      p(d.getUTCMinutes()) +
      p(d.getUTCSeconds())
    );
  },
};

/**
 * Turn one `key=value` command-line argument into the value the wire expects.
 *
 * A shell argument is always text; what it has to become in the JSON body is
 * declared in the catalog. Parsing it as JSON instead — which is what this used
 * to do — silently corrupts the request: `amount=5.00` becomes the number 5,
 * `action=1` becomes 1 rather than "1", and a 31-digit `referenceNo` becomes
 * 8.8e+30 on the one call that moves money. mSpace types nearly every field as
 * a string, so the declared type decides, not the shape of the text.
 */
export function coerceValue(param, raw) {
  const asJson = () => {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };

  switch (param?.type) {
    case "string":
    case "enum":
      return raw;
    case "integer":
    case "number": {
      const n = Number(raw);
      return raw.trim() !== "" && Number.isFinite(n) ? n : raw;
    }
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      return raw;
    case "string[]": {
      const parsed = asJson();
      if (Array.isArray(parsed)) return parsed;
      // A bare or comma-separated list is what people actually type.
      return raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
    case "object":
    case "object[]": {
      const parsed = asJson();
      return parsed === undefined ? raw : parsed;
    }
    default: {
      // Not a declared parameter. Keep the text; validation reports it as
      // unrecognised, which is more useful than a guessed type.
      return raw;
    }
  }
}

/** Coerce a whole `key=value` argument list against a service's contract. */
export function coerceValues(service, pairs) {
  const values = {};
  for (const [key, raw] of Object.entries(pairs)) {
    const param = (service.parameters || service.fields || []).find((p) => p.name === key);
    values[key] = coerceValue(param, raw);
  }
  return values;
}

/**
 * Build a request payload for a service, with env placeholders for secrets.
 *
 * Parameters come out in the order the contract declares them — credentials
 * included, in their declared position — so the generated body is the body the
 * mSpace documentation publishes, field for field. Everything the documented
 * sample carries is emitted, optional fields included: an agent translating
 * this into another language should see the full shape of the call, not a
 * minimal one that happens to be accepted today.
 *
 * `options.perRequest: "fresh"` generates the values a caller must never copy
 * from a sample (a charge's externalTrxId, a notification timestamp). The
 * generated reference leaves them as the documented sample so the document is
 * reproducible; the CLI asks for fresh ones.
 *
 * The credentials are injected here and nowhere else, so no command this tool
 * prints can ever carry a literal password.
 */
export function buildPayload(service, values = {}, options = {}) {
  const { credentials = {}, perRequest = "sample" } = options;
  const payload = {};

  for (const p of service.parameters || []) {
    if (p.name === "applicationId") {
      payload.applicationId = credentials.applicationId || "$MSPACE_APP_ID";
      continue;
    }
    if (p.name === "password") {
      payload.password = credentials.password || "$MSPACE_PASSWORD";
      continue;
    }
    if (values[p.name] !== undefined) {
      payload[p.name] = values[p.name];
      continue;
    }
    const generate = perRequest === "fresh" && GENERATORS[p.perRequest?.kind];
    if (generate) {
      payload[p.name] = generate();
      continue;
    }
    const sample = service.sampleRequest?.[p.name];
    if (sample !== undefined) payload[p.name] = sample;
    // A required parameter the documentation gives no sample for still has to
    // appear, or the body is quietly incomplete.
    else if (p.required) payload[p.name] = `<${p.name}>`;
  }

  return payload;
}

/** The codes that mean this call succeeded. Not a global constant. */
export function successCodesFor(entry) {
  if (entry?.successCodes?.length) return entry.successCodes;
  if (entry?.sampleResponse?.statusCode) return [entry.sampleResponse.statusCode];
  return ["S1000"];
}

/**
 * Validate a payload against a service or callback definition.
 * Catches the mistakes that actually happen, not just missing fields.
 */
export function validatePayload(entry, payload) {
  const spec = entry.parameters || entry.fields || [];
  const errors = [];
  const warnings = [];
  const known = new Set(spec.map((p) => p.name));

  for (const p of spec) {
    const value = payload?.[p.name];

    if (p.required && (value === undefined || value === null || value === "")) {
      errors.push(`Missing required field "${p.name}" — ${p.description}`);
      continue;
    }
    if (value === undefined) continue;

    if (typeof value === "string" && /^<.+>$/.test(value)) {
      errors.push(
        `"${p.name}" is still the placeholder ${value}. Fill it in — this body is not ready to send.`
      );
      continue;
    }

    // mSpace types nearly everything as a string, including amounts, OTPs and
    // numeric identifiers. A JSON number in one of those is a different request
    // body: "5.00" becomes 5, "0700123" loses its leading zero, and a 31-digit
    // referenceNo loses precision entirely.
    if ((p.type === "string" || p.type === "enum") && typeof value !== "string") {
      errors.push(
        `"${p.name}" must be a STRING on the wire, got ${typeof value} ${JSON.stringify(value)}. ` +
          `Quote it: ${JSON.stringify(String(value))}.`
      );
      continue;
    }
    if (p.enum && !p.enum.includes(value)) {
      errors.push(`"${p.name}" must be one of ${p.enum.join(" | ")}, got ${JSON.stringify(value)}`);
    }
    if (p.type === "string[]" && !Array.isArray(value)) {
      errors.push(
        `"${p.name}" must be an ARRAY, got ${typeof value}. This is the most common mSpace integration bug.`
      );
    }
    if (p.type === "string[]" && Array.isArray(value)) {
      const notStrings = value.filter((v) => typeof v !== "string");
      if (notStrings.length) {
        errors.push(
          `"${p.name}" entries must all be strings, got ${JSON.stringify(notStrings[0])}`
        );
      }
    }
    if (p.type === "integer" && !Number.isInteger(value)) {
      errors.push(
        `"${p.name}" must be an integer, got ${typeof value} ${JSON.stringify(value)}` +
          (typeof value === "string" ? " — this one is a JSON number, not a quoted string." : "")
      );
    }
    if (p.type === "boolean" && typeof value !== "boolean") {
      errors.push(`"${p.name}" must be a boolean, got ${typeof value} ${JSON.stringify(value)}`);
    }
    if (p.type === "object" && (typeof value !== "object" || Array.isArray(value))) {
      errors.push(`"${p.name}" must be a JSON object, got ${typeof value}`);
    }
    if (p.name === "amount" && typeof value === "string") {
      if (!/^\d+(\.\d+)?$/.test(value)) {
        errors.push(
          `"amount" must be a plain decimal string such as "5.00" — no currency symbol, no separators. Got ${JSON.stringify(value)}.`
        );
      } else if (!/^\d+\.\d{2}$/.test(value)) {
        warnings.push(
          `amount ${JSON.stringify(value)} is not two-decimal. The documented form is "5.00"; send the exact string you intend to charge.`
        );
      }
    }
    if (p.name === "timeStamp" && typeof value === "string" && entry.id === "subscription-notify") {
      if (!/^\d{10}$|^\d{14}$/.test(value)) {
        errors.push(
          `"timeStamp" must be 14 digits (yyyyMMddHHmmss, the published sample) or 10 (yyMMddHHmm, the prose format). Got ${JSON.stringify(value)}.`
        );
      } else if (value.length === 10) {
        warnings.push(
          "timeStamp is 10 digits. The documentation's prose says yyMMddHHmm, but every published sample on the platform is 14 digits (yyyyMMddHHmmss) — prefer the wire sample."
        );
      }
    }
    if (
      /^(subscriberId|destinationAddress|sourceAddress|requesterId)$/.test(p.name) &&
      typeof value === "string"
    ) {
      // sourceAddress on SMS send is a sender alias or short code, not a subscriber.
      const isSenderAlias = p.name === "sourceAddress" && entry.id === "sms-send";
      if (!isSenderAlias && !value.startsWith("tel:")) {
        errors.push(`"${p.name}" must be tel:-prefixed, got ${JSON.stringify(value)}`);
      }
      if (!isSenderAlias && /[+\s]/.test(value)) {
        errors.push(`"${p.name}" must not contain "+" or spaces`);
      }
      // tel:all addresses the whole subscribed base and is documented for the
      // SMS destination list only. Anywhere else it is a single address that
      // resolves to nobody.
      if (value === "tel:all") {
        errors.push(
          `"${p.name}" cannot be tel:all — that value is only documented for destinationAddresses on SMS Send.`
        );
      }
    }
    if (p.name === "destinationAddresses" && Array.isArray(value)) {
      for (const a of value) {
        if (!String(a).startsWith("tel:")) {
          errors.push(`destinationAddresses entry ${JSON.stringify(a)} must be tel:-prefixed`);
        }
      }
      if (value.includes("tel:all")) {
        warnings.push(
          "tel:all sends to your ENTIRE subscribed base. Confirm this is intended and check the base size first."
        );
      }
    }
    if (p.name === "subscriberIds" && Array.isArray(value) && value.length > 10) {
      errors.push(
        `subscriberIds holds ${value.length} entries; the documented maximum is 10 MSISDNs per request.`
      );
    }
    if (p.name === "requestPage" && Number.isInteger(value) && value < 1) {
      errors.push("requestPage must be 1 or greater, or the request fails with E1106.");
    }
  }

  for (const key of Object.keys(payload || {})) {
    if (!known.has(key)) warnings.push(`Unrecognised field "${key}" — it will be ignored.`);
  }
  if (entry.movesMoney) {
    warnings.push(
      "This call moves real money. Persist externalTrxId BEFORE sending, and never retry with a new one."
    );
  }
  if (entry.id === "caas-otp-generation") {
    warnings.push(
      "The success code for this call is P1003, not S1000. A client that only accepts S1000 reports every successful charge request as a failure."
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Read an actual response body against the contract of the call that produced it.
 *
 * This is the other half of building the request, and the half that is usually
 * wrong: mSpace answers HTTP 200 for failures, success is per endpoint, one
 * endpoint puts its message in a different field, and several responses carry
 * the value the *next* call needs. Paste the body in and this says whether it
 * succeeded, which field the message is in, what is missing, and what to do
 * next — rather than leaving each of those to be remembered.
 */
export function readResponse(entry, body) {
  const successCodes = successCodesFor(entry);
  const messageField = entry.responseMessageField || "statusDetail";
  const notes = [];
  const problems = [];

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {
      service: entry.id,
      ok: false,
      statusCode: null,
      successCodes,
      messageField,
      message: null,
      notes: [],
      problems: ["The response is not a JSON object. mSpace always answers with a JSON envelope."],
      nextSteps: [],
    };
  }

  const statusCode = body.statusCode ?? null;
  const info = statusCode ? lookupStatusCode(statusCode) : null;
  const ok = Boolean(statusCode) && successCodes.includes(statusCode);

  if (!statusCode) {
    problems.push(
      "No statusCode in the body. Either this is not an mSpace response, or something " +
        "upstream unwrapped it. The HTTP status says nothing here — the envelope is the outcome."
    );
  }

  const message = body[messageField] ?? null;
  if (message === null) {
    const elsewhere = ["statusDetail", "statusDescription"].find(
      (f) => f !== messageField && body[f] !== undefined
    );
    if (elsewhere) {
      notes.push(
        `The message is in "${elsewhere}" here, but this endpoint documents "${messageField}". ` +
          `Read both, or a shared parser loses the message on one of them.`
      );
    }
  }

  // Fields the contract publishes but the body does not carry. On the charging
  // path a missing requestCorrelator means the next call cannot be made at all.
  const missingFields = (entry.responseFields || [])
    .map((f) => f.name)
    .filter((name) => body[name] === undefined);
  if (ok && missingFields.length) {
    notes.push(`Documented fields absent from this response: ${missingFields.join(", ")}.`);
  }

  // Per-recipient outcomes: the top-level code can be a success while an
  // individual address failed.
  const perEntry = Array.isArray(body.destinationResponses) ? body.destinationResponses : [];
  const failedEntries = perEntry.filter(
    (r) => r?.statusCode && !successCodes.includes(r.statusCode)
  );
  for (const failure of failedEntries) {
    const who = failure.address || failure.subscriberId || "an entry";
    const detail = lookupStatusCode(failure.statusCode);
    problems.push(
      `destinationResponses: ${who} failed with ${failure.statusCode} — ${detail.description}`
    );
  }

  const nextSteps = [];
  if (ok) {
    nextSteps.push(...(entry.responseHandling || []));
    if (entry.id === "subscription-list") {
      if (statusCode === "S1001") {
        nextSteps.push("S1001 here: no subscribers matched. Stop paging — this is not an error.");
      } else if (body.moreDataAvailable) {
        nextSteps.push(`More pages available: request requestPage ${body.nextPageNumber}.`);
      } else {
        nextSteps.push("moreDataAvailable is false — this was the last page.");
      }
    }
    if (entry.id === "caas-otp-generation" && body.requestCorrelator) {
      nextSteps.push(
        "Carry requestCorrelator into CaaS OTP Verification as referenceNo. Sending externalTrxId there fails with E1855."
      );
    }
  } else if (info) {
    nextSteps.push(info.action);
    if (info.benignFor?.length && !info.benignFor.includes(entry.id)) {
      nextSteps.push(
        `${statusCode} is the documented success of ${info.benignFor.join(", ")} — but not of this call.`
      );
    }
    if (info.retry === true) {
      nextSteps.push("Transient: retry with capped exponential backoff.");
    } else if (info.retry === false && entry.movesMoney) {
      nextSteps.push(
        "Do NOT retry this with a new externalTrxId. Settle the transaction from the charging notification."
      );
    }
  }

  return {
    service: entry.id,
    name: entry.name,
    ok,
    statusCode,
    statusClass: info?.class ?? null,
    known: info?.known ?? false,
    successCodes,
    messageField,
    message,
    description: info?.description ?? null,
    missingFields,
    notes,
    problems,
    nextSteps,
  };
}

/**
 * Render a service call as a runnable curl command.
 *
 * The body goes in through an unquoted heredoc so that $MSPACE_APP_ID and
 * $MSPACE_PASSWORD expand from the environment: the command runs as printed,
 * and no credential is ever written down. Same shape as
 * references/14-curl-reference.md, so the two paths cannot drift.
 */
export function toCurl(service, payload, baseUrl) {
  return [
    `curl -sS -X POST '${urlFor(service, baseUrl)}' \\`,
    `  --header 'Content-Type: application/json;charset=utf-8' \\`,
    `  --max-time 15 \\`,
    `  --data @- <<REQUEST`,
    JSON.stringify(payload, null, 2),
    `REQUEST`,
  ].join("\n");
}

/** Full-text search across services, callbacks, status codes and practices. */
export function search(query, limit = 20) {
  const needle = String(query || "").toLowerCase().trim();
  if (!needle) return [];
  const hit = (haystack, weight) =>
    String(haystack).toLowerCase().includes(needle) ? weight : 0;
  const results = [];

  for (const e of allEntries()) {
    const score =
      hit(e.id, 10) +
      hit(e.name, 8) +
      hit((e.aliases || []).join(" "), 8) +
      hit(e.path || e.suggestedPath || "", 6) +
      hit(e.summary, 4) +
      hit(JSON.stringify(e.parameters || e.fields || []), 2) +
      hit((e.rules || []).join(" "), 1);
    if (score) results.push({ type: e.kind, id: e.id, name: e.name, summary: e.summary, score });
  }
  for (const [code, meta] of Object.entries(catalog.statusCodes)) {
    const score = hit(code, 12) + hit(meta.description, 3);
    if (score) results.push({ type: "statusCode", id: code, name: code, summary: meta.description, score });
  }
  for (const p of catalog.practices) {
    const score = hit(p.id, 8) + hit(p.title, 6) + hit(p.detail, 2);
    if (score) results.push({ type: "practice", id: p.id, name: p.title, summary: p.detail, score });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Symptom signatures for the diagnose command. */
export const SIGNATURES = [
  {
    when: /p1003|charge.*(not|never) (happen|complete)|charge.*otp|otp.*charg|charging.*otp/,
    cause: "CaaS charging on mSpace is two calls, not one. POST /caas/direct/debit only generates an OTP and answers P1003; the money moves when the subscriber's OTP is verified with POST /caas/otp/verify, and the final outcome arrives on the charging notification.",
    fix: "Treat P1003 as success for the generation step, store requestCorrelator, collect the OTP, then call CaaS OTP Verification with referenceNo = requestCorrelator. Settle the transaction from the charging notification. See references/06-caas.md.",
  },
  // Ahead of the generic callback signature: this one has a specific answer,
  // and the generic one would swallow it on the word "notification".
  {
    when: /(never|not|n[o']t|no|missed?|missing).{0,50}(told|know|knew|notified|learn|informed|aware|see|hear).{0,50}(unsub|subscri)|(unsub|subscri).{0,50}(never|not|n[o']t|missed?).{0,50}(told|know|notified|learn|informed|arriv)|subscription.{0,20}(notification|callback).{0,30}(not|never|missing|down)|(missed?|missing|lost|dropped).{0,30}(subscription|subscriber|unsub)|stale.{0,30}subscri|subscri.{0,30}(state|status).{0,30}(stale|drift|wrong|out of date)/,
    cause:
      "The Subscription Notification URL is not configured on the application record, or its handler is rejecting deliveries. It is the only place you learn about a change you did not initiate — a subscriber texting STOP, an operator removal, a billing failure. A handler that hard-fails on a missing field drops them silently, because mSpace publishes no payload specification for that URL.",
    fix: "Configure the URL under Subscription configuration on the application record. Accept subscriberId and status, verify applicationId only when it is present, acknowledge with {\"statusCode\":\"S1000\",\"statusDetail\":\"Success\"} before doing any work, and deduplicate on subscriberId + status + timeStamp. Reconcile the gap with POST /subscription/getSubscriberList, which exists for exactly this. Contract: node tools/mspace.mjs show subscription-notification.",
  },
  {
    when: /callback|webhook|notification.*(not|never)|no.*(callback|webhook)/,
    cause: "The callback URL is not publicly reachable, is wrong on the application record, is behind a WAF challenge or auth middleware, or your handler is not returning HTTP 200 with S1000.",
    fix: "Verify the URL in the application's SMS, USSD, CaaS or Subscription configuration; confirm it is reachable over public HTTPS with a complete certificate chain; exempt it from CSRF and auth middleware and restrict by source IP instead. Test locally with scripts/test-callbacks.sh.",
  },
  {
    when: /nothing happens|gets nothing|no error|silent|not working.*(test|number)/,
    cause: "The test number is not in the application's Whitelisted Numbers list while the application is in Limited Production.",
    fix: "Add the number under Whitelisted Numbers on the application record. Non-whitelisted access returns E1343, and E1104 means the application itself is not in Active or Limited Production status.",
  },
  {
    when: /works locally|fails.*(deploy|production|server)|local.*works/,
    cause: "The deployed server's egress IP is not in Allowed Host Address, or the secrets are not set in the host environment.",
    fix: "Determine the egress IP ON THE DEPLOYED SERVER and add it to Allowed Host Address on the application record. Confirm MSPACE_APP_ID and MSPACE_PASSWORD are set in the host's secret manager.",
  },
  {
    when: /ussd.*(die|drop|hang|stuck|expire)|session.*(lost|expire|die)/,
    cause: "USSD session state is not shared across instances, the flow never sends mt-fin, or the handler is too slow.",
    fix: "Move the session store to Redis with a short TTL, end terminal screens with mt-fin, echo the platform's sessionId, and acknowledge the callback before doing any work.",
  },
  {
    when: /double.?charg|charged twice|duplicate charge/,
    cause: "A charge was retried with a fresh externalTrxId after a timeout, so the platform saw two unrelated transactions.",
    fix: "Persist externalTrxId before the call and reuse it on every resolution attempt. Settle unknown outcomes from the charging notification rather than by charging again.",
  },
  {
    when: /certificate|tls|ssl|self.?signed|unable to verify/,
    cause: "The certificate chain served to your client is incomplete, which strict clients reject.",
    fix: "Supply the missing intermediate CA to the HTTPS client. Do NOT disable verification — that exposes the credentials that can charge your subscribers.",
  },
  {
    when: /success.*but|reports success|no error but.*fail|always succeeds/,
    cause: "The code checks the HTTP status instead of statusCode.",
    fix: "mSpace returns HTTP 200 for application-level failures. Branch on statusCode: S1000 for most services, P1003 for CaaS OTP generation, S1001 as a success on Subscriber List.",
  },
  {
    when: /statusdetail.*(undefined|missing|empty)|no statusdetail/,
    cause: "CaaS OTP Verification returns statusDescription, not statusDetail.",
    fix: "Read statusDescription on /caas/otp/verify, and the boolean status field alongside it. A shared parser that only knows statusDetail loses the message.",
  },
  {
    when: /array|destinationaddress/,
    cause: "destinationAddresses was sent as a bare string.",
    fix: "It is always an array, even for a single recipient.",
  },
  {
    when: /e1103|e1107|e1312|invalid.*(request|parameter|body|payload)|(request|body|payload).*(invalid|wrong|malformed)|mandatory field/,
    cause:
      "The request body does not match the contract. In practice it is one of four things: a string field sent as a JSON number (amount, otp, referenceNo, externalTrxId and action are all strings — 5.00 becomes 5 and a long referenceNo loses precision), destinationAddresses sent as a bare string, a missing mandatory field, or a subscriber address without the tel: prefix.",
    fix: "Run `node tools/mspace.mjs validate <id> '<your exact body>'` — it checks types, enums, tel: prefixes and the documented limits. Then send the same body with `node tools/mspace.mjs curl <id> key=value …` to compare against the contract's own shape.",
  },
  {
    when: /wrong (body|payload)|body.*not.*(generated|expected)|payload.*not.*(generated|expected)|number instead of|as a number|quoted|leading zero|precision/,
    cause:
      "A field mSpace types as a string is being serialised as a JSON number. Language-level JSON encoders do this whenever the value came from a numeric variable: amount 5.00 goes out as 5, an OTP of 012345 loses its leading zero, and a 31-digit referenceNo becomes 8.8e+30.",
    fix: "Keep amount, otp, referenceNo, externalTrxId, action, encoding and deliveryStatusRequest as strings all the way to the wire — requestPage is the only documented integer. Confirm with `node tools/mspace.mjs validate <id> '<body>'`.",
  },
  {
    when: /s1001|no subscriber/,
    cause: "S1001 on Subscriber List is being treated as an error.",
    fix: "S1001 means the request succeeded and matched nobody. Treat it as success and stop paging.",
  },
];

/** Diagnose from a status code or a plain-language symptom. */
export function diagnose(symptom) {
  const codeMatch = String(symptom).match(/\b([SEP]\d{4})\b/i);
  if (codeMatch) return { matchedOn: "statusCode", ...lookupStatusCode(codeMatch[1]) };

  const s = String(symptom).toLowerCase();
  const sig = SIGNATURES.find((x) => x.when.test(s));
  if (sig) return { matchedOn: "symptom", symptom, cause: sig.cause, fix: sig.fix };

  return {
    matchedOn: "none",
    symptom,
    suggestion: "Try `mspace search <keyword>`, or look up the statusCode from the response body.",
    searchResults: search(symptom, 5),
  };
}
