"""
Credential manager — exchanges a Kubit API key for temporary cloud
credentials and auto-refreshes them before expiry.
"""

from __future__ import annotations

import base64
import json
import logging
import threading
import time
from dataclasses import dataclass
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

DEFAULT_TOKEN_ENDPOINT = "https://kubit-ingest.kubit.ai/token"

# Refresh credentials 5 minutes before they expire
_REFRESH_BUFFER_SECONDS = 300


@dataclass
class KinesisCredentials:
    """Temporary cloud credentials for data ingestion."""

    access_key_id: str
    secret_access_key: str
    session_token: str
    expiry: float  # monotonic time when these expire


@dataclass
class WorkspaceIdentity:
    """Resolved identity from a validated API key."""

    wid: str
    org: str
    env: str
    stream_name: str
    region: str
    wid_claim: str


class CredentialManager:
    """
    Thread-safe credential manager.

    On first call (or when credentials are about to expire), exchanges the
    API key for fresh credentials via the Kubit token endpoint.
    """

    def __init__(
        self,
        api_key: str,
        token_endpoint: str = DEFAULT_TOKEN_ENDPOINT,
    ) -> None:
        self._api_key = api_key
        self._endpoint = token_endpoint
        self._lock = threading.Lock()
        self._credentials: Optional[KinesisCredentials] = None
        self._identity: Optional[WorkspaceIdentity] = None
        self._client = httpx.Client(timeout=10.0)
        logger.debug(
            "CredentialManager initialised  endpoint=%s",
            _redact_endpoint(token_endpoint),
        )

    @property
    def identity(self) -> WorkspaceIdentity:
        """Get workspace identity (fetches credentials if needed)."""
        self._ensure_valid()
        assert self._identity is not None
        return self._identity

    @property
    def credentials(self) -> KinesisCredentials:
        """Get current valid credentials (refreshes if needed)."""
        self._ensure_valid()
        assert self._credentials is not None
        return self._credentials

    def close(self) -> None:
        logger.debug("CredentialManager closing http client")
        self._client.close()

    def _ensure_valid(self) -> None:
        """Refresh credentials if missing or about to expire."""
        with self._lock:
            if self._credentials:
                remaining = self._credentials.expiry - time.monotonic()
                if remaining > _REFRESH_BUFFER_SECONDS:
                    logger.debug(
                        "credentials valid  remaining_s=%.0f buffer_s=%d",
                        remaining, _REFRESH_BUFFER_SECONDS,
                    )
                    return
                logger.debug(
                    "credentials nearing expiry — refreshing  remaining_s=%.0f",
                    remaining,
                )
            else:
                logger.debug("no credentials yet — fetching initial token")
            self._refresh()

    def _refresh(self) -> None:
        """Call the token endpoint to get fresh credentials."""
        started = time.monotonic()
        try:
            logger.debug(
                "POST token endpoint  endpoint=%s",
                _redact_endpoint(self._endpoint),
            )
            resp = self._client.post(
                self._endpoint,
                headers={"x-api-key": self._api_key},
            )
        except httpx.HTTPError as exc:
            logger.error("token endpoint unreachable: %s", exc)
            raise CredentialError(f"Token endpoint unreachable: {exc}") from exc

        duration_ms = (time.monotonic() - started) * 1000
        logger.debug(
            "token response  status=%d duration_ms=%.1f",
            resp.status_code, duration_ms,
        )

        if resp.status_code == 401 or resp.status_code == 403:
            logger.error(
                "token endpoint rejected api key  status=%d", resp.status_code,
            )
            raise CredentialError(f"Invalid API key (HTTP {resp.status_code})")

        if resp.status_code != 200:
            logger.error(
                "token endpoint returned non-200  status=%d body_preview=%s",
                resp.status_code, resp.text[:200],
            )
            raise CredentialError(
                f"Token endpoint returned {resp.status_code}: {resp.text[:200]}"
            )

        body = resp.json()

        creds = body.get("credentials", {})
        access_key = creds.get("AccessKeyId", "")
        secret_key = creds.get("SecretAccessKey", "")
        session_token = creds.get("SessionToken", "")

        if not all([access_key, secret_key, session_token]):
            raise CredentialError("Token response missing credentials")

        # Parse metadata
        metadata = body.get("metadata", {})
        wid = metadata.get("partition_key", "")
        stream_name = metadata.get("stream_name", "")
        region = metadata.get("region", "")
        expiry_str = metadata.get("expiry", "")
        wid_claim = metadata.get("wid_claim") or ""

        if not wid:
            raise CredentialError("Token response missing partition_key (wid)")
        if not wid_claim:
            raise CredentialError("Token response missing wid_claim")

        # Parse expiry — endpoint returns an ISO timestamp or epoch
        try:
            from datetime import datetime, timezone

            if expiry_str:
                if isinstance(expiry_str, (int, float)):
                    seconds_until_expiry = float(expiry_str) - time.time()
                else:
                    # ISO format
                    expiry_dt = datetime.fromisoformat(expiry_str.replace("Z", "+00:00"))
                    seconds_until_expiry = (expiry_dt - datetime.now(timezone.utc)).total_seconds()
            else:
                # Default: assume 1 hour if no expiry provided
                seconds_until_expiry = 3600
        except Exception:
            seconds_until_expiry = 3600

        # Extract org and env from API key payload
        org, env = self._extract_org_env()

        self._credentials = KinesisCredentials(
            access_key_id=access_key,
            secret_access_key=secret_key,
            session_token=session_token,
            expiry=time.monotonic() + seconds_until_expiry,
        )

        self._identity = WorkspaceIdentity(
            wid=wid,
            org=org,
            env=env,
            stream_name=stream_name or "kubit-events",
            region=region or "us-east-1",
            wid_claim=wid_claim,
        )

        logger.info(
            "credentials refreshed  wid=%s org=%s env=%s stream=%s region=%s expires_in=%ds",
            wid, org, env, self._identity.stream_name, self._identity.region,
            int(seconds_until_expiry),
        )
        if seconds_until_expiry < _REFRESH_BUFFER_SECONDS * 2:
            logger.warning(
                "credentials short-lived  expires_in=%ds buffer_s=%d",
                int(seconds_until_expiry), _REFRESH_BUFFER_SECONDS,
            )

    def _extract_org_env(self) -> tuple[str, str]:
        """Extract org and env from the API key payload segment."""
        parts = self._api_key.split(".")
        if len(parts) != 4:
            return ("unknown", "unknown")

        payload_b64 = parts[2]
        padding = (4 - len(payload_b64) % 4) % 4
        try:
            payload = json.loads(
                base64.urlsafe_b64decode(payload_b64 + "=" * padding)
            )
            return (
                str(payload.get("org", "unknown")),
                str(payload.get("env", "unknown")),
            )
        except Exception:
            return ("unknown", "unknown")


class CredentialError(Exception):
    """Raised when credential exchange fails."""


def _redact_endpoint(url: str) -> str:
    """
    Return the scheme+host of an endpoint URL, stripping path/query.
    Used in log output so URLs with path-embedded secrets don't leak.
    """
    try:
        from urllib.parse import urlparse
        parsed = urlparse(url)
        if parsed.scheme and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}"
    except Exception:
        pass
    return "<redacted>"
