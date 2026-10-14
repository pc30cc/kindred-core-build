import { z } from 'zod';
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
  }, 'public_https_required'),
  provider: z.enum(['auto', 'webyar', 'crisp', 'raychat', 'goftino', 'custom']).default('auto'),
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
