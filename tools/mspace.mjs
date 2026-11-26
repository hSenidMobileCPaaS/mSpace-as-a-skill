#!/usr/bin/env node
/**
 * mspace — offline reference CLI for the mSpace API.
 *
 * Everything an MCP server would expose as tools, exposed as subcommands any
 * agent can run through its shell. No install, no dependencies, no server, no
 * network access, and it never sees your credentials.
 *
 *   node tools/mspace.mjs <command> [args] [--json]
 *
 * Commands:
 *   list [category] [--direction=outbound|inbound]   List services and callbacks
 *   show <id>                                        Full contract for one
 *   code <statusCode|httpStatus|MAI_CODE>            Decode a status or error code
 *   diagnose <symptom|code>                          Most likely cause + fix
 *   search <query>                                   Search everything
 *   curl <id> [key=value ...]                        Runnable request + definitions
 *   validate <id> <json|@file|->                     Check a payload
 *   practices [severity]                             Security/reliability rules
 *   checklist                                        Go-live checklist
 *   reference <doc>                                  Print a reference doc
 *   platform                                         Base URLs, operator, conventions
 *   mai [models|errors]                              The mAI Tokens (AI gateway) contract
 *   help
 */

import { readFileSync } from "node:fs";
import {
  allEntries,
  buildPayload,
  catalog,
  coerceValues,
  diagnose,
  findEntry,
  isMai,
  lookupMaiError,
  lookupStatusCode,
  maiServices,
  readReference,
  readResponse,
  search,
  successCodesFor,
  toCurl,
  urlFor,
  validatePayload,
} from "./catalog.mjs";

/* ── Output ──────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const JSON_MODE = argv.includes("--json");
const args = argv.filter((a) => a !== "--json");
const [command, ...rest] = args;

const isTTY = process.stdout.isTTY;
const c = (code, s) => (isTTY && !JSON_MODE ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c(1, s);
const dim = (s) => c(2, s);
const red = (s) => c(31, s);
const green = (s) => c(32, s);
const yellow = (s) => c(33, s);
const cyan = (s) => c(36, s);

function out(data, render) {
  if (JSON_MODE) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    render(data);
  }
}

function fail(message, data = {}) {
  if (JSON_MODE) console.log(JSON.stringify({ error: message, ...data }, null, 2));
  else console.error(red(`error: ${message}`));
  process.exit(1);
}

const CLASS_COLOR = {
  success: green,
  pending: cyan,
  configuration: red,
  client: yellow,
  "user-state": yellow,
  transient: cyan,
  unknown: dim,
};

/* ── Commands ────────────────────────────────────────────────────────────── */

function cmdList() {
  const category = rest.find((a) => !a.startsWith("--"));
  const dirFlag = rest.find((a) => a.startsWith("--direction="));
  const direction = dirFlag ? dirFlag.split("=")[1] : null;

  const entries = allEntries()
    .filter((e) => !category || e.category === category)
    .filter((e) => !direction || e.direction === direction)
    .map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      category: e.category,
      direction: e.direction,
      endpoint: e.kind === "service" ? `POST ${e.absoluteUrl || e.path}` : `POST ${e.suggestedPath}`,
      summary: e.summary,
      movesMoney: e.movesMoney || undefined,
      spendsTokens: e.spendsTokens || undefined,
    }));

  if (!entries.length) fail(`No services match "${category || direction}".`);

  out({ count: entries.length, baseUrl: catalog.baseUrls.primary, entries }, (d) => {
    console.log(`\n${bold("mSpace services")}  ${dim(`base ${d.baseUrl}`)}\n`);
    let group = null;
    for (const e of d.entries) {
      if (e.category !== group) {
        group = e.category;
        console.log(bold(`  ${group.toUpperCase()}`));
      }
      const arrow = e.direction === "outbound" ? "→" : "←";
      const money = e.movesMoney ? red("  $$ real money") : e.spendsTokens ? red("  $$ spends tokens") : "";
      console.log(`    ${arrow} ${cyan(e.id.padEnd(28))} ${dim(e.endpoint)}${money}`);
      console.log(`      ${dim(e.summary)}`);
    }
    console.log(
      `\n  ${dim("→ you call mSpace   ← mSpace calls the URL you configured")}` +
        `\n  ${dim(`${d.count} entries. Full contract: mspace show <id>`)}\n`
    );
  });
}

