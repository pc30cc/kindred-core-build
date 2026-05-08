/**
 * E10.1 — Regression runner integration smoke test.
 *
 * Runs end-to-end against a real Supabase project using the service role key.
 * Does NOT touch calls/LiveKit/widget-call. Does NOT write conversation_messages,
 * handoffs, workflows, or learning candidates (asserts these counts are unchanged).
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   SMOKE_WORKSPACE_ID=<uuid> bun run server/scripts/regressionRunnerSmoke.ts
 */
import { loadConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  getOrCreateDefaultRegressionSchedule,
  enqueueRegressionBatch,
  claimQueuedBatch,
  runRegressionBatch,
} from '../services/ai-agent/regressionRunner.js';

function assert(cond: any, msg: string) {
  if (!cond) { console.error('ASSERT FAILED:', msg); process.exit(1); }
}

async function main() {
  const wsId = process.env.SMOKE_WORKSPACE_ID;
  if (!wsId) { console.error('SMOKE_WORKSPACE_ID required'); process.exit(2); }
  const config = loadConfig();
  const sb = getServiceClient(config);

  console.log('— ensure schedule —');
  const sch = await getOrCreateDefaultRegressionSchedule(config, wsId);
  console.log('schedule', sch.id);

  console.log('— ensure ≥1 enabled test case —');
  const { data: existingCases } = await sb.from('ai_agent_test_cases')
    .select('id').eq('workspace_id', wsId).eq('enabled', true).limit(1);
  if (!existingCases?.length) {
    const { error } = await sb.from('ai_agent_test_cases').insert({
      workspace_id: wsId,
      name: 'smoke seed case',
      input_message: 'hello, what do you offer?',
      expected_behavior: 'answer_with_kb',
      enabled: true,
    });
    assert(!error, `seed insert: ${error?.message}`);
  }

  console.log('— baseline counts —');
  const cm = await sb.from('conversation_messages').select('id', { count: 'exact', head: true });
  const baselineMessages = cm.count || 0;

  console.log('— enqueue manual batch —');
  const batch = await enqueueRegressionBatch(config, {
    workspaceId: wsId, scheduleId: sch.id, triggerType: 'manual',
  });
  console.log('batch', batch.id);
  const claimed = await claimQueuedBatch(sb, batch.id);
  assert(claimed, 'claim batch');

  console.log('— run batch —');
  const r = await runRegressionBatch(config, batch.id);
  console.log('result', r);
  assert(r.ok, `runRegressionBatch: ${r.error}`);

  const { data: finalBatch } = await sb.from('ai_agent_regression_batches')
    .select('*').eq('id', batch.id).single();
  assert(finalBatch?.status === 'completed', `expected completed, got ${finalBatch?.status}`);

  const { data: runs } = await sb.from('ai_agent_test_runs')
    .select('*').eq('regression_batch_id', batch.id);
  assert((runs?.length || 0) > 0, 'no test_runs created');
  const passed = runs!.filter((x) => x.status === 'passed').length;
  const failed = runs!.filter((x) => x.status === 'failed').length;
  const errored = runs!.filter((x) => x.status === 'errored').length;
  assert(passed === finalBatch.passed, `passed mismatch ${passed} vs ${finalBatch.passed}`);
  assert(failed === finalBatch.failed, `failed mismatch ${failed} vs ${finalBatch.failed}`);
  assert(errored === finalBatch.errored, `errored mismatch ${errored} vs ${finalBatch.errored}`);

  // Leak proof.
  for (const run of runs!) {
    const sources = (run.selected_sources || []) as any[];
    for (const s of sources) {
      if (s.source_type === 'file') assert(s.source_url == null, 'file source_url must be null');
    }
    const dbg = run.retrieval_debug as any;
    if (dbg && Array.isArray(dbg.candidates)) {
      for (const c of dbg.candidates) {
        if (c?.source_type === 'file') assert(c.source_url == null, 'debug file source_url must be null');
      }
    }
  }

  const cm2 = await sb.from('conversation_messages').select('id', { count: 'exact', head: true });
  assert((cm2.count || 0) === baselineMessages, 'conversation_messages must not grow');

  console.log('OK — all assertions passed');
}

main().catch((e) => { console.error(e); process.exit(1); });