/**
 * mSpace request/response types.
 *
 * Field names and optionality follow the official documentation at
 * https://mspace.lk/API_Documentation/mobitel_tap_api.html. Note that mSpace
 * sends numbers as strings (baseSize, amount, latitude, longitude, TotalAmount)
 * — the types reflect the wire format, not what you wish it were. Parse at the
 * boundary.
 */

/* ── Common ──────────────────────────────────────────────────────────────── */

/**
 * Every mSpace response carries at least these.
 *
 * `statusDetail` is optional because CaaS OTP Verification calls it
 * `statusDescription` instead. Read both.
 */
export interface MspaceBaseResponse {
  statusCode: string;
  statusDetail?: string;
  statusDescription?: string;
  version?: string;
  requestId?: string;
}

/** Credentials injected by the client — never build these at a call site. */
export interface MspaceCredentials {
  applicationId: string;
  password: string;
}

/**
 * A subscriber address. Always `tel:`-prefixed. May be a plain MSISDN
 * (`tel:94702725777`) or, when Mobile Number Masking is enabled for the
 * application, a masked value. Treat it as opaque either way.
 */
export type TelAddress = `tel:${string}`;

/** SMS to the entire subscribed base of the application. Guard its use. */
export const BROADCAST_ADDRESS = "tel:all" as const;

/* ── SMS ─────────────────────────────────────────────────────────────────── */

export type SmsEncoding = "0" | "240" | "245"; // Text | Flash | Binary (hex)

export interface SmsSendRequest extends MspaceCredentials {
  /** Mandatory on this endpoint. */
  version: string;
  message: string;
  /** Always an array, even for a single recipient. */
  destinationAddresses: string[];
  /** The Default Sender Address or a configured Send Address Alias — NOT a tel: address. */
  sourceAddress?: string;
  /** "0" = not required, "1" = required. */
  deliveryStatusRequest?: "0" | "1";
  encoding?: SmsEncoding;
  /** Hex-encoded UDH. Only meaningful with encoding 245. */
  binaryHeader?: string;
}

export interface SmsDestinationResponse {
  address?: string;
  messageId?: string;
  statusCode?: string;
  statusDetail?: string;
  timeStamp?: string;
}

export interface SmsSendResponse extends MspaceBaseResponse {
  /**
   * Per-recipient results, one per address in the request. There is no
   * top-level messageId — the identifiers live here, and a multi-recipient
   * send can partially succeed.
   */
  destinationResponses?: SmsDestinationResponse[];
}

/** Inbound: MO SMS — what the platform POSTs to your Message Receiving URL. */
export interface MoSmsCallback {
  version: string;
  applicationId: string;
  sourceAddress: string;
  message: string;
  requestId: string;
  encoding: SmsEncoding;
}

/**
 * Delivery status. mSpace documents the long forms; the underlying SMPP layer
 * commonly uses the abbreviated ones. Accept both and normalise on the way in.
 */
export type DeliveryStatus =
  | "DELIVERED" | "EXPIRED" | "DELETED" | "UNDELIVERABLE"
  | "ACCEPTED" | "UNKNOWN" | "REJECTED"
  | "DELIVRD" | "UNDELIV" | "ACCEPTD" | "REJECTD";

/** Inbound: delivery report. */
export interface DeliveryReportCallback {
  destinationAddress: string;
  /** Documented as yyMMddHHmm; the documented sample is 14 digits. Parse on length. */
  timeStamp: string;
  requestId: string;
  deliveryStatus: DeliveryStatus;
}

/* ── USSD ────────────────────────────────────────────────────────────────── */

/** Set by the platform on inbound; set by your app on outbound. */
export type UssdOperation =
  | "mo-init"  // platform: subscriber started a session
  | "mo-cont"  // platform: subscriber replied
  | "mt-init"  // app: app-initiated session
  | "mt-cont"  // app: next screen, session stays open
  | "mt-fin";  // app: final screen, session closes

