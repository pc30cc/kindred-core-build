/**
 * Commerce event ingestion — idempotent (same event_id twice is harmless)
 * and version-aware (out-of-order delivery cannot regress state). See
 * docs/commerce/CONNECTOR_PROTOCOL.md §Events.
 */
import { getServiceClient } from '../../supabase.js';
import type { ServerConfig } from '../../config.js';
import type { CommerceEvent } from '../../../shared/commerce/types.js';
import { normalizeWooCommerceProduct } from './connectors/woocommerce.js';
import { upsertProductInIndex, upsertVariantInIndex, tombstoneProductInIndex, tombstoneVariantInIndex, getIndexedProductsByIds } from './productIndex.js';

export type EventIngestOutcome = { status: 'processed' | 'duplicate' | 'ignored'; reason?: string };

export async function ingestCommerceEvent(
  config: ServerConfig,
  workspaceId: string,
  connectionId: string,
  event: CommerceEvent,
): Promise<EventIngestOutcome> {
  const sb = getServiceClient(config);

  // Idempotency reservation: only the FIRST delivery of an event_id gets to
  // apply a mutation. A conflict here means "already handled" — success,
  // no side effect, no error.
  const { data: reserved, error: reserveError } = await sb
    .from('commerce_event_receipts')
    .insert({
      installation_id: event.installation_id,
      connection_id: connectionId,
      event_id: event.event_id,
      event_type: event.type,
      entity_id: event.entity_id,
      entity_version: event.entity_version,
      status: 'processed',
    })
    .select('id')
    .maybeSingle();

  if (reserveError) {
    if ((reserveError as { code?: string }).code !== '23505') throw new Error(`event receipt reserve failed: ${reserveError.message}`);
    // A delivery whose change failed to apply left its receipt at 'error'.
    // The plugin's retry of the same event takes that receipt back and
    // applies it; it used to be acknowledged as a duplicate, so a transient
    // error dropped the change for good (a product.deleted, and the AI kept
    // recommending the product). Compare-and-set: one retry wins.
    if (!(await reclaimFailedReceipt(sb, event))) return { status: 'duplicate' };
  } else if (!reserved) {
    return { status: 'duplicate' };
  }

  try {
    await applyEvent(config, workspaceId, connectionId, event);
    await sb.from('commerce_connections').update({ last_event_at: new Date().toISOString() }).eq('id', connectionId);
    return { status: 'processed' };
  } catch (err) {
    await sb.from('commerce_event_receipts').update({ status: 'error' }).eq('installation_id', event.installation_id).eq('event_id', event.event_id);
    throw err;
  }
}

async function reclaimFailedReceipt(sb: ReturnType<typeof getServiceClient>, event: CommerceEvent): Promise<boolean> {
  const { data, error } = await sb
    .from('commerce_event_receipts')
    .update({ status: 'processed', received_at: new Date().toISOString() })
    .eq('installation_id', event.installation_id)
    .eq('event_id', event.event_id)
    .eq('status', 'error')
    .select('id');
  if (error) throw new Error(`event receipt reclaim failed: ${error.message}`);
  return (data ?? []).length > 0;
}

async function applyEvent(config: ServerConfig, workspaceId: string, connectionId: string, event: CommerceEvent): Promise<void> {
  switch (event.type) {
    case 'product.created':
    case 'product.updated': {
      const product = normalizeWooCommerceProduct(event.payload);
      if (product) await upsertProductInIndex(config, workspaceId, connectionId, product);
      return;
    }
    case 'product.deleted': {
      await tombstoneProductInIndex(config, connectionId, event.entity_id, event.occurred_at);
      return;
    }
    case 'variation.created':
    case 'variation.updated': {
      const parentExternalId = String(payloadField(event.payload, 'parentExternalId') ?? '');
      if (!parentExternalId) return;
      const [parent] = await getIndexedProductsByIds(config, connectionId, [parentExternalId]);
      if (!parent) return; // parent not indexed yet — the next full/incremental sync will pick this up
      const variant = normalizeVariantPayload(event.payload);
      if (variant) await upsertVariantInIndex(config, workspaceId, connectionId, parent.id, variant);
      return;
    }
    case 'variation.deleted': {
      await tombstoneVariantInIndex(config, connectionId, event.entity_id, event.occurred_at);
      return;
    }
    case 'stock.changed': {
      const variantExternalId = payloadField(event.payload, 'variantExternalId');
      if (variantExternalId) {
        const parentExternalId = String(payloadField(event.payload, 'parentExternalId') ?? '');
        const [parent] = parentExternalId ? await getIndexedProductsByIds(config, connectionId, [parentExternalId]) : [];
        if (parent) {
          const variant = normalizeVariantPayload(event.payload);
          if (variant) await upsertVariantInIndex(config, workspaceId, connectionId, parent.id, variant);
        }
        return;
      }
      const product = normalizeWooCommerceProduct(event.payload);
      if (product) await upsertProductInIndex(config, workspaceId, connectionId, product);
      return;
    }
    case 'order.created':
    case 'order.updated':
    case 'order.status_changed':
      // Data minimization (spec §31): order/customer PII is never mirrored
      // into the catalog index from events. The receipt above is the only
      // durable record; order data is fetched live, post-authorization,
      // through the Commerce Gateway when the AI actually needs it.
      return;
    default:
      return;
  }
}

/** One field of an event's (untrusted) payload. */
function payloadField(payload: unknown, key: string): unknown {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined;
}

function normalizeVariantPayload(payload: unknown) {
  const product = normalizeWooCommerceProduct({ ...(payload as Record<string, unknown>), title: payloadField(payload, 'title') ?? 'variant', externalId: payloadField(payload, 'parentExternalId'), variants: [payload] });
  return product?.variants[0] ?? null;
}
