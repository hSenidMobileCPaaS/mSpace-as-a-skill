using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Options;

namespace Mspace;

/// <summary>
/// mSpace API client — C# port of templates/typescript/mspace-client.ts.
///
/// <para>One <c>PostAsync</c> helper injects credentials, applies a timeout, and turns
/// unsuccessful responses into typed errors. Every service is a thin wrapper that resolves its
/// endpoint through <see cref="MspaceOptions.RequireEndpoint"/> — so calling an API your
/// application was not provisioned for fails locally with a clear message, rather than as
/// E1309 from the platform.</para>
///
/// <para>The one thing that is NOT global: success. <c>S1000</c> is the default, CaaS OTP
/// generation succeeds with <c>P1003</c>, and Subscriber List also accepts <c>S1001</c>.</para>
///
/// <para>Register with <c>IHttpClientFactory</c>:
/// <c>builder.Services.AddHttpClient&lt;MspaceClient&gt;();</c></para>
///
/// <para>SERVER-SIDE ONLY.</para>
/// </summary>
public sealed class MspaceClient
{
    /// <summary>A single outbound call should never hang. Protocol constant, not config.</summary>
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(15);

    /// <summary>Platform-side. Worth retrying with backoff.</summary>
    public static readonly IReadOnlySet<string> Transient = new HashSet<string>
    {
        "E1100", "E1105", "E1300", "E1316", "E1318", "E1319", "E1341",
        "E1601", "E1603", "E1857", "E9999",
    };

    /// <summary>Provisioning or credentials are wrong. Retrying will never help.</summary>
    public static readonly IReadOnlySet<string> Configuration = new HashSet<string>
    {
        "E1102", "E1104", "E1301", "E1302", "E1303", "E1309", "E1311",
        "E1313", "E1315", "E1329", "E1330", "E1331", "E1371",
        "E1604", "E1607", "E1608",
    };

    /// <summary>
    /// Success codes that are NOT S1000. P1003 is the documented success of CaaS OTP generation
    /// — the OTP went out, nothing is charged yet. S1001 means Subscriber List worked and matched
    /// nobody. A client that only accepts S1000 reports both as failures.
    /// </summary>
    public static readonly string[] SuccessDefault = { "S1000" };

    public static readonly string[] SuccessCaasOtpGeneration = { "P1003" };

    public static readonly string[] SuccessSubscriberList = { "S1000", "S1001" };

    public const string BroadcastConfirmation = "I_HAVE_VERIFIED_THIS_GOES_TO_ALL_SUBSCRIBERS";

    private readonly MspaceOptions _options;
    private readonly HttpClient _http;

    /// <summary>
    /// If an mSpace host serves an incomplete certificate chain, .NET rejects it. Do NOT install
    /// a callback that returns true unconditionally — that lets anyone on the path read the
    /// applicationId and password that can charge your subscribers. Supply the intermediate CA
    /// through a SocketsHttpHandler with a custom trust store instead. See
    /// references/10-security-best-practices.md.
    /// </summary>
    public MspaceClient(HttpClient http, IOptions<MspaceOptions> options)
    {
        _http = http;
        _http.Timeout = Timeout;
        _options = options.Value;
    }

    /* ── Helpers ──────────────────────────────────────────────────────────── */

    private static readonly Regex Separators = new(@"[\s()\-]", RegexOptions.Compiled);

    /// <summary>
    /// Normalise a subscriber address. The ONLY place <c>tel:</c> is added. Accepts an
    /// already-prefixed address, a masked value, +94…, 0094… or a local 07… number.
    ///
    /// <para>Do NOT push an SMS <c>sourceAddress</c> through this — that is a sender alias or
    /// short code, not a subscriber address.</para>
    /// </summary>
    public static string ToTelAddress(string msisdn)
    {
        var trimmed = (msisdn ?? string.Empty).Trim();
        if (trimmed.Length == 0)
        {
            throw new ArgumentException("[mspace] Empty subscriber address", nameof(msisdn));
        }

        if (trimmed.StartsWith("tel:", StringComparison.OrdinalIgnoreCase))
        {
            return trimmed;
        }

        var digits = Separators.Replace(trimmed, string.Empty).TrimStart('+');
        if (digits.StartsWith("00", StringComparison.Ordinal))
        {
            digits = digits[2..];
        }

        if (digits.StartsWith("0", StringComparison.Ordinal) && digits.Length == 10)
        {
            digits = "94" + digits[1..];
        }

        return "tel:" + digits;
    }

