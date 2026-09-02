"""
mSpace API client — Python port of templates/typescript/mspace-client.ts.

One `_post()` helper injects credentials, applies a timeout, and turns
unsuccessful responses into typed errors. Every service is a thin wrapper that
resolves its endpoint through `config.require_endpoint()` — so calling an API
your application was not provisioned for fails locally with a clear message,
rather than as E1309 from the platform.

The one thing that is NOT global: success. "S1000" is the default, CaaS OTP
generation succeeds with "P1003", and Subscriber List also accepts "S1001".

Standard library only, so it drops into any project without adding a dependency.
Using httpx or requests instead is fine and usually better in an existing
codebase — replace `_request()` and keep everything else:

    resp = httpx.post(url, json=payload, timeout=TIMEOUT_SECONDS)
    data = resp.json()          # note: still do NOT call resp.raise_for_status()
                                # as a success check — see _post().

SERVER-SIDE ONLY.
"""

from __future__ import annotations

import json
import re
import ssl
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Union

from mspace_config import config

#: A single outbound call should never hang. Protocol constant, not config.
TIMEOUT_SECONDS = 15

#: If an mSpace host serves an incomplete certificate chain, strict clients
#: reject it. Do NOT "fix" that with ssl._create_unverified_context() or
#: verify=False — that lets anyone on the path read the applicationId and
#: password that can charge your subscribers. Supply the intermediate CA:
#:
#:     SSL_CONTEXT = ssl.create_default_context(cafile="certs/mspace-chain.pem")
#:
#: See references/09-security-best-practices.md.
SSL_CONTEXT = ssl.create_default_context()

# ── Errors ───────────────────────────────────────────────────────────────────

#: Platform-side. Worth retrying with backoff.
TRANSIENT = frozenset(
    {
        "E1100", "E1105", "E1300", "E1316", "E1318", "E1319", "E1341",
        "E1601", "E1603", "E1857", "E9999",
    }
)

#: Provisioning or credentials are wrong. Retrying will never help.
CONFIGURATION = frozenset(
    {
        "E1102", "E1104", "E1301", "E1302", "E1303", "E1309", "E1311",
        "E1313", "E1315", "E1329", "E1330", "E1331", "E1371",
        "E1604", "E1607", "E1608",
    }
)

#: Success codes that are NOT S1000. P1003 is the documented success of CaaS
#: OTP generation — the OTP went out, nothing is charged yet. S1001 means
#: Subscriber List worked and matched nobody.
SUCCESS_DEFAULT = ("S1000",)
SUCCESS_CAAS_OTP_GENERATION = ("P1003",)
SUCCESS_SUBSCRIBER_LIST = ("S1000", "S1001")


class MspaceError(Exception):
    def __init__(
        self,
        status_code: str,
        status_detail: str,
        service: str,
        raw: Optional[Mapping[str, Any]] = None,
    ) -> None:
        super().__init__(f"[{status_code}] {status_detail} ({service})")
        self.status_code = status_code
        self.status_detail = status_detail
        self.service = service
        self.raw = raw

    @property
    def retryable(self) -> bool:
        return self.status_code in TRANSIENT

    @property
    def is_configuration(self) -> bool:
        return self.status_code in CONFIGURATION


# ── Helpers ──────────────────────────────────────────────────────────────────

_SEPARATORS = re.compile(r"[\s()\-]")


def to_tel_address(msisdn: str) -> str:
    """
    Normalise a subscriber address. The ONLY place `tel:` is added.

    Accepts an already-prefixed address, a masked value, +94…, 0094… or a local
    07… number.

    Do NOT push an SMS source_address through this — that is a sender alias or
    short code, not a subscriber address.
    """
    trimmed = (msisdn or "").strip()
    if not trimmed:
        raise ValueError("[mspace] Empty subscriber address")
    if trimmed.lower().startswith("tel:"):
        return trimmed

    digits = _SEPARATORS.sub("", trimmed).lstrip("+")
    if digits.startswith("00"):
        digits = digits[2:]
    if digits.startswith("0") and len(digits) == 10:
        digits = "94" + digits[1:]
    return f"tel:{digits}"


def mask_address(address: str) -> str:
    """Mask a subscriber address for logging. Never log the raw value."""
    body = re.sub(r"^tel:", "", address, flags=re.IGNORECASE)
    if len(body) <= 6:
        return "tel:***"
    return f"tel:{body[:3]}{'*' * (len(body) - 6)}{body[-3:]}"


def generate_external_trx_id() -> str:
    """
    A unique, persistable idempotency key for a charge.

    mSpace publishes no length limit for externalTrxId, so this is simply a
    value that will never collide. Persist it BEFORE the charge call.
    """
    return uuid.uuid4().hex


