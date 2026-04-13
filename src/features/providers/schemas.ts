// ============================================
// PROVIDER FIELD SCHEMAS
// Defines per-provider-type configuration fields
// for structured form rendering. No raw JSON.
// ============================================

export interface ProviderField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'select' | 'toggle' | 'url';
  placeholder?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
  hint?: string;
  group?: string; // for grouping related fields
}

export interface ProviderVendor {
  name: string;
  label: string;
  description: string;
  fields: ProviderField[];
  docsUrl?: string;
}

export interface ProviderTypeSchema {
  type: string;
  label: string;
  icon: string;
  description: string;
  vendors: ProviderVendor[];
  allowWorkspaceOverride: boolean;
}

// ---- Field definitions per vendor per type ----

const emailVendors: ProviderVendor[] = [
  {
    name: 'resend',
    label: 'Resend',
    description: 'Modern email API with excellent deliverability',
    docsUrl: 'https://resend.com/docs',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true, hint: 'Stored server-side only' },
      { key: 'from_email', label: 'From Email', type: 'text', required: true, placeholder: 'noreply@yourdomain.com' },
      { key: 'from_name', label: 'From Name', type: 'text', placeholder: 'Your Platform' },
    ],
  },
  {
    name: 'sendgrid',
    label: 'SendGrid',
    description: 'Enterprise email delivery by Twilio',
    docsUrl: 'https://docs.sendgrid.com',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true, hint: 'Stored server-side only' },
      { key: 'from_email', label: 'From Email', type: 'text', required: true, placeholder: 'noreply@yourdomain.com' },
      { key: 'from_name', label: 'From Name', type: 'text', placeholder: 'Your Platform' },
    ],
  },
  {
    name: 'smtp',
    label: 'SMTP',
    description: 'Connect any SMTP server (Mailgun, Amazon SES, etc.)',
    fields: [
      { key: 'smtp_host', label: 'SMTP Host', type: 'text', required: true, placeholder: 'smtp.example.com' },
      { key: 'smtp_port', label: 'SMTP Port', type: 'number', required: true, placeholder: '587' },
      { key: 'smtp_user', label: 'SMTP Username', type: 'text', required: true },
      { key: 'smtp_pass', label: 'SMTP Password', type: 'password', hint: 'Stored server-side only' },
      { key: 'from_email', label: 'From Email', type: 'text', required: true, placeholder: 'noreply@yourdomain.com' },
      { key: 'from_name', label: 'From Name', type: 'text', placeholder: 'Your Platform' },
      { key: 'smtp_secure', label: 'Use TLS', type: 'toggle' },
    ],
  },
];