function cmdShow() {
  const id = rest[0];
  if (!id) fail("usage: mspace show <id>");
  const entry = findEntry(id);
  if (!entry) {
    fail(`Unknown service "${id}".`, { available: allEntries().map((e) => e.id) });
  }

  const data = {
    ...entry,
    url: entry.kind === "service" ? urlFor(entry) : undefined,
    statusCodeDetail: (entry.statusCodes || []).map(lookupStatusCode),
    errorCodeDetail: (entry.errorCodes || []).map(lookupMaiError),
  };

  out(data, (d) => {
    console.log(`\n${bold(d.name)}  ${dim(`(${d.id})`)}`);
    console.log(`${d.summary}\n`);
    if (d.kind === "service") {
      console.log(`  ${bold("Endpoint")}  POST ${cyan(d.url)}`);
      console.log(`  ${bold("Variable")}  ${d.envVar}`);
    } else {
      console.log(`  ${bold("Your route")}  POST ${cyan(d.suggestedPath)}   ${dim(`configured in: ${d.configuredIn}`)}`);
      console.log(`  ${bold("Dedupe key")}  ${d.dedupeKey}`);
    }
    if (d.movesMoney) console.log(`  ${red("⚠  This call moves real money.")}`);
    if (d.spendsTokens) console.log(`  ${red("⚠  This call spends real tokens from your mAI Tokens balance.")}`);
    if (isMai(d)) {
      const auth = catalog.maiTokens.auth;
      console.log(`  ${bold("Auth")}      ${auth.header}: ${auth.format}  ${dim(`(${auth.envVar})`)}`);
      console.log(`  ${yellow("⚠  Failures arrive as real HTTP status codes. There is no statusCode field and no S1000.")}`);
    }

    if (d.payloadPublished === false) console.log(`  ${yellow("!")} ${d.payloadNote}`);

    const spec = d.parameters || d.fields || [];
    console.log(`\n  ${bold(d.kind === "service" ? "Request parameters" : "Payload fields")}`);
    for (const p of spec) {
      const req = p.required
        ? red(d.kind === "service" ? "required" : "always sent")
        : dim("optional");
      const en = p.enum ? dim(`  [${p.enum.join(" | ")}]`) : "";
      console.log(`    ${cyan(p.name.padEnd(24))} ${p.type.padEnd(10)} ${req}${en}`);
      console.log(`      ${dim(p.description)}`);
      if (p.perRequest) console.log(`      ${yellow("!")} ${p.perRequest.note}`);
    }

    if (d.responseFields) {
      console.log(`\n  ${bold("Response fields")}`);
      for (const f of d.responseFields) {
        console.log(`    ${cyan(f.name.padEnd(24))} ${dim(f.description)}`);
      }
    }

    if (d.kind === "service" && !isMai(d)) {
      console.log(
        `\n  ${bold("Success")}  ${green(successCodesFor(d).join(" or "))}` +
          `   ${dim(`message in ${d.responseMessageField || "statusDetail"}`)}`
      );
      for (const h of d.responseHandling || []) console.log(`    ${dim("·")} ${h}`);
    }

    const sampleReq = d.sampleRequest || d.samplePayload;
    if (sampleReq) {
      console.log(`\n  ${bold(d.kind === "service" ? "Sample request" : "Sample payload mSpace sends you")}`);
      console.log(indent(JSON.stringify(sampleReq, null, 2), 4));
    }
    if (d.sampleResponse) {
      console.log(`\n  ${bold("Sample response")}`);
      console.log(indent(JSON.stringify(d.sampleResponse, null, 2), 4));
    } else if (d.kind === "callback") {
      console.log(`\n  ${bold("You must respond")}`);
      console.log(indent(JSON.stringify(catalog.conventions.callbackAck, null, 2), 4));
    }

    if (d.rules?.length) {
      console.log(`\n  ${bold("Rules")}`);
      d.rules.forEach((r) => console.log(`    ${yellow("!")} ${r}`));
    }
    if (d.statusCodeDetail?.length) {
      console.log(`\n  ${bold("Status codes")}`);
      for (const s of d.statusCodeDetail) {
        const colour = CLASS_COLOR[s.class] || dim;
        console.log(`    ${colour(s.code.padEnd(7))} ${dim(s.class.padEnd(14))} ${s.description}`);
      }
    }
    if (d.errorCodeDetail?.length) {
      console.log(`\n  ${bold("Errors")}  ${dim("HTTP status, then the code in error.code")}`);
      for (const e of d.errorCodeDetail) {
        const colour = CLASS_COLOR[e.class] || dim;
        console.log(`    ${colour(e.code.padEnd(22))} ${dim(String(e.http).padEnd(5))} ${dim(e.class.padEnd(14))} ${e.description}`);
      }
    }
    console.log(`\n  ${dim(`Full guide: ${d.reference}`)}\n`);
  });
}

