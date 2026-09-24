# mAI Tokens — the mSpace AI gateway

mAI Tokens is mSpace's AI gateway: one OpenAI-shaped API in front of several model providers,
with chat completions across Claude, Gemini and GPT models and image generation on GPT Image.
You authenticate once, against mAI Tokens, and spend from an mAI Tokens balance instead of
holding a separate commercial account with each provider.

Portal: <https://maitokens.mspace.lk>

Every endpoint here is also written out as a runnable request, with each parameter defined, in
[14-curl-reference.md](14-curl-reference.md#the-ai-gateway--mai-tokens).

```bash
node tools/mspace.mjs mai                      # auth, endpoints, models, rules
node tools/mspace.mjs mai models               # what each model is for
node tools/mspace.mjs mai errors               # every failure and its fix
node tools/mspace.mjs show mai-chat-completions
node tools/mspace.mjs curl mai-chat-completions model=claude-sonnet-5
node tools/mspace.mjs validate mai-chat-completions '<json>'
node tools/mspace.mjs response mai-chat-completions '<the body you got>'
node tools/mspace.mjs code TOKEN_QUOTA_EXCEEDED
```

---

## Read this first: mAI Tokens is not the telco platform

It shares the mSpace brand and **nothing else** — not even the host. Every habit the rest of
this skill teaches you is wrong here, and the failures are quiet ones.

| | Telco APIs (SMS, USSD, Subscription, OTP, CaaS, LBS) | mAI Tokens |
|---|---|---|
| **Host** | `https://api.mspace.lk` | `https://maitokens.mspace.lk/api` |
| **Credential** | `applicationId` + `password` in the JSON **body** | one API key in the `Authorization` **header** |
| **Credential source** | the mSpace application record | the mAI Tokens portal — a *different* key |
| **Failure signalling** | HTTP 200 always; branch on `statusCode` | real HTTP status codes; branch on the status, then `error.code` |
| **Success marker** | `statusCode: "S1000"` (`P1003`, `S1001` on two calls) | HTTP 2xx. There is no `statusCode` field at all |
| **Subject** | a subscriber, addressed `tel:94702725777` | no subscriber, no MSISDN, no operator |
| **Inbound** | five callbacks you must host | none. mAI Tokens never calls you |
| **Network control** | *Allowed Host Address* (source-IP whitelist) | none — the key alone authorises the call |
| **Provisioning failure** | `E1309` | `INVALID_LLM_CONFIG` / `PROJECT_INACTIVE` |
| **Cost model** | per SMS / per charge | per token, from a prepaid balance |
| **Latency budget** | sub-second | seconds to tens of seconds |

**Consequence for your code: keep two clients.** A single shared HTTP helper that "handles
mSpace" will apply exactly one of these two conventions and be wrong for half your calls. The
usual bug is an mAI Tokens client that checks `res.ok` and then looks for `statusCode` — finding
nothing, calling it a failure — or a telco client that trusts `res.ok` and reports every `E13xx`
as a success.

---

## Authentication

```
Authorization: app_<keyId>.<keyValue>
```

The whole value goes in the header **verbatim**, including the `app_` prefix.

- It is **not** an OAuth bearer token. Do not write `Bearer app_…`, and do not base64-encode it.
- It is **not** your mSpace application password, and your application password will not work
  here. Generate the key in the mAI Tokens portal.
- A truncated key — one half of `keyId.keyValue` — fails as `404 PROJECT_NOT_FOUND`, which reads
  like a wrong URL. Check the key before you check the endpoint.

```bash
export MAI_TOKENS_API_KEY='app_<keyId>.<keyValue>'
```

**The key is a spend key.** It draws down a real prepaid token balance, so treat it exactly as
you treat the telco password: environment variable only, read through one config module that
validates at startup, never in source, never in a client bundle, never in a log line, never in
git history, never prefixed `NEXT_PUBLIC_` / `VITE_` / `REACT_APP_`. Rotate it in the portal the
moment it is exposed. See [10-security-best-practices.md](10-security-best-practices.md).

**Backend only, for a second reason.** Unlike the telco APIs, mAI Tokens has no *Allowed Host
Address* list, so a leaked key works from anywhere in the world until you rotate it. There is no
network control standing between an exposed key and your balance.

---

## Base URL and endpoints

```
https://maitokens.mspace.lk/api
```

| Endpoint | Method | What it does | Environment variable |
|---|---|---|---|
| `https://maitokens.mspace.lk/api/v1/chat/completions` | POST | Generate a model response for a conversation | `MAI_TOKENS_CHAT_COMPLETIONS_URL` |
| `https://maitokens.mspace.lk/api/v1/images/generations` | POST | Create an image from a text prompt | `MAI_TOKENS_IMAGE_GENERATIONS_URL` |

One variable per endpoint, matching the convention the telco services use: an endpoint you have
no variable for is one your code must refuse to call rather than discover at the platform.

---

## Models

The `model` field takes the id in the first column exactly — lowercase and hyphenated. A display
name such as `Claude Opus 5` is not a model id and fails validation.

### Chat — `POST /v1/chat/completions`

| Model | Provider | Reach for it when |
|---|---|---|
| `gemini-3.7-flash` | Google | The newest Gemini Flash generation. Fast general-purpose chat — a sensible default when latency matters. |
| `gemini-3.6-flash` | Google | Gemini Flash, previous generation. Fast general-purpose chat. |
| `gemini-3.5-flash` | Google | Gemini Flash, earlier generation. Fast general-purpose chat. |
| `gemini-3.5-flash-lite` | Google | Lite tier: among the cheapest and fastest. Classification, routing, short replies, anything on a USSD timer. |
| `gemini-3.1-flash-lite` | Google | Lite tier, earlier generation. Classification, routing and short replies at the lowest cost. |
| `gemini-3.1-pro-preview` | Google | Gemini Pro tier, in preview. Long-context reasoning over large documents and multi-step analysis. A preview model can change behaviour, so pin tests to it deliberately. |
| `claude-fable-5` | Anthropic | Claude Fable 5, a frontier Claude model. Check its price point in the portal before routing volume to it. |
| `claude-opus-5` | Anthropic | Claude's most capable tier — hard reasoning, long drafting and analysis where quality matters more than latency or cost. |
| `claude-sonnet-5` | Anthropic | Claude's balanced tier — strong reasoning and writing at a lower cost and latency than Opus. |
| `claude-sonnet-4-6` | Anthropic | The previous Sonnet generation — balanced quality and cost. |
| `gpt-5.6-sol` | OpenAI | GPT-5.6 family. Check its price point in the portal before routing volume to it. |
| `gpt-5.6-terra` | OpenAI | GPT-5.6 family. Check its price point in the portal before routing volume to it. |
| `gpt-5.6-luna` | OpenAI | GPT-5.6 family. Check its price point in the portal before routing volume to it. |
| `gpt-4o-mini` | OpenAI | Low-cost general chat. A sensible default when cost matters more than depth. |
| `gpt-5-nano` | OpenAI | The smallest GPT-5 model. Very low cost for classification, extraction and short replies. |

### Images — `POST /v1/images/generations`

| Model | Provider | Reach for it when |
|---|---|---|
| `gpt-image-2` | OpenAI | The newer GPT Image model. |
| `gpt-image-1.5` | OpenAI | The earlier GPT Image model. |

Each model has different capabilities, performance characteristics and price points. A model
your project is not configured for fails with `INVALID_LLM_CONFIG` — that is provisioning, not
payload, and no amount of retrying or reformatting will fix it.

**Choose per task, not per project.** Routing a USSD menu classification to `claude-opus-5`
costs many times what `gemini-3.5-flash-lite` or `gpt-5-nano` costs for the same answer, and the
model id is one string in the request body. Put it in configuration so it can be changed without
a deploy.

---

## Chat Completions

```
POST https://maitokens.mspace.lk/api/v1/chat/completions
```

Required: `model` and `messages`. Everything else is optional and follows the OpenAI Chat
Completions shape.

### The message array

`messages` is the conversation so far, oldest first. Each entry has a `role` and `content`, where
content is either a plain string or an array of typed parts (`text`, and image and audio parts
where the model supports them).

| Role | Required fields | Use |
|---|---|---|
| `system` | `role`, `content` | Instructions that govern the whole conversation. |
| `developer` | `role`, `content` | Instructions from you rather than the end user, above user messages in priority. |
| `user` | `role`, `content` | What the person said. |
| `assistant` | `role`, plus `content` **or** `tool_calls` | A previous model turn. Append the response's `message` object verbatim. |
| `tool` | `role`, `content`, `tool_call_id` | The result of a tool the model asked for. `tool_call_id` must match the id from the model's `tool_calls`. |

`name` is optional on `system`, `developer`, `user` and `assistant`.

### Parameters worth setting deliberately

| Parameter | Why it matters |
|---|---|
| `max_completion_tokens` | **Set it on every call.** It is the only hard ceiling on what one request can cost. Without it, one bad prompt or one loop can spend a meaningful share of the balance. |
| `temperature` | 0–2, default 1. Lower for extraction, classification and anything you parse; higher only for open-ended text. |
| `response_format` | Ask for structured output here rather than asking for JSON in the prompt and parsing hopefully. |
| `n` | Every choice is generated **and billed**. Leave it at 1 unless you genuinely use the alternatives. |
| `stop` | Up to 4 stop sequences. Cheaper than generating text you then throw away. |
| `store` | Defaults to false. Leave it false for anything carrying subscriber data. |
| `safety_identifier` | A *stable, opaque* per-user id for abuse detection. A hash of your internal user id — never an MSISDN, never a `subscriberId`. |
| `prompt_cache_key` | Groups requests sharing a long identical prefix so the provider can cache it. Stable per prompt *template*, never per user. |
| `top_p` | Nucleus sampling. Adjust this or `temperature`, not both. |

Also available: `tools`, `service_tier`, `frequency_penalty`, `presence_penalty`, `logprobs`,
`top_logprobs`. Every parameter with its full definition is in
[14-curl-reference.md](14-curl-reference.md#mai-tokens-chat-completions).

### Request

```bash
curl -sS -X POST "$MAI_TOKENS_CHAT_COMPLETIONS_URL" \
  -H 'Content-Type: application/json' \
  -H "Authorization: $MAI_TOKENS_API_KEY" \
  --max-time 120 \
  -d @- <<'REQUEST'
{
  "model": "gpt-4o-mini",
  "messages": [
    { "role": "system", "content": "You are a concise assistant for a Sri Lankan mobile service. Answer in one short paragraph." },
    { "role": "user", "content": "Explain megapixels in a picture" }
  ],
  "response_format": { "type": "text" },
  "max_completion_tokens": 300
}
REQUEST
```

`--max-time 120`, not the 15 seconds the telco endpoints use: a large completion legitimately
takes tens of seconds, and a short timeout cancels a call you have already been billed for. The
heredoc is **quoted** (`<<'REQUEST'`) so a `$` inside a prompt survives the shell — the opposite
of the telco commands, whose unquoted heredoc exists to expand `$MSPACE_PASSWORD`.

### Response

```json
{
  "id": "chatcmpl-B9MBs8CjcvOU2jLn4n570S5qMJKcT",
  "object": "chat.completion",
  "created": 1741569952,
  "model": "gpt-4o-mini",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Megapixels count the millions of pixels…", "refusal": null, "annotations": [] },
      "logprobs": null,
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 19,
    "completion_tokens": 10,
    "total_tokens": 29,
    "prompt_tokens_details": { "cached_tokens": 0, "audio_tokens": 0 },
    "completion_tokens_details": { "reasoning_tokens": 0, "audio_tokens": 0, "accepted_prediction_tokens": 0, "rejected_prediction_tokens": 0 }
  },
  "service_tier": "default"
}
```

Three fields decide whether you can use the answer:

- **`choices[0].finish_reason`** — `stop` is a complete answer. **`length` means the model hit
  `max_completion_tokens` and the content is cut off mid-sentence**; the request succeeded, the
  answer did not. `tool_calls` means the model wants a tool run before it can continue. Check
  this before you use `content`, always.
- **`choices[0].message`** — append it to your history *verbatim* before the next turn,
  `tool_calls` and all. Reconstructing it from the text loses the tool state.
- **`usage.total_tokens`** — what this call drew from the balance. Record it per call; it is the
  only way you will know why the balance moved.

`model` in the response tells you which model actually answered. Read it rather than assuming.

### Tool calling

Pass `tools`; when the model wants one, it replies with `finish_reason: "tool_calls"` and a
`tool_calls` array instead of content. Append that assistant message, run the tool, then append
one `{ "role": "tool", "tool_call_id": "…", "content": "…" }` per call and send the whole array
back. Tool arguments come from the model: **validate them as untrusted input** before acting.

---

## Image Generation

```
POST https://maitokens.mspace.lk/api/v1/images/generations
```

`prompt` is the only required parameter (max 32000 characters for the GPT Image models). Send
`model` explicitly — `gpt-image-2` or `gpt-image-1.5` — so a change of default never changes
your output or your cost.

```bash
curl -sS -X POST "$MAI_TOKENS_IMAGE_GENERATIONS_URL" \
  -H 'Content-Type: application/json' \
  -H "Authorization: $MAI_TOKENS_API_KEY" \
  --max-time 120 \
  -d @- <<'REQUEST'
{
  "model": "gpt-image-2",
  "prompt": "a red apple on a plain background",
  "n": 1,
  "size": "1024x1024",
  "quality": "low"
}
REQUEST
```

```json
{
  "created": 1767763326,
  "background": "opaque",
  "data": [{ "b64_json": "<base64-encoded image bytes>" }],
  "output_format": "png",
  "quality": "low",
  "size": "1024x1024",
  "usage": {
    "input_tokens": 9,
    "input_tokens_details": { "image_tokens": 0, "text_tokens": 9 },
    "output_tokens": 272,
    "total_tokens": 281
  }
}
```

**The image comes back as base64 in the body, never as a URL.** That has consequences:

- Never log the response body, and never put `b64_json` in a database text column or forward it
  through your own JSON API. Decode it once, write the bytes to object storage, and hand around
  a URL of your own.
- Use `output_format` from the response to pick the file extension and `Content-Type`.

Cost and latency levers, in order of impact: `quality` (`low` is dramatically cheaper and faster
than `high`), `n` (each image is billed), then `size`. Default to `low` for previews and
thumbnails; spend `high` only where the image is the product.

Other parameters: `background` (`transparent` needs `output_format` of `png` or `webp` — it is
silently discarded with `jpeg`), `output_compression` (webp/jpeg only), `moderation`, `style`,
`stream` with `partial_images`, and `user`. Full definitions in
[14-curl-reference.md](14-curl-reference.md#mai-tokens-image-generation).

**Generate in a background job.** Image generation is slow. Never do it inside a request the user
is waiting on, and never inside a callback handler.

---

## Errors

Failures arrive as **real HTTP status codes** with this body:

```json
{
  "error": {
    "message": "Human-readable error message",
    "type": "Error type or code",
    "param": "Parameter name that caused the error (if applicable)",
    "code": "Error code",
    "additional_data": { "key": "value" }
  }
}
```

Branch on **`error.code`** — it is the machine-readable one. `error.message` is for your logs,
and `error.param` names the offending field on a 400.

### HTTP statuses

| Status | Meaning | What to do |
|---|---|---|
| `400` | Invalid or malformed request — bad JSON, missing required field, invalid parameter value | Read `error.param`. Validate before sending. Not retryable. |
| `401` | Key missing, invalid or expired | Send the key verbatim, no `Bearer`. Check the variable actually reached the process. |
| `402` | Insufficient token balance | Top up. **Alert** — every AI call in the product is down, not one request. |
| `403` | Insufficient permissions, or the model is restricted for your project | Check the project is ACTIVE and the model is enabled. |
| `404` | No project matches the API key | Verify the full `keyId.keyValue` pair. |
| `429` | Rate limit or token quota exceeded | Read `Retry-After`, back off — **but check `error.code` first**, see below. |
| `500` | Unexpected server error (their team is notified automatically) | Retry with backoff, cap attempts, dead-letter. |
| `502` | Failed to forward to the upstream LLM provider — provider downtime or connectivity | Retry with backoff, or fail over to a model from another provider. |
| `503` | Temporarily unavailable — maintenance or high load | Retry with backoff. |

### Named codes

| `error.code` | HTTP | Meaning | Fix |
|---|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | The API key doesn't match any project | Regenerate the key; confirm both halves were copied. |
| `PROJECT_INACTIVE` | 403 | The project exists but its status is not ACTIVE | Activate it in the portal. No code change will help. |
| `INVALID_LLM_CONFIG` | 400 | The model is not configured or allowed for your project | Use an enabled model. This is the mAI Tokens `E1309`. |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests this minute | Back off; it clears on its own. Queue bursts. |
| `TOKEN_QUOTA_EXCEEDED` | 429 | The project's allocated token quota is used up | **Retrying will not clear this.** Raise the quota or top up, and alert. |
| `INSUFFICIENT_BALANCE` | 402 | Balance too low to process the request | Top up. Monitor proactively so it never fires in production. |
| `FORWARDING_FAILED` | 502 | The call to the upstream provider failed | Retry with backoff, or fail over to another provider's model. |

**The two 429s are not the same failure.** `RATE_LIMIT_EXCEEDED` is transient and clears within
the minute. `TOKEN_QUOTA_EXCEEDED` is a configuration failure wearing a transient status code — a
retry loop against it burns your attempts and delays the alert that would actually fix it. Read
`error.code`, not the status.

### Retry policy

| Retry with capped exponential backoff and jitter | Never retry |
|---|---|
| `429` with `RATE_LIMIT_EXCEEDED` (honour `Retry-After`) | `400`, `401`, `403`, `404` — they fail identically forever |
| `500`, `502`, `503` | `402` and `429` with `TOKEN_QUOTA_EXCEEDED` / `INSUFFICIENT_BALANCE` — alert instead |
| Transport errors and timeouts | |

A timeout is ambiguous: the completion may have been generated and billed. Chat completions are
not idempotent and carry no idempotency key, so a blind retry can pay twice for the same answer.
Cap retries at two, and log the completion `id` when you have one.

### Rate limits

Rate limits reset **every minute**. On `429`, read the `Retry-After` header for the recommended
wait. Quota is enforced two ways — requests per minute and total token spend — and they surface
as different codes on the same status, so read the code.

### Provider status

A `502` is usually one provider being down rather than mAI Tokens:
[OpenAI](https://status.openai.com/) · [Claude](https://status.claude.com/) ·
[Gemini](https://aistudio.google.com/status)

---

## What surrounds the call

The same seven components that [12-any-stack.md](12-any-stack.md) specifies for the telco APIs,
most of them behaving differently:

| Component | For mAI Tokens |
|---|---|
| **1. Config** | `MAI_TOKENS_API_KEY` plus one URL per endpoint, validated at startup. Separate from `MSPACE_APP_ID` / `MSPACE_PASSWORD` — a config module that treats them as interchangeable will send one product's secret to the other. Model ids live here too. |
| **2. Address normalisation** | Does not apply — there is no subscriber address. Its job here is the reverse: **redaction**, so no MSISDN or `subscriberId` reaches a prompt. |
| **3. Transport helper** | A **second** helper. It injects an `Authorization` header rather than body credentials, uses a 60–120 second timeout rather than 15, and must not share the telco helper's `statusCode` branching. |
| **4. Classification** | Branch on the HTTP status, then on `error.code`. There is no `S1000`. The two `429`s classify differently. |
| **5. Service wrappers** | Check `finish_reason` before returning content; decode images to storage before returning a reference. Log the completion `id`, the model and `usage.total_tokens` — never a prompt containing user data, never the key, never a base64 image. |
| **6. Callback endpoints** | None — mAI Tokens never calls you. What matters is that no telco callback *waits* on it (below). |
| **7. State stores** | The conversation history, if you keep one, holds assistant messages verbatim. There is no idempotency key, so design a duplicate call to be merely wasteful, not incorrect. |

---

## Using mAI Tokens *with* the telco APIs

The obvious products — an AI-answering SMS shortcode, a USSD assistant, generated campaign copy —
put a slow, spendy call inside a fast, cheap flow. Three rules make that work.

**1. Never call a model inside a callback response path.** mSpace expects `S1000` immediately,
and USSD sessions time out in seconds while a completion takes tens of them. Acknowledge the
callback first, generate out of band, then deliver the answer — by MT SMS, or on the next USSD
screen. For USSD specifically, reply on the current screen with a "working on it" `mt-cont` and
resolve on the next request, or fall back to SMS. See [08-callbacks.md](08-callbacks.md) and
[03-ussd.md](03-ussd.md).

**2. Redact before the prompt.** Prompts leave your trust boundary and reach a third-party model
provider. No MSISDN, no `subscriberId` (masked or not — a masked number is still a stable
identifier), no OTP, no mSpace password, no CaaS `externalTrxId` or `referenceNo`. Substitute an
opaque placeholder and re-insert the real value in your own code after the response comes back.
Keep `store` false. This is the same PII discipline as
[10-security-best-practices.md](10-security-best-practices.md), with a wider blast radius.

**3. Treat model output as untrusted input.** Never execute it, never interpolate it into SQL or a
shell, and never send it straight to a subscriber. An SMS built from a model response still costs
money per part and still represents your brand: check the length before sending (160 GSM-7
characters per part, 70 for Sinhala or Tamil — see [02-sms.md](02-sms.md)), and check the content.
A model that decides to answer in three paragraphs has just sent five SMS parts to your whole
base.

**Cost sits on top of cost.** An AI-answered SMS costs you a completion *and* an MT SMS. Cap the
completion with `max_completion_tokens`, cap the SMS with a length check, and rate-limit per
subscriber so one person cannot loop your balance away.

---

## Checklist before you ship an mAI Tokens integration

- [ ] `MAI_TOKENS_API_KEY` comes from the environment, validated at startup, and appears in no
      source file, no client bundle, no log line and no commit.
- [ ] The header is `Authorization: app_<keyId>.<keyValue>` — verbatim, no `Bearer`.
- [ ] The mAI Tokens client is separate from the telco client and branches on the HTTP status.
- [ ] `error.code` is read and branched on, and `TOKEN_QUOTA_EXCEEDED` alerts instead of retrying.
- [ ] `max_completion_tokens` is set on every chat call; `n` is 1 unless it genuinely is not.
- [ ] `finish_reason` is checked before the content is used.
- [ ] Client timeout is 60–120 seconds and set explicitly.
- [ ] Retries: transient only, capped, with jitter, honouring `Retry-After`.
- [ ] No MSISDN, `subscriberId`, OTP or credential can reach a prompt, `user`,
      `safety_identifier` or `prompt_cache_key`.
- [ ] `store` is false for anything carrying user data.
- [ ] Model responses are length- and content-checked before being sent to a subscriber.
- [ ] Generated images are decoded to object storage, not logged and not stored as base64 text.
- [ ] No model call happens inside a callback's response path.
- [ ] `usage.total_tokens` is recorded per call, and the balance is monitored so `402` is caught
      before a subscriber is.
- [ ] Model ids live in configuration, so a cheaper model can be swapped in without a deploy.

---

## Related

| | |
|---|---|
| Every mAI Tokens endpoint as a runnable curl | [14-curl-reference.md](14-curl-reference.md#the-ai-gateway--mai-tokens) |
| Machine-readable contract | [`catalog/mspace-api.json`](../catalog/mspace-api.json) → `maiTokens` |
| The contract on the command line | `node tools/mspace.mjs mai` |
| Secrets, TLS, PII and logging | [10-security-best-practices.md](10-security-best-practices.md) |
| The seven components, language-neutrally | [12-any-stack.md](12-any-stack.md) |
| Callback rules an AI flow must not break | [08-callbacks.md](08-callbacks.md) |
| SMS length and encoding limits | [02-sms.md](02-sms.md) |
