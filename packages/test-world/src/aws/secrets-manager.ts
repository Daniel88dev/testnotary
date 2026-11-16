import { randomUUID } from "node:crypto";
import { serve, type HttpServer } from "../http.ts";

export interface SecretsManagerRequest {
  /** The operation from `X-Amz-Target`, e.g. `GetSecretValue`. */
  action: string;
  secretId: string | undefined;
  /** Whether the call carried an AWS Signature Version 4 `Authorization` header, as the SDK sends. */
  signed: boolean;
}

/**
 * A local AWS Secrets Manager endpoint speaking the service's JSON 1.1 protocol, for the AWS SDK
 * pointed here through `AWS_ENDPOINT_URL_SECRETS_MANAGER`. It serves `GetSecretValue` from the
 * secrets put into it and answers `ResourceNotFoundException` for any other id, as AWS does.
 */
export class FakeSecretsManager {
  readonly requests: SecretsManagerRequest[] = [];
  readonly #secrets = new Map<string, { value: string; versionId: string; created: number }>();
  #server: HttpServer | undefined;

  static async start(): Promise<FakeSecretsManager> {
    const fake = new FakeSecretsManager();
    fake.#server = await serve((request) => fake.#handle(request));
    return fake;
  }

  get url(): string {
    return this.#server!.url;
  }

  /** Stores (or replaces) a secret string under a name, like `put-secret-value`. */
  put(name: string, value: string): void {
    this.#secrets.set(name, { value, versionId: randomUUID(), created: Date.now() / 1000 });
  }

  close(): Promise<void> {
    return this.#server?.close() ?? Promise.resolve();
  }

  async #handle(request: Request): Promise<Response> {
    const target = request.headers.get("x-amz-target") ?? "";
    const action = target.replace(/^secretsmanager\./, "");
    const body = (await request.json().catch(() => ({}))) as { SecretId?: unknown };
    const secretId = typeof body.SecretId === "string" ? body.SecretId : undefined;
    const signed = /^AWS4-HMAC-SHA256 Credential=/.test(request.headers.get("authorization") ?? "");
    this.requests.push({ action, secretId, signed });

    if (action !== "GetSecretValue") return awsError(400, "InvalidRequestException", `Unsupported operation ${target}`);
    const secret = secretId === undefined ? undefined : this.#secrets.get(secretId);
    if (!secretId || !secret) {
      return awsError(400, "ResourceNotFoundException", "Secrets Manager can't find the specified secret.");
    }
    return Response.json(
      {
        ARN: `arn:aws:secretsmanager:eu-central-1:000000000000:secret:${secretId}-AbCdEf`,
        Name: secretId,
        VersionId: secret.versionId,
        SecretString: secret.value,
        VersionStages: ["AWSCURRENT"],
        CreatedDate: secret.created,
      },
      { headers: { "content-type": "application/x-amz-json-1.1" } },
    );
  }
}

function awsError(status: number, type: string, message: string): Response {
  return Response.json(
    { __type: type, message },
    { status, headers: { "content-type": "application/x-amz-json-1.1", "x-amzn-errortype": type } },
  );
}
