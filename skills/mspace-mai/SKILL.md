---
name: mspace-mai
description: Build against mAI Tokens, mSpace's AI gateway — chat completions across Claude, Gemini and GPT models, and image generation on GPT Image, on an OpenAI-shaped API billed from an mAI Tokens balance. Use whenever the user mentions mAI Tokens, maitokens.mspace.lk, an mSpace AI or LLM feature, chat completions, model routing, or generating images through mSpace — and whenever an AI answer has to reach a subscriber over SMS or USSD.
---

# mAI Tokens — the mSpace AI gateway

One OpenAI-shaped API in front of several model providers, authenticated once against mAI Tokens
and billed from an mAI Tokens balance.

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

Full contract: **`references/15-mai-tokens.md`**. Every endpoint as a runnable curl with each
parameter defined: **`references/14-curl-reference.md`**, section *The AI gateway — mAI Tokens*.

## Read this before writing a line

**mAI Tokens is not the telco platform.** It shares the mSpace brand and nothing else — not the
host, not the credential, not the envelope. Every convention the rest of this skill teaches is
inverted here:

| | Telco APIs | mAI Tokens |
|---|---|---|
| Host | `api.mspace.lk` | `maitokens.mspace.lk` |
| Credential | `applicationId` + `password` in the **body** | one key in the `Authorization` **header** |
| Key source | the application record | the mAI Tokens portal — a **different** key |
| Failures | HTTP 200 always; branch on `statusCode` | real HTTP status codes; branch on the status, then `error.code` |
| Success | `statusCode: "S1000"` (or `P1003` / `S1001`) | HTTP 2xx. There is no `statusCode` field |
| Subject | a subscriber, `tel:947…` | no subscriber, no MSISDN, no operator |
| Inbound | five callbacks you host | none. mAI Tokens never calls you |
| Timeout | 15s | 60–120s |

**So keep two clients.** A single shared HTTP helper applies exactly one of these conventions
and is wrong for half the calls. The classic bug is an mAI Tokens client that checks `res.ok`,
then looks for `statusCode`, finds nothing, and reports a good answer as a failure.

## Auth

```
Authorization: app_<keyId>.<keyValue>
```

Verbatim, including `app_`. **Not** an OAuth bearer token — no `Bearer` prefix, no base64. Not
your mSpace application password. From `MAI_TOKENS_API_KEY`, backend only.

It is a **spend key** against a prepaid balance, and unlike the telco APIs it has **no** *Allowed
Host Address* list — a leak works from anywhere in the world until you rotate it at
<https://maitokens.mspace.lk>.

## Endpoints

| Endpoint | Purpose | Variable |
|---|---|---|
| `POST https://maitokens.mspace.lk/api/v1/chat/completions` | chat | `MAI_TOKENS_CHAT_COMPLETIONS_URL` |
| `POST https://maitokens.mspace.lk/api/v1/images/generations` | images | `MAI_TOKENS_IMAGE_GENERATIONS_URL` |

## Models

The `model` field takes these ids exactly — lowercase, hyphenated, never a display name.

| Endpoint | Models |
|---|---|
| chat | `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-3.1-pro-preview`, `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-sonnet-4-6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-4o-mini`, `gpt-5-nano` |
| images | `gpt-image-2`, `gpt-image-1.5` |

Choose per task, not per project: a lite or nano model for classification and anything on a USSD
timer, a frontier model only where answer quality is the product. Keep the id in configuration.
A model the project is not enabled for fails with `INVALID_LLM_CONFIG`.

## Six rules that are never negotiable

1. **Cap every call.** `max_completion_tokens` on every chat request, `n` at 1, image `quality`
   at `low` unless the image is the product. Without a ceiling one loop empties the balance and
   takes every AI feature down with a `402`.
2. **Redact before the prompt.** No MSISDN, no `subscriberId` (a masked value is still a stable
   identifier), no OTP, no credential, no `externalTrxId` — not in `messages`, not in `prompt`,
   not in `user`, `safety_identifier` or `prompt_cache_key`. Prompts leave your trust boundary
   and reach a third-party provider. Keep `store` false.
3. **Check `finish_reason` before using the content.** `length` means the answer is cut off
   mid-sentence; the request succeeded, the answer did not.
4. **Branch on `error.code`, not the message.** The two `429`s differ:
   `RATE_LIMIT_EXCEEDED` clears within the minute, `TOKEN_QUOTA_EXCEEDED` never will —
   retrying it burns your attempts and delays the alert that would fix it.
5. **Never call a model inside a callback response path.** mSpace wants `S1000` immediately and
   USSD sessions die in seconds. Acknowledge first, generate out of band, deliver by MT SMS or
   on the next USSD screen.
6. **Treat model output as untrusted input.** Never execute it, never interpolate it into SQL or
   a shell, and never send it to a subscriber unchecked — 160 GSM-7 characters per SMS part, 70
   for Sinhala or Tamil, and every part is billed.

## Retry policy

Retry with capped exponential backoff and jitter: `429` + `RATE_LIMIT_EXCEEDED` (honour
`Retry-After`), `500`, `502`, `503`, and transport errors. Never retry `400`, `401`, `403`,
`404`, `402`, or `429` + `TOKEN_QUOTA_EXCEEDED` — alert on those instead. Chat completions have
no idempotency key, so a timed-out call may already have been billed: cap retries at two.

`INVALID_LLM_CONFIG` is the mAI Tokens `E1309` — provisioning, not payload. No reformatting fixes
it.

## Build it in the project's own stack

Same as everywhere else in this skill: two HTTPS POSTs, no privileged runtime, no SDK required.
Translate the curl in `references/14-curl-reference.md` into the host project's HTTP client.
`references/12-any-stack.md` specifies the surrounding components; `references/15-mai-tokens.md`
says how each one differs for mAI Tokens, and closes with a pre-ship checklist.

Related skills: `mspace` (the telco platform), `mspace-callbacks` (what an AI flow must not
block), `mspace-review`, `mspace-debug`.
