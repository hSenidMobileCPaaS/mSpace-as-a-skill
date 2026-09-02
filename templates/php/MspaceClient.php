<?php

declare(strict_types=1);

namespace App\Mspace;

use DateTimeImmutable;
use DateTimeZone;
use InvalidArgumentException;
use RuntimeException;

/**
 * mSpace API client — PHP port of templates/typescript/mspace-client.ts.
 *
 * One post() helper injects credentials, applies a timeout, and turns
 * unsuccessful responses into typed errors. Every service is a thin wrapper that
 * resolves its endpoint through MspaceConfig::requireEndpoint() — so calling an
 * API your application was not provisioned for fails locally with a clear
 * message, rather than as E1309 from the platform.
 *
 * The one thing that is NOT global: success. 'S1000' is the default, CaaS OTP
 * generation succeeds with 'P1003', and Subscriber List also accepts 'S1001'.
 *
 * Uses the cURL extension so it drops into any project without Composer
 * dependencies. Guzzle is a fine substitute — replace request() and keep
 * everything else, but do NOT enable http_errors as a success check: mSpace
 * returns HTTP 200 for its own failures.
 *
 * Requires PHP 8.1+. MspaceException shares this file for readability — split it
 * into its own file if you autoload with PSR-4.
 *
 * SERVER-SIDE ONLY.
 */
final class MspaceClient
{
    /** A single outbound call should never hang. Protocol constant, not config. */
    private const TIMEOUT_SECONDS = 15;

    /** Platform-side. Worth retrying with backoff. */
    public const TRANSIENT = [
        'E1100', 'E1105', 'E1300', 'E1316', 'E1318', 'E1319', 'E1341',
        'E1601', 'E1603', 'E1857', 'E9999',
    ];

    /** Provisioning or credentials are wrong. Retrying will never help. */
    public const CONFIGURATION = [
        'E1102', 'E1104', 'E1301', 'E1302', 'E1303', 'E1309', 'E1311',
        'E1313', 'E1315', 'E1329', 'E1330', 'E1331', 'E1371',
        'E1604', 'E1607', 'E1608',
    ];

    /**
     * Success codes that are NOT S1000.
     *
     * P1003 is the documented success of CaaS OTP generation — the OTP went out,
     * nothing is charged yet. S1001 means Subscriber List worked and matched
     * nobody. A client that only accepts S1000 reports both as failures.
     */
    public const SUCCESS_DEFAULT              = ['S1000'];
    public const SUCCESS_CAAS_OTP_GENERATION  = ['P1003'];
    public const SUCCESS_SUBSCRIBER_LIST      = ['S1000', 'S1001'];

    public const BROADCAST_CONFIRMATION = 'I_HAVE_VERIFIED_THIS_GOES_TO_ALL_SUBSCRIBERS';

    public function __construct(private readonly MspaceConfig $config)
    {
    }

    /* ── Helpers ──────────────────────────────────────────────────────────── */

    /**
     * Normalise a subscriber address. The ONLY place `tel:` is added.
     *
     * Accepts an already-prefixed address, a masked value, +94…, 0094… or a
     * local 07… number.
     *
     * Do NOT push an SMS sourceAddress through this — that is a sender alias or
     * short code, not a subscriber address.
     */
    public static function toTelAddress(string $msisdn): string
    {
        $trimmed = trim($msisdn);
        if ($trimmed === '') {
            throw new InvalidArgumentException('[mspace] Empty subscriber address');
        }
        if (stripos($trimmed, 'tel:') === 0) {
            return $trimmed;
        }

        $digits = ltrim((string) preg_replace('/[\s()\-]/', '', $trimmed), '+');
        if (str_starts_with($digits, '00')) {
            $digits = substr($digits, 2);
        }
        if (str_starts_with($digits, '0') && strlen($digits) === 10) {
            $digits = '94' . substr($digits, 1);
        }

        return 'tel:' . $digits;
    }

