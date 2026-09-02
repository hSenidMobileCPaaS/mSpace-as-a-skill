using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Mspace;

/// <summary>
/// mSpace callback (inbound webhook) endpoints — ASP.NET Core minimal APIs.
///
/// <para>Routes to register on the application record:</para>
/// <code>
///   SMS Receive (MO)          POST /api/mspace/sms/receive     (Message Receiving URL)
///   Delivery report           POST /api/mspace/sms/report      (Delivery Report URL)
///   USSD receive              POST /api/mspace/ussd/receive    (USSD Connection URL)
///   Subscription notification POST /api/mspace/subscription/notification
///   Charging notification     POST /api/mspace/charging/notification
/// </code>
///
/// <para>The contract, for all five: respond <c>{"statusCode":"S1000","statusDetail":"Success"}</c>
/// with HTTP 200 — always, even for payloads you reject — respond FIRST and work afterwards, be
/// idempotent, and never trust the body. Returning anything the platform cannot parse is
/// reported back as E1607.</para>
///
/// <para>Exclude these routes from authentication and antiforgery
/// (<c>.AllowAnonymous().DisableAntiforgery()</c>) and rely on the source-IP allowlist instead,
/// or you have left an open endpoint.</para>
///
/// <para>Full rules: references/08-callbacks.md.</para>
/// </summary>
public static class MspaceCallbacks
{
    /// <summary>The only response mSpace expects.</summary>
    private static readonly Dictionary<string, string> Ack = new()
    {
        ["statusCode"] = "S1000",
        ["statusDetail"] = "Success",
    };

    /// <summary>
    /// Restrict to the platform's egress IPs. mSpace signs nothing, so there is no signature to
    /// verify — source IP is the strongest control available. Prefer enforcing it at the
    /// firewall or load balancer; this is the fallback.
    /// </summary>
    public static readonly HashSet<string> SourceIps = new();

    public static IEndpointRouteBuilder MapMspaceCallbacks(this IEndpointRouteBuilder routes)
    {
        var group = routes.MapGroup("/api/mspace");

        group.MapPost("/sms/receive", MoSms);
        group.MapPost("/sms/report", DeliveryReport);
        group.MapPost("/ussd/receive", Ussd);
        group.MapPost("/subscription/notification", SubscriptionNotification);
        group.MapPost("/charging/notification", ChargingNotification);

        return routes;
    }

    /* ── Shared guards ────────────────────────────────────────────────────── */

    private static IResult AckResult() => Results.Json(Ack);

    private static bool AllowedSource(HttpContext context)
    {
        if (SourceIps.Count == 0)
        {
            return true; // not configured yet
        }

        var ip = context.Connection.RemoteIpAddress?.ToString();
        return ip is not null && SourceIps.Contains(ip);
    }

