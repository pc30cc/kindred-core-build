/**
 * Writes server/services/mobileApp/iosProjectFacts.json from the native iOS
 * project (ios/WebyarNative): what Super Admin's readiness checks and
 * "Deployment status" card know about the app, since the server image does
 * not carry ios/. Re-run after changing the app icon, the privacy manifest,
 * the entitlements or the background modes; CI fails while the file and the
 * project disagree (server/services/mobileApp/project.test.ts).
 *
 *   npm run ios:project-facts
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_PROJECT_SNAPSHOT, readNativeProjectFacts } from '../../server/services/mobileApp/project.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const facts = readNativeProjectFacts(root);
writeFileSync(NATIVE_PROJECT_SNAPSHOT, `${JSON.stringify(facts, null, 2)}\n`);
console.log(`[ios:project-facts] ${NATIVE_PROJECT_SNAPSHOT}`, facts);
