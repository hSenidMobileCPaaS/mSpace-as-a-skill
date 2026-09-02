<?php

declare(strict_types=1);

namespace App\Mspace;

use Throwable;

/**
 * mSpace callback (inbound webhook) handlers — framework-neutral PHP.
 *
 * Routes to register on the application record:
 *   SMS Receive (MO)          POST /api/mspace/sms/receive     (Message Receiving URL)
 *   Delivery report           POST /api/mspace/sms/report      (Delivery Report URL)
 *   USSD receive              POST /api/mspace/ussd/receive    (USSD Connection URL)
 *   Subscription notification POST /api/mspace/subscription/notification
 *   Charging notification     POST /api/mspace/charging/notification
 *
 * The contract, for all five:
 *   - Respond {"statusCode":"S1000","statusDetail":"Success"}
 *   - Respond FIRST, work afterwards
 *   - Always HTTP 200, even for payloads you reject
 *   - Be idempotent — every callback can arrive more than once
 *   - Never trust the body; it is unauthenticated JSON from the internet
 *
 * Returning anything the platform cannot parse is reported back as E1607.
 *
 * Laravel: make each method a controller action returning response()->json(self::ACK),
 * put the routes in routes/api.php (which is CSRF-exempt), and dispatch a queued
 * Job instead of calling handleJob() inline.
 *
 * Full rules: references/07-callbacks.md.
 */
final class MspaceCallbacks
{
    /** The only response mSpace expects. */
    public const ACK = ['statusCode' => 'S1000', 'statusDetail' => 'Success'];

    /**
     * Restrict to the platform's egress IPs. mSpace signs nothing, so there is
     * no signature to verify — source IP is the strongest control available.
     * Prefer enforcing it at the firewall or load balancer; this is the fallback
     * for when you cannot.
     *
     * @var list<string>
     */
    public const MSPACE_SOURCE_IPS = [];

    public function __construct(
        private readonly MspaceConfig $config,
        private readonly MspaceClient $client,
        private readonly UssdSessionStore $sessions,
        private readonly DedupeStore $dedupe,
        private readonly JobQueue $queue,
    ) {
    }

    /* ── Shared guards ────────────────────────────────────────────────────── */

    public static function isAllowedSource(?string $remoteAddress): bool
    {
        if (self::MSPACE_SOURCE_IPS === []) {
            return true; // not configured yet
        }

        return $remoteAddress !== null
            && in_array($remoteAddress, self::MSPACE_SOURCE_IPS, true);
    }

    /**
     * Read the JSON body without failing the response on malformed input.
     *
     * @return array<string, mixed>|null
     */
    public static function readJson(string $raw): ?array
    {
        $decoded = json_decode($raw, true);

        return is_array($decoded) ? $decoded : null;
    }

    /**
     * Reject payloads addressed to a different application. Cheap noise filter.
     *
     * The delivery report and charging notification payloads do not carry
     * applicationId, so those handlers rely on the source-IP control instead.
     *
     * @param array<string, mixed> $body
     */
    private function isOurApp(array $body): bool
    {
        return ($body['applicationId'] ?? null) === $this->config->applicationId;
    }

    /* ── 1. SMS Receive (MO) ──────────────────────────────────────────────── */

    /**
     * @param array<string, mixed>|null $body
     *
     * @return array<string, string>
     */
    public function moSms(?array $body): array
    {
        if ($body === null || !$this->isOurApp($body) || empty($body['requestId'])) {
            return self::ACK;
        }
        if ($this->dedupe->isDuplicate('mo:' . $body['requestId'])) {
            return self::ACK;
        }

        // Message content deliberately not logged — it is user communication.
        error_log(sprintf(
            '[mspace] sms-mo requestId=%s from=%s',
            (string) $body['requestId'],
            MspaceClient::maskAddress((string) ($body['sourceAddress'] ?? ''))
        ));

        $this->queue->push('sms.mo', $body);

        return self::ACK;
    }

    /* ── 2. SMS delivery report ───────────────────────────────────────────── */

    /** mSpace documents the long forms; SMPP commonly uses the short ones. */
    private const DELIVERY_STATUS = [
        'DELIVRD' => 'DELIVERED',
        'UNDELIV' => 'UNDELIVERABLE',
        'ACCEPTD' => 'ACCEPTED',
        'REJECTD' => 'REJECTED',
    ];

    /**
     * @param array<string, mixed>|null $body
     *
     * @return array<string, string>
     */
    public function deliveryReport(?array $body): array
    {
        if ($body === null || empty($body['requestId']) || empty($body['deliveryStatus'])) {
            return self::ACK;
        }

        $raw = (string) $body['deliveryStatus'];
        $status = self::DELIVERY_STATUS[$raw] ?? $raw;
        if ($this->dedupe->isDuplicate("dlr:{$body['requestId']}:{$status}")) {
            return self::ACK;
        }

        error_log(sprintf(
            '[mspace] delivery-report requestId=%s status=%s',
            (string) $body['requestId'],
            $status
        ));

        $this->queue->push('sms.dlr', array_merge($body, ['deliveryStatus' => $status]));

        return self::ACK;
    }

