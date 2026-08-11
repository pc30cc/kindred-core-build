/**
 * Follow-up 9G.1 — Message Trigger capability truthfulness (backend).
 *
 * classifyMessageTriggerRuntimeCapability() is the pure classification
 * function server/routes/ai-agent/automation.ts's `/message-triggers/:id/
 * test` route now calls (previously that route hard-coded
 * runtimeExecutionEnabled:false and a false "next automation runtime pass"
 * claim for every trigger, live or not). These tests pin the classifier's
 * capability booleans and note text for every event/action combination —
 * they are a unit-level proof of classifier behavior, not of the HTTP
 * route's wiring or of end-to-end side-effect absence. The route currently
 * calls this classifier and does nothing else (a single Supabase `select`,
 * then this pure function, then `res.json`); that the route itself never
 * invokes an executor is verified by reading its source, not by this test
 * file — there is no HTTP/Supabase test harness for this router yet, and
 * this file does not attempt to substitute for one.
 */
import { describe, it, expect } from 'vitest';
import { classifyMessageTriggerRuntimeCapability } from '../../../server/routes/ai-agent/automation.js';

describe('9G.1 — classifyMessageTriggerRuntimeCapability()', () => {
  it('API-TRUTH1 — visitor_first_message + send_message: fully live, dry-run note', () => {
    const r = classifyMessageTriggerRuntimeCapability('visitor_first_message', 'send_message');
    expect(r.eventRuntimeEnabled).toBe(true);
    expect(r.actionRuntimeEnabled).toBe(true);
    expect(r.runtimeExecutionEnabled).toBe(true);
    expect(r.note).toMatch(/live in runtime/i);
    expect(r.note).toMatch(/does not execute side effects/i);
  });

  it('API-TRUTH2 — ai_no_answer + handoff: fully live, still dry-run only', () => {
    const r = classifyMessageTriggerRuntimeCapability('ai_no_answer', 'handoff');
    expect(r.eventRuntimeEnabled).toBe(true);
    expect(r.actionRuntimeEnabled).toBe(true);
    expect(r.runtimeExecutionEnabled).toBe(true);
    expect(r.note).toMatch(/does not execute side effects/i);
  });

  it('API-TRUTH3 — after_prechat + send_message: event not live, action live, overall not runtime-enabled', () => {
    const r = classifyMessageTriggerRuntimeCapability('after_prechat', 'send_message');
    expect(r.eventRuntimeEnabled).toBe(false);
    expect(r.actionRuntimeEnabled).toBe(true);
    expect(r.runtimeExecutionEnabled).toBe(false);
    expect(r.note).toMatch(/after_prechat/);
    expect(r.note).toMatch(/not currently emitted/i);
  });

  it('API-TRUTH4 — conversation_started + send_message: not runtime-enabled (event never reaches the runtime evaluator)', () => {
    const r = classifyMessageTriggerRuntimeCapability('conversation_started', 'send_message');
    expect(r.eventRuntimeEnabled).toBe(false);
    expect(r.runtimeExecutionEnabled).toBe(false);
  });

  it('API-TRUTH5 — visitor_first_message + start_workflow: event live, action planned-only, overall not runtime-enabled', () => {
    const r = classifyMessageTriggerRuntimeCapability('visitor_first_message', 'start_workflow');
    expect(r.eventRuntimeEnabled).toBe(true);
    expect(r.actionRuntimeEnabled).toBe(false);
    expect(r.runtimeExecutionEnabled).toBe(false);
    expect(r.note).toMatch(/start_workflow/);
    expect(r.note).toMatch(/not currently executed/i);
  });

  it.each(['tag', 'internal_note', 'assign'])('API-TRUTH6 — a live event + planned action "%s": actionRuntimeEnabled=false', (action) => {
    const r = classifyMessageTriggerRuntimeCapability('human_requested', action);
    expect(r.eventRuntimeEnabled).toBe(true);
    expect(r.actionRuntimeEnabled).toBe(false);
    expect(r.runtimeExecutionEnabled).toBe(false);
  });

  it('API-TRUTH7 — no response text anywhere claims "enabled in the next automation runtime pass"', () => {
    const combos: Array<[string, string]> = [
      ['visitor_first_message', 'send_message'],
      ['ai_no_answer', 'handoff'],
      ['after_prechat', 'send_message'],
      ['conversation_started', 'send_message'],
      ['visitor_first_message', 'start_workflow'],
      ['human_requested', 'tag'],
      ['no_operator_online', 'assign'],
      ['business_hours_closed', 'internal_note'],
    ];
    for (const [event, action] of combos) {
      const r = classifyMessageTriggerRuntimeCapability(event, action);
      expect(r.note.toLowerCase()).not.toContain('next automation runtime pass');
      expect(r.note.toLowerCase()).not.toContain('will be enabled');
    }
  });

  it('API-TRUTH8 — the classifier is a pure function: identical input always yields identical, deterministic output with no observable side effects', () => {
    const a = classifyMessageTriggerRuntimeCapability('visitor_first_message', 'send_message');
    const b = classifyMessageTriggerRuntimeCapability('visitor_first_message', 'send_message');
    expect(a).toEqual(b);
    // Neither event nor action combination can ever produce a truthy
    // runtimeExecutionEnabled by accident for a non-live pair — dry-run
    // truthfulness holds across the whole matrix, not just the tested cases.
    const allEvents = ['visitor_first_message', 'topic_detected', 'human_requested', 'ai_no_answer', 'after_prechat', 'no_operator_online', 'business_hours_closed', 'conversation_started'];
    const allActions = ['send_message', 'handoff', 'start_workflow', 'assign', 'tag', 'internal_note'];
    const liveEvents = new Set(['visitor_first_message', 'topic_detected', 'human_requested', 'ai_no_answer']);
    const liveActions = new Set(['send_message', 'handoff']);
    for (const e of allEvents) {
      for (const act of allActions) {
        const r = classifyMessageTriggerRuntimeCapability(e, act);
        expect(r.runtimeExecutionEnabled).toBe(liveEvents.has(e) && liveActions.has(act));
      }
    }
  });

  it('both live events (topic_detected, human_requested) also classify correctly', () => {
    expect(classifyMessageTriggerRuntimeCapability('topic_detected', 'send_message').runtimeExecutionEnabled).toBe(true);
    expect(classifyMessageTriggerRuntimeCapability('human_requested', 'handoff').runtimeExecutionEnabled).toBe(true);
  });

  it('both event and action not-live: note mentions both, runtimeExecutionEnabled=false', () => {
    const r = classifyMessageTriggerRuntimeCapability('no_operator_online', 'assign');
    expect(r.eventRuntimeEnabled).toBe(false);
    expect(r.actionRuntimeEnabled).toBe(false);
    expect(r.runtimeExecutionEnabled).toBe(false);
    expect(r.note).toMatch(/no_operator_online/);
    expect(r.note).toMatch(/assign/);
  });
});
