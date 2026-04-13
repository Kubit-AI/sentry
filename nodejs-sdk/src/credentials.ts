/**
 * Credential manager — exchanges a Kubit API key for temporary cloud
 * credentials and auto-refreshes them before expiry.
 */

const DEFAULT_TOKEN_ENDPOINT = "https://langfuse-ingest.kubit.ai/token";

/** Refresh credentials 5 minutes before they expire. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

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
    try {
      resp = await fetch(this.endpoint, {
        method: "POST",
        headers: { "x-api-key": this.apiKey },
      });
    } catch (err) {
      throw new CredentialError(
        `Token endpoint unreachable: ${(err as Error).message}`
      );
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
    const streamName: string = metadata.stream_name ?? "langfuse-kubit-events";
    const region: string = metadata.region ?? "us-east-1";
    const expiryStr: string | number = metadata.expiry ?? "";

    if (!wid) {
      throw new CredentialError("Token response missing partition_key (wid)");
    }

    // Parse expiry
    let msUntilExpiry = 3600_000; // default 1 hour
    try {
      if (expiryStr) {
        if (typeof expiryStr === "number") {
          msUntilExpiry = expiryStr * 1000 - Date.now();
        } else {
          msUntilExpiry = new Date(expiryStr).getTime() - Date.now();
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