function cmdCode() {
  const code = rest[0];
  if (!code) fail("usage: mspace code <statusCode|httpStatus|MAI_CODE>");

  // Telco codes are a letter and four digits; anything else that resolves in
  // the mAI Tokens table is an AI gateway failure. Deciding by shape keeps
  // `code 429` and `code E1603` from ever being answered from the wrong table.
  const isTelcoShaped = /^[SEP]\d{4}$/i.test(String(code).trim());
  if (!isTelcoShaped) {
    const mai = lookupMaiError(code);
    if (mai.known) {
      return out({ source: "mai-tokens", ...mai }, (d) => {
        const colour = CLASS_COLOR[d.class] || dim;
        console.log(`\n  ${colour(bold(d.code))}  ${dim(`mAI Tokens · HTTP ${d.http} · ${d.class}`)}`);
        console.log(`  ${d.description}\n`);
        console.log(`  ${bold("Retry")}   ${d.retry ? green("yes, with backoff") : red("no")}`);
        console.log(`  ${bold("Action")}  ${d.action}`);
        if (d.affects.length) console.log(`  ${dim(`Seen on: ${d.affects.join(", ")}`)}`);
        console.log(`\n  ${dim(catalog.maiTokens.reference)}\n`);
      });
    }
  }

  const info = lookupStatusCode(code);

  out(info, (d) => {
    const colour = CLASS_COLOR[d.class] || dim;
    console.log(`\n  ${colour(bold(d.code))}  ${dim(d.class)}${d.known ? "" : dim("  (not in published list)")}`);
    console.log(`  ${d.description}\n`);
    console.log(`  ${bold("Retry")}   ${d.retry === true ? green("yes, with backoff") : d.retry === "after-user-action" ? yellow("only after user action") : red("no")}`);
    console.log(`  ${bold("Action")}  ${d.action}`);
    if (d.benignFor?.length) {
      console.log(`  ${green(bold("Success"))}  This is the documented success outcome for: ${d.benignFor.join(", ")}`);
    }
    if (d.affects?.length) console.log(`  ${dim(`Seen on: ${d.affects.join(", ")}`)}`);
    console.log();
  });
}

function cmdDiagnose() {
  const symptom = rest.join(" ");
  if (!symptom) fail('usage: mspace diagnose "<symptom or status code>"');
  const d = diagnose(symptom);

  out(d, (r) => {
    console.log();
    if (r.matchedOn === "statusCode" || r.matchedOn === "maiError") {
      const colour = CLASS_COLOR[r.class] || dim;
      console.log(`  ${colour(bold(r.code))}  ${r.description}\n`);
      console.log(`  ${bold("Fix")}  ${r.action}`);
    } else if (r.matchedOn === "symptom") {
      console.log(`  ${bold("Likely cause")}`);
      console.log(`  ${r.cause}\n`);
      console.log(`  ${bold("Fix")}`);
      console.log(`  ${green(r.fix)}`);
    } else {
      console.log(`  ${yellow("No signature matched.")} ${r.suggestion}`);
      if (r.searchResults?.length) {
        console.log(`\n  ${bold("Closest matches")}`);
        r.searchResults.forEach((x) => console.log(`    ${cyan(x.id.padEnd(28))} ${dim(x.summary?.slice(0, 70) ?? "")}`));
      }
    }
    console.log();
  });
}

function cmdSearch() {
  const query = rest.join(" ");
  if (!query) fail("usage: mspace search <query>");
  const results = search(query, 20);

  out({ query, results }, (d) => {
    if (!d.results.length) {
      console.log(`\n  ${yellow(`Nothing matched "${d.query}".`)}\n`);
      return;
    }
    console.log(`\n  ${bold(`${d.results.length} results for "${d.query}"`)}\n`);
    for (const r of d.results) {
      console.log(`    ${dim(r.type.padEnd(11))} ${cyan(r.id.padEnd(28))} ${(r.summary || "").slice(0, 64)}`);
    }
    console.log(`\n  ${dim("Detail: mspace show <id>   or   mspace code <CODE>")}\n`);
  });
}

