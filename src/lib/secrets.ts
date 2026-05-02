import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

let client: SecretManagerServiceClient | null = null;
const cache = new Map<string, string>();

function getClient(): SecretManagerServiceClient {
  if (!client) client = new SecretManagerServiceClient();
  return client;
}

export async function getSecret(secretName: string): Promise<string> {
  if (process.env.NODE_ENV !== 'production') {
    // Read from env var if present (e.g. HUBSPOT_API_KEY in .env), otherwise treat
    // secretName as the literal token value (set by the UI connect flow in dev).
    return process.env[secretName] ?? secretName;
  }

  const cached = cache.get(secretName);
  if (cached) return cached;

  const [version] = await getClient().accessSecretVersion({ name: secretName });
  const value = version.payload!.data!.toString();
  cache.set(secretName, value);
  return value;
}
