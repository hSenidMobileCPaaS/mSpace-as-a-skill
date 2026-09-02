# Security Policy

## This repository contains no secrets

Every credential in this repo is a placeholder. `templates/.env.example` holds only `APP_XXXXXX`
and `replace-me`. CI fails the build if a credential-shaped value is committed.

If you believe a real credential has been committed here, **do not open a public issue**. Email the
maintainers privately, and rotate the credential on the mSpace platform first — rotation matters
more than disclosure timing.

## If you leak your own mSpace credentials

An `applicationId` + `password` pair can send SMS to your entire subscriber base and debit real
money from real people's mobile accounts. Treat exposure as an active incident.

1. **Rotate the password on the mSpace platform.** Do this before anything else.
2. Deploy the new value.
3. Review your application's reports for unexpected SMS volume or charges.
4. Purge from git history with `git filter-repo` — and understand that anything pushed to a public
   remote must be treated as permanently public regardless.
5. Contact mSpace if you see unauthorised usage: <https://mspace.lk> ·
   <https://www.mobitel.lk/mspace>.

Assume a credential is compromised the moment it lands anywhere shared: a commit, a chat message, a
screenshot, a log aggregator, a pasted stack trace, or an AI prompt.

Note that the CaaS API key is delivered **by email** on application approval. An inbox is not a
secret store: move it into your secret manager and delete the mail.

## Reporting a problem with this skill

Open an issue for anything that would lead an agent to write insecure code — a missing warning,
guidance that encourages hardcoding, a dangerous default in a template.

Report privately instead if the issue is directly exploitable, for example a template that leaks
credentials or a script that transmits them somewhere.

## Scope

This skill is documentation, reference templates, and an offline CLI. It:

- makes **no network calls** — `tools/mspace.mjs` reads a local JSON file and nothing else
- **never reads your credentials** — request builders emit `$MSPACE_APP_ID` placeholders
- has **no runtime dependencies**

The `scripts/smoke-test.*` scripts do call mSpace, deliberately, using credentials from your
environment. Read them before running them, and note that `--with-charge` starts a real charge and
sends an OTP to a real subscriber.

## Maintenance and licence

Owned and maintained by hSenid Mobile Solutions (Pvt) Ltd. The skill is proprietary and licensed
for use only — see [LICENSE](LICENSE).

The platform evolves, so verify anything security- or billing-critical against
<https://mspace.lk/API_Documentation/mobitel_tap_api.html> before going live, and confirm what your
application is actually provisioned for.