    /// <summary>Read the body without failing the response on malformed input.</summary>
    private static async Task<JsonElement?> ReadJsonAsync(HttpRequest request)
    {
        try
        {
            return await request.ReadFromJsonAsync<JsonElement>().ConfigureAwait(false);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string Field(JsonElement body, string name) =>
        body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out var value)
            ? value.ToString()
            : string.Empty;

    /* ── 1. SMS Receive (MO) ──────────────────────────────────────────────── */

    private static async Task<IResult> MoSms(
        HttpContext context,
        IOptions<MspaceOptions> options,
        MspaceWorkQueue queue,
        ILogger<MspaceWorkQueue> logger,
        MspaceDedupe dedupe)
    {
        if (!AllowedSource(context))
        {
            return AckResult();
        }

        var body = await ReadJsonAsync(context.Request).ConfigureAwait(false);
        if (body is null || Field(body.Value, "applicationId") != options.Value.ApplicationId)
        {
            return AckResult();
        }

        var requestId = Field(body.Value, "requestId");
        if (requestId.Length == 0 || dedupe.IsDuplicate($"mo:{requestId}"))
        {
            return AckResult();
        }

        // Message content deliberately not logged — it is user communication.
        logger.LogInformation(
            "sms-mo requestId={RequestId} from={From}",
            requestId,
            MspaceClient.MaskAddress(Field(body.Value, "sourceAddress")));

        await queue.EnqueueAsync(new MspaceJob("sms.mo", body.Value.Clone()))
            .ConfigureAwait(false);
        return AckResult();
    }

    /* ── 2. SMS delivery report ───────────────────────────────────────────── */

    /// <summary>mSpace documents the long forms; SMPP commonly uses the short ones.</summary>
    private static readonly Dictionary<string, string> DeliveryStatuses = new()
    {
        ["DELIVRD"] = "DELIVERED",
        ["UNDELIV"] = "UNDELIVERABLE",
        ["ACCEPTD"] = "ACCEPTED",
        ["REJECTD"] = "REJECTED",
    };

    private static async Task<IResult> DeliveryReport(
        HttpContext context,
        MspaceWorkQueue queue,
        ILogger<MspaceWorkQueue> logger,
        MspaceDedupe dedupe)
    {
        if (!AllowedSource(context))
        {
            return AckResult();
        }

        var body = await ReadJsonAsync(context.Request).ConfigureAwait(false);
        if (body is null)
        {
            return AckResult();
        }

        var requestId = Field(body.Value, "requestId");
        var raw = Field(body.Value, "deliveryStatus");
        if (requestId.Length == 0 || raw.Length == 0)
        {
            return AckResult();
        }

        var status = DeliveryStatuses.TryGetValue(raw, out var normalised) ? normalised : raw;
        if (dedupe.IsDuplicate($"dlr:{requestId}:{status}"))
        {
            return AckResult();
        }

        logger.LogInformation(
            "delivery-report requestId={RequestId} status={Status}", requestId, status);

        await queue.EnqueueAsync(new MspaceJob("sms.dlr", body.Value.Clone()))
            .ConfigureAwait(false);
        return AckResult();
    }

    /* ── 3. USSD receive ──────────────────────────────────────────────────── */

    /// <summary>
    /// The response body here is ONLY an acknowledgement. The screen the subscriber sees comes
    /// from a separate POST /ussd/send — which is why the reply is queued rather than returned.
    /// USSD sessions time out in seconds, so nothing slow may happen before the acknowledgement.
    /// </summary>
    private static async Task<IResult> Ussd(
        HttpContext context,
        IOptions<MspaceOptions> options,
        MspaceWorkQueue queue,
        ILogger<MspaceWorkQueue> logger,
        MspaceDedupe dedupe)
    {
        if (!AllowedSource(context))
        {
            return AckResult();
        }

        var body = await ReadJsonAsync(context.Request).ConfigureAwait(false);
        if (body is null || Field(body.Value, "applicationId") != options.Value.ApplicationId)
        {
            return AckResult();
        }

        var sessionId = Field(body.Value, "sessionId");
        var source = Field(body.Value, "sourceAddress");
        if (sessionId.Length == 0 || source.Length == 0)
        {
            return AckResult();
        }

        if (dedupe.IsDuplicate($"ussd:{Field(body.Value, "requestId")}"))
        {
            return AckResult();
        }

        logger.LogInformation(
            "ussd sessionId={SessionId} operation={Operation} from={From}",
            sessionId,
            Field(body.Value, "ussdOperation"),
            MspaceClient.MaskAddress(source));

        await queue.EnqueueAsync(new MspaceJob("ussd.receive", body.Value.Clone()))
            .ConfigureAwait(false);
        return AckResult();
    }

    /* ── 4. Subscription notification ─────────────────────────────────────── */

    /// <summary>
    /// The authoritative source of subscription state — including changes you did not initiate
    /// (a subscriber texting STOP, an operator removal, a billing failure). Consuming it is what
    /// lets you keep a local mirror instead of polling getStatus.
    ///
    /// <para>mSpace publishes no separate payload for this URL. These are the fields the
    /// documented POST /subscription/notify service defines, so accept them and tolerate
    /// anything else — log the raw body on the first delivery in Limited Production and widen
    /// from there. If it is ever down, GetSubscriberListAsync is the documented catch-up
    /// mechanism.</para>
    /// </summary>
    private static async Task<IResult> SubscriptionNotification(
        HttpContext context,
        IOptions<MspaceOptions> options,
        MspaceWorkQueue queue,
        ILogger<MspaceWorkQueue> logger,
        MspaceDedupe dedupe)
    {
        if (!AllowedSource(context))
        {
            return AckResult();
        }

        var body = await ReadJsonAsync(context.Request).ConfigureAwait(false);
        if (body is null)
        {
            return AckResult();
        }

        var applicationId = Field(body.Value, "applicationId");
        if (applicationId.Length > 0 && applicationId != options.Value.ApplicationId)
        {
            return AckResult();
        }

        var subscriberId = Field(body.Value, "subscriberId");
        var status = Field(body.Value, "status");
        if (subscriberId.Length == 0 || status.Length == 0)
        {
            return AckResult();
        }

        if (dedupe.IsDuplicate($"sub:{subscriberId}:{status}:{Field(body.Value, "timeStamp")}"))
        {
            return AckResult();
        }

        logger.LogInformation(
            "subscription-notification subscriber={Subscriber} status={Status}",
            MspaceClient.MaskAddress(subscriberId),
            status);

        await queue.EnqueueAsync(new MspaceJob("subscription.notification", body.Value.Clone()))
            .ConfigureAwait(false);
        return AckResult();
    }

    /* ── 5. Charging notification ─────────────────────────────────────────── */

    /// <summary>
    /// Your reconciliation channel, and the only place a charge is finally settled. Every charge
    /// left in an unknown state after a timeout gets resolved here. Idempotency is not optional —
    /// a duplicate that double-counts revenue is a real bug with real consequences.
    ///
    /// <para>S1000 means the request was processed and the due amount was fully paid. Read
    /// TotalAmount, paidAmount and balanceDue together before believing it.</para>
    /// </summary>
    private static async Task<IResult> ChargingNotification(
        HttpContext context,
        MspaceWorkQueue queue,
        ILogger<MspaceWorkQueue> logger,
        MspaceDedupe dedupe)
    {
        if (!AllowedSource(context))
        {
            return AckResult();
        }

        var body = await ReadJsonAsync(context.Request).ConfigureAwait(false);
        if (body is null)
        {
            return AckResult();
        }

        var external = Field(body.Value, "externalTrxId");
        var key = external.Length > 0 ? external : Field(body.Value, "internalTrxId");
        if (key.Length == 0)
        {
            return AckResult();
        }

        var statusCode = Field(body.Value, "statusCode");
        if (dedupe.IsDuplicate($"charge:{key}:{statusCode}"))
        {
            return AckResult();
        }

        logger.LogInformation(
            "charging-notification externalTrxId={ExternalTrxId} statusCode={StatusCode} " +
            "paidAmount={PaidAmount} balanceDue={BalanceDue}",
            external,
            statusCode,
            Field(body.Value, "paidAmount"),
            Field(body.Value, "balanceDue"));

        await queue.EnqueueAsync(new MspaceJob("charging.notification", body.Value.Clone()))
            .ConfigureAwait(false);
        return AckResult();
    }
}

/// <summary>A payload handed off for processing after the response was sent.</summary>
public sealed record MspaceJob(string Name, JsonElement Payload);

/// <summary>
/// Bounded in-process queue. Register as a singleton. For anything that must survive a crash —
/// charging reconciliation above all — publish to a real broker instead.
/// </summary>
public sealed class MspaceWorkQueue
{
    private readonly Channel<MspaceJob> _channel =
        Channel.CreateBounded<MspaceJob>(new BoundedChannelOptions(1024)
        {
            FullMode = BoundedChannelFullMode.DropWrite,
        });

