<?php

declare(strict_types=1);

namespace App\Mspace;

use RuntimeException;

/**
 * mSpace configuration — the ONLY class that reads the environment.
 *
 * Two credentials, plus one URL per service you provisioned. Nothing else is
 * configuration: timeouts and encodings are constants in the client, because
 * they are properties of the protocol rather than of your deployment.
 *
 * An endpoint that is not set means that API is not enabled on your
 * application. The client refuses to call it, so you get a clear local error
 * instead of E1309 from the platform.
 *
 * Build it once during bootstrap and bind it as a singleton, so a misconfigured
 * deployment fails on the first request rather than deep inside a charge.
 *
 * Laravel: bind this in a service provider and read from config('services.mspace')
 * so `php artisan config:cache` still works — do NOT call env() outside config files.
 * Never put credentials in a committed .env.example, config file, or Blade view.
 *
 * SERVER-SIDE ONLY.
 */
final class MspaceConfig
{
    /**
     * Environment variable per service. The names are identical in every
     * language template, so a polyglot estate has one deployment story.
     *
     * @var array<string, string>
     */
    private const ENDPOINT_VARS = [
        'smsSend'                  => 'MSPACE_SMS_SEND_URL',
        'ussdSend'                 => 'MSPACE_USSD_SEND_URL',
        'subscriptionSend'         => 'MSPACE_SUBSCRIPTION_SEND_URL',
        'subscriptionStatus'       => 'MSPACE_SUBSCRIPTION_STATUS_URL',
        'subscriptionQueryBase'    => 'MSPACE_SUBSCRIPTION_QUERY_BASE_URL',
        'subscriptionChargingInfo' => 'MSPACE_SUBSCRIPTION_CHARGING_INFO_URL',
        'subscriptionList'         => 'MSPACE_SUBSCRIPTION_LIST_URL',
        'subscriptionNotify'       => 'MSPACE_SUBSCRIPTION_NOTIFY_URL',
        'otpRequest'               => 'MSPACE_OTP_REQUEST_URL',
        'otpVerify'                => 'MSPACE_OTP_VERIFY_URL',
        'caasDebit'                => 'MSPACE_CAAS_DEBIT_URL',
        'caasOtpVerify'            => 'MSPACE_CAAS_OTP_VERIFY_URL',
        'lbsRequest'               => 'MSPACE_LBS_REQUEST_URL',
    ];

    /** @param array<string, string> $endpoints */
    private function __construct(
        public readonly string $applicationId,
        public readonly string $password,
        private readonly array $endpoints,
    ) {
    }

    /** Read and validate the environment. Call once, during bootstrap. */
    public static function fromEnvironment(): self
    {
        $endpoints = [];
        foreach (self::ENDPOINT_VARS as $service => $variable) {
            $value = rtrim(trim((string) (getenv($variable) ?: '')), '/');
            if ($value !== '') {
                $endpoints[$service] = $value;
            }
        }

        return new self(
            self::requireEnv('MSPACE_APP_ID'),
            self::requireEnv('MSPACE_PASSWORD'),
            $endpoints,
        );
    }

    private static function requireEnv(string $name): string
    {
        $value = trim((string) (getenv($name) ?: ''));
        if ($value === '') {
            throw new RuntimeException(
                "[mspace] Missing required environment variable {$name}.\n" .
                "Copy .env.example to .env and fill in your mSpace credentials.\n" .
                "In production, set it in your host's secret manager."
            );
        }

        return $value;
    }

    /**
     * Resolve an endpoint, or fail with a message that names the missing
     * variable. This is the guard that keeps you from calling an API your
     * application was never provisioned for.
     */
    public function requireEndpoint(string $service): string
    {
        if (!isset(self::ENDPOINT_VARS[$service])) {
            throw new RuntimeException("[mspace] Unknown service '{$service}'");
        }
        if (!isset($this->endpoints[$service])) {
            $variable = self::ENDPOINT_VARS[$service];

            throw new RuntimeException(
                "[mspace] {$service} is not configured. Either the API is not enabled on " .
                "your application, or {$variable} is missing from the environment. " .
                'See .env.example.'
            );
        }

        return $this->endpoints[$service];
    }

    /**
     * Which services this deployment can actually call. Useful at startup.
     *
     * @return list<string>
     */
    public function enabledServices(): array
    {
        return array_keys($this->endpoints);
    }

    /**
     * Redacted view, safe to log at startup to confirm what the process loaded.
     *
     * @return array<string, mixed>
     */
    public function describe(): array
    {
        return [
            'applicationId'   => $this->applicationId,
            'password'        => '***redacted***',
            'enabledServices' => $this->enabledServices(),
        ];
    }
}
