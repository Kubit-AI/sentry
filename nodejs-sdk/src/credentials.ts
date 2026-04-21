/**
 * Credential manager — exchanges a Kubit API key for temporary cloud
 * credentials and auto-refreshes them before expiry.
 */

import { logger, redactEndpoint } from "./logger";

const DEFAULT_TOKEN_ENDPOINT = "https://kubit-ingest.kubit.ai/token";

/** Refresh credentials 5 minutes before they expire. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** Timeout for token endpoint requests (10 seconds). */
const FETCH_TIMEOUT_MS = 10_000;

/** Minimum credential lifetime to accept (30 seconds). */
const MIN_CREDENTIAL_LIFETIME_MS = 30_000;

export interface KinesisCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** Absolute time (Date.now()) when these expire. */
  expiry: number;
}

export interface WorkspaceIdentity {
  wid: string;
  org: string;
  env: string;
  streamName: string;
  region: string;
  widClaim: string;
}

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

export class CredentialManager {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private credentials: KinesisCredentials | null = null;
  private _identity: WorkspaceIdentity | null = null;
  private refreshPromise: Promise<void> | null = null;

  constructor(apiKey: string, tokenEndpoint: string = DEFAULT_TOKEN_ENDPOINT) {
    this.apiKey = apiKey;
    this.endpoint = tokenEndpoint;
    logger.debug(
      `CredentialManager initialised  endpoint=${redactEndpoint(tokenEndpoint)}`
    );
  }

  async getIdentity(): Promise<WorkspaceIdentity> {
    await this.ensureValid();
    return this._identity!;
  }

  async getCredentials(): Promise<KinesisCredentials> {
    await this.ensureValid();
    return this.credentials!;
  }

  private async ensureValid(): Promise<void> {
    if (this.credentials) {
      const remainingMs = this.credentials.expiry - Date.now();
      if (remainingMs > REFRESH_BUFFER_MS) {
        logger.debug(
          `credentials valid  remaining_s=${Math.round(remainingMs / 1000)} buffer_s=${Math.round(REFRESH_BUFFER_MS / 1000)}`
        );
        return;
      }
      logger.debug(
        `credentials nearing expiry — refreshing  remaining_s=${Math.round(remainingMs / 1000)}`
      );
    } else {
      logger.debug("no credentials yet — fetching initial token");
    }

    // Deduplicate concurrent refresh calls
    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    await this.refreshPromise;
  }

  private async refresh(): Promise<void> {
    const started = Date.now();
    let resp: Response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      logger.debug(
        `POST token endpoint  endpoint=${redactEndpoint(this.endpoint)}`
      );
      resp = await fetch(this.endpoint, {
        method: "POST",
        headers: { "x-api-key": this.apiKey },
        signal: controller.signal,
      });
    } catch (err) {
      const msg =
        (err as Error).name === "AbortError"
          ? `Token endpoint timed out after ${FETCH_TIMEOUT_MS}ms`
          : `Token endpoint unreachable: ${(err as Error).message}`;
      logger.error(msg);
      throw new CredentialError(msg);
    } finally {
      clearTimeout(timeoutId);
    }

    const durationMs = Date.now() - started;
    logger.debug(
      `token response  status=${resp.status} duration_ms=${durationMs}`
    );

    if (resp.status === 401 || resp.status === 403) {
      logger.error(`token endpoint rejected api key  status=${resp.status}`);
      throw new CredentialError(`Invalid API key (HTTP ${resp.status})`);
    }

    if (resp.status !== 200) {
      const text = await resp.text();
      logger.error(
        `token endpoint returned non-200  status=${resp.status} body_preview=${text.slice(0, 200)}`
      );
      throw new CredentialError(
        `Token endpoint returned ${resp.status}: ${text.slice(0, 200)}`
      );
    }

    const body = (await resp.json()) as Record<string, any>;

    const creds = body.credentials ?? {};
    const accessKeyId: string = creds.AccessKeyId ?? "";
    const secretAccessKey: string = creds.SecretAccessKey ?? "";
    const sessionToken: string = creds.SessionToken ?? "";

    if (!accessKeyId || !secretAccessKey || !sessionToken) {
      throw new CredentialError("Token response missing credentials");
    }

    const metadata = body.metadata ?? {};
    const wid: string = metadata.partition_key ?? "";
    const streamName: string = metadata.stream_name ?? "";

    if (!streamName) {
      throw new CredentialError("Token response missing stream_name");
    }
    const region: string = metadata.region ?? "us-east-1";
    const expiryStr: string | number = metadata.expiry ?? "";
    const widClaim: string = metadata.wid_claim ?? "";

    if (!wid) {
      throw new CredentialError("Token response missing partition_key (wid)");
    }
    if (!widClaim) {
      throw new CredentialError("Token response missing wid_claim");
    }

    // Parse expiry — guard against negative/zero values from clock skew or
    // already-expired tokens; fall back to 1 hour default.
    let msUntilExpiry = 3600_000; // default 1 hour
    try {
      if (expiryStr) {
        if (typeof expiryStr === "number") {
          msUntilExpiry = expiryStr * 1000 - Date.now();
        } else {
          msUntilExpiry = new Date(expiryStr).getTime() - Date.now();
        }
        if (msUntilExpiry < MIN_CREDENTIAL_LIFETIME_MS) {
          msUntilExpiry = 3600_000;
        }
      }
    } catch {
      msUntilExpiry = 3600_000;
    }

    const { org, env } = this.extractOrgEnv();

    this.credentials = {
      accessKeyId,
      secretAccessKey,
      sessionToken,
      expiry: Date.now() + msUntilExpiry,
    };

    this._identity = { wid, org, env, streamName, region, widClaim };

    const expiresInS = Math.round(msUntilExpiry / 1000);
    logger.info(
      `credentials refreshed  wid=${wid} org=${org} env=${env} stream=${streamName} region=${region} expires_in=${expiresInS}s`
    );
    if (msUntilExpiry < REFRESH_BUFFER_MS * 2) {
      logger.warn(
        `credentials short-lived  expires_in=${expiresInS}s buffer_s=${Math.round(REFRESH_BUFFER_MS / 1000)}`
      );
    }
  }

  private extractOrgEnv(): { org: string; env: string } {
    const parts = this.apiKey.split(".");
    if (parts.length !== 4) return { org: "unknown", env: "unknown" };

    try {
      const payload = JSON.parse(
        Buffer.from(parts[2], "base64url").toString("utf-8")
      );
      return {
        org: String(payload.org ?? "unknown"),
        env: String(payload.env ?? "unknown"),
      };
    } catch {
      return { org: "unknown", env: "unknown" };
    }
  }
}

export { DEFAULT_TOKEN_ENDPOINT };