export interface UssdSendRequest extends MspaceCredentials {
  /** Mandatory on this endpoint. */
  version: string;
  message: string;
  /** Echo the sessionId the USSD Gateway gave you. Never generate your own. */
  sessionId: string;
  ussdOperation: Extract<UssdOperation, "mt-init" | "mt-cont" | "mt-fin">;
  destinationAddress: string;
  /** "440" = plain ASCII characters. */
  encoding?: "440";
}

export interface UssdSendResponse extends MspaceBaseResponse {
  timeStamp?: string;
}

/** Inbound: USSD keypress or session start, to your Connection URL. */
export interface UssdReceiveCallback {
  version: string;
  applicationId: string;
  message: string;
  requestId: string;
  sessionId: string;
  ussdOperation: Extract<UssdOperation, "mo-init" | "mo-cont">;
  sourceAddress: string;
  vlrAddress?: string;
  encoding: "440";
}

/* ── Subscription ────────────────────────────────────────────────────────── */

/** "1" = opt in (register), "0" = opt out (unregister). */
export type SubscriptionAction = "1" | "0";

/**
 * Six statuses, not two. INITIAL, REG_PENDING and TEMPORARY_BLOCKED are live
 * subscribers in some state of trouble — do not fold them into UNREGISTERED.
 */
export type SubscriptionStatus =
  | "INITIAL"
  | "REG_PENDING"
  | "TRIAL"
  | "REGISTERED"
  | "UNREGISTERED"
  | "TEMPORARY_BLOCKED";

export interface SubscriptionSendRequest extends MspaceCredentials {
  subscriberId: string;
  action: SubscriptionAction;
}

export interface SubscriptionSendResponse extends MspaceBaseResponse {
  subscriptionStatus?: SubscriptionStatus;
}

export interface SubscriptionStatusRequest extends MspaceCredentials {
  subscriberId: string;
}

export interface SubscriptionStatusResponse extends MspaceBaseResponse {
  subscriptionStatus?: SubscriptionStatus;
}

export interface QueryBaseRequest extends MspaceCredentials {}

export interface QueryBaseResponse extends MspaceBaseResponse {
  /** Number of registered users — arrives as a string. Coerce before arithmetic. */
  baseSize?: string;
}

/** One subscriber's charging info. Which fields appear depends on the status. */
export interface SubscriberInfo {
  subscriberId: string;
  subscriptionStatus?: SubscriptionStatus;
  /** "YYYY-MM-DD hh:mm:ss". Omitted for free applications and pre-charge states. */
  lastChargedDate?: string;
  /** e.g. "30.00 LKR". "0.00 LKR" for a free application. */
  lastChargedAmount?: string;
  /** "prepaid" or "postpaid". */
  numberType?: string;
  statusCode?: string;
  statusDetail?: string;
}

export interface ChargingInfoRequest extends MspaceCredentials {
  /** Maximum 10 MSISDNs per request. */
  subscriberIds?: string[];
}

export interface ChargingInfoResponse extends MspaceBaseResponse {
  destinationResponses?: SubscriberInfo[];
}

export interface SubscriberListRequest extends MspaceCredentials {
  version?: string;
  /** Must be 1 or greater, or the request fails with E1106. */
  requestPage: number;
}

export interface SubscriberData {
  subscriberId: string;
  subscriptionStatus?: SubscriptionStatus;
  lastChargedDate?: string;
  lastChargedAmount?: string;
}

export interface SubscriberListResponse extends MspaceBaseResponse {
  /** -1 when there is no next page. */
  nextPageNumber?: number;
  moreDataAvailable?: boolean;
  subscribers?: SubscriberData | SubscriberData[];
}

export type NotificationFrequency = "daily" | "weekly" | "monthly" | "yearly";

export interface SubscriberNotifyRequest extends MspaceCredentials {
  /** "yyMMddHHmm". */
  timeStamp: string;
  version: string;
  subscriberId: string;
  frequency: NotificationFrequency;
  status: string;
}

/**
 * Inbound: subscription notification, to your Subscription Notification URL.
 *
 * mSpace publishes no separate payload for this URL. These are the fields the
 * documented `POST /subscription/notify` service defines, so accept them and
 * tolerate anything else — log the first real body and widen from there.
 */