def format_amount(amount: Union[Decimal, str]) -> str:
    """
    Money crosses the wire as a string. Keep it in Decimal in your own code —
    a float will eventually charge someone 99.99999 rupees.
    """
    if isinstance(amount, float):  # pragma: no cover - guard against a real bug
        raise TypeError("[mspace] Use Decimal or str for money, never float")
    return str(amount)


def detail_of(data: Mapping[str, Any]) -> str:
    """
    The human-readable message, wherever mSpace put it.

    Every service uses statusDetail except CaaS OTP verification, which uses
    statusDescription. A reader that only knows one loses the message on
    exactly the call that took someone's money.
    """
    return str(data.get("statusDetail") or data.get("statusDescription") or "")


def format_notify_timestamp(moment: datetime) -> str:
    """yyMMddHHmm, the documented timestamp format for subscriber notifications."""
    return moment.astimezone(timezone.utc).strftime("%y%m%d%H%M")


# ── Core ─────────────────────────────────────────────────────────────────────


def _request(url: str, body: bytes) -> Dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json;charset=utf-8",
            "Content-Length": str(len(body)),
        },
    )
    try:
        with urllib.request.urlopen(
            request, timeout=TIMEOUT_SECONDS, context=SSL_CONTEXT
        ) as response:
            text = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        # mSpace answers 200 even for its own errors, so a non-2xx here is a
        # gateway or proxy problem — but the body may still be the real answer.
        text = exc.read().decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"[mspace] Non-JSON response: {text[:200]}") from exc


def _post(
    service: str,
    url: str,
    body: Mapping[str, Any],
    success_codes: Iterable[str] = SUCCESS_DEFAULT,
) -> Dict[str, Any]:
    payload = {
        "applicationId": config.application_id,
        "password": config.password,
        **body,
    }
    data = _request(url, json.dumps(payload).encode("utf-8"))

    # The HTTP status is deliberately never consulted: mSpace returns 200 for
    # application-level failures, and the real outcome is statusCode.
    status = str(data.get("statusCode"))
    if status in set(success_codes):
        return data
    raise MspaceError(status, detail_of(data), service, data)


# ── SMS ──────────────────────────────────────────────────────────────────────


def send_sms(
    to: Union[str, Sequence[str]],
    message: str,
    *,
    source_address: Optional[str] = None,
    delivery_status_request: Optional[str] = None,
    encoding: Optional[str] = None,
    binary_header: Optional[str] = None,
) -> Dict[str, Any]:
    """Send an MT SMS to one or more subscribers."""
    recipients: List[str] = [
        to_tel_address(x) for x in ([to] if isinstance(to, str) else list(to))
    ]
    if "tel:all" in recipients:
        raise ValueError(
            "[mspace] Use broadcast_sms() for tel:all — broadcasts must be deliberate."
        )
    body: Dict[str, Any] = {
        "version": "1.0",
        "message": message,
        "destinationAddresses": recipients,
    }
    if source_address:
        body["sourceAddress"] = source_address
    if delivery_status_request:
        body["deliveryStatusRequest"] = delivery_status_request
    if encoding:
        body["encoding"] = encoding
    if binary_header:
        body["binaryHeader"] = binary_header
    return _post("sms-send", config.require_endpoint("sms_send"), body)


BROADCAST_CONFIRMATION = "I_HAVE_VERIFIED_THIS_GOES_TO_ALL_SUBSCRIBERS"


def broadcast_sms(message: str, confirmation: str, **options: Any) -> Dict[str, Any]:
    """
    Send to the ENTIRE subscribed base of the application.

    Deliberately separate from send_sms so it can never be reached by accident —
    check the subscriber base size first with query_base(), and put an
    authorisation check in front of this.
    """
    if confirmation != BROADCAST_CONFIRMATION:
        raise ValueError("[mspace] Broadcast confirmation token missing")
    body: Dict[str, Any] = {
        "version": "1.0",
        "message": message,
        "destinationAddresses": ["tel:all"],
    }
    body.update({k: v for k, v in options.items() if v is not None})
    return _post("sms-send", config.require_endpoint("sms_send"), body)


# ── USSD ─────────────────────────────────────────────────────────────────────


def send_ussd(
    *, session_id: str, destination_address: str, message: str, operation: str
) -> Dict[str, Any]:
    """
    Send a USSD screen.

    `session_id` MUST be the one the USSD Gateway sent you. Use "mt-fin" for the
    final screen — anything else leaves the session hanging until the network
    times it out.
    """
    if operation not in {"mt-init", "mt-cont", "mt-fin"}:
        raise ValueError(f"[mspace] Invalid ussdOperation '{operation}'")
    return _post(
        "ussd-send",
        config.require_endpoint("ussd_send"),
        {
            "version": "1.0",
            "message": message,
            "sessionId": session_id,
            "ussdOperation": operation,
            "destinationAddress": to_tel_address(destination_address),
            "encoding": "440",
        },
    )


