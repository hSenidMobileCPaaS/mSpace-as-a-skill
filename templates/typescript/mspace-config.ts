/**
 * mSpace configuration — the ONLY module that reads process.env.
 *
 * Two credentials, plus one URL per service you provisioned. Nothing else is
 * configuration: timeouts and encodings are constants in the client, because
 * they are properties of the protocol rather than of your deployment.
 *
 * An endpoint that is not set means that API is not enabled on your
 * application. The client refuses to call it, so you get a clear local error
 * instead of E1309 from the platform.
 *
 * Validation runs at import time, so a misconfigured deployment fails at boot
 * rather than under load.
 *
 * SERVER-SIDE ONLY. Importing this into client code would bundle the password
 * into something a user can read.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `[mspace] Missing required environment variable ${name}.\n` +
        `Copy .env.example to .env and fill in your mSpace credentials.\n` +
        `In production, set it in your host's secret manager.`
    );
  }
  return value.trim();
}

/** An endpoint is optional: absent means that API is not provisioned. */
function endpoint(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim().replace(/\/+$/, "") : undefined;
}

export const config = {
  /** Never log these. Never send them to a client. */
  applicationId: requireEnv("MSPACE_APP_ID"),
  password: requireEnv("MSPACE_PASSWORD"),

  /**
   * Only the services enabled on your application. Point any of these at the
   * mSpace simulator from the developer bundle during development — that is
   * the whole environment switch.
   */
  endpoints: {
    smsSend: endpoint("MSPACE_SMS_SEND_URL"),
    ussdSend: endpoint("MSPACE_USSD_SEND_URL"),
    subscriptionSend: endpoint("MSPACE_SUBSCRIPTION_SEND_URL"),
    subscriptionStatus: endpoint("MSPACE_SUBSCRIPTION_STATUS_URL"),
    subscriptionQueryBase: endpoint("MSPACE_SUBSCRIPTION_QUERY_BASE_URL"),
    subscriptionChargingInfo: endpoint("MSPACE_SUBSCRIPTION_CHARGING_INFO_URL"),
    subscriptionList: endpoint("MSPACE_SUBSCRIPTION_LIST_URL"),
    subscriptionNotify: endpoint("MSPACE_SUBSCRIPTION_NOTIFY_URL"),
    otpRequest: endpoint("MSPACE_OTP_REQUEST_URL"),
    otpVerify: endpoint("MSPACE_OTP_VERIFY_URL"),
    caasDebit: endpoint("MSPACE_CAAS_DEBIT_URL"),
    caasOtpVerify: endpoint("MSPACE_CAAS_OTP_VERIFY_URL"),
    lbsRequest: endpoint("MSPACE_LBS_REQUEST_URL"),
  },
} as const;

export type ServiceName = keyof typeof config.endpoints;

/**
 * Resolve an endpoint, or fail with a message that names the missing variable.
 *
 * This is the guard that keeps you from calling an API your application was
 * never provisioned for.
 */
export function requireEndpoint(service: ServiceName): string {
  const url = config.endpoints[service];
  if (!url) {
    throw new Error(
      `[mspace] ${service} is not configured. Either the API is not enabled on ` +
        `your application, or its URL is missing from the environment. See .env.example.`
    );
  }
  return url;
}

/** Which services this deployment can actually call. Useful at startup. */
export function enabledServices(): ServiceName[] {
  return (Object.keys(config.endpoints) as ServiceName[]).filter(
    (s) => config.endpoints[s] !== undefined
  );
}

/** Redacted view, safe to log at startup to confirm what the process loaded. */
export function describeConfig(): Record<string, unknown> {
  return {
    applicationId: config.applicationId,
    password: "***redacted***",
    enabledServices: enabledServices(),
  };
}
