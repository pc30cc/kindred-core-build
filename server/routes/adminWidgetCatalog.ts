/**
 * SUPER ADMIN → WIDGET SETTINGS → WIDGET TEMPLATES.
 *
 * Mounted under adminRouter, which already gates `/api/admin/*` behind
 * `requirePlatformAdmin`; each handler asks again for the actor's id, as the
 * other admin routers do.
 *
 * The chat widget template catalog of the running edition
 * (widget_edition_settings.chat_templates, migration 275;
 * shared/chatTemplateCatalog.ts): which of the templates the edition ships
 * workspaces may wear, their display names per dashboard language, their
 * order, their option defaults, and the default one. Only the edition's
 * offered ids are accepted; the edition comes from getPlatformEdition, which
 * answers 503 rather than show or write a guessed edition's row.
 *
 * A save is audited (admin.widget_catalog.changed) and publishes `platform`,
 * which clears the widget's platform snapshot on every backend process: the
 * next page view of every site wears the new catalog. Before migration 275
 * the page reads the code's defaults (`ready: false`) and a save answers 409
 * `migration_required`.
 */
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { requirePlatformAdmin } from '../lib/workspaceAuth.js';
import { publishCacheInvalidation } from '../lib/cacheBus.js';
import { insertAuditLogRows } from '../services/auditLog.js';
import { getPlatformEdition } from '../services/platformRegion.js';
import { respondEditionUnavailable } from '../services/editionSettings.js';
import {
  TEMPLATE_CATALOG_MIGRATION_REQUIRED,
  countTemplateUsage,
  isCatalogTableMissing,
  readEditionChatTemplates,
  saveEditionChatTemplates,
  type EditionChatTemplatesRow,
} from '../services/widget/templateCatalog.js';
import type { Edition } from '../../shared/edition.js';
import { EDITION_CHAT_WIDGET_TEMPLATES } from '../../shared/widgetTemplates.js';
import {
  CHAT_TEMPLATE_LIMITS,
  CHAT_TEMPLATE_NAME_MAX,
  CHAT_TEMPLATE_NAV_MODES,
  CHAT_TEMPLATE_NAV_STYLES,
  CHAT_TEMPLATE_ORDER_MAX,
  CHAT_TEMPLATE_PRECHAT_MODES,
  CHAT_TEMPLATE_TOPIC_ICONS,
  chatTemplateOptionKeys,
  cleanChatTemplateCatalogInput,
  resolveChatTemplateCatalog,
  type ChatTemplateCatalogInput,
} from '../../shared/chatTemplateCatalog.js';

export const adminWidgetCatalogRouter = Router();

function serverConfigOf(req: Request): ServerConfig {
  return (req as unknown as Request & { serverConfig: ServerConfig }).serverConfig;
}

/** A name field: a string (trimmed and cleaned later), or null / '' to clear it. */
const nameText = z.string().max(CHAT_TEMPLATE_NAME_MAX * 4).nullable().optional();

export const widgetCatalogSchema = z.object({
  defaultId: z.string().min(1).max(32),
  templates: z.array(z.object({
    id: z.string().min(1).max(32),
    enabled: z.boolean(),
    order: z.number().int().min(0).max(CHAT_TEMPLATE_ORDER_MAX).optional(),
    name: z.object({ fa: nameText, en: nameText, tr: nameText }).strict().optional(),
    // Checked per key and value by shared/chatTemplateCatalog.ts.
    options: z.record(z.string(), z.unknown()).optional(),
  }).strict()).min(1).max(16),
}).strict();

/** What the page edits: each value an option may take (the first is the code's default). */
function optionSpec(id: string): Record<string, unknown> {
  const spec: Record<string, unknown> = {};
  for (const key of chatTemplateOptionKeys(id)) {
    if (key === 'navStyle') spec.navStyle = CHAT_TEMPLATE_NAV_STYLES;
    if (key === 'navMode') spec.navMode = CHAT_TEMPLATE_NAV_MODES;
    if (key === 'topics') spec.topics = { max: CHAT_TEMPLATE_LIMITS.topics, labelMax: CHAT_TEMPLATE_LIMITS.topicLabel, icons: CHAT_TEMPLATE_TOPIC_ICONS };
    if (key === 'askExamples') spec.askExamples = { max: CHAT_TEMPLATE_LIMITS.askExamples, textMax: CHAT_TEMPLATE_LIMITS.askExample };
    if (key === 'prechatMode') spec.prechatMode = CHAT_TEMPLATE_PRECHAT_MODES;
    // On / off, the code's default (on) first.
    if (key === 'csat') spec.csat = [true, false];
    if (key === 'transcriptEmail') spec.transcriptEmail = [true, false];
  }
  return spec;
}