const aiVendors: ProviderVendor[] = [
  {
    name: 'openai',
    label: 'OpenAI',
    description: 'GPT-4, GPT-3.5, embeddings',
    docsUrl: 'https://platform.openai.com/docs',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'model', label: 'Default Model', type: 'select', options: [
        { value: 'gpt-4o', label: 'GPT-4o' },
        { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
        { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
        { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' },
      ]},
      { key: 'max_tokens', label: 'Max Tokens', type: 'number', placeholder: '4096' },
      { key: 'temperature', label: 'Temperature', type: 'number', placeholder: '0.7' },
      { key: 'org_id', label: 'Organization ID', type: 'text', hint: 'Optional' },
    ],
  },
  {
    name: 'anthropic',
    label: 'Anthropic',
    description: 'Claude models for safe, helpful AI',
    docsUrl: 'https://docs.anthropic.com',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'model', label: 'Default Model', type: 'select', options: [
        { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
        { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
        { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku' },
      ]},
      { key: 'max_tokens', label: 'Max Tokens', type: 'number', placeholder: '4096' },
    ],
  },
  {
    name: 'gemini',
    label: 'Google Gemini',
    description: 'Google AI models',
    docsUrl: 'https://ai.google.dev/docs',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'model', label: 'Default Model', type: 'select', options: [
        { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
        { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      ]},
    ],
  },
];

const storageVendors: ProviderVendor[] = [
  {
    name: 'supabase',
    label: 'Supabase Storage',
    description: 'Built-in Supabase object storage',
    fields: [
      { key: 'default_bucket', label: 'Default Bucket', type: 'text', placeholder: 'uploads' },
      { key: 'max_file_size', label: 'Max File Size (MB)', type: 'number', placeholder: '50' },
    ],
  },
  {
    name: 's3',
    label: 'Amazon S3',
    description: 'AWS S3 or S3-compatible storage',
    docsUrl: 'https://docs.aws.amazon.com/s3',
    fields: [
      { key: 'access_key_id', label: 'Access Key ID', type: 'password', required: true },
      { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
      { key: 'bucket', label: 'Bucket Name', type: 'text', required: true },
      { key: 'region', label: 'Region', type: 'text', required: true, placeholder: 'us-east-1' },
      { key: 'endpoint', label: 'Custom Endpoint', type: 'url', hint: 'For S3-compatible (MinIO, R2, etc.)' },
    ],
  },
  {
    name: 'cloudflare_r2',
    label: 'Cloudflare R2',
    description: 'S3-compatible with zero egress fees',
    docsUrl: 'https://developers.cloudflare.com/r2',
    fields: [
      { key: 'access_key_id', label: 'Access Key ID', type: 'password', required: true },
      { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
      { key: 'bucket', label: 'Bucket Name', type: 'text', required: true },
      { key: 'account_id', label: 'Account ID', type: 'text', required: true },
      { key: 'public_url', label: 'Public URL', type: 'url', hint: 'Custom domain for public access' },
    ],
  },
];

const billingVendors: ProviderVendor[] = [
  {
    name: 'stripe',
    label: 'Stripe',
    description: 'Full payment processing with subscriptions',
    docsUrl: 'https://stripe.com/docs',
    fields: [
      { key: 'secret_key', label: 'Secret Key', type: 'password', required: true, hint: 'sk_live_... or sk_test_...' },
      { key: 'publishable_key', label: 'Publishable Key', type: 'text', required: true, hint: 'pk_live_... or pk_test_...' },
      { key: 'webhook_secret', label: 'Webhook Secret', type: 'password', required: true, hint: 'whsec_...' },
      { key: 'price_id_free', label: 'Free Plan Price ID', type: 'text', placeholder: 'price_...' },
      { key: 'price_id_pro', label: 'Pro Plan Price ID', type: 'text', placeholder: 'price_...' },
      { key: 'price_id_enterprise', label: 'Enterprise Plan Price ID', type: 'text', placeholder: 'price_...' },
    ],
  },
  {
    name: 'paddle',
    label: 'Paddle',
    description: 'Merchant of Record for global payments',
    docsUrl: 'https://developer.paddle.com',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'seller_id', label: 'Seller ID', type: 'text', required: true },
      { key: 'webhook_secret', label: 'Webhook Secret', type: 'password' },
      { key: 'sandbox', label: 'Sandbox Mode', type: 'toggle' },
    ],
  },
];

const captchaVendors: ProviderVendor[] = [
  {
    name: 'recaptcha',
    label: 'Google reCAPTCHA',
    description: 'Bot protection by Google',
    docsUrl: 'https://developers.google.com/recaptcha',
    fields: [
      { key: 'site_key', label: 'Site Key', type: 'text', required: true },
      { key: 'secret_key', label: 'Secret Key', type: 'password', required: true },
      { key: 'version', label: 'Version', type: 'select', options: [
        { value: 'v2', label: 'reCAPTCHA v2' },
        { value: 'v3', label: 'reCAPTCHA v3' },
      ]},
      { key: 'min_score', label: 'Min Score (v3)', type: 'number', placeholder: '0.5', hint: '0.0 to 1.0' },
    ],
  },
  {
    name: 'hcaptcha',
    label: 'hCaptcha',
    description: 'Privacy-focused CAPTCHA',
    docsUrl: 'https://docs.hcaptcha.com',
    fields: [
      { key: 'site_key', label: 'Site Key', type: 'text', required: true },
      { key: 'secret_key', label: 'Secret Key', type: 'password', required: true },
    ],
  },
  {
    name: 'turnstile',
    label: 'Cloudflare Turnstile',
    description: 'Non-intrusive verification by Cloudflare',
    docsUrl: 'https://developers.cloudflare.com/turnstile',
    fields: [
      { key: 'site_key', label: 'Site Key', type: 'text', required: true },
      { key: 'secret_key', label: 'Secret Key', type: 'password', required: true },
    ],
  },
];

const cdnVendors: ProviderVendor[] = [
  {
    name: 'cloudflare',
    label: 'Cloudflare CDN',
    description: 'Global CDN with edge caching',
    docsUrl: 'https://developers.cloudflare.com',
    fields: [
      { key: 'zone_id', label: 'Zone ID', type: 'text', required: true },
      { key: 'api_token', label: 'API Token', type: 'password', required: true },
      { key: 'custom_domain', label: 'Custom Domain', type: 'url', placeholder: 'assets.yourdomain.com' },
    ],
  },
  {
    name: 'bunny',
    label: 'Bunny CDN',
    description: 'Cost-effective global CDN',
    docsUrl: 'https://docs.bunny.net',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'pull_zone_id', label: 'Pull Zone ID', type: 'text', required: true },
      { key: 'hostname', label: 'CDN Hostname', type: 'url', required: true },
    ],
  },
];

