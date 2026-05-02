import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

let client: SecretManagerServiceClient | null = null;
const cache = new Map<string, string>();

function getClient(): SecretManagerServiceClient {
  if (!client) client = new SecretManagerServiceClient();
  return client;
}

let cachedProjectId: string | null = null;
async function getProjectId(): Promise<string> {
  if (cachedProjectId) return cachedProjectId;
  const explicit = process.env.GCP_PROJECT_ID || process.env.FIRESTORE_PROJECT_ID;
  if (explicit && explicit !== 'demo-local') {
    cachedProjectId = explicit;
    return explicit;
  }
  cachedProjectId = await getClient().getProjectId();
  return cachedProjectId;
}

export async function getSecret(secretName: string): Promise<string> {
  // 1. Env var with this name wins in any environment (lets ops override via Cloud Run vars).
  if (process.env[secretName]) return process.env[secretName]!;

  // 2. Only fetch from Secret Manager when the value actually looks like a resource name.
  //    The Connect-tab UI stores literal tokens under tokenSecretName; those are not resource
  //    names and would trigger PERMISSION_DENIED if passed to accessSecretVersion.
  const looksLikeResourceName = secretName.startsWith('projects/');
  if (!looksLikeResourceName) return secretName;

  const cached = cache.get(secretName);
  if (cached) return cached;

  const [version] = await getClient().accessSecretVersion({ name: secretName });
  const value = version.payload!.data!.toString();
  cache.set(secretName, value);
  return value;
}

// Writes a token into Secret Manager and returns the full version resource name.
// In dev (NODE_ENV !== 'production') the value is returned as-is so getSecret's
// literal-token short-circuit keeps working without GCP credentials.
//
// On first use for a given secretId the secret resource is created with automatic
// replication. On subsequent calls a new version is added and its resource name
// is returned — the previous version stays in place (cheap audit trail; admin
// can disable / destroy old versions in the GCP console if a token leaks).
export async function writeSecret(secretId: string, value: string): Promise<string> {
  if (process.env.NODE_ENV !== 'production') return value;

  const c = getClient();
  const projectId = await getProjectId();
  const parent = `projects/${projectId}`;
  const secretFullName = `${parent}/secrets/${secretId}`;

  // Ensure the secret exists. NOT_FOUND (gRPC code 5) → create it.
  try {
    await c.getSecret({ name: secretFullName });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 5) throw err;
    await c.createSecret({
      parent,
      secretId,
      secret: { replication: { automatic: {} } },
    });
  }

  const [version] = await c.addSecretVersion({
    parent: secretFullName,
    payload: { data: Buffer.from(value, 'utf8') },
  });

  if (!version.name) {
    throw new Error(`Secret Manager did not return a version name for ${secretId}`);
  }
  return version.name;
}
