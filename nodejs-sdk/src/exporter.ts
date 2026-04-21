/**
 * KubitExporter — OpenTelemetry SpanExporter for Kubit analytics.
 *
 * Transforms OTel spans into Kubit records and sends them to the ingestion
 * backend. Credentials are auto-refreshed before expiry.
 */

import {
  KinesisClient,
  PutRecordsCommand,
  type PutRecordsRequestEntry,
} from "@aws-sdk/client-kinesis";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  CredentialManager,
  DEFAULT_TOKEN_ENDPOINT,
} from "./credentials";
import { logger } from "./logger";
import { transformSpans, type KubitRecord } from "./transformer";

/** Max records per PutRecords call. */
const MAX_RECORDS_PER_CALL = 250;
/** Max bytes per PutRecords call (5 MB). */
const MAX_BYTES_PER_CALL = 5 * 1024 * 1024;
/** Max bytes per individual record (1 MB). */
const MAX_RECORD_BYTES = 1_048_576;
/** Max retry attempts for partial failures. */
const MAX_RETRIES = 5;

export interface KubitExporterConfig {
  apiKey: string;
  tokenEndpoint?: string;
}

export class KubitExporter {
  private readonly credManager: CredentialManager;
  private client: KinesisClient | null = null;
  private currentAccessKey: string | null = null;

  constructor(config: KubitExporterConfig) {
    const endpoint = config.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;
    this.credManager = new CredentialManager(config.apiKey, endpoint);
    logger.debug(`KubitExporter initialised  token_endpoint=${endpoint}`);
  }

  /**
   * Export a batch of spans to Kubit.
   *
   * Compatible with both OTel v1 (callback) and v2 (promise) SpanExporter
   * interfaces. The runtime behaviour is identical — only the TypeScript
   * structural types diverge between versions.
   */
  async export(
    spans: ReadableSpan[],
    resultCallback?: (result: { code: number }) => void
  ): Promise<{ code: number }> {
    const SUCCESS = { code: 0 }; // ExportResultCode.SUCCESS
    const FAILED = { code: 1 };  // ExportResultCode.FAILED

    if (spans.length === 0) {
      resultCallback?.(SUCCESS);
      return SUCCESS;
    }

    const started = Date.now();
    try {
      logger.debug(`export start  spans=${spans.length}`);
      const identity = await this.credManager.getIdentity();
      const creds = await this.credManager.getCredentials();

      // Rebuild client if credentials changed
      if (this.currentAccessKey !== creds.accessKeyId) {
        this.client = new KinesisClient({
          region: identity.region,
          credentials: {
            accessKeyId: creds.accessKeyId,
            secretAccessKey: creds.secretAccessKey,
            sessionToken: creds.sessionToken,
          },
        });
        this.currentAccessKey = creds.accessKeyId;
        logger.debug(
          `Ingestion client refreshed  region=${identity.region} stream=${identity.streamName}`
        );
      }

      const records = transformSpans(spans, identity.wid, identity.widClaim);
      if (records.length === 0) {
        logger.debug(`no records produced from batch  spans=${spans.length}`);
        resultCallback?.(SUCCESS);
        return SUCCESS;
      }

      // Serialise and send
      const entries = this.serialise(records, identity.wid);
      const batches = this.splitBatches(entries);
      const totalBytes = batches.reduce(
        (sum, b) => sum + b.reduce((s, e) => s + (e.Data as Buffer).length, 0),
        0
      );
      logger.debug(
        `batch split  records=${entries.length} batches=${batches.length} bytes=${totalBytes}`
      );

      let totalSent = 0;
      for (let idx = 0; idx < batches.length; idx++) {
        const batch = batches[idx];
        logger.debug(
          `sending batch ${idx + 1}/${batches.length}  records=${batch.length}`
        );
        totalSent += await this.sendBatchWithRetry(batch, identity.streamName);
      }

      const durationMs = Date.now() - started;
      logger.info(
        `export complete  wid=${identity.wid} spans=${spans.length} ` +
          `records=${records.length} sent=${totalSent} bytes=${totalBytes} ` +
          `batches=${batches.length} duration_ms=${durationMs}`
      );

      resultCallback?.(SUCCESS);
      return SUCCESS;
    } catch (err) {
      logger.error(`export failed: ${(err as Error).message}`);
      resultCallback?.(FAILED);
      return FAILED;
    }
  }