function cmdCurl() {
  const id = rest[0];
  if (!id) fail("usage: mspace curl <id> [key=value ...]");
  const entry = findEntry(id);
  if (!entry) fail(`Unknown service "${id}".`, { available: allEntries().map((e) => e.id) });

  if (entry.kind === "callback") {
    const data = {
      note: `${entry.name} is inbound — mSpace calls you, you do not call it.`,
      yourRoute: `POST ${entry.suggestedPath}`,
      fields: entry.fields,
      incomingPayload: entry.samplePayload,
      yourResponse: catalog.conventions.callbackAck,
      dedupeKey: entry.dedupeKey,
      testCommand: `curl -X POST 'http://localhost:3000${entry.suggestedPath}' \\\n  --header 'Content-Type: application/json' \\\n  --data '${JSON.stringify(entry.samplePayload)}'`,
      reference: "references/14-curl-reference.md",
    };
    return out(data, (d) => {
      console.log(`\n  ${yellow(d.note)}\n`);
      console.log(`  ${bold("Payload fields")}`);
      for (const f of d.fields) {
        const req = f.required ? red("always sent") : dim("optional");
        console.log(`    ${cyan(f.name.padEnd(22))} ${f.type.padEnd(8)} ${req}`);
        console.log(`      ${dim(f.description)}`);
      }
      console.log(`\n  ${bold("Test your handler with:")}\n`);
      console.log(indent(d.testCommand, 4));
      console.log(`\n  ${bold("It must respond:")} ${JSON.stringify(d.yourResponse)}`);
      console.log(`  ${bold("Deduplicate on:")} ${d.dedupeKey}\n`);
    });
  }

  // Every argument arrives as text; the catalog decides what it becomes on the
  // wire. Parsing it as JSON would turn amount=5.00 into 5 and a long
  // referenceNo into 8.8e+30 — a corrupted body that still looks plausible.
  const raw = {};
  for (const pair of rest.slice(1)) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    raw[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  const values = coerceValues(entry, raw);

  const payload = buildPayload(entry, values, { perRequest: "fresh" });
  const validation = validatePayload(entry, payload);

  // Credentials are always placeholders here, so a value typed on the command
  // line is dropped rather than printed. Say so, or it looks like it was used.
  for (const secret of isMai(entry) ? [] : ["applicationId", "password"]) {
    if (raw[secret] !== undefined) {
      validation.warnings.unshift(
        `${secret} was ignored — this command never prints a credential. Export MSPACE_${
          secret === "password" ? "PASSWORD" : "APP_ID"
        } and let the shell expand it.`
      );
    }
  }
  const curl = toCurl(entry, payload);

  const mai = isMai(entry);
  const data = {
    service: entry.id,
    name: entry.name,
    maiTokens: mai || undefined,
    endpoint: `POST ${urlFor(entry)}`,
    envVar: entry.envVar,
    url: urlFor(entry),
    parameters: entry.parameters,
    payload,
    curl,
    sampleResponse: entry.sampleResponse,
    successCodes: mai ? undefined : successCodesFor(entry),
    responseMessageField: mai ? undefined : entry.responseMessageField || "statusDetail",
    responseHandling: entry.responseHandling,
    responseFields: entry.responseFields,
    errorCodes: mai ? entry.errorCodes : undefined,
    validation,
    rules: entry.rules,
    reference: mai ? catalog.maiTokens.reference : "references/14-curl-reference.md",
  };

  out(data, (d) => {
    console.log(`\n  ${bold(d.name)}  ${dim(d.endpoint)}`);
    console.log(`  ${dim(`endpoint variable ${d.envVar}`)}`);
    if (d.maiTokens) {
      const auth = catalog.maiTokens.auth;
      console.log(`  ${dim(`auth ${auth.header}: ${auth.format} — from ${auth.envVar}, no Bearer prefix`)}`);
    }
    console.log();

    console.log(`  ${bold("Parameters")}`);
    for (const p of d.parameters) {
      const req = p.required ? red("required") : dim("optional");
      const en = p.enum ? dim(`  [${p.enum.join(" | ")}]`) : "";
      console.log(`    ${cyan(p.name.padEnd(22))} ${p.type.padEnd(8)} ${req}${en}`);
      console.log(`      ${dim(p.description)}`);
      if (p.perRequest) console.log(`      ${yellow("!")} ${p.perRequest.note}`);
    }

    console.log(`\n  ${bold("Request")}\n`);
    console.log(indent(d.curl, 2));

    if (d.sampleResponse) {
      const note = d.maiTokens
        ? "HTTP 200 — failures arrive as real HTTP status codes with an error object"
        : `HTTP 200 — success is statusCode ${d.successCodes.join(" or ")}, nothing else`;
      console.log(`\n  ${bold("Response")}  ${dim(note)}\n`);
      console.log(indent(JSON.stringify(d.sampleResponse, null, 2), 4));
    }
    if (d.responseFields?.length) {
      console.log(`\n  ${bold("Response fields")}`);
      for (const f of d.responseFields) {
        console.log(`    ${cyan(f.name.padEnd(22))} ${dim(f.description)}`);
      }
    }
    if (d.responseHandling?.length) {
      console.log(`\n  ${bold("Reading the response")}  ${dim(`message field: ${d.responseMessageField}`)}`);
      d.responseHandling.forEach((h) => console.log(`    ${dim("·")} ${h}`));
      console.log(`    ${dim(`Check a real one: mspace response ${d.service} '<body>'`)}`);
    }

    console.log();
    if (!d.validation.valid) {
      console.log(`  ${red(bold("Invalid:"))}`);
      d.validation.errors.forEach((e) => console.log(`    ${red("✗")} ${e}`));
    }
    d.validation.warnings.forEach((w) => console.log(`  ${yellow("!")} ${w}`));
    console.log(
      `\n  ${dim(
        d.maiTokens
          ? `The key is an env placeholder — export ${catalog.maiTokens.auth.envVar}, do not paste it in.`
          : "Credentials are env placeholders — export them, do not paste them in."
      )}`
    );
    console.log(`  ${dim(`Every endpoint in this form: ${d.reference}`)}\n`);
  });
}

/** Read a JSON document from an inline argument, a @file, or stdin. */
function readJsonArgument(source, label) {
  let raw = source;
  if (source === "-") raw = readFileSync(0, "utf8");
  else if (source.startsWith("@")) raw = readFileSync(source.slice(1), "utf8");

  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(`${label} is not valid JSON: ${err.message}`);
  }
}

