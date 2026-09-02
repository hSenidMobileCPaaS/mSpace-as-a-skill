# Getting Started with mSpace

## What mSpace is

mSpace is Mobitel's application platform for **Sri Lanka**. Its own summary is "Making Apps
Should Be Easy" — it lets a developer or company use carrier capabilities (sending SMS, running
USSD menus, managing subscriptions, charging a mobile account, locating a handset) through plain
JSON-over-HTTPS APIs, without a direct operator integration.

- **Site:** <https://mspace.lk>
- **API documentation:** <https://mspace.lk/API_Documentation/mobitel_tap_api.html>
- **OpenAPI document:** <https://mspace.lk/API_Documentation/openapi.json>
- **Operator page:** <https://www.mobitel.lk/mspace>

### Two tracks: Inzpire and Xpand

| | **Inzpire** | **Xpand** |
|---|---|---|
| Audience | Developers | Non-developers |
| You write the code | Yes | No |
| You host an endpoint | Yes — required | No |
| API access | Full: SMS, USSD, CaaS, Subscription, OTP, LBS | None (template applications) |
| Customisation | Full | Template-bound |

**This skill is about Inzpire.** Xpand covers four ready-made application types created and
managed through the platform without code — **Contact** (subscribers reach you), **Vote**
(subscribers vote for a contestant), **Alert** (subscribers receive instant notifications) and
**Scheduled Messages** (notifications sent on an hourly, daily, weekly or monthly schedule). If a
user wants one of those and nothing more, an Xpand application is a better answer than an
integration — say so rather than building it.

### Operator

Provisioning asks you to select the operator; the mSpace guide describes **Mobitel** as the prime
provider of the APIs. mSpace does not publish a per-operator prefix table, so do not assume one —
whitelist the numbers you intend to test with and let the platform route.

## Before you provision

The provisioning form asks for things that must already exist. Get these ready first:

1. **A hosted, publicly reachable HTTPS endpoint.** The platform pushes MO SMS, USSD requests,
   delivery reports, subscription notifications and charging notifications *to you*. Without a
   live URL these flows cannot be configured. `localhost` will not work — use a tunnel (ngrok,
   Cloudflare Tunnel) for development only.
2. **The static egress IP of the server that will call mSpace.** This is what goes in *Allowed
   Host Address*. Determine it **on that server**, not on a laptop: a laptop IP, a CI runner IP
   or a rotating serverless IP will fail with `E1303` in production.
3. **A decision on charging** — amount, currency and frequency, for prepaid and postpaid
   separately. It is disclosed to end users before they subscribe.
4. **A decision on which APIs you need.** You can only call what you provisioned; anything else
   fails with `E1309` no matter how correct the payload is.