export interface SubscriptionNotificationCallback {
  applicationId?: string;
  subscriberId?: string;
  status?: string;
  frequency?: NotificationFrequency | string;
  version?: string;
  timeStamp?: string;
  [extra: string]: unknown;
}

/* ── OTP (subscription activation) ───────────────────────────────────────── */

export interface OtpApplicationMetaData {
  /** Client type: a web browser or a mobile app. */
  client?: string;
  /** Type or OS of device — iPhone 6, Galaxy S5, PC. */
  device?: string;
  /** OS or device version — Android 6, iOS 5, Windows 10. */
  os?: string;
  /** Store identifier for an app, or the web link for a browser. */
  appCode?: string;
}

export interface OtpRequestInput extends MspaceCredentials {
  subscriberId: string;
  applicationHash?: string;
  applicationMetaData?: OtpApplicationMetaData;
}

export interface OtpRequestResponse extends MspaceBaseResponse {
  /** Keep server-side, in the session. Never send to the client. */
  referenceNo?: string;
}

export interface OtpVerifyInput extends MspaceCredentials {
  referenceNo: string;
  otp: string;
}

export interface OtpVerifyResponse extends MspaceBaseResponse {
  subscriptionStatus?: SubscriptionStatus;
  /** The masked subscriberId to use for every subsequent API call. */
  subscriberId?: string;
}

/* ── CaaS ────────────────────────────────────────────────────────────────── */

/** The only documented payment instrument. */
export type PaymentInstrumentName = "Mobile Account";

export interface CaasGenerateOtpRequest extends MspaceCredentials {
  /** Your idempotency key. Persist BEFORE calling. */
  externalTrxId: string;
  subscriberId: string;
  paymentInstrumentName: PaymentInstrumentName;
  /** Sent as a string. Hold it as a decimal type in your own code. */
  amount: string;
  /** Only "LKR" is allowed. */
  currency: string;
  /** Optional integrity hash over agreed parameters, e.g. SHA-256. */
  applicationHash?: string;
}

export interface CaasGenerateOtpResponse extends MspaceBaseResponse {
  /** SUCCESS here is "P1003", not "S1000". */
  statusCode: string;
  timeStamp?: string;
  externalTrxId?: string;
  /** Pass this as referenceNo to CaaS OTP verification. */
  requestCorrelator?: string;
  /** Persist it — this is what support traces with. */
  internalTrxId?: string;
}

export interface CaasVerifyOtpRequest extends MspaceCredentials {
  /** The requestCorrelator from OTP generation — NOT your externalTrxId. */
  referenceNo: string;
  otp: string;
  sourceAddress: string;
}

export interface CaasVerifyOtpResponse extends MspaceBaseResponse {
  /** Note: this endpoint returns statusDescription, not statusDetail. */
  statusDescription?: string;
  /** true if the OTP was valid and charging proceeded. */
  status?: boolean;
}

/** Inbound: charging notification — your reconciliation channel. */
export interface ChargingNotificationCallback {
  timeStamp?: string;
  version?: string;
  externalTrxId?: string;
  internalTrxId?: string;
  referenceId?: string;
  currency?: string;
  /** Capital T. Amount deducted as the one-time charge. */
  TotalAmount?: string;
  paidAmount?: string;
  balanceDue?: string;
  statusCode?: string;
  statusDetail?: string;
}

/* ── LBS ─────────────────────────────────────────────────────────────────── */

export type LbsServiceType = "IMMEDIATE";

export interface LbsRequestInput extends MspaceCredentials {
  version?: string;
  /** MSISDN of the subscriber REQUESTING the location. Mandatory. */
  requesterId: string;
  /** MSISDN of the subscriber WHOSE location is needed. Mandatory. */
  subscriberId: string;
  serviceType?: LbsServiceType;
}

export interface LbsRequestResponse extends MspaceBaseResponse {
  /** Capital D — messageID, not messageId. */
  messageID?: string;
  /** String; absent on failure. Sanity-check before use. */
  latitude?: string;
  longitude?: string;
  /** Handset power state. true = on, false = off. */
  subscriberState?: boolean;
  /** Lower-case s — timestamp, not timeStamp, on this endpoint alone. */
  timestamp?: string;
}