    /** Mask a subscriber address for logging. Never log the raw value. */
    public static function maskAddress(string $address): string
    {
        $body = (string) preg_replace('/^tel:/i', '', $address);
        if (strlen($body) <= 6) {
            return 'tel:***';
        }

        return 'tel:' . substr($body, 0, 3)
            . str_repeat('*', strlen($body) - 6)
            . substr($body, -3);
    }

    /**
     * A unique, persistable idempotency key for a charge.
     *
     * mSpace publishes no length limit for externalTrxId, so this is simply a
     * value that will never collide. Persist it BEFORE the charge call.
     */
    public static function generateExternalTrxId(): string
    {
        return bin2hex(random_bytes(16));
    }

    /**
     * The human-readable message, wherever mSpace put it.
     *
     * Every service uses statusDetail except CaaS OTP verification, which uses
     * statusDescription.
     *
     * @param array<string, mixed> $data
     */
    public static function detailOf(array $data): string
    {
        return (string) ($data['statusDetail'] ?? $data['statusDescription'] ?? '');
    }

    /** yyMMddHHmm, the documented timestamp format for subscriber notifications. */
    public static function formatNotifyTimestamp(?DateTimeImmutable $moment = null): string
    {
        $moment ??= new DateTimeImmutable('now', new DateTimeZone('UTC'));

        return $moment->setTimezone(new DateTimeZone('UTC'))->format('ymdHi');
    }

    /* ── Core ─────────────────────────────────────────────────────────────── */

    /**
     * @param array<string, mixed> $body
     * @param list<string>         $successCodes
     *
     * @return array<string, mixed>
     */
    private function post(
        string $service,
        string $url,
        array $body,
        array $successCodes = self::SUCCESS_DEFAULT
    ): array {
        $payload = json_encode(
            array_merge(
                [
                    'applicationId' => $this->config->applicationId,
                    'password'      => $this->config->password,
                ],
                $body
            ),
            JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES
        );

        $data = $this->request($service, $url, $payload);

        $statusCode = (string) ($data['statusCode'] ?? '');
        if (in_array($statusCode, $successCodes, true)) {
            return $data;
        }

        throw new MspaceException($statusCode, self::detailOf($data), $service, $data);
    }

    /** @return array<string, mixed> */
    private function request(string $service, string $url, string $payload): array
    {
        $handle = curl_init($url);
        if ($handle === false) {
            throw new RuntimeException("[mspace] {$service}: could not initialise cURL");
        }

        curl_setopt_array($handle, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $payload,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => self::TIMEOUT_SECONDS,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json;charset=utf-8'],
            // If an mSpace host serves an incomplete certificate chain, do NOT
            // "fix" it with CURLOPT_SSL_VERIFYPEER => false — that lets anyone
            // on the path read the applicationId and password that can charge
            // your subscribers. Supply the intermediate CA instead:
            //   CURLOPT_CAINFO => __DIR__ . '/certs/mspace-chain.pem',
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ]);

        $raw = curl_exec($handle);
        $error = curl_error($handle);
        curl_close($handle);

        if ($raw === false) {
            throw new RuntimeException("[mspace] {$service}: transport failure: {$error}");
        }

        // The HTTP status is deliberately not consulted: mSpace returns 200 for
        // application-level failures, and the real outcome is statusCode.
        $decoded = json_decode((string) $raw, true);
        if (!is_array($decoded)) {
            throw new RuntimeException(
                "[mspace] {$service}: non-JSON response: " . substr((string) $raw, 0, 200)
            );
        }