/**
 * Read a real response body against the contract of the call that made it.
 *
 * Half of every mSpace integration is what you do with the answer, and it is
 * the half that has no HTTP status to lean on: 200 means nothing, success is
 * per endpoint, and one endpoint names its message field differently.
 */
function cmdResponse() {
  const [id, source] = rest;
  if (!id || !source) fail("usage: mspace response <id> <json|@file|->");
  const entry = findEntry(id);
  if (!entry) fail(`Unknown service "${id}".`, { available: allEntries().map((e) => e.id) });

  const body = readJsonArgument(source, "Response");
  const result = readResponse(entry, body);

  if (isMai(entry)) {
    out(result, (d) => {
      console.log();
      const verdict = d.ok ? green("✓ success") : red(`✗ failure  ${d.errorCode ?? ""}`);
      console.log(`  ${verdict}  ${dim(`against ${bold(d.service)}`)}`);
      if (d.model) console.log(`  ${bold("Model")}    ${d.model}`);
      if (d.message) console.log(`  ${bold("Message")}  ${String(d.message).slice(0, 200)}`);
      if (!d.ok && d.description) console.log(`  ${dim(d.description)}`);
      d.problems.forEach((p) => console.log(`\n  ${red("✗")} ${p}`));
      d.notes.forEach((n) => console.log(`\n  ${yellow("!")} ${n}`));
      if (d.nextSteps.length) {
        console.log(`\n  ${bold("Next")}`);
        d.nextSteps.forEach((x) => console.log(`    ${dim("·")} ${x}`));
      }
      console.log();
    });
    if (!result.ok) process.exitCode = 1;
    return;
  }

  out(result, (d) => {
    console.log();
    const verdict = d.ok
      ? green(`✓ success  ${d.statusCode}`)
      : red(`✗ failure  ${d.statusCode ?? "no statusCode"}`);
    console.log(`  ${verdict}  ${dim(`against ${bold(d.service)}`)}`);
    console.log(`  ${dim(`success for this call: ${d.successCodes.join(" or ")}`)}`);
    // The platform's own message when there is one; the catalog's meaning of
    // the code when there is not.
    if (d.message) console.log(`  ${bold("Message")}  ${d.message}`);
    else {
      console.log(`  ${bold("Message")}  ${dim(`absent — this endpoint puts it in "${d.messageField}"`)}`);
      if (d.description) console.log(`  ${d.description}`);
    }
    if (!d.ok && d.description) console.log(`  ${dim(d.description)}`);

    d.problems.forEach((p) => console.log(`\n  ${red("✗")} ${p}`));
    d.notes.forEach((n) => console.log(`\n  ${yellow("!")} ${n}`));

    if (d.nextSteps.length) {
      console.log(`\n  ${bold("Next")}`);
      d.nextSteps.forEach((s) => console.log(`    ${dim("·")} ${s}`));
    }
    console.log();
  });
  if (!result.ok) process.exitCode = 1;
}