  async shutdown(): Promise<void> {
    logger.debug("KubitExporter shutdown");
    this.client?.destroy();
    this.client = null;
  }

  async forceFlush(): Promise<void> {
    logger.debug("forceFlush called");
    // Nothing to flush — export() is async but self-contained.
  }

  // ── Serialisation ─────────────────────────────────────────────────────────

  private serialise(
    records: KubitRecord[],
    wid: string
  ): PutRecordsRequestEntry[] {
    const entries: PutRecordsRequestEntry[] = [];

    for (const rec of records) {
      const data = Buffer.from(JSON.stringify(rec), "utf-8");
      if (data.length > MAX_RECORD_BYTES) {
        logger.warn(
          `record ${rec.id} exceeds 1 MB (${data.length} bytes), skipping`
        );
        continue;
      }
      const recordId = rec.id || crypto.randomUUID();
      entries.push({
        Data: data,
        PartitionKey: `${wid}/${recordId}`,
      });
    }

    return entries;
  }

  private splitBatches(
    entries: PutRecordsRequestEntry[]
  ): PutRecordsRequestEntry[][] {
    const batches: PutRecordsRequestEntry[][] = [];
    let current: PutRecordsRequestEntry[] = [];
    let currentBytes = 0;

    for (const entry of entries) {
      const entrySize =
        (entry.Data as Buffer).length +
        Buffer.byteLength(entry.PartitionKey!, "utf-8");

      if (
        current.length > 0 &&
        (current.length >= MAX_RECORDS_PER_CALL ||
          currentBytes + entrySize > MAX_BYTES_PER_CALL)
      ) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }

      current.push(entry);
      currentBytes += entrySize;
    }

    if (current.length > 0) batches.push(current);
    return batches;
  }

  // ── Send with retry ───────────────────────────────────────────────────────

  private async sendBatchWithRetry(
    batch: PutRecordsRequestEntry[],
    streamName: string
  ): Promise<number> {
    let pending = batch;
    let totalSent = 0;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (pending.length === 0) break;

      try {
        logger.debug(
          `put_records  attempt=${attempt + 1}/${MAX_RETRIES + 1} pending=${pending.length} stream=${streamName}`
        );
        const result = await this.client!.send(
          new PutRecordsCommand({
            StreamName: streamName,
            Records: pending,
          })
        );

        const failedCount = result.FailedRecordCount ?? 0;
        totalSent += pending.length - failedCount;

        if (failedCount === 0) break;

        // Retry only failed records
        const failedRecords = (result.Records ?? [])
          .map((rec, i) => (rec.ErrorCode ? pending[i] : null))
          .filter((r): r is PutRecordsRequestEntry => r !== null);

        logger.warn(
          `put_records partial failure  failed=${failedCount}/${pending.length} attempt=${attempt + 1}/${MAX_RETRIES + 1}`
        );
        pending = failedRecords;

        if (attempt < MAX_RETRIES) {
          const delayMs = 2 ** attempt * 1000;
          logger.debug(`retry sleep  delay_ms=${delayMs}`);
          await sleep(delayMs);
        }
      } catch (err) {
        logger.error(
          `put_records failed  attempt=${attempt + 1}/${MAX_RETRIES + 1}: ${(err as Error).message}`
        );
        if (attempt < MAX_RETRIES) {
          const delayMs = 2 ** attempt * 1000;
          logger.debug(`retry sleep  delay_ms=${delayMs}`);
          await sleep(delayMs);
          continue;
        }
        throw err;
      }
    }

    return totalSent;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
