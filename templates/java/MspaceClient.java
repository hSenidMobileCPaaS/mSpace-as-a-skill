package com.example.mspace;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * mSpace API client — Java port of templates/typescript/mspace-client.ts.
 *
 * <p>One {@link #post} helper injects credentials, applies a timeout, and turns unsuccessful
 * responses into typed errors. Every service is a thin wrapper that resolves its endpoint
 * through {@link MspaceConfig#requireEndpoint} — so calling an API your application was not
 * provisioned for fails locally with a clear message, rather than as E1309 from the platform.
 *
 * <p>The one thing that is NOT global: success. {@code S1000} is the default, CaaS OTP
 * generation succeeds with {@code P1003}, and Subscriber List also accepts {@code S1001}.
 *
 * <p>Java 17 ({@code java.net.http.HttpClient}, {@code Stream.toList()}, switch expressions) and
 * Jackson — the Spring Boot 3 baseline. On Java 11 replace {@code .toList()} with
 * {@code .collect(Collectors.toList())}. Register it as a singleton bean; it is thread-safe and
 * the underlying {@code HttpClient} pools connections.
 *
 * <p>SERVER-SIDE ONLY.
 */
public final class MspaceClient {

  /** A single outbound call should never hang. Protocol constant, not config. */
  private static final Duration TIMEOUT = Duration.ofSeconds(15);

  /** Platform-side. Worth retrying with backoff. */
  private static final Set<String> TRANSIENT =
      Set.of(
          "E1100", "E1105", "E1300", "E1316", "E1318", "E1319", "E1341", "E1601", "E1603",
          "E1857", "E9999");

  /** Provisioning or credentials are wrong. Retrying will never help. */
  private static final Set<String> CONFIGURATION =
      Set.of(
          "E1102", "E1104", "E1301", "E1302", "E1303", "E1309", "E1311", "E1313", "E1315",
          "E1329", "E1330", "E1331", "E1371", "E1604", "E1607", "E1608");

  /**
   * Success codes that are NOT S1000.
   *
   * <p>P1003 is the documented success of CaaS OTP generation — the OTP went out, nothing is
   * charged yet. S1001 means Subscriber List worked and matched nobody. A client that only
   * accepts S1000 reports both as failures.
   */
  public static final String[] SUCCESS_DEFAULT = {"S1000"};

  public static final String[] SUCCESS_CAAS_OTP_GENERATION = {"P1003"};

  public static final String[] SUCCESS_SUBSCRIBER_LIST = {"S1000", "S1001"};

  private final MspaceConfig config;
  private final ObjectMapper mapper = new ObjectMapper();
  private final HttpClient http;

  public MspaceClient(MspaceConfig config) {
    this.config = config;
    // If an mSpace host serves an incomplete certificate chain, strict clients reject it.
    // Do NOT install a trust-all TrustManager to work around it — that lets anyone on the path
    // read the applicationId and password that can charge your subscribers. Import the
    // intermediate CA into a truststore and point an SSLContext at it instead:
    //
    //   .sslContext(SSLContexts.custom().loadTrustMaterial(truststore, null).build())
    //
    // See references/10-security-best-practices.md.
    this.http = HttpClient.newBuilder().connectTimeout(TIMEOUT).build();
  }

  /* ── Errors ─────────────────────────────────────────────────────────────── */

  public static final class MspaceException extends RuntimeException {
    private final String statusCode;
    private final String statusDetail;
    private final String service;

    MspaceException(String statusCode, String statusDetail, String service) {
      super("[" + statusCode + "] " + statusDetail + " (" + service + ")");
      this.statusCode = statusCode;
      this.statusDetail = statusDetail;
      this.service = service;
    }

    public String statusCode() {
      return statusCode;
    }

    public String statusDetail() {
      return statusDetail;
    }

    public String service() {
      return service;
    }

    public boolean isRetryable() {
      return TRANSIENT.contains(statusCode);
    }

    public boolean isConfiguration() {
      return CONFIGURATION.contains(statusCode);
    }
  }

  /* ── Helpers ────────────────────────────────────────────────────────────── */

  /**
   * Normalise a subscriber address. The ONLY place {@code tel:} is added.
   *
   * <p>Accepts an already-prefixed address, a masked value, +94…, 0094… or a local 07… number.
   *
   * <p>Do NOT push an SMS {@code sourceAddress} through this — that is a sender alias or short
   * code, not a subscriber address.
   */
  public static String toTelAddress(String msisdn) {
    String trimmed = msisdn == null ? "" : msisdn.trim();
    if (trimmed.isEmpty()) {
      throw new IllegalArgumentException("[mspace] Empty subscriber address");
    }
    if (trimmed.toLowerCase(Locale.ROOT).startsWith("tel:")) {
      return trimmed;
    }
    String digits = trimmed.replaceAll("[\\s()-]", "").replaceFirst("^\\+", "");
    if (digits.startsWith("00")) {
      digits = digits.substring(2);
    }
    if (digits.startsWith("0") && digits.length() == 10) {
      digits = "94" + digits.substring(1);
    }
    return "tel:" + digits;
  }

  /** Mask a subscriber address for logging. Never log the raw value. */
  public static String maskAddress(String address) {
    String body = address == null ? "" : address.replaceFirst("(?i)^tel:", "");
    if (body.length() <= 6) {
      return "tel:***";
    }
    return "tel:"
        + body.substring(0, 3)
        + "*".repeat(body.length() - 6)
        + body.substring(body.length() - 3);
  }

  /**
   * A unique, persistable idempotency key for a charge.
   *
   * <p>mSpace publishes no length limit for externalTrxId, so this is simply a value that will
   * never collide. Persist it BEFORE the charge call.
   */
  public static String generateExternalTrxId() {
    return UUID.randomUUID().toString().replace("-", "");
  }

  /**
   * The human-readable message, wherever mSpace put it.
   *
   * <p>Every service uses {@code statusDetail} except CaaS OTP verification, which uses
   * {@code statusDescription}.
   */
  public static String detailOf(JsonNode data) {
    String detail = data.path("statusDetail").asText("");
    return detail.isEmpty() ? data.path("statusDescription").asText("") : detail;
  }

  private static final DateTimeFormatter NOTIFY_TIMESTAMP =
      DateTimeFormatter.ofPattern("yyMMddHHmm");

  /** yyMMddHHmm, the documented timestamp format for subscriber notifications. */
  public static String formatNotifyTimestamp(ZonedDateTime moment) {
    return moment.withZoneSameInstant(ZoneOffset.UTC).format(NOTIFY_TIMESTAMP);
  }

  /* ── Core ───────────────────────────────────────────────────────────────── */

  private JsonNode post(
      String service, String url, Map<String, Object> body, String... successCodes) {
    Map<String, Object> payload = new LinkedHashMap<>();
    payload.put("applicationId", config.applicationId());
    payload.put("password", config.password());
    payload.putAll(body);

    JsonNode data;
    try {
      HttpRequest request =
          HttpRequest.newBuilder(URI.create(url))
              .timeout(TIMEOUT)
              .header("Content-Type", "application/json;charset=utf-8")
              .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(payload)))
              .build();
      HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
      // The HTTP status is deliberately not consulted: mSpace returns 200 for
      // application-level failures, and the real outcome is statusCode in the body.
      data = mapper.readTree(response.body());
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("[mspace] " + service + " interrupted", e);
    } catch (Exception e) {
      throw new IllegalStateException("[mspace] " + service + " transport failure", e);
    }

    String statusCode = data.path("statusCode").asText("");
    String[] accepted = successCodes.length == 0 ? SUCCESS_DEFAULT : successCodes;
    if (List.of(accepted).contains(statusCode)) {
      return data;
    }
    throw new MspaceException(statusCode, detailOf(data), service);
  }

  /* ── SMS ────────────────────────────────────────────────────────────────── */

  /** Send an MT SMS to one or more subscribers. */
  public JsonNode sendSms(List<String> to, String message) {
    List<String> recipients = to.stream().map(MspaceClient::toTelAddress).toList();
    if (recipients.contains("tel:all")) {
      throw new IllegalArgumentException(
          "[mspace] Use broadcastSms() for tel:all — broadcasts must be deliberate.");
    }
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("version", "1.0");
    body.put("message", message);
    body.put("destinationAddresses", recipients);
    return post("sms-send", config.requireEndpoint("smsSend"), body);
  }

  public static final String BROADCAST_CONFIRMATION =
      "I_HAVE_VERIFIED_THIS_GOES_TO_ALL_SUBSCRIBERS";

  /**
   * Send to the ENTIRE subscribed base of the application.
   *
   * <p>Deliberately separate from {@link #sendSms} so it can never be reached by accident —
   * check the subscriber base size first, and put an authorisation check in front of this.
   */
  public JsonNode broadcastSms(String message, String confirmation) {
    if (!BROADCAST_CONFIRMATION.equals(confirmation)) {
      throw new IllegalArgumentException("[mspace] Broadcast confirmation token missing");
    }
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("version", "1.0");
    body.put("message", message);
    body.put("destinationAddresses", List.of("tel:all"));
    return post("sms-send", config.requireEndpoint("smsSend"), body);
  }

  /* ── USSD ───────────────────────────────────────────────────────────────── */

  /**
   * Send a USSD screen.
   *
   * <p>{@code sessionId} MUST be the one the USSD Gateway sent you. Use "mt-fin" for the final
   * screen — anything else leaves the session hanging until the network times out.
   */
  public JsonNode sendUssd(
      String sessionId, String destinationAddress, String message, String operation) {
    if (!Set.of("mt-init", "mt-cont", "mt-fin").contains(operation)) {
      throw new IllegalArgumentException("[mspace] Invalid ussdOperation '" + operation + "'");
    }
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("version", "1.0");
    body.put("message", message);
    body.put("sessionId", sessionId);
    body.put("ussdOperation", operation);
    body.put("destinationAddress", toTelAddress(destinationAddress));
    body.put("encoding", "440");
    return post("ussd-send", config.requireEndpoint("ussdSend"), body);
  }

  /* ── Subscription ───────────────────────────────────────────────────────── */

  /** Opt a subscriber in. Only call this with recorded, explicit consent. */
  public JsonNode register(String subscriberId) {
    return post(
        "subscription-register",
        config.requireEndpoint("subscriptionSend"),
        Map.of("subscriberId", toTelAddress(subscriberId), "action", "1"));
  }

  /** Opt a subscriber out. Make it as reachable as register, in every channel. */
  public JsonNode unregister(String subscriberId) {
    return post(
        "subscription-unregister",
        config.requireEndpoint("subscriptionSend"),
        Map.of("subscriberId", toTelAddress(subscriberId), "action", "0"));
  }

  /**
   * Check one subscriber's status. For reconciliation, not per-request gating.
   *
   * <p>The result is one of six statuses, not two: INITIAL, REG_PENDING, TRIAL, REGISTERED,
   * UNREGISTERED, TEMPORARY_BLOCKED.
   */
  public JsonNode getSubscriptionStatus(String subscriberId) {
    return post(
        "subscription-status",
        config.requireEndpoint("subscriptionStatus"),
        Map.of("subscriberId", toTelAddress(subscriberId)));
  }

  /**
   * Subscriber base size. Needs no subscriber and charges nothing, which also makes it the best
   * connectivity and credential smoke test. {@code baseSize} comes back as a string.
   */
  public long queryBase() {
    JsonNode data =
        post("subscription-query-base", config.requireEndpoint("subscriptionQueryBase"), Map.of());
    return Long.parseLong(data.path("baseSize").asText("0"));
  }

  /**
   * Subscription status and last-charge details for up to ten subscribers.
   *
   * <p>Every entry in {@code destinationResponses} carries its own statusCode — one subscriber
   * failing does not fail the request — and which fields are present depends on the status.
   */
  public JsonNode getSubscriberChargingInfo(List<String> subscriberIds) {
    if (subscriberIds.size() > 10) {
      throw new IllegalArgumentException(
          "[mspace] getSubscriberChargingInfo accepts at most 10 subscriberIds");
    }
    return post(
        "subscription-charging-info",
        config.requireEndpoint("subscriptionChargingInfo"),
        Map.of(
            "subscriberIds", subscriberIds.stream().map(MspaceClient::toTelAddress).toList()));
  }

  /**
   * One page of the subscriber list — the catch-up mechanism for subscription notifications you
   * missed.
   *
   * <p>S1001 ("No Subscribers Found") is a SUCCESS: the request worked and matched nobody. Page
   * until {@code moreDataAvailable} is false; {@code nextPageNumber} is -1 when there is no next
   * page.
   */
  public JsonNode getSubscriberList(int requestPage) {
    if (requestPage < 1) {
      throw new IllegalArgumentException(
          "[mspace] requestPage must be 1 or greater (E1106)");
    }
    return post(
        "subscription-list",
        config.requireEndpoint("subscriptionList"),
        Map.of("version", "1.0", "requestPage", requestPage),
        SUCCESS_SUBSCRIBER_LIST);
  }

  /** Send a subscription notification to a subscriber. */
  public JsonNode notifySubscriber(
      String subscriberId, String frequency, String status, String timeStamp) {
    if (!Set.of("daily", "weekly", "monthly", "yearly").contains(frequency)) {
      throw new IllegalArgumentException("[mspace] Invalid frequency '" + frequency + "'");
    }
    Map<String, Object> body = new LinkedHashMap<>();
    body.put(
        "timeStamp",
        timeStamp == null ? formatNotifyTimestamp(ZonedDateTime.now(ZoneOffset.UTC)) : timeStamp);
    body.put("version", "1.0");
    body.put("subscriberId", toTelAddress(subscriberId));
    body.put("frequency", frequency);
    body.put("status", status);
    return post("subscription-notify", config.requireEndpoint("subscriptionNotify"), body);
  }

  /* ── OTP (subscription activation) ──────────────────────────────────────── */

  /**
   * Send an OTP to a plain mobile number.
   *
   * <p>Rate-limit per number AND per IP before calling, or the application becomes an
   * SMS-bombing tool. Keep the returned referenceNo server-side; never log it.
   */
  public JsonNode requestOtp(String subscriberId, Map<String, Object> applicationMetaData) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("subscriberId", toTelAddress(subscriberId));
    if (applicationMetaData != null && !applicationMetaData.isEmpty()) {
      body.put("applicationMetaData", applicationMetaData);
    }
    return post("otp-request", config.requireEndpoint("otpRequest"), body);
  }

  /**
   * Verify an OTP and activate the subscription.
   *
   * <p>mSpace does not publish the validity window or the attempt limit — E1851 (expired) and
   * E1852 (attempts reached) are what you get when either is hit, so enforce your own limits too.
   * The returned subscriberId is the masked identifier to use for every subsequent call.
   */
  public JsonNode verifyOtp(String referenceNo, String otp) {
    return post(
        "otp-verify",
        config.requireEndpoint("otpVerify"),
        Map.of("referenceNo", referenceNo, "otp", otp));
  }

  /* ── CaaS ───────────────────────────────────────────────────────────────── */

  /**
   * Step 1 of a charge: generate and send the OTP.
   *
   * <p>THIS STARTS A REAL CHARGE. It does not complete one.
   *
   * <ul>
   *   <li>The success code is <b>P1003</b>, not S1000. Nothing is charged yet; mSpace has SMSed
   *       an OTP to the subscriber.
   *   <li>{@code externalTrxId} is your idempotency key. Generate it with {@link
   *       #generateExternalTrxId()}, PERSIST IT, then call this.
   *   <li>Persist {@code requestCorrelator} from the response — step 3 needs it — and
   *       {@code internalTrxId}, which is what support traces with.
   *   <li>There are deliberately no retries here. A timeout does NOT mean nothing happened.
   *       Settle unknown outcomes from the charging notification.
   *   <li>Amount is {@link BigDecimal} — never {@code double}.
   * </ul>
   */
  public JsonNode startCharge(
      String subscriberId, BigDecimal amount, String externalTrxId, String currency) {
    if (externalTrxId == null || externalTrxId.isBlank()) {
      throw new IllegalArgumentException(
          "[mspace] externalTrxId is required and must be persisted first");
    }
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("externalTrxId", externalTrxId);
    body.put("subscriberId", toTelAddress(subscriberId));
    body.put("paymentInstrumentName", "Mobile Account");
    body.put("amount", amount.toPlainString());
    body.put("currency", currency == null ? "LKR" : currency);
    return post(
        "caas-otp-generation",
        config.requireEndpoint("caasDebit"),
        body,
        SUCCESS_CAAS_OTP_GENERATION);
  }

  /**
   * Step 3 of a charge: verify the OTP the subscriber entered.
   *
   * <p>THIS IS THE CALL THAT MOVES THE MONEY.
   *
   * <p>{@code requestCorrelator} is the value returned by {@link #startCharge}, NOT your
   * externalTrxId — sending the wrong one gives E1855. The response carries
   * {@code statusDescription} rather than {@code statusDetail}, plus a boolean {@code status}.
   *
   * <p>The final outcome still arrives on the charging notification.
   */
  public JsonNode confirmCharge(String requestCorrelator, String otp, String sourceAddress) {
    return post(
        "caas-otp-verify",
        config.requireEndpoint("caasOtpVerify"),
        Map.of(
            "referenceNo", requestCorrelator,
            "otp", otp,
            "sourceAddress", toTelAddress(sourceAddress)));
  }

  /* ── LBS ────────────────────────────────────────────────────────────────── */

  /**
   * Request a subscriber's location. mSpace returns it only if the subscriber has granted
   * permission.
   *
   * <p>{@code requesterId} (who is asking) and {@code subscriberId} (who is being located) are
   * two different mandatory fields. Swapping them locates the wrong person.
   *
   * <p>Requires explicit, purpose-specific consent — consent to receive SMS is not consent to be
   * located.
   */
  public JsonNode requestLocation(String requesterId, String subscriberId, String serviceType) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("requesterId", toTelAddress(requesterId));
    body.put("subscriberId", toTelAddress(subscriberId));
    if (serviceType != null) {
      body.put("serviceType", serviceType);
    }
    return post("lbs-request", config.requireEndpoint("lbsRequest"), body);
  }

  /* ── Extension point ────────────────────────────────────────────────────────
   *
   * Adding a service mSpace publishes later:
   *
   *   1. Add its URL variable to .env.example and to ENDPOINT_VARS in MspaceConfig
   *   2. Add one wrapper here:
   *
   *        public JsonNode newThing(Map<String, Object> input) {
   *          return post("new-thing", config.requireEndpoint("newThing"), input);
   *        }
   *
   * It inherits credential injection, the timeout, error mapping and the not-provisioned guard
   * for free. Do not build a parallel client.
   */
}
