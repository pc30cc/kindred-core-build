/**
 * The AI KB builder worker charges a draft once: the AI wallet, when the
 * draft is generated (executeAICompletion's billing boundary). It must not
 * also call the legacy deduct_ai_credits counter, whose entitlement key
 * ('ai_credits') no plan has: that refused every draft after the wallet had
 * paid for it. An exhausted wallet stops the job instead.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('worker/intelligence/processor.ts', 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');

describe('AI KB builder worker: the AI wallet is the only charge', () => {
  it('never calls the legacy credit counter', () => {
    expect(src).not.toMatch(/consumeAiCredits|deductAICredits|deduct_ai_credits/);
  });

  it('stops the job when the wallet is exhausted', () => {
    expect(src).toMatch(/allowanceExhausted:\s*isAllowanceExhausted\(caught\)/);
    expect(src).toMatch(/if \(result\.allowanceExhausted\) \{[\s\S]*?creditExhausted = true;[\s\S]*?break;/);
  });
});