# ── Subscription ─────────────────────────────────────────────────────────────


def register(subscriber_id: str) -> Dict[str, Any]:
    """Opt a subscriber in. Only call this with recorded, explicit consent."""
    return _post(
        "subscription-register",
        config.require_endpoint("subscription_send"),
        {"subscriberId": to_tel_address(subscriber_id), "action": "1"},
    )


def unregister(subscriber_id: str) -> Dict[str, Any]:
    """Opt a subscriber out. Make it as reachable as register, in every channel."""
    return _post(
        "subscription-unregister",
        config.require_endpoint("subscription_send"),
        {"subscriberId": to_tel_address(subscriber_id), "action": "0"},
    )


def get_subscription_status(subscriber_id: str) -> Dict[str, Any]:
    """
    Check one subscriber's status. For reconciliation, not per-request gating.

    The result is one of six statuses, not two: INITIAL, REG_PENDING, TRIAL,
    REGISTERED, UNREGISTERED, TEMPORARY_BLOCKED.
    """
    return _post(
        "subscription-status",
        config.require_endpoint("subscription_status"),
        {"subscriberId": to_tel_address(subscriber_id)},
    )


def query_base() -> Dict[str, Any]:
    """
    Subscriber base size. Needs no subscriber and charges nothing, which also
    makes it the best connectivity and credential smoke test.

    `baseSize` comes back as a string, so a parsed integer is added alongside.
    """
    response = _post(
        "subscription-query-base",
        config.require_endpoint("subscription_query_base"),
        {},
    )
    return {**response, "size": int(response.get("baseSize") or 0)}


def get_subscriber_charging_info(subscriber_ids: Sequence[str]) -> Dict[str, Any]:
    """
    Subscription status and last-charge details for up to ten subscribers.

    Every entry carries its own statusCode — one subscriber failing does not
    fail the request, so read the per-entry code rather than only the top-level
    one, and check lastChargedDate exists before using it.
    """
    if len(subscriber_ids) > 10:
        raise ValueError(
            "[mspace] get_subscriber_charging_info accepts at most 10 subscriberIds"
        )
    return _post(
        "subscription-charging-info",
        config.require_endpoint("subscription_charging_info"),
        {"subscriberIds": [to_tel_address(x) for x in subscriber_ids]},
    )


def get_subscriber_list(request_page: int) -> Dict[str, Any]:
    """
    One page of the subscriber list — the catch-up mechanism for subscription
    notifications you missed.

    S1001 ("No Subscribers Found") is a SUCCESS: the request worked and matched
    nobody. Page until moreDataAvailable is false; nextPageNumber is -1 when
    there is no next page.
    """
    if not isinstance(request_page, int) or request_page < 1:
        raise ValueError("[mspace] request_page must be an integer of 1 or greater (E1106)")
    return _post(
        "subscription-list",
        config.require_endpoint("subscription_list"),
        {"version": "1.0", "requestPage": request_page},
        SUCCESS_SUBSCRIBER_LIST,
    )


def notify_subscriber(
    *,
    subscriber_id: str,
    frequency: str,
    status: str,
    time_stamp: Optional[str] = None,
) -> Dict[str, Any]:
    """Send a subscription notification to a subscriber."""
    if frequency not in {"daily", "weekly", "monthly", "yearly"}:
        raise ValueError(f"[mspace] Invalid frequency '{frequency}'")
    return _post(
        "subscription-notify",
        config.require_endpoint("subscription_notify"),
        {
            "timeStamp": time_stamp or format_notify_timestamp(datetime.now(timezone.utc)),
            "version": "1.0",
            "subscriberId": to_tel_address(subscriber_id),
            "frequency": frequency,
            "status": status,
        },
    )


# ── OTP (subscription activation) ────────────────────────────────────────────