function cmdValidate() {
  const [id, source] = rest;
  if (!id || !source) fail("usage: mspace validate <id> <json|@file|->");
  const entry = findEntry(id);
  if (!entry) fail(`Unknown service "${id}".`);

  const payload = readJsonArgument(source, "Payload");

  const result = validatePayload(entry, payload);
  out({ service: entry.id, ...result }, (d) => {
    console.log();
    if (d.valid) console.log(`  ${green("✓ valid")}  against ${bold(d.service)}`);
    else {
      console.log(`  ${red(`✗ ${d.errors.length} error(s)`)}  against ${bold(d.service)}`);
      d.errors.forEach((e) => console.log(`    ${red("✗")} ${e}`));
    }
    d.warnings.forEach((w) => console.log(`    ${yellow("!")} ${w}`));
    console.log();
  });
  if (!result.valid) process.exitCode = 1;
}

function cmdPractices() {
  const severity = rest[0];
  const practices = catalog.practices.filter((p) => !severity || p.severity === severity);
  if (!practices.length) fail(`No practices with severity "${severity}". Try: critical, high, medium.`);

  out({ practices }, (d) => {
    console.log(`\n  ${bold("mSpace practices")}\n`);
    let group = null;
    for (const p of d.practices) {
      if (p.severity !== group) {
        group = p.severity;
        const colour = group === "critical" ? red : group === "high" ? yellow : dim;
        console.log(`  ${colour(bold(group.toUpperCase()))}`);
      }
      console.log(`    ${bold(p.title)}`);
      console.log(`      ${dim(p.detail)}`);
      console.log(`      ${dim(p.reference)}\n`);
    }
  });
}

function cmdChecklist() {
  const doc = readReference("11-production-checklist");
  if (!doc) fail("Checklist not found.");
  if (JSON_MODE) {
    const items = doc
      .split("\n")
      .filter((l) => l.trim().startsWith("- [ ]"))
      .map((l) => l.replace(/^\s*- \[ \]\s*/, "").trim());
    console.log(JSON.stringify({ count: items.length, items }, null, 2));
  } else {
    console.log(doc);
  }
}

const REFERENCE_DOCS = [
  "01-getting-started", "02-sms", "03-ussd", "04-subscription", "05-otp",
  "06-caas", "07-lbs", "08-callbacks", "09-status-codes",
  "10-security-best-practices", "11-production-checklist", "12-any-stack",
  "13-implementation-playbook", "14-curl-reference", "15-mai-tokens",
];

function cmdReference() {
  const doc = rest[0];
  if (!doc) {
    return out({ documents: REFERENCE_DOCS }, (d) => {
      console.log(`\n  ${bold("Reference documents")}\n`);
      d.documents.forEach((x) => console.log(`    ${cyan(x)}`));
      console.log(`\n  ${dim("mspace reference <name>")}\n`);
    });
  }
  const content = readReference(doc);
  if (!content) fail(`Reference "${doc}" not found.`);
  console.log(content);
}

function cmdPlatform() {
  const data = {
    platform: catalog.platform,
    operators: catalog.operators,
    baseUrls: catalog.baseUrls,
    conventions: catalog.conventions,
  };
  out(data, (d) => {
    console.log(`\n  ${bold(d.platform.name)} — ${d.platform.operator}, ${d.platform.market}\n`);
    console.log(`  ${bold("Tracks")}`);
    d.platform.tracks.forEach((t) => {
      console.log(`    ${cyan(t.name.padEnd(10))} ${dim(t.url)}`);
      console.log(`      ${dim(t.summary)}`);
    });
    console.log(`\n  ${bold("Inzpire APIs")}  ${dim("the six services mSpace publishes")}`);
    for (const api of d.platform.apis || []) {
      const outbound = catalog.services.filter((s) => s.category === api.category).length;
      const inbound = catalog.callbacks.filter((c) => c.category === api.category).length;
      const shape = inbound ? `${outbound} → · ${inbound} ←` : `${outbound} →`;
      console.log(`    ${cyan(api.name.padEnd(18))} ${dim(`${shape}  ${api.reference}`)}`);
      console.log(`      ${dim(api.summary)}`);
      if (api.note) console.log(`      ${yellow("!")} ${dim(api.note)}`);
    }
    console.log(`    ${dim("→ you call mSpace   ← mSpace calls the URL you configured")}`);

    console.log(`\n  ${bold("Operator")}`);
    d.operators.forEach((o) => console.log(`    ${o.name.padEnd(10)} ${dim(o.note)}`));
    console.log(`\n  ${bold("Base URLs")}`);
    console.log(`    API        ${cyan(d.baseUrls.primary)}`);
    console.log(`    docs       ${dim(d.baseUrls.docs)}`);
    console.log(`    simulator  ${dim(d.baseUrls.simulator)}  ${dim("(local, from the developer bundle)")}`);
    console.log(`\n  ${bold("Addressing")}  ${d.conventions.addressing.format}`);
    d.conventions.addressing.rules.forEach((r) => console.log(`    ${dim("·")} ${dim(r)}`));
    console.log(`\n  ${red(bold("Critical"))}  ${d.conventions.responseEnvelope.criticalNote}`);
    console.log(`\n  ${bold("Site")}  ${d.platform.support.site}  ·  ${d.platform.support.operator}\n`);
  });
}

