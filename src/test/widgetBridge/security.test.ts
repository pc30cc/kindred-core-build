import { explicitAiResponder } from '../../../worker/widget-bridge/aiReply.js';
import { SessionRelay } from '../../../worker/widget-bridge/sessionRelay.js';
import { isBridgeProviderSite, bridgeProviderDomains } from '../../../shared/widgetBridgeTargets.js';
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { publicDestination } from '../../../worker/widget-bridge/egress.js';
import { bridgeContactSchema, bridgeSettingsSchema } from '../../../server/services/widgetBridge/validation.js';
import { messageKeys } from '../../../worker/widget-bridge/adapters.js';
import { encryptPluginSecret, decryptPluginSecret } from '../../../server/lib/pluginCrypto.js';

describe('widget bridge network and identity boundaries', () => {
  it.each(['http://example.com','https://localhost','https://127.0.0.1','https://169.254.169.254','https://user:pass@example.com'])('rejects unsafe site URL %s', url => {
    expect(bridgeContactSchema.safeParse({ url }).success).toBe(false);
  });
  it('requires the scoped custom selectors rather than guessing site forms', () => {
    expect(bridgeContactSchema.safeParse({ url: 'https://example.com', provider: 'custom', selectors: { composer: 'textarea' } }).success).toBe(false);
    expect(bridgeContactSchema.safeParse({ url: 'https://example.com', provider: 'custom', selectors: { root: '#widget', composer: 'textarea', inbound: '.agent', outbound: '.visitor' } }).success).toBe(true);
  });
  it('rejects executable scripts and extra identity fields', () => {
    expect(bridgeContactSchema.safeParse({ url: 'https://example.com', selectors: { script: 'alert(1)' } }).success).toBe(false);
    expect(bridgeSettingsSchema.safeParse({ enabled: true, identity: { name: 'Name', email: '', phone: '', secret: 'x' } }).success).toBe(false);
  });
  it('pins a validated public address without a second DNS lookup', async () => {
    const dns = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
    expect(await publicDestination('example.com:443', dns as never)).toEqual({ address: '93.184.216.34', family: 4 });
    expect(dns).toHaveBeenCalledTimes(1);
  });
  it.each(['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','::1','fc00::1','fe80::1','::ffff:127.0.0.1'])('blocks private DNS result %s including mixed answers', async address => {
    const dns = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }]);
    await expect(publicDestination('example.com:443', dns as never)).rejects.toThrow('blocked_destination');
  });
  it('rejects non-HTTPS ports and failed DNS resolution', async () => {
    await expect(publicDestination('example.com:5432')).rejects.toThrow('blocked_destination');
    await expect(publicDestination('example.com:443', vi.fn(async () => []) as never)).rejects.toThrow('blocked_destination');
  });
  it('encrypts session cookies and refuses a wrong key or absent encryption', () => {
    const key = 'a'.repeat(64); const envelope = encryptPluginSecret('{"cookie":"visitor-secret"}', key);
    expect(JSON.stringify(envelope)).not.toContain('visitor-secret');
    expect(decryptPluginSecret(envelope, key)).toContain('visitor-secret');
    expect(() => decryptPluginSecret(envelope, 'b'.repeat(64))).toThrow();
    expect(() => encryptPluginSecret('cookie', undefined)).toThrow();
  });
  it('preserves repeated identical replies and deduplicates stable ids', () => {
    const same = messageKeys([{ id: null, body: 'Hi' }, { id: null, body: 'Hi' }]);
    expect(same).toHaveLength(2); expect(same[0].key).not.toBe(same[1].key);
    expect(messageKeys([{ id: 'a', body: 'Hi' }, { id: 'a', body: 'Hi again' }])).toEqual([{ key: 'id:a', body: 'Hi again' }]);
  });
});


describe('provider website destinations', () => {
  it.each(bridgeProviderDomains)('blocks %s and its subdomains with normalized hostnames', domain => {
    for (const url of [`https://${domain}`, `https://www.${domain}/chat`, `https://SUPPORT.${domain.toUpperCase()}./`]) {
      expect(isBridgeProviderSite(url)).toBe(true);
      expect(bridgeContactSchema.safeParse({ url }).success).toBe(false);
    }
  });
  it.each(['https://tayebatstore.ir', 'https://www.tayebatstore.ir', 'https://notgoftino.com', 'https://goftino.com.example.org', 'https://example.com/goftino.com'])('allows customer target %s without substring matches', url => {
    expect(isBridgeProviderSite(url)).toBe(false);
    expect(bridgeContactSchema.safeParse({ url }).success).toBe(true);
  });
});


describe('two-way session relay', () => {
  const identity = {name:'Admin',email:'',phone:''};
  it('prepares once and forwards both directions without rewriting messages', async () => {
    const remote = {prepare:vi.fn(async()=>{}),send:vi.fn(async()=>true),receive:vi.fn(async()=>[{key:'1',body:'Reply'}]),acknowledge:vi.fn()};
    const relay = new SessionRelay(remote,()=>{});
    await relay.prepare(identity); await relay.send('سلام');
    expect(await relay.receive()).toEqual([{key:'1',body:'Reply'}]);
    relay.acknowledge?.(1);
    await relay.prepare(identity); await relay.send('سلام');
    expect(remote.prepare).toHaveBeenCalledTimes(1);
    expect(remote.send.mock.calls).toEqual([['سلام'],['سلام']]);
    expect(remote.acknowledge).toHaveBeenCalledWith(1);
  });
  it('does not add acknowledgement semantics to snapshot adapters', () => {
    const relay = new SessionRelay({prepare:async()=>{},send:async()=>true,receive:async()=>[]},()=>{});
    expect(relay.acknowledge).toBeUndefined();
  });
  it('refuses changed identity and stopped connections before sending', async () => {
    let stopped = false;
    const remote = {prepare:vi.fn(async()=>{}),send:vi.fn(async()=>true),receive:vi.fn(async()=>[])};
    const relay = new SessionRelay(remote,()=>{if(stopped)throw new Error('connection_stopped');});
    await relay.prepare(identity);
    await expect(relay.prepare({...identity,name:'Different'})).rejects.toThrow('connection_stopped');
    stopped=true;
    await expect(relay.send('سلام')).rejects.toThrow('connection_stopped');
    expect(remote.send).not.toHaveBeenCalled();
  });
});


describe('explicit AI responder labels', () => {
  it.each(['هوش مصنوعی ایران سرور','AI assistant','Yapay zekâ destek'])('recognizes explicit label %s', label => {
    expect(explicitAiResponder(label)).toBe(label);
  });
  it.each(['سلام، بفرمایید.','مشاوره خرید','Ali','I am an AI assistant','سوالی درباره هوش مصنوعی دارم'])('does not infer AI from ambiguous label or prose %s', label => {
    expect(explicitAiResponder(label)).toBeUndefined();
  });
});