const authVendors: ProviderVendor[] = [
  {
    name: 'supabase',
    label: 'Supabase Auth',
    description: 'Built-in authentication (default)',
    fields: [
      { key: 'site_url', label: 'Site URL', type: 'url', placeholder: 'https://yoursite.com' },
      { key: 'redirect_urls', label: 'Allowed Redirect URLs', type: 'text', hint: 'Comma-separated' },
    ],
  },
];

const databaseVendors: ProviderVendor[] = [
  {
    name: 'supabase',
    label: 'Supabase (PostgreSQL)',
    description: 'Built-in PostgreSQL database (default)',
    fields: [],
  },
];

const realtimeVendors: ProviderVendor[] = [
  {
    name: 'supabase',
    label: 'Supabase Realtime',
    description: 'Built-in WebSocket channels (default)',
    fields: [],
  },
  {
    name: 'pusher',
    label: 'Pusher',
    description: 'Hosted WebSocket channels',
    docsUrl: 'https://pusher.com/docs',
    fields: [
      { key: 'app_id', label: 'App ID', type: 'text', required: true },
      { key: 'key', label: 'Key', type: 'text', required: true },
      { key: 'secret', label: 'Secret', type: 'password', required: true },
      { key: 'cluster', label: 'Cluster', type: 'text', required: true, placeholder: 'eu' },
    ],
  },
];

const searchVendors: ProviderVendor[] = [
  {
    name: 'meilisearch',
    label: 'Meilisearch',
    description: 'Open-source search engine',
    docsUrl: 'https://www.meilisearch.com/docs',
    fields: [
      { key: 'host', label: 'Host URL', type: 'url', required: true, placeholder: 'http://localhost:7700' },
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
    ],
  },
  {
    name: 'algolia',
    label: 'Algolia',
    description: 'Hosted search-as-a-service',
    docsUrl: 'https://www.algolia.com/doc',
    fields: [
      { key: 'app_id', label: 'Application ID', type: 'text', required: true },
      { key: 'api_key', label: 'Admin API Key', type: 'password', required: true },
      { key: 'search_key', label: 'Search-only Key', type: 'text', required: true },
    ],
  },
  {
    name: 'typesense',
    label: 'Typesense',
    description: 'Open-source, typo-tolerant search',
    docsUrl: 'https://typesense.org/docs',
    fields: [
      { key: 'host', label: 'Host URL', type: 'url', required: true },
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'port', label: 'Port', type: 'number', placeholder: '8108' },
    ],
  },
];

const notificationVendors: ProviderVendor[] = [
  {
    name: 'onesignal',
    label: 'OneSignal',
    description: 'Push notifications and in-app messaging',
    docsUrl: 'https://documentation.onesignal.com',
    fields: [
      { key: 'app_id', label: 'App ID', type: 'text', required: true },
      { key: 'rest_api_key', label: 'REST API Key', type: 'password', required: true },
    ],
  },
  {
    name: 'firebase_fcm',
    label: 'Firebase Cloud Messaging',
    description: 'Push notifications by Google',
    docsUrl: 'https://firebase.google.com/docs/cloud-messaging',
    fields: [
      { key: 'project_id', label: 'Project ID', type: 'text', required: true },
      { key: 'service_account_json', label: 'Service Account JSON', type: 'password', required: true, hint: 'Paste the full JSON key' },
    ],
  },
  {
    name: 'novu',
    label: 'Novu',
    description: 'Open-source notification infrastructure',
    docsUrl: 'https://docs.novu.co',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'app_id', label: 'Application ID', type: 'text', required: true },
    ],
  },
];

const cacheVendors: ProviderVendor[] = [
  {
    name: 'memory',
    label: 'In-Memory',
    description: 'Local in-memory cache (default, no config needed)',
    fields: [],
  },
  {
    name: 'redis',
    label: 'Redis',
    description: 'Distributed caching with Redis',
    fields: [
      { key: 'url', label: 'Redis URL', type: 'password', required: true, placeholder: 'redis://user:pass@host:6379' },
      { key: 'ttl_default', label: 'Default TTL (seconds)', type: 'number', placeholder: '3600' },
    ],
  },
  {
    name: 'upstash',
    label: 'Upstash Redis',
    description: 'Serverless Redis',
    docsUrl: 'https://docs.upstash.com',
    fields: [
      { key: 'url', label: 'REST URL', type: 'url', required: true },
      { key: 'token', label: 'REST Token', type: 'password', required: true },
    ],
  },
];