/**
 * The mAI Tokens contract in one screen.
 *
 * It gets its own command rather than being folded into `platform` because the
 * two products agree on almost nothing: different host, different credential,
 * different failure envelope, no subscriber. Anyone who reads `platform` and
 * assumes it also describes the AI gateway writes a broken client.
 */
function cmdMai() {
  const m = catalog.maiTokens;
  const topic = (rest[0] || "").toLowerCase();

  if (topic === "models") {
    return out({ models: m.models }, (d) => {
      console.log(`\n  ${bold("mAI Tokens models")}\n`);
      for (const x of d.models) {
        console.log(`    ${cyan(x.id.padEnd(24))} ${dim(x.provider.padEnd(10))} ${dim(x.endpoint)}`);
        console.log(`      ${dim(x.note)}`);
      }
      console.log();
    });
  }

  if (topic === "errors") {
    const errors = Object.keys(m.errors).map(lookupMaiError);
    return out({ errors }, (d) => {
      console.log(`\n  ${bold("mAI Tokens errors")}  ${dim("HTTP status, then the code in error.code")}\n`);
      for (const e of d.errors) {
        const colour = CLASS_COLOR[e.class] || dim;
        console.log(`    ${colour(e.code.padEnd(22))} ${dim(String(e.http).padEnd(5))} ${dim(e.class.padEnd(14))} ${e.description}`);
        console.log(`      ${dim(e.action)}`);
      }
      console.log(`\n  ${dim(`mspace code <CODE>  ·  ${m.reference}`)}\n`);
    });
  }

  const data = {
    name: m.name,
    summary: m.summary,
    baseUrl: m.baseUrl,
    portal: m.portal,
    auth: m.auth,
    models: m.models,
    rateLimits: m.rateLimits,
    differsFromTelco: m.differsFromTelco,
    services: maiServices().map((x) => ({
      id: x.id,
      name: x.name,
      endpoint: `POST ${urlFor(x)}`,
      envVar: x.envVar,
      summary: x.summary,
    })),
    practices: m.practices,
    statusPages: m.statusPages,
    reference: m.reference,
  };

  out(data, (d) => {
    console.log(`\n  ${bold(d.name)} — ${dim(d.baseUrl)}`);
    console.log(`  ${d.summary}\n`);

    console.log(`  ${bold("Auth")}      ${d.auth.header}: ${cyan(d.auth.format)}   ${dim(`from ${d.auth.envVar}`)}`);
    console.log(`  ${dim(`            ${d.auth.note}`)}`);
    console.log(`  ${bold("Key from")}  ${d.auth.issuedBy}\n`);

    console.log(`  ${bold("Endpoints")}`);
    for (const x of d.services) {
      console.log(`    ${cyan(x.id.padEnd(26))} ${dim(x.endpoint)}`);
      console.log(`      ${dim(x.summary)}`);
    }

    console.log(`\n  ${bold("Models")}`);
    for (const x of d.models) console.log(`    ${cyan(x.id.padEnd(24))} ${dim(`${x.provider.padEnd(10)} ${x.endpoint}`)}`);

    console.log(`\n  ${bold("Rate limits")}  ${dim(d.rateLimits.reset)} ${dim(d.rateLimits.onExceed)}`);

    console.log(`\n  ${red(bold("Not the telco platform"))}`);
    d.differsFromTelco.forEach((x) => console.log(`    ${yellow("!")} ${x}`));

    console.log(`\n  ${bold("Rules")}`);
    d.practices.forEach((x) => console.log(`    ${x.severity === "critical" ? red("!") : yellow("!")} ${x.title} — ${dim(x.detail)}`));

    console.log(`\n  ${dim("mspace show mai-chat-completions  ·  mspace mai models  ·  mspace mai errors")}`);
    console.log(`  ${dim(`Full guide: ${d.reference}`)}\n`);
  });
}