    /// <summary>Mask a subscriber address for logging. Never log the raw value.</summary>
    public static string MaskAddress(string address)
    {
        var body = address ?? string.Empty;
        if (body.StartsWith("tel:", StringComparison.OrdinalIgnoreCase))
        {
            body = body[4..];
        }

        return body.Length <= 6
            ? "tel:***"
            : $"tel:{body[..3]}{new string('*', body.Length - 6)}{body[^3..]}";
    }

    /// <summary>
    /// A unique, persistable idempotency key for a charge. mSpace publishes no length limit, so
    /// this is simply a value that will never collide. Persist it BEFORE the charge call.
    /// </summary>
    public static string GenerateExternalTrxId() => Guid.NewGuid().ToString("N");

    /// <summary>
    /// The human-readable message, wherever mSpace put it. Every service uses
    /// <c>statusDetail</c> except CaaS OTP verification, which uses <c>statusDescription</c>.
    /// </summary>
    public static string DetailOf(JsonElement data)
    {
        if (data.TryGetProperty("statusDetail", out var detail) &&
            detail.GetString() is { Length: > 0 } text)
        {
            return text;
        }

        return data.TryGetProperty("statusDescription", out var description)
            ? description.GetString() ?? string.Empty
            : string.Empty;
    }

    /// <summary>yyMMddHHmm, the documented timestamp format for subscriber notifications.</summary>
    public static string FormatNotifyTimestamp(DateTimeOffset moment) =>
        moment.ToUniversalTime().ToString("yyMMddHHmm", CultureInfo.InvariantCulture);

    /* ── Core ─────────────────────────────────────────────────────────────── */

    private async Task<JsonElement> PostAsync(
        string service,
        string url,
        IDictionary<string, object?> body,
        CancellationToken cancellationToken,
        string[]? successCodes = null)
    {
        successCodes ??= SuccessDefault;

        var payload = new Dictionary<string, object?>(body)
        {
            ["applicationId"] = _options.ApplicationId,
            ["password"] = _options.Password,
        };

        using var response = await _http
            .PostAsJsonAsync(url, payload, cancellationToken)
            .ConfigureAwait(false);

        // response.EnsureSuccessStatusCode() is deliberately NOT called: mSpace returns
        // HTTP 200 for application-level failures, and the real outcome is statusCode.
        var data = await response.Content
            .ReadFromJsonAsync<JsonElement>(cancellationToken: cancellationToken)
            .ConfigureAwait(false);

        var statusCode = data.TryGetProperty("statusCode", out var code)
            ? code.GetString() ?? string.Empty
            : string.Empty;

        if (successCodes.Contains(statusCode))
        {
            return data;
        }

        throw new MspaceException(statusCode, DetailOf(data), service);
    }

    /* ── SMS ──────────────────────────────────────────────────────────────── */

    /// <summary>Send an MT SMS to one or more subscribers.</summary>
    public Task<JsonElement> SendSmsAsync(
        IEnumerable<string> to,
        string message,
        CancellationToken cancellationToken = default)
    {
        var recipients = to.Select(ToTelAddress).ToList();
        if (recipients.Contains("tel:all"))
        {
            throw new ArgumentException(
                "[mspace] Use BroadcastSmsAsync for tel:all — broadcasts must be deliberate.",
                nameof(to));
        }

        return PostAsync(
            "sms-send",
            _options.RequireEndpoint("SmsSend"),
            new Dictionary<string, object?>
            {
                ["version"] = "1.0",
                ["message"] = message,
                ["destinationAddresses"] = recipients,
            },
            cancellationToken);
    }

    /// <summary>
    /// Send to the ENTIRE subscribed base of the application. Deliberately separate from
    /// <see cref="SendSmsAsync"/> so it can never be reached by accident — check the subscriber
    /// base size first, and put an authorisation check in front of this.
    /// </summary>
    public Task<JsonElement> BroadcastSmsAsync(
        string message,
        string confirmation,
        CancellationToken cancellationToken = default)
    {
        if (confirmation != BroadcastConfirmation)
        {
            throw new ArgumentException(
                "[mspace] Broadcast confirmation token missing", nameof(confirmation));
        }

        return PostAsync(
            "sms-send",
            _options.RequireEndpoint("SmsSend"),
            new Dictionary<string, object?>
            {
                ["version"] = "1.0",
                ["message"] = message,
                ["destinationAddresses"] = new[] { "tel:all" },
            },
            cancellationToken);
    }