        return $decoded;
    }

    /* ── SMS ──────────────────────────────────────────────────────────────── */

    /**
     * Send an MT SMS to one or more subscribers.
     *
     * @param string|list<string>  $to
     * @param array<string, mixed> $options sourceAddress, deliveryStatusRequest,
     *                                      encoding, binaryHeader
     *
     * @return array<string, mixed>
     */
    public function sendSms(string|array $to, string $message, array $options = []): array
    {
        $recipients = array_map(
            [self::class, 'toTelAddress'],
            is_array($to) ? $to : [$to]
        );
        if (in_array('tel:all', $recipients, true)) {
            throw new InvalidArgumentException(
                '[mspace] Use broadcastSms() for tel:all — broadcasts must be deliberate.'
            );
        }

        return $this->post('sms-send', $this->config->requireEndpoint('smsSend'), array_merge(
            [
                'version'              => '1.0',
                'message'              => $message,
                'destinationAddresses' => array_values($recipients),
            ],
            $options
        ));
    }

    /**
     * Send to the ENTIRE subscribed base of the application.
     *
     * Deliberately separate from sendSms() so it can never be reached by
     * accident — check the subscriber base size first, and put an authorisation
     * check in front of this.
     *
     * @param array<string, mixed> $options
     *
     * @return array<string, mixed>
     */
    public function broadcastSms(string $message, string $confirmation, array $options = []): array
    {
        if ($confirmation !== self::BROADCAST_CONFIRMATION) {
            throw new InvalidArgumentException('[mspace] Broadcast confirmation token missing');
        }

        return $this->post('sms-send', $this->config->requireEndpoint('smsSend'), array_merge(
            [
                'version'              => '1.0',
                'message'              => $message,
                'destinationAddresses' => ['tel:all'],
            ],
            $options
        ));
    }

    /* ── USSD ─────────────────────────────────────────────────────────────── */

    /**
     * Send a USSD screen.
     *
     * $sessionId MUST be the one the USSD Gateway sent you. Use 'mt-fin' for the
     * final screen — anything else leaves the session hanging until the network
     * times out.
     *
     * @return array<string, mixed>
     */
    public function sendUssd(
        string $sessionId,
        string $destinationAddress,
        string $message,
        string $operation
    ): array {
        if (!in_array($operation, ['mt-init', 'mt-cont', 'mt-fin'], true)) {
            throw new InvalidArgumentException("[mspace] Invalid ussdOperation '{$operation}'");
        }

        return $this->post('ussd-send', $this->config->requireEndpoint('ussdSend'), [
            'version'            => '1.0',
            'message'            => $message,
            'sessionId'          => $sessionId,
            'ussdOperation'      => $operation,
            'destinationAddress' => self::toTelAddress($destinationAddress),
            'encoding'           => '440',
        ]);
    }

    /* ── Subscription ─────────────────────────────────────────────────────── */

    /**
     * Opt a subscriber in. Only call this with recorded, explicit consent.
     *
     * @return array<string, mixed>
     */
    public function register(string $subscriberId): array
    {
        return $this->post(
            'subscription-register',
            $this->config->requireEndpoint('subscriptionSend'),
            ['subscriberId' => self::toTelAddress($subscriberId), 'action' => '1']
        );
    }

    /**
     * Opt a subscriber out. Make it as reachable as register, in every channel.
     *
     * @return array<string, mixed>
     */
    public function unregister(string $subscriberId): array
    {
        return $this->post(
            'subscription-unregister',
            $this->config->requireEndpoint('subscriptionSend'),
            ['subscriberId' => self::toTelAddress($subscriberId), 'action' => '0']
        );
    }

    /**
     * Check one subscriber's status. For reconciliation, not per-request gating.
     *
     * The result is one of six statuses, not two: INITIAL, REG_PENDING, TRIAL,
     * REGISTERED, UNREGISTERED, TEMPORARY_BLOCKED.
     *
     * @return array<string, mixed>
     */
    public function subscriptionStatus(string $subscriberId): array
    {
        return $this->post(
            'subscription-status',
            $this->config->requireEndpoint('subscriptionStatus'),
            ['subscriberId' => self::toTelAddress($subscriberId)]
        );
    }

    /**
     * Subscriber base size. Needs no subscriber and charges nothing, which also
     * makes it the best connectivity and credential smoke test.
     */
    public function queryBase(): int
    {
        $data = $this->post(
            'subscription-query-base',
            $this->config->requireEndpoint('subscriptionQueryBase'),
            []
        );

        return (int) ($data['baseSize'] ?? 0); // documented as a string
    }

    /**
     * Subscription status and last-charge details for up to ten subscribers.
     *
     * Every entry in destinationResponses carries its own statusCode, and which
     * fields are present depends on the status.
     *
     * @param list<string> $subscriberIds
     *
     * @return array<string, mixed>
     */
    public function subscriberChargingInfo(array $subscriberIds): array
    {
        if (count($subscriberIds) > 10) {
            throw new InvalidArgumentException(
                '[mspace] subscriberChargingInfo accepts at most 10 subscriberIds'
            );
        }

        return $this->post(
            'subscription-charging-info',
            $this->config->requireEndpoint('subscriptionChargingInfo'),
            ['subscriberIds' => array_map([self::class, 'toTelAddress'], $subscriberIds)]
        );
    }

    /**
     * One page of the subscriber list — the catch-up mechanism for subscription
     * notifications you missed.
     *
     * S1001 ("No Subscribers Found") is a SUCCESS: the request worked and matched
     * nobody. Page until moreDataAvailable is false; nextPageNumber is -1 when
     * there is no next page.
     *
     * @return array<string, mixed>
     */
    public function subscriberList(int $requestPage): array
    {
        if ($requestPage < 1) {
            throw new InvalidArgumentException('[mspace] requestPage must be 1 or greater (E1106)');
        }

        return $this->post(
            'subscription-list',
            $this->config->requireEndpoint('subscriptionList'),
            ['version' => '1.0', 'requestPage' => $requestPage],
            self::SUCCESS_SUBSCRIBER_LIST
        );
    }

    /**
     * Send a subscription notification to a subscriber.
     *
     * @return array<string, mixed>
     */
    public function notifySubscriber(
        string $subscriberId,
        string $frequency,
        string $status,
        ?string $timeStamp = null
    ): array {
        if (!in_array($frequency, ['daily', 'weekly', 'monthly', 'yearly'], true)) {
            throw new InvalidArgumentException("[mspace] Invalid frequency '{$frequency}'");
        }

        return $this->post(
            'subscription-notify',
            $this->config->requireEndpoint('subscriptionNotify'),
            [
                'timeStamp'    => $timeStamp ?? self::formatNotifyTimestamp(),
                'version'      => '1.0',
                'subscriberId' => self::toTelAddress($subscriberId),
                'frequency'    => $frequency,
                'status'       => $status,
            ]
        );
    }

    /* ── OTP (subscription activation) ────────────────────────────────────── */

    /**
     * Send an OTP to a plain mobile number.
     *
     * Rate-limit per number AND per IP before calling, or the application
     * becomes an SMS-bombing tool. Keep the returned referenceNo server-side;
     * never log it.
     *
     * @param array<string, mixed> $applicationMetaData
     *
     * @return array<string, mixed>
     */
    public function requestOtp(string $subscriberId, array $applicationMetaData = []): array
    {
        $body = ['subscriberId' => self::toTelAddress($subscriberId)];
        if ($applicationMetaData !== []) {
            $body['applicationMetaData'] = $applicationMetaData;
        }

        return $this->post('otp-request', $this->config->requireEndpoint('otpRequest'), $body);
    }

    /**
     * Verify an OTP and activate the subscription.
     *
     * mSpace does not publish the validity window or the attempt limit — E1851
     * (expired) and E1852 (attempts reached) are what you get when either is
     * hit, so enforce your own limits too. The returned subscriberId is the
     * masked identifier to use for every subsequent call.
     *
     * @return array<string, mixed>
     */
    public function verifyOtp(string $referenceNo, string $otp): array
    {
        return $this->post('otp-verify', $this->config->requireEndpoint('otpVerify'), [
            'referenceNo' => $referenceNo,
            'otp'         => $otp,
        ]);
    }

    /* ── CaaS ─────────────────────────────────────────────────────────────── */

    /**
     * Step 1 of a charge: generate and send the OTP.
     *
     * THIS STARTS A REAL CHARGE. It does not complete one.
     *
     * - The success code is P1003, not S1000. Nothing is charged yet; mSpace has
     *   SMSed an OTP to the subscriber.
     * - $externalTrxId is your idempotency key. Generate it with
     *   generateExternalTrxId(), PERSIST IT, then call this.
     * - Persist requestCorrelator from the response — step 3 needs it — and
     *   internalTrxId, which is what support traces with.
     * - There are deliberately no retries here. A timeout does NOT mean nothing
     *   happened. Settle unknown outcomes from the charging notification.
     * - $amount is a string: keep money in bcmath or integer minor units. A
     *   float will eventually charge someone 99.99999 rupees.
     *
     * @return array<string, mixed>
     */
    public function startCharge(
        string $subscriberId,
        string $amount,
        string $externalTrxId,
        string $currency = 'LKR'
    ): array {
        if ($externalTrxId === '') {
            throw new InvalidArgumentException(
                '[mspace] externalTrxId is required and must be persisted first'
            );
        }

        return $this->post(
            'caas-otp-generation',
            $this->config->requireEndpoint('caasDebit'),
            [
                'externalTrxId'         => $externalTrxId,
                'subscriberId'          => self::toTelAddress($subscriberId),
                'paymentInstrumentName' => 'Mobile Account',
                'amount'                => $amount,
                'currency'              => $currency,
            ],
            self::SUCCESS_CAAS_OTP_GENERATION
        );
    }

    /**
     * Step 3 of a charge: verify the OTP the subscriber entered.
     *
     * THIS IS THE CALL THAT MOVES THE MONEY.
     *
     * $requestCorrelator is the value returned by startCharge(), NOT your
     * externalTrxId — sending the wrong one gives E1855. The response carries
     * statusDescription rather than statusDetail, plus a boolean status.
     *
     * The final outcome still arrives on the charging notification.
     *
     * @return array<string, mixed>
     */
    public function confirmCharge(
        string $requestCorrelator,
        string $otp,
        string $sourceAddress
    ): array {
        return $this->post(
            'caas-otp-verify',
            $this->config->requireEndpoint('caasOtpVerify'),
            [
                'referenceNo'   => $requestCorrelator,
                'otp'           => $otp,
                'sourceAddress' => self::toTelAddress($sourceAddress),
            ]
        );
    }

    /* ── LBS ──────────────────────────────────────────────────────────────── */

    /**
     * Request a subscriber's location. mSpace returns it only if the subscriber
     * has granted permission.
     *
     * $requesterId (who is asking) and $subscriberId (who is being located) are
     * two different mandatory fields. Swapping them locates the wrong person.
     *
     * Requires explicit, purpose-specific consent — consent to receive SMS is
     * not consent to be located.
     *
     * @return array<string, mixed>
     */
    public function requestLocation(
        string $requesterId,
        string $subscriberId,
        ?string $serviceType = null
    ): array {
        $body = [
            'requesterId'  => self::toTelAddress($requesterId),
            'subscriberId' => self::toTelAddress($subscriberId),
        ];
        if ($serviceType !== null) {
            $body['serviceType'] = $serviceType;
        }

        return $this->post('lbs-request', $this->config->requireEndpoint('lbsRequest'), $body);
    }

    /* ── Extension point ───────────────────────────────────────────────────
     *
     * Adding a service mSpace publishes later:
     *
     *   1. Add its URL variable to .env.example and to ENDPOINT_VARS in
     *      MspaceConfig
     *   2. Add one wrapper here that calls $this->post() with the new key.
     *
     * It inherits credential injection, the timeout, error mapping and the
     * not-provisioned guard for free. Do not build a parallel client.
     */
}

/** An unsuccessful application-level response. */
final class MspaceException extends RuntimeException
{
    /** @param array<string, mixed> $raw */
    public function __construct(
        public readonly string $statusCode,
        public readonly string $statusDetail,
        public readonly string $service,
        public readonly array $raw = [],
    ) {
        parent::__construct("[{$statusCode}] {$statusDetail} ({$service})");
    }

    public function isRetryable(): bool
    {
        return in_array($this->statusCode, MspaceClient::TRANSIENT, true);
    }

    public function isConfiguration(): bool
    {
        return in_array($this->statusCode, MspaceClient::CONFIGURATION, true);
    }
}