function cmdHelp() {
  console.log(`
  ${bold("mspace")} — offline reference for the mSpace API ${dim(`(catalog v${catalog.catalogVersion})`)}

  ${bold("USAGE")}
    node tools/mspace.mjs <command> [args] [--json]

  ${bold("DISCOVER")}
    list [category] [--direction=outbound|inbound]   List services and callbacks
    search <query>                                   Search everything
    show <id>                                        Full contract for one service
    platform                                         Base URL, operator, conventions
    mai [models|errors]                              The mAI Tokens AI gateway: auth,
                                                     models, endpoints, errors

  ${bold("BUILD")}
    curl <id> [key=value ...]                        Runnable request + parameter and
                                                     response definitions
    validate <id> <json|@file|->                     Check a payload against the spec
    response <id> <json|@file|->                     Read a real response body against
                                                     the contract of the call

    Every endpoint and callback in that form, filled in and explained, is
    references/14-curl-reference.md. Translate the request into the host project's HTTP
    client — that is the integration, in any language.

    Values are typed by the contract, not by how they look: amount, otp, referenceNo,
    externalTrxId and action are strings on the wire. requestPage is the one integer.

  ${bold("DEBUG")}
    code <statusCode|httpStatus|MAI_CODE>            Decode a telco status code or an
                                                     mAI Tokens error
    diagnose "<symptom>"                             Most likely cause and fix
    response <id> '<the body you got>'               Success or failure, per endpoint,
                                                     and what to do with it next

  ${bold("GUIDANCE")}
    practices [critical|high|medium]                 Security and reliability rules
    checklist                                        Go-live checklist
    reference [doc]                                  Print a reference document

  ${bold("EXAMPLES")}
    ${dim("$")} node tools/mspace.mjs list subscription
    ${dim("$")} node tools/mspace.mjs show unsub
    ${dim("$")} node tools/mspace.mjs search "base size"
    ${dim("$")} node tools/mspace.mjs code E1303
    ${dim("$")} node tools/mspace.mjs code P1003
    ${dim("$")} node tools/mspace.mjs diagnose "callbacks never arrive"
    ${dim("$")} node tools/mspace.mjs curl sms-send destinationAddresses='["tel:94702725777"]' message="Hi"
    ${dim("$")} node tools/mspace.mjs validate sms-send '{"message":"hi","destinationAddresses":"tel:94702725777"}'
    ${dim("$")} node tools/mspace.mjs curl caas-otp-generation externalTrxId=ORD-1001 amount=5.00
    ${dim("$")} node tools/mspace.mjs response caas-otp-generation '{"statusCode":"P1003"}'
    ${dim("$")} node tools/mspace.mjs show subscription-notification
    ${dim("$")} node tools/mspace.mjs reference 14-curl-reference
    ${dim("$")} node tools/mspace.mjs mai
    ${dim("$")} node tools/mspace.mjs curl mai-chat-completions model=claude-sonnet-4-6
    ${dim("$")} node tools/mspace.mjs code TOKEN_QUOTA_EXCEEDED

  ${dim("Add --json to any command for machine-readable output.")}
  ${dim("Offline and read-only: no network calls, and it never sees your credentials.")}
`);
}

/* ── Dispatch ────────────────────────────────────────────────────────────── */

function indent(s, n) {
  const pad = " ".repeat(n);
  return s.split("\n").map((l) => pad + l).join("\n");
}

const COMMANDS = {
  list: cmdList,
  ls: cmdList,
  show: cmdShow,
  get: cmdShow,
  code: cmdCode,
  status: cmdCode,
  diagnose: cmdDiagnose,
  debug: cmdDiagnose,
  search: cmdSearch,
  find: cmdSearch,
  curl: cmdCurl,
  build: cmdCurl,
  validate: cmdValidate,
  check: cmdValidate,
  response: cmdResponse,
  read: cmdResponse,
  practices: cmdPractices,
  checklist: cmdChecklist,
  reference: cmdReference,
  docs: cmdReference,
  platform: cmdPlatform,
  info: cmdPlatform,
  mai: cmdMai,
  ai: cmdMai,
  help: cmdHelp,
};

const handler = COMMANDS[command];
if (!command || command === "--help" || command === "-h") {
  cmdHelp();
} else if (!handler) {
  fail(`Unknown command "${command}". Run \`mspace help\`.`, {
    commands: [...new Set(Object.keys(COMMANDS))],
  });
} else {
  handler();
}
