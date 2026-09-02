"""
mSpace configuration — the ONLY module that reads the environment.

Two credentials, plus one URL per service you provisioned. Nothing else is
configuration: timeouts and encodings are constants in the client, because they
are properties of the protocol rather than of your deployment.

An endpoint that is not set means that API is not enabled on your application.
The client refuses to call it, so you get a clear local error instead of E1309
from the platform.

Validation runs at import time, so a misconfigured deployment fails at boot
rather than under load. If your framework defers imports (Django app loading,
Celery workers), call `describe_config()` from your startup hook as well so the
failure surfaces on deploy rather than on first traffic.

SERVER-SIDE ONLY. Nothing here may be exposed through an API response, a
template context, or a settings endpoint the browser can read.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional

# In development, load .env before this module is imported:
#     from dotenv import load_dotenv; load_dotenv()
# In production do not ship a .env at all — use the host's secret manager.


def _require_env(name: str) -> str:
    value = (os.environ.get(name) or "").strip()
    if not value:
        raise RuntimeError(
            f"[mspace] Missing required environment variable {name}.\n"
            f"Copy .env.example to .env and fill in your mSpace credentials.\n"
            f"In production, set it in your host's secret manager."
        )
    return value


def _endpoint(name: str) -> Optional[str]:
    """An endpoint is optional: absent means that API is not provisioned."""
    value = (os.environ.get(name) or "").strip()
    return value.rstrip("/") if value else None


#: Environment variable per service. The names are identical in every language
#: template, so a polyglot estate has one deployment story.
_ENDPOINT_VARS: Dict[str, str] = {
    "sms_send": "MSPACE_SMS_SEND_URL",
    "ussd_send": "MSPACE_USSD_SEND_URL",
    "subscription_send": "MSPACE_SUBSCRIPTION_SEND_URL",
    "subscription_status": "MSPACE_SUBSCRIPTION_STATUS_URL",
    "subscription_query_base": "MSPACE_SUBSCRIPTION_QUERY_BASE_URL",
    "subscription_charging_info": "MSPACE_SUBSCRIPTION_CHARGING_INFO_URL",
    "subscription_list": "MSPACE_SUBSCRIPTION_LIST_URL",
    "subscription_notify": "MSPACE_SUBSCRIPTION_NOTIFY_URL",
    "otp_request": "MSPACE_OTP_REQUEST_URL",
    "otp_verify": "MSPACE_OTP_VERIFY_URL",
    "caas_debit": "MSPACE_CAAS_DEBIT_URL",
    "caas_otp_verify": "MSPACE_CAAS_OTP_VERIFY_URL",
    "lbs_request": "MSPACE_LBS_REQUEST_URL",
}


@dataclass(frozen=True)
class MspaceConfig:
    #: Never log these. Never send them to a client.
    application_id: str
    password: str
    #: Only the services enabled on your application. Point any of these at the
    #: mSpace simulator during development — that is the whole switch.
    endpoints: Dict[str, Optional[str]] = field(default_factory=dict)

    def require_endpoint(self, service: str) -> str:
        """
        Resolve an endpoint, or fail with a message that names the missing
        variable. This is the guard that keeps you from calling an API your
        application was never provisioned for.
        """
        if service not in _ENDPOINT_VARS:
            raise KeyError(f"[mspace] Unknown service '{service}'")
        url = self.endpoints.get(service)
        if not url:
            raise RuntimeError(
                f"[mspace] {service} is not configured. Either the API is not enabled "
                f"on your application, or {_ENDPOINT_VARS[service]} is missing from "
                f"the environment. See .env.example."
            )
        return url

    def enabled_services(self) -> List[str]:
        """Which services this deployment can actually call. Useful at startup."""
        return sorted(name for name, url in self.endpoints.items() if url)


def load_config() -> MspaceConfig:
    return MspaceConfig(
        application_id=_require_env("MSPACE_APP_ID"),
        password=_require_env("MSPACE_PASSWORD"),
        endpoints={name: _endpoint(var) for name, var in _ENDPOINT_VARS.items()},
    )


#: Import-time validation: a missing credential stops the process starting.
config = load_config()


def describe_config() -> Dict[str, object]:
    """Redacted view, safe to log at startup to confirm what the process loaded."""
    return {
        "applicationId": config.application_id,
        "password": "***redacted***",
        "enabledServices": config.enabled_services(),
    }