There is a local simulator, so you can build and exercise the whole integration before any of
this exists — see [Testing before provisioning](#testing-before-provisioning) below.

## Provisioning walkthrough (Inzpire)

From the mSpace platform: click the **Inzpire** icon, then **+** to create a new application.

### Basic page

| Field | What it means | Get this wrong and… |
|---|---|---|
| Application Name | The name of your application | Rejected as duplicate |
| Application Description | Read by a human approver. More than 4 and fewer than 1000 characters. | Approval delayed; be specific about the use case |
| **Allowed Host Address** | A valid host address your application might be hosted at | Every call fails `E1303` |
| **Whitelisted Numbers** | Mobile numbers used to test the application | Your test number silently does nothing (`E1343`) |
| Blacklisted Numbers | Mobile numbers restricted from accessing the application | — |

**Save Draft** keeps a partly-filled form for later; **Discard Changes** ends the creation
procedure.

### Advanced page

- **Enable Automatic Content Governance** — fixed value `yes`.
- **Enable Advertisements** — fixed value `yes`.
- **Enable Mobile Number Masking** — fixed value `yes`. **This changes what your code receives**:
  `subscriberId` and `sourceAddress` arrive as masked numbers rather than plain MSISDNs. Design
  for it from the start and treat the value as opaque.
- **Start date and time** for the application to go live, and an **expire date and time** if the
  application should stop providing the service on a given date.

Then select the **Mobitel** operator, and at least one API to continue: **SMS**, **USSD**,
**CaaS** or **Subscription**.

### SMS configuration

| Field | What it is |
|---|---|
| Message Receiving URL | Where the platform delivers subscribers' messages — your MO callback |
| Default Sender Address | The name you send under, for example `mSpaceApps` |
| Send Address Aliases | Other names you may send under |
| Delivery Report URL | Where delivery reports land — your DLR callback |
| SMS Short Code | The short code subscribers send messages to |
| SMS Keyword | The unique short name that routes an SMS to *your* application |
| Charged Party | The party charged on usage |
| Charging Amount | The amount charged from the charging party |
| Mobile Originated / Mobile Terminated | Subscriber-to-app and app-to-subscriber directions |

### USSD configuration

| Field | What it is |
|---|---|
| Connection URL | Where the platform delivers subscribers' USSD input — your USSD callback |
| Service Code | The short code the USSD is sent to |
| Key Word | The unique short number sent along with the service code |
| Charged Party / Charging Amount | Who is charged, and how much |

### CaaS configuration

| Field | What it is |
|---|---|
| Charging Notification URL | Where a notification is sent after charging completes |
| Payment instruments | At least one must be selected, apart from In-App Purchasing and Debit Requests |
| Debit Requests | Enables charging subscribers for your service |

### Subscription configuration

| Field | What it is |
|---|---|
| Subscription Response Message | Sent to the subscriber on subscription |
| Unsubscription Response Message | Sent to the subscriber on unsubscription |
| Subscription Notification URL | Where subscription changes are delivered — your notification callback |
| Maximum subscriptions per day | A cap on new subscriptions |
| Charging frequency and amount | `monthly` or `daily`, with an amount, for prepaid and postpaid customer bases separately |

## Application states

Status code `E1104` — *Application is Not in Active or Limited Production Status* — names the two
states the platform will serve. **Limited Production** is where only the numbers in *Whitelisted
Numbers* can use the application, and it is your real integration-test environment. Budget for it
being where you find every bug: build with real credentials against whitelisted test numbers.

## Credentials

Provisioning gives you two values:

```
applicationId   APP_001807       — identifies the application
password        …                — authenticates it
```

For the CaaS services the documentation is explicit about where the password comes from: *"This
API key will be sent to your registered email address on the platform upon application
approval."*

They are a symmetric shared secret with full authority over your application, including the
ability to charge your subscribers real money. Handle them accordingly —
[10-security-best-practices.md](10-security-best-practices.md) is not optional reading.

## Environments

The only thing that changes between environments is environment variables.

| Stage | Target | How |
|---|---|---|
| Local development | The mSpace simulator, or your own mock | Point the service URLs at `http://localhost:10001/…` |
| Integration test | Real platform, Limited Production | Real credentials, whitelisted numbers only |
| Production | Real platform | Same code, different env values |

### Configure one URL per provisioned service

Your application can only call the APIs it was provisioned for. So the configuration is not a
single base URL — it is **one endpoint variable per service you enabled**:

```bash
MSPACE_APP_ID=APP_001807
MSPACE_PASSWORD=…

# Only the services enabled on this application:
MSPACE_SMS_SEND_URL=https://api.mspace.lk/sms/send
MSPACE_SUBSCRIPTION_SEND_URL=https://api.mspace.lk/subscription/send
MSPACE_SUBSCRIPTION_QUERY_BASE_URL=https://api.mspace.lk/subscription/query-base
```

An unset endpoint is meaningful: it means that API is not enabled, and your client should refuse
to call it locally rather than send a request that fails `E1309` at the platform. Pointing one of
them at the simulator is the whole local-development switch:

```bash
MSPACE_SMS_SEND_URL=http://localhost:10001/sms/send
```

Never branch on an environment name (`NODE_ENV`, `APP_ENV`, `ASPNETCORE_ENVIRONMENT`, a Spring
profile) inside the client to pick a URL, and never inline one. Read them from config so the same
build runs everywhere. See [templates/.env.example](../templates/.env.example) — the variable
names are identical in every language — and the config module for your stack in
[templates/](../templates/README.md).

## Testing before provisioning

mSpace ships a **developer bundle** with a local simulator, linked from the Inzpire services page
at <https://mspace.lk/serviceInzpire.html>.

Prerequisites (from <https://mspace.lk/prerequisite.html>): **Java version 1.6.0 or above**.

```bash
# 1. Extract developer_bundle.zip
# 2. Take the bin folder inside sdk-standalone-1.1.7, inside the mSpace Simulator folder
# 3. From that path:
sdp-simulator.bat console     # Windows
sh sdp-simulator console      # Linux

# 4. Open the simulator
#    http://localhost:10001/
#
# Ctrl+C stops it.
```

That is the supported way to exercise the integration end to end before an application exists.
Point your `MSPACE_*_URL` variables at the simulator and everything else in your code stays the
same.

## Your first call against the real platform

The cheapest way to prove credentials, whitelisting and connectivity all work is Query Base — it
needs no subscriber and charges nothing:

```bash
curl -X POST 'https://api.mspace.lk/subscription/query-base' \
  --header 'Content-Type: application/json;charset=utf-8' \
  --data '{"applicationId":"'"$MSPACE_APP_ID"'","password":"'"$MSPACE_PASSWORD"'"}'
```

| Response | Meaning |
|---|---|
| `S1000` + `baseSize` | Everything works |
| `E1313` | Wrong `applicationId`/`password`, or the application is not active |
| `E1303` | This machine's IP is not in Allowed Host Address |
| `E1309` | The Subscription API is not provisioned for this application |
| `E1104` | The application is not in Active or Limited Production status |
| Connection timeout | Network/firewall, or you are behind a proxy |

More smoke tests: [scripts/smoke-test.sh](../scripts/smoke-test.sh). Every other endpoint in the
same runnable form, with its parameters and response defined:
[14-curl-reference.md](14-curl-reference.md) — start there whatever language you will build in,
because a call proven by hand is one you cannot get wrong in code.

## Where to go for help

- <https://mspace.lk> — the platform, the tutorials and the API documentation
- <https://www.mobitel.lk/mspace> — the operator's mSpace page

When you raise an issue, quote the `requestId`, `externalTrxId`, `internalTrxId` or `sessionId`
and the `statusCode` — those are what a trace is built from.