/** The GET answer: the edition's catalog as workspaces get it, with usage counts. */
async function catalogBody(config: ServerConfig, edition: Edition, row: EditionChatTemplatesRow) {
  const catalog = resolveChatTemplateCatalog(edition, row.stored);
  const offered = EDITION_CHAT_WIDGET_TEMPLATES[edition].offered;
  const usage = row.ready ? await countTemplateUsage(config, offered).catch(() => null) : null;
  return {
    edition,
    ready: row.ready,
    defaultId: catalog.defaultId,
    templates: catalog.entries.map((e) => ({
      id: e.id,
      enabled: e.enabled,
      order: e.order,
      name: e.name,
      options: e.options,
      optionSpec: optionSpec(e.id),
      chosenBy: usage ? usage.chosenBy[e.id] ?? 0 : null,
    })),
    followingDefault: usage ? usage.followingDefault : null,
    limits: { nameMax: CHAT_TEMPLATE_NAME_MAX, orderMax: CHAT_TEMPLATE_ORDER_MAX },
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

adminWidgetCatalogRouter.get('/', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const config = serverConfigOf(req);
  try {
    const edition = await getPlatformEdition(config);
    const row = await readEditionChatTemplates(config, edition);
    return res.json(await catalogBody(config, edition, row));
  } catch (err) {
    if (respondEditionUnavailable(res, err)) return;
    return res.status(500).json({ error: (err as Error).message });
  }
});

adminWidgetCatalogRouter.put('/', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const parsed = widgetCatalogSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid input',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const config = serverConfigOf(req);
  try {
    // Never written into a guessed edition: unknown answers 503.
    const edition = await getPlatformEdition(config);
    const previous = await readEditionChatTemplates(config, edition);
    if (!previous.ready) return res.status(409).json(TEMPLATE_CATALOG_MIGRATION_REQUIRED);
    const cleaned = cleanChatTemplateCatalogInput(edition, parsed.data as ChatTemplateCatalogInput, previous.stored);
    if (cleaned.ok === false) return res.status(400).json({ error: cleaned.problem, ...(cleaned.id ? { id: cleaned.id } : {}) });

    const saved = await saveEditionChatTemplates(config, edition, cleaned.value, actorId);
    if (saved.error) {
      if (isCatalogTableMissing(saved.error)) return res.status(409).json(TEMPLATE_CATALOG_MIGRATION_REQUIRED);
      return res.status(500).json({ error: saved.error.message });
    }
    // The widget's platform snapshot holds the catalog: drop it on every node.
    publishCacheInvalidation(['platform']);

    const sb = getServiceClient(config);
    const { error: auditError } = await insertAuditLogRows(config, sb, {
      workspace_id: null,
      user_id: actorId,
      action: 'admin.widget_catalog.changed',
      entity_type: 'widget_edition_settings',
      // The row's key is the edition (text), not a uuid: it is in the values.
      entity_id: null,
      old_value: { edition, chat_templates: previous.stored },
      new_value: { edition, chat_templates: cleaned.value },
    });
    if (auditError) console.warn('[admin-widget-catalog] audit_logs insert failed:', auditError.message);

    const row = saved.data as { chat_templates?: unknown; updated_at?: string | null; updated_by?: string | null } | null;
    return res.json(await catalogBody(config, edition, {
      ready: true,
      stored: (row?.chat_templates as EditionChatTemplatesRow['stored']) ?? cleaned.value,
      updatedAt: row?.updated_at ?? null,
      updatedBy: row?.updated_by ?? actorId,
    }));
  } catch (err) {
    if (respondEditionUnavailable(res, err)) return;
    return res.status(500).json({ error: (err as Error).message });
  }
});