    /* ── USSD ─────────────────────────────────────────────────────────────── */

    /// <summary>
    /// Send a USSD screen. <paramref name="sessionId"/> MUST be the one the USSD Gateway sent
    /// you. Use "mt-fin" for the final screen — anything else leaves the session hanging until
    /// the network times out.
    /// </summary>
    public Task<JsonElement> SendUssdAsync(
        string sessionId,
        string destinationAddress,
        string message,
        string operation,
        CancellationToken cancellationToken = default)
    {
        if (operation is not ("mt-init" or "mt-cont" or "mt-fin"))
        {
            throw new ArgumentException(
                $"[mspace] Invalid ussdOperation '{operation}'", nameof(operation));
        }

        return PostAsync(
            "ussd-send",
            _options.RequireEndpoint("UssdSend"),
            new Dictionary<string, object?>
            {
                ["version"] = "1.0",
                ["message"] = message,
                ["sessionId"] = sessionId,
                ["ussdOperation"] = operation,
                ["destinationAddress"] = ToTelAddress(destinationAddress),
                ["encoding"] = "440",
            },
            cancellationToken);
    }

    /* ── Subscription ─────────────────────────────────────────────────────── */

    /// <summary>Opt a subscriber in. Only call this with recorded, explicit consent.</summary>
    public Task<JsonElement> RegisterAsync(
        string subscriberId, CancellationToken cancellationToken = default) =>
        SubscriptionAsync("subscription-register", subscriberId, "1", cancellationToken);

    /// <summary>
    /// Opt a subscriber out. Make it as reachable as register, in every channel the subscriber
    /// has.
    /// </summary>
    public Task<JsonElement> UnregisterAsync(
        string subscriberId, CancellationToken cancellationToken = default) =>
        SubscriptionAsync("subscription-unregister", subscriberId, "0", cancellationToken);

    private Task<JsonElement> SubscriptionAsync(
        string service,
        string subscriberId,
        string action,
        CancellationToken cancellationToken) =>
        PostAsync(
            service,
            _options.RequireEndpoint("SubscriptionSend"),
            new Dictionary<string, object?>
            {
                ["subscriberId"] = ToTelAddress(subscriberId),
                ["action"] = action,
            },
            cancellationToken);

    /// <summary>
    /// Check one subscriber's status. For reconciliation, not per-request gating. The result is
    /// one of six statuses, not two: INITIAL, REG_PENDING, TRIAL, REGISTERED, UNREGISTERED,
    /// TEMPORARY_BLOCKED.
    /// </summary>
    public Task<JsonElement> GetSubscriptionStatusAsync(
        string subscriberId, CancellationToken cancellationToken = default) =>
        PostAsync(
            "subscription-status",
            _options.RequireEndpoint("SubscriptionStatus"),
            new Dictionary<string, object?> { ["subscriberId"] = ToTelAddress(subscriberId) },
            cancellationToken);