const featureFlagVendors: ProviderVendor[] = [
  {
    name: 'supabase',
    label: 'Database Flags',
    description: 'Feature flags stored in Supabase (default)',
    fields: [],
  },
  {
    name: 'launchdarkly',
    label: 'LaunchDarkly',
    description: 'Enterprise feature management',
    docsUrl: 'https://docs.launchdarkly.com',
    fields: [
      { key: 'sdk_key', label: 'SDK Key', type: 'password', required: true },
      { key: 'client_id', label: 'Client-side ID', type: 'text' },
    ],
  },
  {
    name: 'flagsmith',
    label: 'Flagsmith',
    description: 'Open-source feature flags',
    docsUrl: 'https://docs.flagsmith.com',
    fields: [
      { key: 'api_url', label: 'API URL', type: 'url', placeholder: 'https://api.flagsmith.com/api/v1' },
      { key: 'environment_key', label: 'Environment Key', type: 'password', required: true },
    ],
  },
];

const widgetVendors: ProviderVendor[] = [
  {
    name: 'self_hosted',
    label: 'Self-Hosted Widget',
    description: 'Built-in widget delivery (default)',
    fields: [
      { key: 'widget_url', label: 'Widget Script URL', type: 'url', hint: 'Override the default widget loader URL' },
    ],
  },
];

// ---- Master schema map ----

export const PROVIDER_SCHEMAS: Record<string, ProviderTypeSchema> = {
  auth: {
    type: 'auth', label: 'Auth Provider', icon: 'Shield',
    description: 'User authentication and session management',
    vendors: authVendors, allowWorkspaceOverride: false,
  },
  database: {
    type: 'database', label: 'Database (DAL)', icon: 'Layers',
    description: 'Data access layer for all CRUD operations',
    vendors: databaseVendors, allowWorkspaceOverride: false,
  },
  realtime: {
    type: 'realtime', label: 'Realtime', icon: 'Radio',
    description: 'WebSocket channels, presence, and live updates',
    vendors: realtimeVendors, allowWorkspaceOverride: false,
  },
  email: {
    type: 'email', label: 'Email Provider', icon: 'Mail',
    description: 'Transactional and notification emails',
    vendors: emailVendors, allowWorkspaceOverride: true,
  },
  ai: {
    type: 'ai', label: 'AI Provider', icon: 'Bot',
    description: 'LLM completions, embeddings, and AI features',
    vendors: aiVendors, allowWorkspaceOverride: true,
  },
  storage: {
    type: 'storage', label: 'Storage Provider', icon: 'HardDrive',
    description: 'File uploads, CDN, and asset management',
    vendors: storageVendors, allowWorkspaceOverride: true,
  },
  search: {
    type: 'search', label: 'Search Provider', icon: 'Search',
    description: 'Full-text and vector search',
    vendors: searchVendors, allowWorkspaceOverride: false,
  },
  notification: {
    type: 'notification', label: 'Notifications', icon: 'Bell',
    description: 'Push notifications and in-app alerts',
    vendors: notificationVendors, allowWorkspaceOverride: true,
  },
  cache: {
    type: 'cache', label: 'Cache Provider', icon: 'Database',
    description: 'Key-value caching for performance',
    vendors: cacheVendors, allowWorkspaceOverride: false,
  },
  feature_flag: {
    type: 'feature_flag', label: 'Feature Flags', icon: 'Flag',
    description: 'Feature toggles and gradual rollouts',
    vendors: featureFlagVendors, allowWorkspaceOverride: false,
  },
  widget: {
    type: 'widget', label: 'Widget Delivery', icon: 'MessageSquare',
    description: 'Chat widget configuration and delivery',
    vendors: widgetVendors, allowWorkspaceOverride: false,
  },
  billing: {
    type: 'billing', label: 'Billing Provider', icon: 'CreditCard',
    description: 'Subscriptions, plans, and payment processing',
    vendors: billingVendors, allowWorkspaceOverride: false,
  },
  captcha: {
    type: 'captcha', label: 'Captcha / Abuse', icon: 'ShieldAlert',
    description: 'Bot protection and abuse prevention',
    vendors: captchaVendors, allowWorkspaceOverride: false,
  },
  cdn: {
    type: 'cdn', label: 'CDN / Assets', icon: 'Globe',
    description: 'Asset delivery and CDN management',
    vendors: cdnVendors, allowWorkspaceOverride: true,
  },
};

export function getSchemaForType(type: string): ProviderTypeSchema | undefined {
  return PROVIDER_SCHEMAS[type];
}

export function getVendorSchema(type: string, vendorName: string): ProviderVendor | undefined {
  return PROVIDER_SCHEMAS[type]?.vendors.find(v => v.name === vendorName);
}
