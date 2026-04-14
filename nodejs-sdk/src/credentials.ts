/**
 * Credential manager — exchanges a Kubit API key for temporary cloud
 * credentials and auto-refreshes them before expiry.
 */

const DEFAULT_TOKEN_ENDPOINT = "https://langfuse-ingest.kubit.ai/token";

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
    if (
      this.credentials &&
      this.credentials.expiry - Date.now() > REFRESH_BUFFER_MS
    ) {
      return;
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
    let resp: Response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
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
      throw new CredentialError(msg);
    } finally {
      clearTimeout(timeoutId);
    }

    if (resp.status === 401 || resp.status === 403) {
      throw new CredentialError(`Invalid API key (HTTP ${resp.status})`);
    }

    if (resp.status !== 200) {
      const text = await resp.text();
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

    if (!wid) {
      throw new CredentialError("Token response missing partition_key (wid)");
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

    this._identity = { wid, org, env, streamName, region };
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