    /// <summary>
    /// Subscriber base size. Needs no subscriber and charges nothing, which also makes it the
    /// best connectivity and credential smoke test. <c>baseSize</c> comes back as a string.
    /// </summary>
    public async Task<long> QueryBaseAsync(CancellationToken cancellationToken = default)
    {
        var data = await PostAsync(
            "subscription-query-base",
            _options.RequireEndpoint("SubscriptionQueryBase"),
            new Dictionary<string, object?>(),
            cancellationToken).ConfigureAwait(false);

        var raw = data.TryGetProperty("baseSize", out var value) ? value.GetString() : "0";
        return long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var size)
            ? size
            : 0;
    }

    /// <summary>
    /// Subscription status and last-charge details for up to ten subscribers. Every entry in
    /// <c>destinationResponses</c> carries its own statusCode, and which fields are present
    /// depends on the status.
    /// </summary>
    public Task<JsonElement> GetSubscriberChargingInfoAsync(
        IReadOnlyCollection<string> subscriberIds,
        CancellationToken cancellationToken = default)
    {
        if (subscriberIds.Count > 10)
        {
            throw new ArgumentException(
                "[mspace] GetSubscriberChargingInfoAsync accepts at most 10 subscriberIds",
                nameof(subscriberIds));
        }

        return PostAsync(
            "subscription-charging-info",
            _options.RequireEndpoint("SubscriptionChargingInfo"),
            new Dictionary<string, object?>
            {
                ["subscriberIds"] = subscriberIds.Select(ToTelAddress).ToList(),
            },
            cancellationToken);
    }

    /// <summary>
    /// One page of the subscriber list — the catch-up mechanism for subscription notifications
    /// you missed. S1001 ("No Subscribers Found") is a SUCCESS: the request worked and matched
    /// nobody. Page until <c>moreDataAvailable</c> is false; <c>nextPageNumber</c> is -1 when
    /// there is no next page.
    /// </summary>
    public Task<JsonElement> GetSubscriberListAsync(
        int requestPage, CancellationToken cancellationToken = default)
    {
        if (requestPage < 1)
        {
            throw new ArgumentException(
                "[mspace] requestPage must be 1 or greater (E1106)", nameof(requestPage));
        }

        return PostAsync(
            "subscription-list",
            _options.RequireEndpoint("SubscriptionList"),
            new Dictionary<string, object?>
            {
                ["version"] = "1.0",
                ["requestPage"] = requestPage,
            },
            cancellationToken,
            SuccessSubscriberList);
    }

    /// <summary>Send a subscription notification to a subscriber.</summary>
    public Task<JsonElement> NotifySubscriberAsync(
        string subscriberId,
        string frequency,
        string status,
        string? timeStamp = null,
        CancellationToken cancellationToken = default)
    {
        if (frequency is not ("daily" or "weekly" or "monthly" or "yearly"))
        {
            throw new ArgumentException(
                $"[mspace] Invalid frequency '{frequency}'", nameof(frequency));
        }

        return PostAsync(
            "subscription-notify",
            _options.RequireEndpoint("SubscriptionNotify"),
            new Dictionary<string, object?>
            {
                ["timeStamp"] = timeStamp ?? FormatNotifyTimestamp(DateTimeOffset.UtcNow),
                ["version"] = "1.0",
                ["subscriberId"] = ToTelAddress(subscriberId),
                ["frequency"] = frequency,
                ["status"] = status,
            },
            cancellationToken);
    }

    /* ── OTP (subscription activation) ────────────────────────────────────── */

    /// <summary>
    /// Send an OTP to a plain mobile number. Rate-limit per number AND per IP before calling,
    /// or the application becomes an SMS-bombing tool. Keep the returned referenceNo
    /// server-side, and never log it.
    /// </summary>
    public Task<JsonElement> RequestOtpAsync(
        string subscriberId,
        IDictionary<string, object?>? applicationMetaData = null,
        CancellationToken cancellationToken = default)
    {
        var body = new Dictionary<string, object?>
        {
            ["subscriberId"] = ToTelAddress(subscriberId),
        };
        if (applicationMetaData is { Count: > 0 })
        {
            body["applicationMetaData"] = applicationMetaData;
        }

        return PostAsync(
            "otp-request", _options.RequireEndpoint("OtpRequest"), body, cancellationToken);
    }

    /// <summary>
    /// Verify an OTP and activate the subscription. mSpace does not publish the validity window
    /// or the attempt limit — E1851 (expired) and E1852 (attempts reached) are what you get when
    /// either is hit, so enforce your own limits too. The returned subscriberId is the masked
    /// identifier to use for every subsequent call.
    /// </summary>
    public Task<JsonElement> VerifyOtpAsync(
        string referenceNo, string otp, CancellationToken cancellationToken = default) =>
        PostAsync(
            "otp-verify",
            _options.RequireEndpoint("OtpVerify"),
            new Dictionary<string, object?> { ["referenceNo"] = referenceNo, ["otp"] = otp },
            cancellationToken);

    /* ── CaaS ─────────────────────────────────────────────────────────────── */

    /// <summary>
    /// Step 1 of a charge: generate and send the OTP. THIS STARTS A REAL CHARGE. It does not
    /// complete one.
    ///
    /// <para>The success code is <b>P1003</b>, not S1000 — nothing is charged yet; mSpace has
    /// SMSed an OTP to the subscriber. <paramref name="externalTrxId"/> is your idempotency key:
    /// generate it with <see cref="GenerateExternalTrxId"/>, PERSIST IT, then call this. Persist
    /// <c>requestCorrelator</c> from the response — step 3 needs it — and <c>internalTrxId</c>,
    /// which is what support traces with. There are deliberately no retries: a timeout does NOT
    /// mean nothing happened, so settle unknown outcomes from the charging notification.</para>
    ///
    /// <para><paramref name="amount"/> is <c>decimal</c>, never <c>double</c>.</para>
    /// </summary>
    public Task<JsonElement> StartChargeAsync(
        string subscriberId,
        decimal amount,
        string externalTrxId,
        string currency = "LKR",
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(externalTrxId))
        {
            throw new ArgumentException(
                "[mspace] externalTrxId is required and must be persisted first",
                nameof(externalTrxId));
        }

        return PostAsync(
            "caas-otp-generation",
            _options.RequireEndpoint("CaasDebit"),
            new Dictionary<string, object?>
            {
                ["externalTrxId"] = externalTrxId,
                ["subscriberId"] = ToTelAddress(subscriberId),
                ["paymentInstrumentName"] = "Mobile Account",
                ["amount"] = amount.ToString(CultureInfo.InvariantCulture),
                ["currency"] = currency,
            },
            cancellationToken,
            SuccessCaasOtpGeneration);
    }

    /// <summary>
    /// Step 3 of a charge: verify the OTP the subscriber entered. THIS IS THE CALL THAT MOVES
    /// THE MONEY.
    ///
    /// <para><paramref name="requestCorrelator"/> is the value returned by
    /// <see cref="StartChargeAsync"/>, NOT your externalTrxId — sending the wrong one gives
    /// E1855. The response carries <c>statusDescription</c> rather than <c>statusDetail</c>,
    /// plus a boolean <c>status</c>. The final outcome still arrives on the charging
    /// notification.</para>
    /// </summary>
    public Task<JsonElement> ConfirmChargeAsync(
        string requestCorrelator,
        string otp,
        string sourceAddress,
        CancellationToken cancellationToken = default) =>
        PostAsync(
            "caas-otp-verify",
            _options.RequireEndpoint("CaasOtpVerify"),
            new Dictionary<string, object?>
            {
                ["referenceNo"] = requestCorrelator,
                ["otp"] = otp,
                ["sourceAddress"] = ToTelAddress(sourceAddress),
            },
            cancellationToken);

    /* ── LBS ──────────────────────────────────────────────────────────────── */

    /// <summary>
    /// Request a subscriber's location. mSpace returns it only if the subscriber has granted
    /// permission.
    ///
    /// <para><paramref name="requesterId"/> (who is asking) and
    /// <paramref name="subscriberId"/> (who is being located) are two different mandatory
    /// fields. Swapping them locates the wrong person.</para>
    ///
    /// <para>Requires explicit, purpose-specific consent — consent to receive SMS is not
    /// consent to be located.</para>
    /// </summary>
    public Task<JsonElement> RequestLocationAsync(
        string requesterId,
        string subscriberId,
        string? serviceType = null,
        CancellationToken cancellationToken = default)
    {
        var body = new Dictionary<string, object?>
        {
            ["requesterId"] = ToTelAddress(requesterId),
            ["subscriberId"] = ToTelAddress(subscriberId),
        };
        if (serviceType is not null)
        {
            body["serviceType"] = serviceType;
        }

        return PostAsync(
            "lbs-request", _options.RequireEndpoint("LbsRequest"), body, cancellationToken);
    }

    /* ── Extension point ───────────────────────────────────────────────────
     *
     * Adding a service mSpace publishes later:
     *
     *   1. Add its URL variable to .env.example and to EndpointVariables in MspaceOptions
     *   2. Add one wrapper here that calls PostAsync with the new key.
     *
     * It inherits credential injection, the timeout, error mapping and the not-provisioned
     * guard for free. Do not build a parallel client.
     */
}

/// <summary>An unsuccessful application-level response.</summary>
public sealed class MspaceException : Exception
{
    public MspaceException(string statusCode, string statusDetail, string service)
        : base($"[{statusCode}] {statusDetail} ({service})")
    {
        StatusCode = statusCode;
        StatusDetail = statusDetail;
        Service = service;
    }

    public string StatusCode { get; }

    public string StatusDetail { get; }

    public string Service { get; }

    public bool IsRetryable => MspaceClient.Transient.Contains(StatusCode);

    public bool IsConfiguration => MspaceClient.Configuration.Contains(StatusCode);
}