    public ValueTask EnqueueAsync(MspaceJob job) => _channel.Writer.WriteAsync(job);

    public IAsyncEnumerable<MspaceJob> ReadAllAsync(CancellationToken cancellationToken) =>
        _channel.Reader.ReadAllAsync(cancellationToken);
}

/// <summary>Drains the queue outside the request lifetime. Register as a hosted service.</summary>
public sealed class MspaceWorker : BackgroundService
{
    private readonly MspaceWorkQueue _queue;
    private readonly MspaceClient _client;
    private readonly ILogger<MspaceWorker> _logger;

    public MspaceWorker(
        MspaceWorkQueue queue, MspaceClient client, ILogger<MspaceWorker> logger)
    {
        _queue = queue;
        _client = client;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var job in _queue.ReadAllAsync(stoppingToken).ConfigureAwait(false))
        {
            try
            {
                switch (job.Name)
                {
                    case "ussd.receive":
                        // Look up the session, decide the next screen, and reply with
                        // _client.SendUssdAsync(...). Terminal screens MUST use "mt-fin".
                        break;
                    case "sms.mo":
                        // Honour opt-out keywords, then handle your own commands.
                        break;
                    case "sms.dlr":
                        // Persist the latest status keyed by requestId.
                        break;
                    case "subscription.notification":
                        // Upsert your local subscription mirror. Six statuses, not two.
                        break;
                    case "charging.notification":
                        // Reconcile against your charge ledger by externalTrxId. Mark CHARGED
                        // only on S1000 with balanceDue settled.
                        break;
                    default:
                        _logger.LogWarning("unknown job {Job}", job.Name);
                        break;
                }
            }
            catch (MspaceException error)
            {
                _logger.LogError(
                    "job {Job} failed with {StatusCode}", job.Name, error.StatusCode);
                // Send to a dead-letter queue here.
            }
            catch (Exception error)
            {
                _logger.LogError(error, "job {Job} failed", job.Name);
            }
        }
    }
}

/// <summary>
/// Deduplication. DEVELOPMENT ONLY as written — replace the dictionary with Redis (SETNX + TTL)
/// or a unique database constraint in production, because an in-process store does not survive
/// a restart or a second instance, which is exactly when duplicates arrive.
/// </summary>
public sealed class MspaceDedupe
{
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(10);
    private readonly ConcurrentDictionary<string, DateTimeOffset> _seen = new();

    public bool IsDuplicate(string key)
    {
        var now = DateTimeOffset.UtcNow;

        foreach (var entry in _seen)
        {
            if (entry.Value < now)
            {
                _seen.TryRemove(entry.Key, out _);
            }
        }

        return !_seen.TryAdd(key, now.Add(Ttl));
    }
}

/* ── Wiring ────────────────────────────────────────────────────────────────
 *
 *   builder.Services.AddHttpClient<MspaceClient>();
 *   builder.Services.AddSingleton<MspaceWorkQueue>();
 *   builder.Services.AddSingleton<MspaceDedupe>();
 *   builder.Services.AddHostedService<MspaceWorker>();
 *
 *   var app = builder.Build();
 *   app.MapMspaceCallbacks();
 *
 * The USSD session store is not shown: use IDistributedCache backed by Redis, keyed by
 * sessionId with an expiry of about two minutes. An in-memory cache breaks the moment you run a
 * second instance, and the subscriber's menu dies mid-flow.
 */