    /**
     * Timestamps are documented as yyMMddHHmm (10 digits), and the documented
     * sample is 14 (yyyyMMddHHmmss). Parse both; return null rather than
     * guessing.
     */
    public static function parseMspaceTimestamp(string $raw): ?\DateTimeImmutable
    {
        $format = match (strlen($raw)) {
            14 => 'YmdHis',
            10 => 'ymdHi',
            default => null,
        };
        if ($format === null || !ctype_digit($raw)) {
            return null;
        }

        $parsed = \DateTimeImmutable::createFromFormat(
            $format,
            $raw,
            new \DateTimeZone('UTC')
        );

        return $parsed === false ? null : $parsed;
    }

    /* ── 3. USSD receive ──────────────────────────────────────────────────── */

    /**
     * The response body here is ONLY an acknowledgement. The screen the
     * subscriber sees comes from a separate POST /ussd/send — which is why the
     * reply is queued rather than returned.
     *
     * USSD sessions time out in seconds. Do nothing slow before acknowledging.
     *
     * @param array<string, mixed>|null $body
     *
     * @return array<string, string>
     */
    public function ussd(?array $body): array
    {
        if ($body === null || !$this->isOurApp($body)) {
            return self::ACK;
        }
        if (empty($body['sessionId']) || empty($body['sourceAddress'])) {
            return self::ACK;
        }
        if ($this->dedupe->isDuplicate('ussd:' . ($body['requestId'] ?? ''))) {
            return self::ACK;
        }

        error_log(sprintf(
            '[mspace] ussd sessionId=%s operation=%s from=%s',
            (string) $body['sessionId'],
            (string) ($body['ussdOperation'] ?? ''),
            MspaceClient::maskAddress((string) $body['sourceAddress'])
        ));

        $this->queue->push('ussd.receive', $body);

        return self::ACK;
    }

    /**
     * The menu logic, run out of band. Replies via sendUssd().
     *
     * @param array<string, mixed> $payload
     */
    public function handleUssdInput(array $payload): void
    {
        $sessionId = (string) $payload['sessionId'];
        $source = (string) $payload['sourceAddress'];
        $input = trim((string) ($payload['message'] ?? ''));

        if (($payload['ussdOperation'] ?? '') === 'mo-init') {
            $this->sessions->set($sessionId, 'root', $source);
            $this->client->sendUssd(
                $sessionId,
                $source,
                "Welcome to Acme\n1. Balance\n2. Support\n0. Exit",
                'mt-cont'
            );

            return;
        }

        if ($this->sessions->get($sessionId) === null) {
            // Expired or unknown — close cleanly rather than leaving it hanging.
            $this->client->sendUssd(
                $sessionId,
                $source,
                'Session expired. Please dial again.',
                'mt-fin'
            );

            return;
        }

        // Terminal screens MUST use mt-fin, or the session hangs until the
        // network times it out.
        switch ($input) {
            case '0':
                $this->sessions->end($sessionId);
                $this->client->sendUssd($sessionId, $source, 'Thank you.', 'mt-fin');

                return;

            case '1':
                $this->sessions->end($sessionId);
                $this->client->sendUssd(
                    $sessionId,
                    $source,
                    'Your balance is Rs. 300.00',
                    'mt-fin'
                );

                return;

            case '2':
                $this->sessions->set($sessionId, 'support', $source);
                $this->client->sendUssd(
                    $sessionId,
                    $source,
                    "Support\n1. Call us\n2. SMS us\n0. Exit",
                    'mt-cont'
                );

                return;

            default:
                // Invalid input: reshow rather than dropping the session.
                $this->client->sendUssd(
                    $sessionId,
                    $source,
                    "Invalid option\n1. Balance\n2. Support\n0. Exit",
                    'mt-cont'
                );
        }
    }

    /* ── 4. Subscription notification ─────────────────────────────────────── */

    /**
     * The authoritative source of subscription state — including changes you did
     * not initiate (a subscriber texting STOP, an operator removal, a billing
     * failure). Consuming it is what lets you keep a local mirror instead of
     * polling getStatus.
     *
     * mSpace publishes no separate payload for this URL. These are the fields
     * the documented POST /subscription/notify service defines, so accept them
     * and tolerate anything else — log the raw body on the first delivery in
     * Limited Production and widen from there. If it is ever down,
     * subscriberList() is the documented catch-up mechanism.
     *
     * @param array<string, mixed>|null $body
     *
     * @return array<string, string>
     */
    public function subscriptionNotification(?array $body): array
    {
        if ($body === null) {
            return self::ACK;
        }
        if (isset($body['applicationId']) && !$this->isOurApp($body)) {
            return self::ACK;
        }
        if (empty($body['subscriberId']) || empty($body['status'])) {
            return self::ACK;
        }

        $key = sprintf(
            'sub:%s:%s:%s',
            $body['subscriberId'],
            $body['status'],
            $body['timeStamp'] ?? ''
        );
        if ($this->dedupe->isDuplicate($key)) {
            return self::ACK;
        }

        error_log(sprintf(
            '[mspace] subscription-notification subscriber=%s status=%s',
            MspaceClient::maskAddress((string) $body['subscriberId']),
            (string) $body['status']
        ));

        $this->queue->push('subscription.notification', $body);

        return self::ACK;
    }

