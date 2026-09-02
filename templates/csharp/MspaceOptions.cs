using System;
using System.Collections.Generic;
using System.Linq;

namespace Mspace;

/// <summary>
/// mSpace configuration — the ONLY type that reads configuration values.
///
/// <para>Two credentials, plus one URL per service you provisioned. Nothing else is
/// configuration: timeouts and encodings are constants in the client, because they are
/// properties of the protocol rather than of your deployment.</para>
///
/// <para>An endpoint that is not set means that API is not enabled on your application. The
/// client refuses to call it, so you get a clear local error instead of E1309 from the
/// platform.</para>
///
/// <para>Bind it with <c>ValidateOnStart()</c> so a misconfigured deployment fails at boot
/// rather than under load:</para>
///
/// <code>
/// builder.Services
///     .AddOptions&lt;MspaceOptions&gt;()
///     .Configure&lt;IConfiguration&gt;((options, configuration) => options.Load(configuration))
///     .Validate(options => options.Validate(out _), "mSpace configuration is incomplete")
///     .ValidateOnStart();
/// </code>
///
/// <para>Credentials come from environment variables or the secret manager — never from a
/// committed appsettings.json, and never from anything served to the browser.</para>
///
/// <para>SERVER-SIDE ONLY.</para>
/// </summary>
public sealed class MspaceOptions
{
    /// <summary>
    /// Environment variable per service. The names are identical in every language template,
    /// so a polyglot estate has one deployment story.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, string> EndpointVariables =
        new Dictionary<string, string>
        {
            ["SmsSend"] = "MSPACE_SMS_SEND_URL",
            ["UssdSend"] = "MSPACE_USSD_SEND_URL",
            ["SubscriptionSend"] = "MSPACE_SUBSCRIPTION_SEND_URL",
            ["SubscriptionStatus"] = "MSPACE_SUBSCRIPTION_STATUS_URL",
            ["SubscriptionQueryBase"] = "MSPACE_SUBSCRIPTION_QUERY_BASE_URL",
            ["SubscriptionChargingInfo"] = "MSPACE_SUBSCRIPTION_CHARGING_INFO_URL",
            ["SubscriptionList"] = "MSPACE_SUBSCRIPTION_LIST_URL",
            ["SubscriptionNotify"] = "MSPACE_SUBSCRIPTION_NOTIFY_URL",
            ["OtpRequest"] = "MSPACE_OTP_REQUEST_URL",
            ["OtpVerify"] = "MSPACE_OTP_VERIFY_URL",
            ["CaasDebit"] = "MSPACE_CAAS_DEBIT_URL",
            ["CaasOtpVerify"] = "MSPACE_CAAS_OTP_VERIFY_URL",
            ["LbsRequest"] = "MSPACE_LBS_REQUEST_URL",
        };

    /// <summary>Never log this. Never send it to a client.</summary>
    public string ApplicationId { get; set; } = string.Empty;

    /// <summary>Never log this. Never send it to a client.</summary>
    public string Password { get; set; } = string.Empty;

    /// <summary>
    /// Only the services enabled on your application. Point any of these at the mSpace
    /// simulator during development — that is the whole switch.
    /// </summary>
    public Dictionary<string, string> Endpoints { get; } = new();

    /// <summary>Populate from IConfiguration (which includes environment variables).</summary>
    public void Load(Microsoft.Extensions.Configuration.IConfiguration configuration)
    {
        ApplicationId = configuration["MSPACE_APP_ID"]?.Trim() ?? string.Empty;
        Password = configuration["MSPACE_PASSWORD"]?.Trim() ?? string.Empty;

        foreach (var (service, variable) in EndpointVariables)
        {
            var value = configuration[variable]?.Trim().TrimEnd('/');
            if (!string.IsNullOrEmpty(value))
            {
                Endpoints[service] = value;
            }
        }
    }

    /// <summary>Fails the host at startup when a credential is missing.</summary>
    public bool Validate(out string error)
    {
        var required = new (string Value, string Variable)[]
        {
            (ApplicationId, "MSPACE_APP_ID"),
            (Password, "MSPACE_PASSWORD"),
        };

        foreach (var (value, variable) in required)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                error =
                    $"[mspace] Missing required environment variable {variable}. " +
                    "Copy .env.example to .env for development, or set it in your host's " +
                    "secret manager in production.";
                return false;
            }
        }

        error = string.Empty;
        return true;
    }

    /// <summary>
    /// Resolve an endpoint, or fail with a message that names the missing variable. This is
    /// the guard that keeps you from calling an API your application was never provisioned for.
    /// </summary>
    public string RequireEndpoint(string service)
    {
        if (!EndpointVariables.TryGetValue(service, out var variable))
        {
            throw new ArgumentException($"[mspace] Unknown service '{service}'", nameof(service));
        }

        if (!Endpoints.TryGetValue(service, out var url))
        {
            throw new InvalidOperationException(
                $"[mspace] {service} is not configured. Either the API is not enabled on " +
                $"your application, or {variable} is missing from the environment. " +
                "See .env.example.");
        }

        return url;
    }

    /// <summary>Which services this deployment can actually call. Useful at startup.</summary>
    public IReadOnlyList<string> EnabledServices() => Endpoints.Keys.OrderBy(x => x).ToList();

    /// <summary>Redacted view, safe to log at startup to confirm what the process loaded.</summary>
    public string Describe() =>
        $"mSpace{{applicationId={ApplicationId}, password=***redacted***, " +
        $"enabledServices=[{string.Join(", ", EnabledServices())}]}}";
}
