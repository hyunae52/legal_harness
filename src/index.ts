import dotenv from 'dotenv';
import { createApp } from './app.js';
import { createKoreanLawClient } from './koreanLawClient.js';
import { configuredFailureService } from './failures.js';
import { SourceVerifier } from './sourceVerifier.js';
import { configuredCorrectionService } from './correctionGitHub.js';
import { createLegalRetrievalClient } from './taxLawClient.js';
dotenv.config();
const corrections = configuredCorrectionService(process.env);
const runtime = createApp({ law: createLegalRetrievalClient(createKoreanLawClient()), failures: configuredFailureService(process.env), sources:new SourceVerifier(()=>createKoreanLawClient()), corrections });
const host = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1', '::1'].includes(host)) throw new Error('Use a local HTTPS tunnel; HOST must be loopback.');
const server = runtime.app.listen(Number(process.env.PORT || 3000), host, () => console.error('Legal Harness listening on loopback.'));
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
corrections?.start();
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await runtime.drain();
    await corrections?.close();
    await runtime.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } catch {
    // Keep ingress closed; do not interrupt an in-flight public PR publication.
    // The operator must investigate a drain timeout instead of declaring readiness.
    console.error('Legal Harness drain did not complete; ingress remains closed.');
    closing = false;
  }
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
