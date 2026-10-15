import { z } from 'zod';
import { isBridgeProviderSite } from '../../../shared/widgetBridgeTargets.js';
import { normalizeBridgeUrls } from '../../../shared/widgetBridge.js';
import { acceptedBridgeProviders, storedBridgeProviders, toStoredProvider, toStoredProviderList } from './providerIds.js';

// Provider ids are accepted as the API's (`platform`) or the stored legacy id,
// and parse to the stored id (providerIds.ts).
const allowedProvider = z.enum(acceptedBridgeProviders).transform(id => toStoredProvider(id));
import { isSafeOutboundUrl } from '../../../shared/net/hostGuard.js';

const selector = z.string().trim().max(300).optional();
export const bridgeSelectorsSchema = z.object({
  frame: selector, root: selector, launcher: selector, start: selector,
  name: selector, email: selector, phone: selector, formSubmit: selector,
  composer: selector, send: selector, inbound: selector, outbound: selector,
  messageIdAttribute: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/).optional(),
}).strict();
export const bridgeSettingsSchema = z.object({
  enabled: z.boolean(),
  roundSize: z.number().int().min(1).max(50).default(1),
  intervalSeconds: z.number().int().min(5).max(3600).default(30),
  allowedProviders: z.array(z.enum(acceptedBridgeProviders)).max(acceptedBridgeProviders.length)
    .transform(ids => toStoredProviderList(ids)).default([...storedBridgeProviders]),
  identity: z.object({
    name: z.string().trim().min(1).max(200),
    email: z.union([z.string().email().max(254), z.literal('')]),
    phone: z.string().trim().max(40),
  }).strict(),
}).strict();
export const bridgeContactSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  url: z.string().trim().max(2048).refine(value => {
    if (!isSafeOutboundUrl(value)) return false;
    return !new URL(value).port || new URL(value).port === '443';
  }, 'public_https_required').refine(value => !isBridgeProviderSite(value), 'provider_site_blocked'),
  provider: z.enum(['auto', ...acceptedBridgeProviders] as const).transform(id => toStoredProvider(id)).default('auto'),
  selectors: bridgeSelectorsSchema.default({}),
  enabled: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  if (value.provider === 'custom' && (!value.selectors.root || !value.selectors.composer || !value.selectors.inbound || !value.selectors.outbound)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'custom_selectors_required', path: ['selectors'] });
  }
});
export const bridgeMessageSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  clientMessageId: z.string().uuid(),
}).strict();

export const bridgeBatchSchema = z.object({
  clientBatchId: z.string().uuid(),
  provider: allowedProvider.optional(),
  body: z.string().trim().min(1).max(2000),
  urls: z.array(z.string().trim().max(2048).refine(value => {
    if (!isSafeOutboundUrl(value)) return false;
    return !new URL(value).port || new URL(value).port === '443';
  })).min(1).max(500),
}).strict();

export const bridgeSiteListSchema = z.object({
  urls: z.array(z.string().trim().min(1).max(2048)).max(500),
  includeShared: z.boolean().default(false),
}).strict().transform((value, ctx) => {
  try {
    const urls = normalizeBridgeUrls(value.urls);
    if (urls.some(url => url.length > 2048 || !isSafeOutboundUrl(url) || (new URL(url).port && new URL(url).port !== '443'))) throw new Error('invalid_url');
    return { ...value, urls };
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'public_https_required' });
    return z.NEVER;
  }
});
