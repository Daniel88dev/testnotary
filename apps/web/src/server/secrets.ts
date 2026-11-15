// Secrets reach the service as references, never as values: in a deployment an environment
// variable such as `DATABASE_URL` holds `secretsmanager:<secret id>` (or `…#<json key>` for one
// field of a JSON secret), and the service fetches the value from AWS Secrets Manager when it
// starts. The image and the App Runner service definition therefore hold no secret, and the
// same image runs anywhere the AWS SDK finds credentials (App Runner's instance role, ECS).
//
// Resolution is generic over the environment: it runs before `configFromEnv`, so a setting added
// to `ServiceConfig` later is a secret simply by being given a reference in the deployment.

export const SECRET_REFERENCE_PREFIX = "secretsmanager:";

/** Fetches a secret's current string value by id or ARN. */
export interface SecretStore {
  getSecretString(secretId: string): Promise<string>;
}

interface Reference {
  name: string;
  secretId: string;
  jsonKey: string | undefined;
}

function referencesIn(env: Readonly<Record<string, string | undefined>>): Reference[] {
  const references: Reference[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value?.startsWith(SECRET_REFERENCE_PREFIX)) continue;
    const target = value.slice(SECRET_REFERENCE_PREFIX.length);
    const hash = target.indexOf("#");
    const secretId = hash === -1 ? target : target.slice(0, hash);
    const jsonKey = hash === -1 ? undefined : target.slice(hash + 1);
    if (!secretId || jsonKey === "") throw new Error(`${name} holds a malformed Secrets Manager reference`);
    references.push({ name, secretId, jsonKey });
  }
  return references;
}

export function hasSecretReferences(env: Readonly<Record<string, string | undefined>>): boolean {
  return referencesIn(env).length > 0;
}

/**
 * Returns the variables of `env` that hold references, with their values fetched from `store`.
 * Each secret is fetched once. Errors name the variable and the secret id, never a value.
 */
export async function resolveSecretReferences(
  env: Readonly<Record<string, string | undefined>>,
  store: SecretStore,
): Promise<Record<string, string>> {
  const references = referencesIn(env);
  const fetched = new Map<string, Promise<string>>();
  const resolved: Record<string, string> = {};
  for (const reference of references) {
    let secret = fetched.get(reference.secretId);
    if (!secret) {
      secret = store.getSecretString(reference.secretId);
      fetched.set(reference.secretId, secret);
    }
    let value: string;
    try {
      value = await secret;
    } catch (error) {
      throw new Error(`${reference.name}: cannot read secret ${reference.secretId} from Secrets Manager`, { cause: error });
    }
    resolved[reference.name] = reference.jsonKey === undefined ? value : field(value, reference);
  }
  return resolved;
}

function field(secret: string, reference: Reference): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new Error(`${reference.name}: secret ${reference.secretId} is not a JSON object`);
  }
  const value = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)[reference.jsonKey!] : undefined;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${reference.name}: secret ${reference.secretId} has no field ${reference.jsonKey}`);
  }
  return String(value);
}

/** The production store: AWS Secrets Manager through the AWS SDK's default credential chain. */
export async function secretsManagerStore(): Promise<SecretStore> {
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient({});
  return {
    async getSecretString(secretId) {
      const output = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      if (output.SecretString === undefined) throw new Error(`secret ${secretId} holds no string`);
      return output.SecretString;
    },
  };
}
