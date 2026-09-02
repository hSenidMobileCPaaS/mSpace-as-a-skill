/**
 * mSpace API client.
 *
 * One `post()` helper injects credentials, applies a timeout, and turns
 * unsuccessful responses into typed errors. Every service is a thin wrapper
 * that resolves its endpoint through `requireEndpoint()` — so calling an API
 * your application was not provisioned for fails locally with a clear message,
 * rather than as E1309 from the platform.
 *
 * The one thing that is NOT global here: success. `S1000` is the default, CaaS
 * OTP generation succeeds with `P1003`, and Subscriber List also accepts
 * `S1001`. The success set is a parameter of `post()`, not a constant.
 *
 * SERVER-SIDE ONLY.
 */

import https from "node:https";
import { randomUUID } from "node:crypto";
import { config, requireEndpoint } from "./mspace-config";
import type {
  CaasGenerateOtpResponse,
  CaasVerifyOtpResponse,
  ChargingInfoResponse,
  LbsRequestInput,
  LbsRequestResponse,
  MspaceBaseResponse,
  NotificationFrequency,
  OtpApplicationMetaData,
  OtpRequestResponse,
  OtpVerifyResponse,
  QueryBaseResponse,
  SmsEncoding,
  SmsSendResponse,
  SubscriberListResponse,
  SubscriptionSendResponse,
  SubscriptionStatusResponse,
  UssdSendResponse,
} from "./mspace-types";

/** A single outbound call should never hang. Protocol constant, not config. */
const TIMEOUT_MS = 15_000;

/**
 * If an mSpace host serves an incomplete certificate chain, Node rejects it.
 *
 * Do NOT "fix" that by disabling verification. Disabling it lets anyone on the
 * path present their own certificate and read the applicationId and password
 * that can charge your subscribers. The correct fix is to supply the missing
 * intermediate CA:
 *
 *   const agent = new https.Agent({ ca: fs.readFileSync("certs/mspace-chain.pem") });
 *
 * See references/10-security-best-practices.md.
 */
const agent = new https.Agent({ keepAlive: true });

/* ── Errors ──────────────────────────────────────────────────────────────── */

/** Platform-side. Worth retrying with backoff. */
const TRANSIENT = new Set([
  "E1100", "E1105", "E1300", "E1316", "E1318", "E1319", "E1341",
  "E1601", "E1603", "E1857", "E9999",
]);

/** Provisioning or credentials are wrong. Retrying will never help. */
const CONFIGURATION = new Set([
  "E1102", "E1104", "E1301", "E1302", "E1303", "E1309", "E1311",
  "E1313", "E1315", "E1329", "E1330", "E1331", "E1371",
  "E1604", "E1607", "E1608",
]);

/**
 * Success codes that are NOT S1000.
 *
 * P1003 is the documented success of CaaS OTP generation — the OTP went out,
 * nothing is charged yet. S1001 means Subscriber List worked and matched
 * nobody. A client that only accepts S1000 reports both as failures.
 */
export const SUCCESS = {
  default: ["S1000"] as const,
  caasOtpGeneration: ["P1003"] as const,
  subscriberList: ["S1000", "S1001"] as const,
};

