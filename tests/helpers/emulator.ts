import { initializeApp, getApps, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

let testApp: App | null = null;

export function initTestApp(): App {
  if (testApp) return testApp;
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('FIRESTORE_EMULATOR_HOST must be set to run Firestore tests');
  }
  testApp = initializeApp(
    { projectId: process.env.FIRESTORE_PROJECT_ID ?? 'demo-local' },
    `test-app-${Date.now()}`
  );
  return testApp;
}

export async function clearEmulatorCollections(collections: string[]): Promise<void> {
  const app = getApps().find(a => a.name !== '[DEFAULT]') ?? initTestApp();
  const db = getFirestore(app);
  for (const col of collections) {
    const snapshot = await db.collection(col).get();
    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    if (snapshot.docs.length > 0) await batch.commit();
  }
}

export async function teardownTestApp(): Promise<void> {
  if (testApp) {
    await deleteApp(testApp);
    testApp = null;
  }
}
