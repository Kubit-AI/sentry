"""
KubitExporter — OpenTelemetry SpanExporter for Kubit analytics.

Transforms OTel spans into Kubit records and sends them to the ingestion
backend. Credentials are auto-refreshed before expiry.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Optional, Sequence

import boto3

from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult

from kubit_otel.credentials import CredentialManager, DEFAULT_TOKEN_ENDPOINT
from kubit_otel.transformer import transform_spans

logger = logging.getLogger(__name__)

# Kinesis limits
_MAX_RECORDS_PER_CALL = 250
_MAX_BYTES_PER_CALL = 5 * 1024 * 1024  # 5 MB
_MAX_RECORD_BYTES = 1_048_576  # 1 MB per record
_MAX_RETRIES = 5


class KubitExporter(SpanExporter):
    """
    OpenTelemetry SpanExporter that sends spans to Kubit for analytics.

    Parameters
    ----------
    api_key : str
        Kubit API key (``rg.v1.<payload>.<sig>``).
    token_endpoint : str
        URL of the credential endpoint (default: ``https://langfuse-ingest.kubit.ai/token``).
    """

    def __init__(
        self,
        api_key: str,
        token_endpoint: str = DEFAULT_TOKEN_ENDPOINT,
    ) -> None:
        self._cred_manager = CredentialManager(api_key, token_endpoint)
        self._client: Optional[Any] = None
        self._current_access_key: Optional[str] = None
        logger.debug(
            "KubitExporter initialised  token_endpoint=%s", token_endpoint,
        )

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        """Export a batch of spans to Kubit."""
        import time as _time
        if not spans:
            return SpanExportResult.SUCCESS

        started = _time.monotonic()
        try:
            logger.debug("export start  spans=%d", len(spans))
            identity = self._cred_manager.identity
            creds = self._cred_manager.credentials

            # Rebuild boto3 client if credentials changed
            if self._current_access_key != creds.access_key_id:
                self._client = boto3.client(
                    "kinesis",
                    region_name=identity.region,
                    aws_access_key_id=creds.access_key_id,
                    aws_secret_access_key=creds.secret_access_key,
                    aws_session_token=creds.session_token,
                )
                self._current_access_key = creds.access_key_id
                logger.debug(
                    "Ingestion client refreshed  region=%s stream=%s",
                    identity.region, identity.stream_name,
                )

            records = transform_spans(spans, identity.wid, identity.wid_claim)
            if not records:
                logger.debug("no records produced from batch  spans=%d", len(spans))
                return SpanExportResult.SUCCESS

            # Serialise and send
            kinesis_records = self._serialise(records, identity.wid)
            batches = self._split_batches(kinesis_records)
            total_bytes = sum(len(e["Data"]) for b in batches for e in b)
            logger.debug(
                "batch split  records=%d batches=%d bytes=%d",
                len(kinesis_records), len(batches), total_bytes,
            )

            total_sent = 0
            for idx, batch in enumerate(batches):
                logger.debug(
                    "sending batch %d/%d  records=%d",
                    idx + 1, len(batches), len(batch),
                )
                sent = self._send_batch_with_retry(batch, identity.stream_name)
                total_sent += sent

            logger.info(
                "export complete  wid=%s spans=%d records=%d sent=%d bytes=%d "
                "batches=%d duration_ms=%.1f",
                identity.wid,
                len(spans),
                len(records),
                total_sent,
                total_bytes,
                len(batches),
                (_time.monotonic() - started) * 1000,
            )

            return SpanExportResult.SUCCESS

        except Exception as exc:
            logger.error("export failed: %s", exc, exc_info=True)
            return SpanExportResult.FAILURE

    def shutdown(self) -> None:
        """Clean up resources."""
        logger.debug("KubitExporter shutdown")
        self._cred_manager.close()
        self._client = None

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        """Nothing to flush — export() is synchronous."""
        logger.debug("force_flush called  timeout_ms=%d", timeout_millis)
        return True

    # ── Serialisation ────────────────────────────────────────────────────────

    @staticmethod
    def _serialise(
        records: list[dict[str, Any]], wid: str
    ) -> list[dict[str, Any]]:
        """Convert records to ingestion entries."""
        entries: list[dict[str, Any]] = []
        for rec in records:
            data = json.dumps(rec, separators=(",", ":"), default=str).encode("utf-8")
            if len(data) > _MAX_RECORD_BYTES:
                logger.warning(
                    "Record %s exceeds 1 MB (%d bytes), skipping",
                    rec.get("id", "?"),
                    len(data),
                )
                continue
            record_id = rec.get("id") or str(uuid.uuid4())
            entries.append({
                "Data": data,
                "PartitionKey": f"{wid}/{record_id}",
            })
        return entries

    @staticmethod
    def _split_batches(
        entries: list[dict[str, Any]],
    ) -> list[list[dict[str, Any]]]:
        """Split entries into batches respecting size limits."""
        batches: list[list[dict[str, Any]]] = []
        current: list[dict[str, Any]] = []
        current_bytes = 0

        for entry in entries:
            entry_size = len(entry["Data"]) + len(entry["PartitionKey"].encode("utf-8"))
            if current and (
                len(current) >= _MAX_RECORDS_PER_CALL
                or current_bytes + entry_size > _MAX_BYTES_PER_CALL
            ):
                batches.append(current)
                current = []
                current_bytes = 0
            current.append(entry)
            current_bytes += entry_size

        if current:
            batches.append(current)

        return batches

    # ── Send with retry ──────────────────────────────────────────────────────

    def _send_batch_with_retry(
        self,
        batch: list[dict[str, Any]],
        stream_name: str,
    ) -> int:
        """Send a batch with partial-failure retry."""
        import time

        pending = batch
        total_sent = 0

        for attempt in range(_MAX_RETRIES + 1):
            if not pending:
                break

            try:
                logger.debug(
                    "put_records  attempt=%d/%d pending=%d stream=%s",
                    attempt + 1, _MAX_RETRIES + 1, len(pending), stream_name,
                )
                result = self._client.put_records(
                    StreamName=stream_name,
                    Records=pending,
                )
            except Exception as exc:
                logger.error(
                    "put_records failed  attempt=%d/%d: %s",
                    attempt + 1, _MAX_RETRIES + 1, exc,
                )
                if attempt < _MAX_RETRIES:
                    delay = 2 ** attempt
                    logger.debug("retry sleep  delay_s=%d", delay)
                    time.sleep(delay)
                    continue
                raise

            failed_count = result.get("FailedRecordCount", 0)
            total_sent += len(pending) - failed_count

            if failed_count == 0:
                break

            # Retry only failed records
            failed_records = [
                pending[i]
                for i, rec in enumerate(result.get("Records", []))
                if rec.get("ErrorCode")
            ]

            logger.warning(
                "put_records partial failure  failed=%d/%d attempt=%d/%d",
                failed_count, len(pending), attempt + 1, _MAX_RETRIES + 1,
            )
            pending = failed_records

            if attempt < _MAX_RETRIES:
                delay = 2 ** attempt
                logger.debug("retry sleep  delay_s=%d", delay)
                time.sleep(delay)

        return total_sent