export class MspaceError extends Error {
  constructor(
    readonly statusCode: string,
    readonly statusDetail: string,
    readonly service: string,
    readonly raw?: unknown
  ) {
    super(`[${statusCode}] ${statusDetail} (${service})`);
    this.name = "MspaceError";
  }
  get retryable() { return TRANSIENT.has(this.statusCode); }
  get isConfiguration() { return CONFIGURATION.has(this.statusCode); }
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * Normalise a subscriber address. The ONLY place `tel:` is added.
 *
 * Accepts an already-prefixed address, a masked value, `+94…`, `0094…` or a
 * local `07…` number.
 *
 * Do NOT push an SMS `sourceAddress` through this — that is a sender alias or
 * short code, not a subscriber address, and it carries no tel: prefix.
 */
export function toTelAddress(msisdn: string): string {
  const trimmed = (msisdn ?? "").trim();
  if (!trimmed) throw new Error("[mspace] Empty subscriber address");
  if (trimmed.toLowerCase().startsWith("tel:")) return trimmed;

  let digits = trimmed.replace(/[\s()-]/g, "").replace(/^\+/, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 10) digits = "94" + digits.slice(1);

  return `tel:${digits}`;
}

/** Mask a subscriber address for logging. Never log the raw value. */
export function maskAddress(address: string): string {
  const body = address.replace(/^tel:/i, "");
  if (body.length <= 6) return "tel:***";
  return `tel:${body.slice(0, 3)}${"*".repeat(body.length - 6)}${body.slice(-3)}`;
}

/**
 * A unique, persistable idempotency key for a charge.
 *
 * mSpace publishes no length limit for externalTrxId, so this is simply a
 * value that will never collide. Persist it BEFORE the charge call.
 */
export function generateExternalTrxId(): string {
  return randomUUID().replace(/-/g, "");
}

/**
 * The human-readable message, wherever mSpace put it.
 *
 * Every service uses `statusDetail` except CaaS OTP verification, which uses
 * `statusDescription`. A reader that only knows one loses the message on
 * exactly the call that took someone's money.
 */
export function detailOf(data: MspaceBaseResponse): string {
  return data.statusDetail ?? data.statusDescription ?? "";
}

/* ── Core ────────────────────────────────────────────────────────────────── */

async function post<T extends MspaceBaseResponse>(
  service: string,
  url: string,
  body: Record<string, unknown>,
  successCodes: readonly string[] = SUCCESS.default
): Promise<T> {
  const payload = JSON.stringify({
    applicationId: config.applicationId,
    password: config.password,
    ...body,
  });

  const data = await request<T>(url, payload);

  // The HTTP status is deliberately never consulted: mSpace returns 200 for
  // application-level failures, and the real outcome is statusCode.
  if (successCodes.includes(data.statusCode)) return data;

  throw new MspaceError(data.statusCode, detailOf(data), service, data);
}

function request<T>(url: string, body: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: "POST",
        agent,
        timeout: TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json;charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(
              new Error(`Non-JSON response (HTTP ${res.statusCode}): ${text.slice(0, 200)}`)
            );
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`mSpace request timed out after ${TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/* ── SMS ─────────────────────────────────────────────────────────────────── */

export interface SendSmsOptions {
  /** The Default Sender Address or a configured alias — not a tel: address. E1331 otherwise. */
  sourceAddress?: string;
  /** "1" requests a delivery report to your Delivery Report URL. */
  deliveryStatusRequest?: "0" | "1";
  /** 0 Text (default) / 240 Flash / 245 Binary, hex-encoded. */
  encoding?: SmsEncoding;
  /** Hex-encoded UDH. Only meaningful with encoding 245. */
  binaryHeader?: string;
}

/** Send an MT SMS to one or more subscribers. */
export function sendSms(
  to: string | string[],
  message: string,
  options: SendSmsOptions = {}
): Promise<SmsSendResponse> {
  const recipients = (Array.isArray(to) ? to : [to]).map(toTelAddress);
  if (recipients.includes("tel:all")) {
    throw new Error("[mspace] Use broadcastSms() for tel:all — broadcasts must be deliberate.");
  }
  return post<SmsSendResponse>("sms-send", requireEndpoint("smsSend"), {
    version: "1.0",
    message,
    destinationAddresses: recipients,
    ...options,
  });
}

/**
 * Send to the ENTIRE subscribed base of the application.
 *
 * `tel:all` is documented, and it does exactly what it says. Deliberately
 * separate from sendSms so it can never be reached by accident — check the
 * subscriber base size first with queryBase(), and put an authorisation check
 * in front of this.
 */
export function broadcastSms(
  message: string,
  confirmation: "I_HAVE_VERIFIED_THIS_GOES_TO_ALL_SUBSCRIBERS",
  options: SendSmsOptions = {}
): Promise<SmsSendResponse> {
  if (confirmation !== "I_HAVE_VERIFIED_THIS_GOES_TO_ALL_SUBSCRIBERS") {
    throw new Error("[mspace] Broadcast confirmation token missing");
  }
  return post<SmsSendResponse>("sms-send", requireEndpoint("smsSend"), {
    version: "1.0",
    message,
    destinationAddresses: ["tel:all"],
    ...options,
  });
}

/* ── USSD ────────────────────────────────────────────────────────────────── */

/**
 * Send a USSD screen.
 *
 * `sessionId` MUST be the one the USSD Gateway sent you. Use "mt-fin" for the
 * final screen — anything else leaves the session hanging until the network
 * times it out.
 */
export function sendUssd(input: {
  sessionId: string;
  destinationAddress: string;
  message: string;
  operation: "mt-init" | "mt-cont" | "mt-fin";
}): Promise<UssdSendResponse> {
  return post<UssdSendResponse>("ussd-send", requireEndpoint("ussdSend"), {
    version: "1.0",
    message: input.message,
    sessionId: input.sessionId,
    ussdOperation: input.operation,
    destinationAddress: toTelAddress(input.destinationAddress),
    encoding: "440",
  });
}

/* ── Subscription ────────────────────────────────────────────────────────── */

/** Opt a subscriber in. Only call this with recorded, explicit consent. */
export function register(subscriberId: string): Promise<SubscriptionSendResponse> {
  return post<SubscriptionSendResponse>(
    "subscription-register",
    requireEndpoint("subscriptionSend"),
    { subscriberId: toTelAddress(subscriberId), action: "1" }
  );
}

/** Opt a subscriber out. Make it as reachable as register, in every channel. */
export function unregister(subscriberId: string): Promise<SubscriptionSendResponse> {
  return post<SubscriptionSendResponse>(
    "subscription-unregister",
    requireEndpoint("subscriptionSend"),
    { subscriberId: toTelAddress(subscriberId), action: "0" }
  );
}

/**
 * Check one subscriber's status. For reconciliation, not per-request gating.
 *
 * The result is one of six statuses, not two: INITIAL, REG_PENDING, TRIAL,
 * REGISTERED, UNREGISTERED, TEMPORARY_BLOCKED.
 */
export function getSubscriptionStatus(
  subscriberId: string
): Promise<SubscriptionStatusResponse> {
  return post<SubscriptionStatusResponse>(
    "subscription-status",
    requireEndpoint("subscriptionStatus"),
    { subscriberId: toTelAddress(subscriberId) }
  );
}

/**
 * Subscriber base size. Needs no subscriber and charges nothing, which also
 * makes it the best connectivity and credential smoke test.
 *
 * `baseSize` comes back as a string, so a parsed number is returned alongside.
 */
export async function queryBase(): Promise<QueryBaseResponse & { size: number }> {
  const res = await post<QueryBaseResponse>(
    "subscription-query-base",
    requireEndpoint("subscriptionQueryBase"),
    {}
  );
  return { ...res, size: Number.parseInt(res.baseSize ?? "0", 10) };
}

/**
 * Subscription status and last-charge details for up to ten subscribers.
 *
 * Every entry carries its own statusCode — one subscriber failing does not fail
 * the request, so read the per-entry code rather than only the top-level one.
 */
export function getSubscriberChargingInfo(
  subscriberIds: string[]
): Promise<ChargingInfoResponse> {
  if (subscriberIds.length > 10) {
    throw new Error("[mspace] getSubscriberChargingInfo accepts at most 10 subscriberIds");
  }
  return post<ChargingInfoResponse>(
    "subscription-charging-info",
    requireEndpoint("subscriptionChargingInfo"),
    { subscriberIds: subscriberIds.map(toTelAddress) }
  );
}

/**
 * One page of the subscriber list — the catch-up mechanism for subscription
 * notifications you missed.
 *
 * S1001 ("No Subscribers Found") is a SUCCESS: the request worked and matched
 * nobody. Page until moreDataAvailable is false; nextPageNumber is -1 when
 * there is no next page.
 */
export function getSubscriberList(requestPage: number): Promise<SubscriberListResponse> {
  if (!Number.isInteger(requestPage) || requestPage < 1) {
    throw new Error("[mspace] requestPage must be an integer of 1 or greater (E1106)");
  }
  return post<SubscriberListResponse>(
    "subscription-list",
    requireEndpoint("subscriptionList"),
    { version: "1.0", requestPage },
    SUCCESS.subscriberList
  );
}

/** Send a subscription notification to a subscriber. */
export function notifySubscriber(input: {
  subscriberId: string;
  frequency: NotificationFrequency;
  status: string;
  /** "yyMMddHHmm". Defaults to now. */
  timeStamp?: string;
}): Promise<MspaceBaseResponse> {
  return post<MspaceBaseResponse>(
    "subscription-notify",
    requireEndpoint("subscriptionNotify"),
    {
      timeStamp: input.timeStamp ?? formatNotifyTimestamp(new Date()),
      version: "1.0",
      subscriberId: toTelAddress(input.subscriberId),
      frequency: input.frequency,
      status: input.status,
    }
  );
}

/** yyMMddHHmm, the documented timestamp format for subscriber notifications. */
export function formatNotifyTimestamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    p(date.getUTCFullYear() % 100) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes())
  );
}

/* ── OTP (subscription activation) ───────────────────────────────────────── */

/**
 * Send an OTP to a plain mobile number.
 *
 * Rate-limit per number AND per IP before calling, or the application becomes
 * an SMS-bombing tool. Keep the returned referenceNo server-side, and never
 * log it.
 */
export function requestOtp(input: {
  subscriberId: string;
  metaData?: OtpApplicationMetaData;
  applicationHash?: string;
}): Promise<OtpRequestResponse> {
  return post<OtpRequestResponse>("otp-request", requireEndpoint("otpRequest"), {
    subscriberId: toTelAddress(input.subscriberId),
    ...(input.metaData ? { applicationMetaData: input.metaData } : {}),
    ...(input.applicationHash ? { applicationHash: input.applicationHash } : {}),
  });
}

/**
 * Verify an OTP and activate the subscription.
 *
 * mSpace does not publish the validity window or the attempt limit — E1851
 * (expired) and E1852 (attempts reached) are what you get when either is hit,
 * so enforce your own limits too. The returned subscriberId is the masked
 * identifier to use for every subsequent call.
 */
export function verifyOtp(input: {
  referenceNo: string;
  otp: string;
}): Promise<OtpVerifyResponse> {
  return post<OtpVerifyResponse>("otp-verify", requireEndpoint("otpVerify"), {
    referenceNo: input.referenceNo,
    otp: input.otp,
  });
}

/* ── CaaS ────────────────────────────────────────────────────────────────── */

/**
 * Step 1 of a charge: generate and send the OTP.
 *
 * THIS STARTS A REAL CHARGE. It does not complete one.
 *
 * - The success code is P1003, not S1000. Nothing has been charged yet; mSpace
 *   has SMSed an OTP to the subscriber.
 * - `externalTrxId` is your idempotency key. Generate it with
 *   generateExternalTrxId(), PERSIST IT, then call this.
 * - Persist `requestCorrelator` from the response — step 3 needs it — and
 *   `internalTrxId`, which is what support traces with.
 * - There are deliberately no retries here. A timeout does NOT mean nothing
 *   happened. Settle unknown outcomes from the charging notification. Never
 *   re-roll the id.
 */
export function startCharge(input: {
  subscriberId: string;
  amount: string;
  externalTrxId: string;
  currency?: string;
  /** Optional integrity hash over agreed parameters, e.g. SHA-256. */
  applicationHash?: string;
}): Promise<CaasGenerateOtpResponse> {
  if (!input.externalTrxId) {
    throw new Error("[mspace] externalTrxId is required and must be persisted first");
  }
  return post<CaasGenerateOtpResponse>(
    "caas-otp-generation",
    requireEndpoint("caasDebit"),
    {
      externalTrxId: input.externalTrxId,
      subscriberId: toTelAddress(input.subscriberId),
      paymentInstrumentName: "Mobile Account",
      amount: input.amount,
      currency: input.currency ?? "LKR",
      ...(input.applicationHash ? { applicationHash: input.applicationHash } : {}),
    },
    SUCCESS.caasOtpGeneration
  );
}

/**
 * Step 3 of a charge: verify the OTP the subscriber entered.
 *
 * THIS IS THE CALL THAT MOVES THE MONEY.
 *
 * `referenceNo` is the `requestCorrelator` from startCharge(), NOT your
 * externalTrxId — sending the wrong one gives E1855. The response carries
 * `statusDescription` rather than `statusDetail`, plus a boolean `status`.
 *
 * The final outcome still arrives on the charging notification. Confirm there.
 */
export function confirmCharge(input: {
  requestCorrelator: string;
  otp: string;
  sourceAddress: string;
}): Promise<CaasVerifyOtpResponse> {
  return post<CaasVerifyOtpResponse>(
    "caas-otp-verify",
    requireEndpoint("caasOtpVerify"),
    {
      referenceNo: input.requestCorrelator,
      otp: input.otp,
      sourceAddress: toTelAddress(input.sourceAddress),
    }
  );
}

/* ── LBS ─────────────────────────────────────────────────────────────────── */

/**
 * Request a subscriber's location. mSpace returns it only if the subscriber
 * has granted permission.
 *
 * `requesterId` (who is asking) and `subscriberId` (who is being located) are
 * two different mandatory fields. Swapping them locates the wrong person.
 *
 * Requires explicit, purpose-specific consent — consent to receive SMS is not
 * consent to be located.
 */
export function requestLocation(
  input: Omit<LbsRequestInput, "applicationId" | "password">
): Promise<LbsRequestResponse> {
  return post<LbsRequestResponse>("lbs-request", requireEndpoint("lbsRequest"), {
    requesterId: toTelAddress(input.requesterId),
    subscriberId: toTelAddress(input.subscriberId),
    ...(input.version ? { version: input.version } : {}),
    ...(input.serviceType ? { serviceType: input.serviceType } : {}),
  });
}

/**
 * Parse an LBS fix, or null.
 *
 * latitude and longitude are strings and absent on failure, so check before
 * reading. The range check is your own sanity guard, not a platform rule.
 */
export function parseFix(
  response: LbsRequestResponse
): { latitude: number; longitude: number } | null {
  if (!response.latitude || !response.longitude) return null;
  const latitude = Number.parseFloat(response.latitude);
  const longitude = Number.parseFloat(response.longitude);
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) return null;
  // Sri Lanka spans roughly 5.9–9.9 N, 79.5–81.9 E. Anything well outside that
  // is a bad fix or a swapped pair — discard rather than plot it.
  if (latitude < 5.5 || latitude > 10.5 || longitude < 79 || longitude > 82.5) return null;
  return { latitude, longitude };
}

/* ── Extension point ─────────────────────────────────────────────────────── */

/**
 * Adding a service mSpace publishes later:
 *
 *   1. Add its URL variable to .env.example and to `endpoints` in
 *      mspace-config.ts
 *   2. Add request/response interfaces to mspace-types.ts
 *   3. Add one wrapper here:
 *
 *        export function newThing(input: NewThingInput): Promise<NewThingResponse> {
 *          return post<NewThingResponse>("new-thing", requireEndpoint("newThing"), { ...input });
 *        }
 *
 * It inherits credential injection, the timeout, error mapping and the
 * not-provisioned guard for free. Do not build a parallel client.
 */
