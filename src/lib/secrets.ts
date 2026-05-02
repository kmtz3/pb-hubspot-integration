import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

let client: SecretManagerServiceClient | null = null;
const cache = new Map<string, string>();

function getClient(): SecretManagerServiceClient {
  if (!client) client = new SecretManagerServiceClient();
  return client;
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