    /* ── 5. Charging notification ─────────────────────────────────────────── */

    /**
     * Your reconciliation channel, and the only place a charge is finally
     * settled. Every charge left in an unknown state after a timeout gets
     * resolved here. Idempotency is not optional — a duplicate that
     * double-counts revenue is a real bug with real consequences.
     *
     * S1000 means the request was processed and the due amount was fully paid.
     * Read TotalAmount, paidAmount and balanceDue together before believing it.
     *
     * @param array<string, mixed>|null $body
     *
     * @return array<string, string>
     */
    public function chargingNotification(?array $body): array
    {
        if ($body === null) {
            return self::ACK;
        }

        $key = $body['externalTrxId'] ?? $body['internalTrxId'] ?? null;
        if ($key === null) {
            return self::ACK;
        }
        if ($this->dedupe->isDuplicate("charge:{$key}:" . ($body['statusCode'] ?? ''))) {
            return self::ACK;
        }

        error_log(sprintf(
            '[mspace] charging-notification externalTrxId=%s statusCode=%s paidAmount=%s balanceDue=%s',
            (string) ($body['externalTrxId'] ?? ''),
            (string) ($body['statusCode'] ?? ''),
            (string) ($body['paidAmount'] ?? ''),
            (string) ($body['balanceDue'] ?? '')
        ));

        $this->queue->push('charging.notification', $body);

        return self::ACK;
    }

    /* ── Job dispatch ─────────────────────────────────────────────────────── */

    /** @param array<string, mixed> $payload */
    public function handleJob(string $job, array $payload): void
    {
        try {
            match ($job) {
                'ussd.receive' => $this->handleUssdInput($payload),
                // Honour opt-out keywords, then handle your own commands.
                'sms.mo' => null,
                // Persist the latest status keyed by requestId.
                'sms.dlr' => null,
                // Upsert your local subscription mirror. Six statuses, not two.
                'subscription.notification' => null,
                // Reconcile against your charge ledger by externalTrxId.
                'charging.notification' => null,
                default => error_log("[mspace] unknown job {$job}"),
            };
        } catch (Throwable $error) {
            error_log("[mspace] job {$job} failed: " . $error->getMessage());
            // Send to a dead-letter queue here.
        }
    }
}

/**
 * Deduplication. The array implementation below lives only as long as one
 * request, which is useless — wire this to Redis (SETNX + TTL) or a unique
 * database constraint, because duplicates arrive as separate requests.
 */
interface DedupeStore
{
    public function isDuplicate(string $key): bool;
}

/**
 * USSD session store: keyed by sessionId, TTL of about 2 minutes, shared across
 * processes. PHP has no long-lived process to hold sessions in, so Redis (or a
 * database table with an expiry column) is the only correct implementation here.
 */
interface UssdSessionStore
{
    public function get(string $sessionId): ?string;

    public function set(string $sessionId, string $node, string $sourceAddress): void;

    public function end(string $sessionId): void;
}

/**
 * Work handed off so the HTTP response does not wait for it.
 *
 * PHP-FPM has no background worker of its own: a queue (Laravel queues, a Redis
 * list drained by a worker, a database table with a cron consumer) is required.
 * fastcgi_finish_request() flushes the response early and is an acceptable
 * stopgap for USSD, but it does not survive a crash — never use it for charging
 * reconciliation.
 */
interface JobQueue
{
    /** @param array<string, mixed> $payload */
    public function push(string $job, array $payload): void;
}

/* ── Front controller ──────────────────────────────────────────────────────
 *
 * A plain-PHP entry point, for projects without a framework router:
 *
 *   $body = MspaceCallbacks::readJson(file_get_contents('php://input') ?: '');
 *   $callbacks = new MspaceCallbacks($config, $client, $sessions, $dedupe, $queue);
 *
 *   $response = match ($_SERVER['REQUEST_URI'] ?? '') {
 *       '/api/mspace/sms/receive'                => $callbacks->moSms($body),
 *       '/api/mspace/sms/report'                 => $callbacks->deliveryReport($body),
 *       '/api/mspace/ussd/receive'               => $callbacks->ussd($body),
 *       '/api/mspace/subscription/notification'  => $callbacks->subscriptionNotification($body),
 *       '/api/mspace/charging/notification'      => $callbacks->chargingNotification($body),
 *       default                                  => MspaceCallbacks::ACK,
 *   };
 *
 *   http_response_code(200);                      // ALWAYS 200
 *   header('Content-Type: application/json');
 *   echo json_encode($response);
 *
 * Keep these paths out of any auth middleware and rely on the source-IP
 * allowlist instead — or you have left an open endpoint.
 */