def request_otp(
    *,
    subscriber_id: str,
    meta_data: Optional[Mapping[str, Any]] = None,
    application_hash: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Send an OTP to a plain mobile number.

    Rate-limit per number AND per IP before calling, or the application becomes
    an SMS-bombing tool. Keep the returned referenceNo server-side; never log it.
    """
    body: Dict[str, Any] = {"subscriberId": to_tel_address(subscriber_id)}
    if meta_data:
        body["applicationMetaData"] = dict(meta_data)
    if application_hash:
        body["applicationHash"] = application_hash
    return _post("otp-request", config.require_endpoint("otp_request"), body)


def verify_otp(*, reference_no: str, otp: str) -> Dict[str, Any]:
    """
    Verify an OTP and activate the subscription.

    mSpace does not publish the validity window or the attempt limit — E1851
    (expired) and E1852 (attempts reached) are what you get when either is hit,
    so enforce your own limits too. The returned subscriberId is the masked
    identifier to use for every subsequent call.
    """
    return _post(
        "otp-verify",
        config.require_endpoint("otp_verify"),
        {"referenceNo": reference_no, "otp": otp},
    )


# ── CaaS ─────────────────────────────────────────────────────────────────────


def start_charge(
    *,
    subscriber_id: str,
    amount: Union[Decimal, str],
    external_trx_id: str,
    currency: str = "LKR",
    application_hash: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Step 1 of a charge: generate and send the OTP.

    THIS STARTS A REAL CHARGE. It does not complete one.

    - The success code is P1003, not S1000. Nothing has been charged yet;
      mSpace has SMSed an OTP to the subscriber.
    - `external_trx_id` is your idempotency key. Generate it with
      generate_external_trx_id(), PERSIST IT, then call this.
    - Persist `requestCorrelator` from the response — step 3 needs it — and
      `internalTrxId`, which is what support traces with.
    - There are deliberately no retries here. A timeout does NOT mean nothing
      happened. Settle unknown outcomes from the charging notification.
    """
    if not external_trx_id:
        raise ValueError(
            "[mspace] external_trx_id is required and must be persisted first"
        )
    body: Dict[str, Any] = {
        "externalTrxId": external_trx_id,
        "subscriberId": to_tel_address(subscriber_id),
        "paymentInstrumentName": "Mobile Account",
        "amount": format_amount(amount),
        "currency": currency,
    }
    if application_hash:
        body["applicationHash"] = application_hash
    return _post(
        "caas-otp-generation",
        config.require_endpoint("caas_debit"),
        body,
        SUCCESS_CAAS_OTP_GENERATION,
    )


def confirm_charge(
    *, request_correlator: str, otp: str, source_address: str
) -> Dict[str, Any]:
    """
    Step 3 of a charge: verify the OTP the subscriber entered.

    THIS IS THE CALL THAT MOVES THE MONEY.

    `request_correlator` is the value returned by start_charge(), NOT your
    external_trx_id — sending the wrong one gives E1855. The response carries
    statusDescription rather than statusDetail, plus a boolean status.

    The final outcome still arrives on the charging notification.
    """
    return _post(
        "caas-otp-verify",
        config.require_endpoint("caas_otp_verify"),
        {
            "referenceNo": request_correlator,
            "otp": otp,
            "sourceAddress": to_tel_address(source_address),
        },
    )


# ── LBS ──────────────────────────────────────────────────────────────────────


def request_location(
    *,
    requester_id: str,
    subscriber_id: str,
    service_type: Optional[str] = None,
    version: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Request a subscriber's location. mSpace returns it only if the subscriber
    has granted permission.

    `requester_id` (who is asking) and `subscriber_id` (who is being located)
    are two different mandatory fields. Swapping them locates the wrong person.

    Requires explicit, purpose-specific consent — consent to receive SMS is not
    consent to be located.
    """
    body: Dict[str, Any] = {
        "requesterId": to_tel_address(requester_id),
        "subscriberId": to_tel_address(subscriber_id),
    }
    if service_type:
        body["serviceType"] = service_type
    if version:
        body["version"] = version
    return _post("lbs-request", config.require_endpoint("lbs_request"), body)


def parse_fix(response: Mapping[str, Any]) -> Optional[Dict[str, float]]:
    """
    Parse an LBS fix, or None.

    latitude and longitude are strings and absent on failure, so check before
    reading. The range check is your own sanity guard, not a platform rule.
    """
    raw_lat = response.get("latitude")
    raw_lon = response.get("longitude")
    if not raw_lat or not raw_lon:
        return None
    try:
        latitude = float(raw_lat)
        longitude = float(raw_lon)
    except (TypeError, ValueError):
        return None
    # Sri Lanka spans roughly 5.9-9.9 N, 79.5-81.9 E. Anything well outside that
    # is a bad fix or a swapped pair — discard rather than plot it.
    if not (5.5 <= latitude <= 10.5 and 79.0 <= longitude <= 82.5):
        return None
    return {"latitude": latitude, "longitude": longitude}


# ── Extension point ──────────────────────────────────────────────────────────
#
# Adding a service mSpace publishes later:
#
#   1. Add its URL variable to .env.example and to _ENDPOINT_VARS in
#      mspace_config.py
#   2. Add one wrapper here:
#
#          def new_thing(**kwargs):
#              return _post("new-thing", config.require_endpoint("new_thing"), kwargs)
#
# It inherits credential injection, the timeout, error mapping and the
# not-provisioned guard for free. Do not build a parallel client.
