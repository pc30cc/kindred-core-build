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
  group?: string;
}

export interface ProviderVendor {
  name: string;
  label: string;
  description: string;
  fields: ProviderField[];
  docsUrl?: string;
  /** Locale tags — if set, vendor is only shown when workspace/platform locale matches */
  locales?: ('en' | 'fa' | 'tr')[];
  /** Currency this vendor operates in */
  currency?: string;
  /**
   * Deployment classification for self-host operators.
   * - `selfhosted`  : runs entirely on operator infra, no external calls
   * - `external`    : depends on a public/cloud vendor
   * - `builtin`     : ships in the codebase, no infra needed (centroid, OSM public)
   * - `disabled`    : explicit no-op / off
   */
  deployment?: 'selfhosted' | 'external' | 'builtin' | 'disabled';
  /** Recommended setup tag, surfaced in admin UI as a hint badge. */
  recommendation?: 'simple' | 'production-selfhost' | 'cloud';
  /**
   * Listed in the catalogue but has no real backend runtime yet.
   * Admin UI must render it disabled — never selectable, never savable.
   */
  comingSoon?: boolean;
}

export interface ProviderTypeSchema {
  type: string;
  label: string;
  icon: string;
  description: string;
  vendors: ProviderVendor[];
  allowWorkspaceOverride: boolean;
}

// =============================================
// EMAIL VENDORS
// =============================================
const emailVendors: ProviderVendor[] = [
  {
    name: 'resend', label: 'Resend',
    description: 'Modern email API with excellent deliverability',
    docsUrl: 'https://resend.com/docs',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true, hint: 'Stored server-side only' },
      { key: 'from_email', label: 'From Email', type: 'text', required: true, placeholder: 'noreply@yourdomain.com' },
      { key: 'from_name', label: 'From Name', type: 'text', placeholder: 'Your Platform' },
    ],
  },
  {
    name: 'sendgrid', label: 'SendGrid',
    description: 'Enterprise email delivery by Twilio',
    docsUrl: 'https://docs.sendgrid.com',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true, hint: 'Stored server-side only' },
      { key: 'from_email', label: 'From Email', type: 'text', required: true, placeholder: 'noreply@yourdomain.com' },
      { key: 'from_name', label: 'From Name', type: 'text', placeholder: 'Your Platform' },
    ],
  },
  {
    name: 'smtp', label: 'SMTP (Self-Hosted)',
    description: 'Connect your own SMTP server — Postfix, hMailServer, Mail-in-a-Box, etc.',
    fields: [
      { key: 'smtp_host', label: 'SMTP Host', type: 'text', required: true, placeholder: 'mail.yourdomain.com' },
      { key: 'smtp_port', label: 'SMTP Port', type: 'number', required: true, placeholder: '587' },
      { key: 'smtp_user', label: 'SMTP Username', type: 'text', required: true },
      { key: 'smtp_pass', label: 'SMTP Password', type: 'password', hint: 'Stored server-side only' },
      { key: 'from_email', label: 'From Email', type: 'text', required: true, placeholder: 'noreply@yourdomain.com' },
      { key: 'from_name', label: 'From Name', type: 'text', placeholder: 'Your Platform' },
      { key: 'smtp_secure', label: 'Use TLS', type: 'toggle' },
    ],
  },
  {
    name: 'mailgun', label: 'Mailgun',
    description: 'Email API by Sinch for transactional & marketing email',
    docsUrl: 'https://documentation.mailgun.com',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'domain', label: 'Domain', type: 'text', required: true, placeholder: 'mg.yourdomain.com' },
      { key: 'from_email', label: 'From Email', type: 'text', required: true, placeholder: 'noreply@yourdomain.com' },
      { key: 'from_name', label: 'From Name', type: 'text', placeholder: 'Your Platform' },
      { key: 'region', label: 'Region', type: 'select', options: [
        { value: 'us', label: 'US' }, { value: 'eu', label: 'EU' },
      ]},
    ],
  },
  {
    name: 'ses', label: 'Amazon SES',
    description: 'AWS Simple Email Service — high-scale, low-cost',
    docsUrl: 'https://docs.aws.amazon.com/ses',
    fields: [
      { key: 'access_key_id', label: 'Access Key ID', type: 'password', required: true },
      { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
      { key: 'region', label: 'AWS Region', type: 'text', required: true, placeholder: 'us-east-1' },
      { key: 'from_email', label: 'From Email', type: 'text', required: true, placeholder: 'noreply@yourdomain.com' },
      { key: 'from_name', label: 'From Name', type: 'text', placeholder: 'Your Platform' },
    ],
  },
  {
    name: 'postmark', label: 'Postmark',
    description: 'Reliable transactional email with fast delivery',
    docsUrl: 'https://postmarkapp.com/developer',
    fields: [
      { key: 'server_token', label: 'Server API Token', type: 'password', required: true },
      { key: 'from_email', label: 'From Email', type: 'text', required: true, placeholder: 'noreply@yourdomain.com' },
      { key: 'from_name', label: 'From Name', type: 'text', placeholder: 'Your Platform' },
      { key: 'message_stream', label: 'Message Stream', type: 'text', placeholder: 'outbound', hint: 'Default: outbound' },
    ],
  },
  {
    name: 'sparkpost', label: 'SparkPost (MessageBird)',
    description: 'Enterprise-grade email delivery',
    docsUrl: 'https://developers.sparkpost.com',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'from_email', label: 'From Email', type: 'text', required: true },
      { key: 'from_name', label: 'From Name', type: 'text' },
      { key: 'region', label: 'Region', type: 'select', options: [
        { value: 'us', label: 'US' }, { value: 'eu', label: 'EU' },
      ]},
    ],
  },
  {
    name: 'mailtrap', label: 'Mailtrap',
    description: 'Email testing & sending platform',
    docsUrl: 'https://mailtrap.io/sending/documentation',
    fields: [
      { key: 'api_token', label: 'API Token', type: 'password', required: true },
      { key: 'from_email', label: 'From Email', type: 'text', required: true },
      { key: 'from_name', label: 'From Name', type: 'text' },
    ],
  },
  {
    name: 'brevo', label: 'Brevo (Sendinblue)',
    description: 'All-in-one marketing & transactional email',
    docsUrl: 'https://developers.brevo.com',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'from_email', label: 'From Email', type: 'text', required: true },
      { key: 'from_name', label: 'From Name', type: 'text' },
    ],
  },
];

// =============================================
// AI VENDORS
// =============================================
const aiVendors: ProviderVendor[] = [
  {
    name: 'openai', label: 'OpenAI',
    description: 'GPT-5, GPT-4o, o1, embeddings, DALL·E',
    docsUrl: 'https://platform.openai.com/docs',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'model', label: 'Default Model', type: 'select', options: [
        { value: 'gpt-5', label: 'GPT-5' },
        { value: 'gpt-5-mini', label: 'GPT-5 Mini' },
        { value: 'gpt-5-nano', label: 'GPT-5 Nano' },
        { value: 'gpt-4o', label: 'GPT-4o' },
        { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
        { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
        { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' },
        { value: 'o1', label: 'o1' },
        { value: 'o1-mini', label: 'o1 Mini' },
      ]},
      { key: 'max_tokens', label: 'Max Tokens', type: 'number', placeholder: '4096' },
      { key: 'temperature', label: 'Temperature', type: 'number', placeholder: '0.7' },
      { key: 'org_id', label: 'Organization ID', type: 'text', hint: 'Optional' },
      { key: 'base_url', label: 'Custom Base URL', type: 'url', hint: 'For Azure OpenAI or proxy' },
    ],
  },
  {
    name: 'anthropic', label: 'Anthropic',
    description: 'Claude 4, Claude 3.5, Claude 3 models',
    docsUrl: 'https://docs.anthropic.com',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'model', label: 'Default Model', type: 'select', options: [
        { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
        { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
        { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku' },
        { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus' },
      ]},
      { key: 'max_tokens', label: 'Max Tokens', type: 'number', placeholder: '4096' },
    ],
  },
  {
    name: 'gemini', label: 'Google Gemini',
    description: 'Gemini 2.5 Flash, Pro — multimodal AI',
    docsUrl: 'https://ai.google.dev/docs',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'model', label: 'Default Model', type: 'select', options: [
        { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
        { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
        { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
      ]},
    ],
  },
  {
    name: 'mistral', label: 'Mistral AI',
    description: 'Open-weight & proprietary European AI models',
    docsUrl: 'https://docs.mistral.ai',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'model', label: 'Default Model', type: 'select', options: [
        { value: 'mistral-large-latest', label: 'Mistral Large' },
        { value: 'mistral-medium-latest', label: 'Mistral Medium' },
        { value: 'mistral-small-latest', label: 'Mistral Small' },
        { value: 'open-mixtral-8x22b', label: 'Mixtral 8x22B' },
      ]},
    ],
  },
  {
    name: 'groq', label: 'Groq',
    description: 'Ultra-fast LPU inference for open models',
    docsUrl: 'https://console.groq.com/docs',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'model', label: 'Default Model', type: 'select', options: [
        { value: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
        { value: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B' },
        { value: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B' },
        { value: 'gemma2-9b-it', label: 'Gemma 2 9B' },
      ]},
    ],
  },
  {
    name: 'together', label: 'Together AI',
    description: 'Run open-source models at scale',
    docsUrl: 'https://docs.together.ai',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'model', label: 'Default Model', type: 'text', placeholder: 'meta-llama/Llama-3-70b-chat-hf' },
    ],
  },
  {
    name: 'cohere', label: 'Cohere',
    description: 'Enterprise NLP — Command, Embed, Rerank',
    docsUrl: 'https://docs.cohere.com',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'model', label: 'Default Model', type: 'select', options: [
        { value: 'command-r-plus', label: 'Command R+' },
        { value: 'command-r', label: 'Command R' },
        { value: 'command-light', label: 'Command Light' },
      ]},
    ],
  },
  {
    name: 'perplexity', label: 'Perplexity',
    description: 'Search-augmented AI with real-time knowledge',
    docsUrl: 'https://docs.perplexity.ai',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'model', label: 'Default Model', type: 'select', options: [
        { value: 'sonar-pro', label: 'Sonar Pro' },
        { value: 'sonar', label: 'Sonar' },
      ]},
    ],
  },
  {
    name: 'deepseek', label: 'DeepSeek',
    description: 'High-performance Chinese AI models',
    docsUrl: 'https://platform.deepseek.com/docs',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'model', label: 'Default Model', type: 'select', options: [
        { value: 'deepseek-chat', label: 'DeepSeek Chat (V3)' },
        { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner (R1)' },
      ]},
    ],
  },
  {
    name: 'ollama', label: 'Ollama (Self-Hosted)',
    description: 'Run LLMs locally on your own server',
    docsUrl: 'https://ollama.com',
    fields: [
      { key: 'base_url', label: 'Ollama Server URL', type: 'url', required: true, placeholder: 'http://localhost:11434' },
      { key: 'model', label: 'Default Model', type: 'text', required: true, placeholder: 'llama3.1' },
    ],
  },
  {
    name: 'openrouter', label: 'OpenRouter',
    description: 'Unified API gateway to 100+ AI models',
    docsUrl: 'https://openrouter.ai/docs',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'model', label: 'Default Model', type: 'text', placeholder: 'openai/gpt-4o' },
      { key: 'site_url', label: 'Site URL', type: 'url', hint: 'For usage tracking' },
    ],
  },
  {
    name: 'azure_openai', label: 'Azure OpenAI',
    description: 'OpenAI models hosted on Microsoft Azure',
    docsUrl: 'https://learn.microsoft.com/azure/ai-services/openai',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'endpoint', label: 'Endpoint URL', type: 'url', required: true, placeholder: 'https://your-resource.openai.azure.com' },
      { key: 'deployment_name', label: 'Deployment Name', type: 'text', required: true },
      { key: 'api_version', label: 'API Version', type: 'text', placeholder: '2024-02-15-preview' },
    ],
  },
];

// =============================================
// STORAGE VENDORS
// =============================================
const storageVendors: ProviderVendor[] = [
  {
    name: 'supabase', label: 'Supabase Storage',
    description: 'Built-in Supabase object storage (default)',
    fields: [
      { key: 'default_bucket', label: 'Default Bucket', type: 'text', placeholder: 'uploads' },
      { key: 'max_file_size', label: 'Max File Size (MB)', type: 'number', placeholder: '50' },
    ],
  },
  {
    name: 's3', label: 'Amazon S3',
    description: 'AWS S3 or any S3-compatible service',
    docsUrl: 'https://docs.aws.amazon.com/s3',
    fields: [
      { key: 'access_key_id', label: 'Access Key ID', type: 'password', required: true },
      { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
      { key: 'bucket', label: 'Bucket Name', type: 'text', required: true },
      { key: 'region', label: 'Region', type: 'text', required: true, placeholder: 'us-east-1' },
      { key: 'endpoint', label: 'Custom Endpoint', type: 'url', hint: 'For S3-compatible (MinIO, DigitalOcean Spaces, etc.)' },
    ],
  },
  {
    name: 'cloudflare_r2', label: 'Cloudflare R2',
    description: 'S3-compatible storage with zero egress fees',
    docsUrl: 'https://developers.cloudflare.com/r2',
    fields: [
      { key: 'access_key_id', label: 'Access Key ID', type: 'password', required: true },
      { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
      { key: 'bucket', label: 'Bucket Name', type: 'text', required: true },
      { key: 'account_id', label: 'Account ID', type: 'text', required: true },
      { key: 'public_url', label: 'Public URL', type: 'url', hint: 'Custom domain for public access' },
    ],
  },
  {
    name: 'minio', label: 'MinIO (Self-Hosted)',
    description: 'Self-hosted S3-compatible object storage',
    docsUrl: 'https://min.io/docs',
    fields: [
      { key: 'endpoint', label: 'MinIO Endpoint', type: 'url', required: true, placeholder: 'http://minio.local:9000' },
      { key: 'access_key', label: 'Access Key', type: 'password', required: true },
      { key: 'secret_key', label: 'Secret Key', type: 'password', required: true },
      { key: 'bucket', label: 'Bucket Name', type: 'text', required: true },
      { key: 'use_ssl', label: 'Use SSL', type: 'toggle' },
    ],
  },
  {
    name: 'bunny_storage', label: 'Bunny Storage',
    description: 'Edge storage by BunnyCDN — fast global replication',
    docsUrl: 'https://docs.bunny.net/reference/storage-api',
    fields: [
      { key: 'username', label: 'Username', type: 'text', required: true, placeholder: 'your-storage-zone', hint: 'Your Bunny Storage Zone name (shown as Username in the FTP & API Access panel)' },
      { key: 'hostname', label: 'Hostname', type: 'text', required: true, placeholder: 'storage.bunnycdn.com', hint: 'Region-specific hostname, e.g. ny.storage.bunnycdn.com or sg.storage.bunnycdn.com' },
      { key: 'connection_type', label: 'Connection type', type: 'select', required: true, options: [
        { value: 'ftp', label: 'FTP' },
        { value: 'ftps', label: 'FTPS (Explicit TLS)' },
        { value: 'sftp', label: 'SFTP' },
        { value: 'https', label: 'HTTPS (Storage API)' },
      ], hint: 'Select the protocol matching your Bunny credentials' },
      { key: 'port', label: 'Port', type: 'number', required: true, placeholder: '21', hint: '21 for FTP/FTPS, 22 for SFTP, 443 for HTTPS' },
      { key: 'password', label: 'Password', type: 'password', required: true, hint: 'FTP/API password from Bunny dashboard. Stored server-side only.' },
      { key: 'storage_zone', label: 'Storage Zone Name', type: 'text', placeholder: 'Same as username in most cases', hint: 'Optional override if different from username' },
      { key: 'region', label: 'Region', type: 'select', options: [
        { value: 'de', label: 'Europe (Falkenstein) — storage.bunnycdn.com' },
        { value: 'ny', label: 'US East (New York) — ny.storage.bunnycdn.com' },
        { value: 'la', label: 'US West (Los Angeles) — la.storage.bunnycdn.com' },
        { value: 'sg', label: 'Asia (Singapore) — sg.storage.bunnycdn.com' },
        { value: 'syd', label: 'Oceania (Sydney) — syd.storage.bunnycdn.com' },
        { value: 'uk', label: 'UK (London) — uk.storage.bunnycdn.com' },
        { value: 'se', label: 'Sweden (Stockholm) — se.storage.bunnycdn.com' },
        { value: 'br', label: 'Brazil (São Paulo) — br.storage.bunnycdn.com' },
        { value: 'jh', label: 'South Africa (Johannesburg) — jh.storage.bunnycdn.com' },
      ], hint: 'Used to derive default hostname when API uploads are enabled' },
      { key: 'cdn_url', label: 'CDN Pull URL', type: 'url', hint: 'Public CDN hostname, e.g. https://yourzone.b-cdn.net' },
    ],
  },
  {
    name: 'do_spaces', label: 'DigitalOcean Spaces',
    description: 'S3-compatible object storage by DigitalOcean',
    docsUrl: 'https://docs.digitalocean.com/products/spaces',
    fields: [
      { key: 'access_key_id', label: 'Spaces Key', type: 'password', required: true },
      { key: 'secret_access_key', label: 'Spaces Secret', type: 'password', required: true },
      { key: 'bucket', label: 'Space Name', type: 'text', required: true },
      { key: 'region', label: 'Region', type: 'text', required: true, placeholder: 'nyc3' },
      { key: 'cdn_endpoint', label: 'CDN Endpoint', type: 'url', hint: 'Optional CDN URL' },
    ],
  },
  {
    name: 'gcs', label: 'Google Cloud Storage',
    description: 'Object storage on Google Cloud',
    docsUrl: 'https://cloud.google.com/storage/docs',
    fields: [
      { key: 'project_id', label: 'Project ID', type: 'text', required: true },
      { key: 'service_account_json', label: 'Service Account JSON', type: 'password', required: true, hint: 'Paste the full JSON key' },
      { key: 'bucket', label: 'Bucket Name', type: 'text', required: true },
    ],
  },
  {
    name: 'azure_blob', label: 'Azure Blob Storage',
    description: 'Microsoft Azure object storage',
    docsUrl: 'https://learn.microsoft.com/azure/storage/blobs',
    fields: [
      { key: 'connection_string', label: 'Connection String', type: 'password', required: true },
      { key: 'container', label: 'Container Name', type: 'text', required: true },
    ],
  },
  {
    name: 'backblaze_b2', label: 'Backblaze B2',
    description: 'Low-cost S3-compatible cloud storage',
    docsUrl: 'https://www.backblaze.com/docs/cloud-storage',
    fields: [
      { key: 'application_key_id', label: 'Application Key ID', type: 'password', required: true },
      { key: 'application_key', label: 'Application Key', type: 'password', required: true },
      { key: 'bucket_id', label: 'Bucket ID', type: 'text', required: true },
      { key: 'bucket_name', label: 'Bucket Name', type: 'text', required: true },
    ],
  },
  {
    name: 'wasabi', label: 'Wasabi',
    description: 'S3-compatible hot cloud storage — no egress fees',
    docsUrl: 'https://wasabi.com/help',
    fields: [
      { key: 'access_key_id', label: 'Access Key', type: 'password', required: true },
      { key: 'secret_access_key', label: 'Secret Key', type: 'password', required: true },
      { key: 'bucket', label: 'Bucket Name', type: 'text', required: true },
      { key: 'region', label: 'Region', type: 'text', required: true, placeholder: 'us-east-1' },
    ],
  },
];

// =============================================
// BILLING VENDORS
// =============================================
const billingVendors: ProviderVendor[] = [
  // ── International (EN) ──────────────────────────
  {
    name: 'stripe', label: 'Stripe',
    description: 'Full payment processing — USD / EUR / multi-currency',
    docsUrl: 'https://stripe.com/docs',
    locales: ['en'], currency: 'USD/EUR',
    fields: [
      { key: 'secret_key', label: 'Secret Key', type: 'password', required: true, hint: 'sk_live_... or sk_test_...' },
      { key: 'publishable_key', label: 'Publishable Key', type: 'text', required: true, hint: 'pk_live_... or pk_test_...' },
      { key: 'webhook_secret', label: 'Webhook Secret', type: 'password', required: true, hint: 'whsec_...' },
      { key: 'currency', label: 'Default Currency', type: 'select', options: [
        { value: 'usd', label: 'USD ($)' }, { value: 'eur', label: 'EUR (€)' }, { value: 'gbp', label: 'GBP (£)' },
      ]},
      { key: 'price_id_free', label: 'Free Plan Price ID', type: 'text', placeholder: 'price_...' },
      { key: 'price_id_pro', label: 'Pro Plan Price ID', type: 'text', placeholder: 'price_...' },
      { key: 'price_id_enterprise', label: 'Enterprise Plan Price ID', type: 'text', placeholder: 'price_...' },
    ],
  },
  {
    name: 'paddle', label: 'Paddle',
    description: 'Merchant of Record — handles tax & compliance globally (USD/EUR)',
    docsUrl: 'https://developer.paddle.com',
    locales: ['en'], currency: 'USD/EUR',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'seller_id', label: 'Seller ID', type: 'text', required: true },
      { key: 'webhook_secret', label: 'Webhook Secret', type: 'password' },
      { key: 'sandbox', label: 'Sandbox Mode', type: 'toggle' },
    ],
  },
  {
    name: 'lemon_squeezy', label: 'Lemon Squeezy',
    description: 'Merchant of Record for digital products (USD)',
    docsUrl: 'https://docs.lemonsqueezy.com',
    locales: ['en'], currency: 'USD',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'store_id', label: 'Store ID', type: 'text', required: true },
      { key: 'webhook_secret', label: 'Webhook Signing Secret', type: 'password' },
    ],
  },
  {
    name: 'paypal', label: 'PayPal',
    description: 'Global payments with PayPal & Venmo (USD/EUR)',
    docsUrl: 'https://developer.paypal.com/docs',
    locales: ['en'], currency: 'USD/EUR',
    fields: [
      { key: 'client_id', label: 'Client ID', type: 'text', required: true },
      { key: 'client_secret', label: 'Client Secret', type: 'password', required: true },
      { key: 'sandbox', label: 'Sandbox Mode', type: 'toggle' },
    ],
  },

  // ── Iranian (FA) — IRR / Toman ──────────────────
  {
    name: 'zarinpal', label: 'زرین‌پال (ZarinPal)',
    description: 'درگاه پرداخت آنلاین — ریال / تومان',
    docsUrl: 'https://docs.zarinpal.com',
    locales: ['fa'], currency: 'IRR',
    fields: [
      { key: 'merchant_id', label: 'شناسه مرچنت (Merchant ID)', type: 'password', required: true, hint: '36 کاراکتر UUID' },
      { key: 'sandbox', label: 'حالت تست (Sandbox)', type: 'toggle' },
      { key: 'currency', label: 'واحد پول', type: 'select', options: [
        { value: 'IRR', label: 'ریال (IRR)' }, { value: 'IRT', label: 'تومان (IRT)' },
      ]},
    ],
  },
  {
    name: 'idpay', label: 'آیدی پی (IDPay)',
    description: 'درگاه پرداخت اینترنتی رایگان — ریال / تومان',
    docsUrl: 'https://idpay.ir/web-service',
    locales: ['fa'], currency: 'IRR',
    fields: [
      { key: 'api_key', label: 'کلید API', type: 'password', required: true },
      { key: 'sandbox', label: 'حالت تست', type: 'toggle' },
    ],
  },
  {
    name: 'zarinpal_test', label: 'زرین‌پال — سندباکس (ZarinPal-Test)',
    description: 'اتصال به محیط سندباکس زرین‌پال برای تست پرداخت — بدون تراکنش واقعی (sandbox.zarinpal.com)',
    docsUrl: 'https://www.zarinpal.com/docs/paymentGateway/sandBox.html',
    locales: ['fa'], currency: 'IRR',
    fields: [
      { key: 'merchant_id', label: 'مرچنت آیدی سندباکس (UUID)', type: 'text', required: false, hint: 'اختیاری — در سندباکس هر UUID دلخواهی پذیرفته می‌شود؛ در صورت خالی بودن یک UUID پیش‌فرض استفاده می‌شود' },
      { key: 'currency', label: 'واحد پول', type: 'select', options: [
        { value: 'IRR', label: 'ریال (IRR)' }, { value: 'IRT', label: 'تومان (IRT)' },
      ]},
    ],
  },
  {
    name: 'idpay_test', label: 'آیدی پی — آزمایشگاه (IDPay-Test)',
    description: 'اتصال به محیط آزمایشگاه IDPay برای تست پرداخت — بدون تراکنش واقعی (X-SANDBOX: 1)',
    docsUrl: 'https://idpay.ir/web-service/v1.1/',
    locales: ['fa'], currency: 'IRR',
    fields: [
      { key: 'api_key', label: 'کلید API آزمایشگاه', type: 'password', required: false, hint: 'اختیاری — در صورت خالی بودن از کلید نمونهٔ مستندات IDPay استفاده می‌شود' },
    ],
  },
  {
    name: 'iranpardakht_sandbox', label: 'ایران‌پرداخت — سندباکس (IranPardakht-Sandbox)',
    description: 'اتصال مستقیم به محیط آزمایشی رسمی ایران‌درگاه با مرچنت TEST — بدون تراکنش واقعی',
    docsUrl: 'https://docs.irandargah.com/#8614460e98',
    locales: ['fa'], currency: 'IRR',
    fields: [
      { key: 'currency', label: 'واحد پول تنظیم‌شده در پلن‌ها', type: 'select', options: [
        { value: 'IRR', label: 'ریال (IRR)' }, { value: 'IRT', label: 'تومان (IRT)' },
      ], hint: 'مرچنت سندباکس طبق مستندات به‌صورت خودکار TEST است؛ مبلغ نهایی همیشه به ریال ارسال می‌شود' },
    ],
  },
  {
    name: 'nextpay', label: 'نکست‌پی (NextPay)',
    description: 'درگاه پرداخت واسط — بدون نیاز به نماد اعتماد',
    docsUrl: 'https://nextpay.org/docs',
    locales: ['fa'], currency: 'IRR',
    fields: [
      { key: 'api_key', label: 'کلید API', type: 'password', required: true },
    ],
  },
  {
    name: 'payping', label: 'پی‌پینگ (PayPing)',
    description: 'درگاه پرداخت و لینک پرداخت — ریال',
    docsUrl: 'https://docs.payping.ir',
    locales: ['fa'], currency: 'IRR',
    fields: [
      { key: 'bearer_token', label: 'توکن Bearer', type: 'password', required: true },
    ],
  },
  {
    name: 'zibal', label: 'زیبال (Zibal)',
    description: 'درگاه پرداخت اینترنتی زیبال — ریال / تومان',
    docsUrl: 'https://docs.zibal.ir',
    locales: ['fa'], currency: 'IRR',
    fields: [
      { key: 'merchant', label: 'مرچنت کد', type: 'password', required: true },
      { key: 'lazy_mode', label: 'حالت Lazy', type: 'toggle', hint: 'تأیید دستی تراکنش' },
    ],
  },
  {
    name: 'sep_shaparak', label: 'سپ (سامان‌کیش)',
    description: 'درگاه مستقیم بانک سامان — شاپرک',
    locales: ['fa'], currency: 'IRR',
    fields: [
      { key: 'terminal_id', label: 'شماره ترمینال', type: 'text', required: true },
      { key: 'merchant_key', label: 'کلید مرچنت', type: 'password', required: true },
    ],
  },

  // ── Turkish (TR) — TRY ──────────────────────────
  {
    name: 'iyzico', label: 'iyzico',
    description: 'Türkiye\'nin lider ödeme altyapısı — TRY',
    docsUrl: 'https://dev.iyzipay.com',
    locales: ['tr'], currency: 'TRY',
    fields: [
      { key: 'api_key', label: 'API Anahtarı', type: 'password', required: true },
      { key: 'secret_key', label: 'Gizli Anahtar', type: 'password', required: true },
      { key: 'base_url', label: 'API URL', type: 'url', placeholder: 'https://api.iyzipay.com' },
      { key: 'sandbox', label: 'Test Modu', type: 'toggle' },
    ],
  },
  {
    name: 'paytr', label: 'PayTR',
    description: 'Sanal POS ve ödeme çözümleri — TRY',
    docsUrl: 'https://dev.paytr.com',
    locales: ['tr'], currency: 'TRY',
    fields: [
      { key: 'merchant_id', label: 'Mağaza No', type: 'text', required: true },
      { key: 'merchant_key', label: 'Mağaza Anahtarı', type: 'password', required: true },
      { key: 'merchant_salt', label: 'Mağaza Salt', type: 'password', required: true },
      { key: 'sandbox', label: 'Test Modu', type: 'toggle' },
    ],
  },
  {
    name: 'sipay', label: 'Sipay',
    description: 'Türkiye dijital ödeme platformu — TRY',
    docsUrl: 'https://docs.sipay.com.tr',
    locales: ['tr'], currency: 'TRY',
    fields: [
      { key: 'merchant_key', label: 'Merchant Key', type: 'password', required: true },
      { key: 'app_key', label: 'App Key', type: 'text', required: true },
      { key: 'app_secret', label: 'App Secret', type: 'password', required: true },
    ],
  },
  {
    name: 'paratika', label: 'Paratika (Asseco)',
    description: 'Sanal POS entegrasyonu — TRY',
    docsUrl: 'https://dev.paratika.com.tr',
    locales: ['tr'], currency: 'TRY',
    fields: [
      { key: 'merchant_code', label: 'Üye İşyeri Kodu', type: 'text', required: true },
      { key: 'merchant_user', label: 'API Kullanıcı', type: 'text', required: true },
      { key: 'merchant_password', label: 'API Şifre', type: 'password', required: true },
    ],
  },
  {
    name: 'craftgate', label: 'Craftgate',
    description: 'Ödeme orkestrasyonu — çoklu banka desteği — TRY',
    docsUrl: 'https://developer.craftgate.io',
    locales: ['tr'], currency: 'TRY',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'text', required: true },
      { key: 'secret_key', label: 'Secret Key', type: 'password', required: true },
      { key: 'sandbox', label: 'Test Modu', type: 'toggle' },
    ],
  },
];

// =============================================
// CAPTCHA VENDORS
// =============================================
const captchaVendors: ProviderVendor[] = [
  {
    name: 'recaptcha', label: 'Google reCAPTCHA',
    description: 'Bot protection by Google',
    docsUrl: 'https://developers.google.com/recaptcha',
    fields: [
      { key: 'site_key', label: 'Site Key', type: 'text', required: true },
      { key: 'secret_key', label: 'Secret Key', type: 'password', required: true },
      { key: 'version', label: 'Version', type: 'select', options: [
        { value: 'v2', label: 'reCAPTCHA v2' }, { value: 'v3', label: 'reCAPTCHA v3' },
      ]},
      { key: 'min_score', label: 'Min Score (v3)', type: 'number', placeholder: '0.5', hint: '0.0 to 1.0' },
    ],
  },
  {
    name: 'hcaptcha', label: 'hCaptcha',
    description: 'Privacy-focused CAPTCHA',
    docsUrl: 'https://docs.hcaptcha.com',
    fields: [
      { key: 'site_key', label: 'Site Key', type: 'text', required: true },
      { key: 'secret_key', label: 'Secret Key', type: 'password', required: true },
    ],
  },
  {
    name: 'turnstile', label: 'Cloudflare Turnstile',
    description: 'Non-intrusive, privacy-preserving verification',
    docsUrl: 'https://developers.cloudflare.com/turnstile',
    fields: [
      { key: 'site_key', label: 'Site Key', type: 'text', required: true },
      { key: 'secret_key', label: 'Secret Key', type: 'password', required: true },
    ],
  },
  {
    name: 'friendly_captcha', label: 'Friendly Captcha',
    description: 'GDPR-compliant, proof-of-work CAPTCHA',
    docsUrl: 'https://docs.friendlycaptcha.com',
    fields: [
      { key: 'site_key', label: 'Site Key', type: 'text', required: true },
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
    ],
  },
];

// =============================================
// CDN VENDORS
// =============================================
const cdnVendors: ProviderVendor[] = [
  // ── International (EN) ──────────────────────────
  {
    name: 'cloudflare', label: 'Cloudflare CDN',
    description: 'Global CDN with edge caching & DDoS protection',
    docsUrl: 'https://developers.cloudflare.com',
    locales: ['en'], currency: 'USD',
    fields: [
      { key: 'zone_id', label: 'Zone ID', type: 'text', required: true },
      { key: 'api_token', label: 'API Token', type: 'password', required: true },
      { key: 'custom_domain', label: 'Custom Domain', type: 'url', placeholder: 'assets.yourdomain.com' },
    ],
  },
  {
    name: 'bunny', label: 'Bunny CDN',
    description: 'Cost-effective global CDN with 100+ PoPs',
    docsUrl: 'https://docs.bunny.net',
    locales: ['en'], currency: 'USD',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'pull_zone_id', label: 'Pull Zone ID', type: 'text', required: true },
      { key: 'hostname', label: 'CDN Hostname', type: 'url', required: true },
    ],
  },
  {
    name: 'fastly', label: 'Fastly',
    description: 'Edge cloud platform for content delivery',
    docsUrl: 'https://developer.fastly.com',
    locales: ['en'], currency: 'USD',
    fields: [
      { key: 'api_token', label: 'API Token', type: 'password', required: true },
      { key: 'service_id', label: 'Service ID', type: 'text', required: true },
      { key: 'domain', label: 'Domain', type: 'url', required: true },
    ],
  },
  {
    name: 'aws_cloudfront', label: 'AWS CloudFront',
    description: 'Amazon CloudFront CDN distribution',
    docsUrl: 'https://docs.aws.amazon.com/cloudfront',
    locales: ['en'], currency: 'USD',
    fields: [
      { key: 'access_key_id', label: 'Access Key ID', type: 'password', required: true },
      { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
      { key: 'distribution_id', label: 'Distribution ID', type: 'text', required: true },
      { key: 'domain', label: 'CDN Domain', type: 'url', required: true },
    ],
  },
  {
    name: 'keycdn', label: 'KeyCDN',
    description: 'Simple, affordable CDN',
    docsUrl: 'https://www.keycdn.com/api',
    locales: ['en'], currency: 'USD',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'zone_id', label: 'Zone ID', type: 'text', required: true },
      { key: 'zone_url', label: 'Zone URL', type: 'url', required: true },
    ],
  },

  // ── Iranian (FA) ──────────────────────────
  {
    name: 'arvancloud', label: 'ابر آروان (ArvanCloud)',
    description: 'سی‌دی‌ان ابری ایرانی — PoP داخلی و بین‌المللی',
    docsUrl: 'https://www.arvancloud.ir/docs/api/cdn',
    locales: ['fa'], currency: 'IRR',
    fields: [
      { key: 'api_key', label: 'کلید API', type: 'password', required: true },
      { key: 'domain', label: 'دامنه', type: 'url', required: true, placeholder: 'cdn.yourdomain.ir' },
    ],
  },
  {
    name: 'iranserver_cdn', label: 'ایران سرور CDN',
    description: 'سی‌دی‌ان ایران سرور — زیرساخت داخلی',
    docsUrl: 'https://www.iranserver.com',
    locales: ['fa'], currency: 'IRR',
    fields: [
      { key: 'api_key', label: 'کلید API', type: 'password', required: true },
      { key: 'domain', label: 'دامنه CDN', type: 'url', required: true },
    ],
  },
  {
    name: 'parspack_cdn', label: 'پارس‌پک CDN',
    description: 'سرویس CDN پارس‌پک — دیتاسنتر ایران',
    docsUrl: 'https://www.parspack.com',
    locales: ['fa'], currency: 'IRR',
    fields: [
      { key: 'api_key', label: 'کلید API', type: 'password', required: true },
      { key: 'zone_name', label: 'نام Zone', type: 'text', required: true },
      { key: 'domain', label: 'دامنه', type: 'url', required: true },
    ],
  },
  {
    name: 'derakcloud', label: 'ابر دراک (DerakCloud)',
    description: 'پلتفرم ابری و CDN ایرانی',
    docsUrl: 'https://derak.cloud',
    locales: ['fa'], currency: 'IRR',
    fields: [
      { key: 'api_token', label: 'توکن API', type: 'password', required: true },
      { key: 'domain', label: 'دامنه', type: 'url', required: true },
    ],
  },

  // ── Turkish (TR) ──────────────────────────
  {
    name: 'medianova', label: 'Medianova',
    description: 'Türkiye merkezli CDN — düşük gecikme süresi',
    docsUrl: 'https://docs.medianova.com',
    locales: ['tr'], currency: 'TRY',
    fields: [
      { key: 'api_key', label: 'API Anahtarı', type: 'password', required: true },
      { key: 'api_secret', label: 'API Secret', type: 'password', required: true },
      { key: 'zone_id', label: 'Zone ID', type: 'text', required: true },
      { key: 'domain', label: 'CDN Alan Adı', type: 'url', required: true },
    ],
  },
  {
    name: 'turkcell_cdn', label: 'Turkcell Bulut CDN',
    description: 'Turkcell altyapısı ile içerik dağıtımı — TRY',
    locales: ['tr'], currency: 'TRY',
    fields: [
      { key: 'api_key', label: 'API Anahtarı', type: 'password', required: true },
      { key: 'domain', label: 'CDN Alan Adı', type: 'url', required: true },
    ],
  },
];

// =============================================
// AUTH VENDORS
// =============================================
const authVendors: ProviderVendor[] = [
  {
    name: 'supabase', label: 'Supabase Auth (Cloud)',
    description: 'Managed Supabase authentication — current active instance',
    fields: [
      { key: 'supabase_url', label: 'Supabase URL', type: 'url', required: true, placeholder: 'https://xxxx.supabase.co', hint: 'Your project URL' },
      { key: 'supabase_anon_key', label: 'Anon/Public Key', type: 'text', required: true, hint: 'Publishable key — safe for frontend' },
      { key: 'site_url', label: 'Site URL', type: 'url', placeholder: 'https://yoursite.com', hint: 'Used in email redirects' },
      { key: 'redirect_urls', label: 'Allowed Redirect URLs', type: 'text', hint: 'Comma-separated' },
      { key: 'jwt_expiry', label: 'JWT Expiry (seconds)', type: 'number', placeholder: '3600' },
      { key: 'enable_signup', label: 'Enable Sign-Up', type: 'toggle' },
    ],
  },
  {
    name: 'supabase_self_hosted', label: 'Supabase Auth (Self-Hosted)',
    description: 'Connect to your own self-hosted Supabase/GoTrue instance',
    docsUrl: 'https://supabase.com/docs/guides/self-hosting',
    fields: [
      { key: 'supabase_url', label: 'Supabase URL', type: 'url', required: true, placeholder: 'https://supabase.yourdomain.com' },
      { key: 'supabase_anon_key', label: 'Anon/Public Key', type: 'text', required: true },
      { key: 'supabase_service_role_key', label: 'Service Role Key', type: 'password', hint: 'Server-side only — never exposed to frontend' },
      { key: 'gotrue_url', label: 'GoTrue URL', type: 'url', hint: 'Override if GoTrue runs on a different URL', placeholder: 'https://auth.yourdomain.com' },
      { key: 'site_url', label: 'Site URL', type: 'url', placeholder: 'https://yoursite.com' },
      { key: 'redirect_urls', label: 'Allowed Redirect URLs', type: 'text', hint: 'Comma-separated' },
      { key: 'jwt_secret', label: 'JWT Secret', type: 'password', hint: 'HMAC secret for token signing' },
      { key: 'jwt_expiry', label: 'JWT Expiry (seconds)', type: 'number', placeholder: '3600' },
      { key: 'enable_signup', label: 'Enable Sign-Up', type: 'toggle' },
      { key: 'smtp_host', label: 'Auth SMTP Host', type: 'text', hint: 'SMTP for auth emails (verify, reset)', placeholder: 'smtp.yourdomain.com' },
      { key: 'smtp_port', label: 'Auth SMTP Port', type: 'number', placeholder: '587' },
      { key: 'smtp_user', label: 'Auth SMTP User', type: 'text' },
      { key: 'smtp_pass', label: 'Auth SMTP Password', type: 'password' },
    ],
  },
  {
    name: 'auth0', label: 'Auth0',
    description: 'Enterprise identity platform by Okta',
    docsUrl: 'https://auth0.com/docs',
    fields: [
      { key: 'domain', label: 'Domain', type: 'text', required: true, placeholder: 'your-tenant.auth0.com' },
      { key: 'client_id', label: 'Client ID', type: 'text', required: true },
      { key: 'client_secret', label: 'Client Secret', type: 'password', required: true },
      { key: 'audience', label: 'API Audience', type: 'url', hint: 'Optional API identifier' },
    ],
  },
  {
    name: 'clerk', label: 'Clerk',
    description: 'Modern auth with pre-built UI components',
    docsUrl: 'https://clerk.com/docs',
    fields: [
      { key: 'publishable_key', label: 'Publishable Key', type: 'text', required: true },
      { key: 'secret_key', label: 'Secret Key', type: 'password', required: true },
    ],
  },
  {
    name: 'firebase_auth', label: 'Firebase Auth',
    description: 'Google Firebase authentication',
    docsUrl: 'https://firebase.google.com/docs/auth',
    fields: [
      { key: 'api_key', label: 'Web API Key', type: 'text', required: true },
      { key: 'auth_domain', label: 'Auth Domain', type: 'text', required: true, placeholder: 'your-project.firebaseapp.com' },
      { key: 'project_id', label: 'Project ID', type: 'text', required: true },
    ],
  },
  {
    name: 'keycloak', label: 'Keycloak (Self-Hosted)',
    description: 'Open-source identity & access management',
    docsUrl: 'https://www.keycloak.org/documentation',
    fields: [
      { key: 'server_url', label: 'Server URL', type: 'url', required: true, placeholder: 'https://keycloak.yourdomain.com' },
      { key: 'realm', label: 'Realm', type: 'text', required: true },
      { key: 'client_id', label: 'Client ID', type: 'text', required: true },
      { key: 'client_secret', label: 'Client Secret', type: 'password' },
    ],
  },
];

// =============================================
// DATABASE VENDORS
// =============================================
const databaseVendors: ProviderVendor[] = [
  {
    name: 'supabase', label: 'Supabase PostgreSQL (Cloud)',
    description: 'Managed Supabase PostgreSQL — current active instance',
    fields: [
      { key: 'supabase_url', label: 'Supabase URL', type: 'url', required: true, placeholder: 'https://xxxx.supabase.co' },
      { key: 'supabase_anon_key', label: 'Anon/Public Key', type: 'text', required: true },
      { key: 'schema', label: 'Default Schema', type: 'text', placeholder: 'public' },
      { key: 'pool_size', label: 'Connection Pool Size', type: 'number', placeholder: '10' },
    ],
  },
  {
    name: 'supabase_self_hosted', label: 'Supabase PostgreSQL (Self-Hosted)',
    description: 'Connect to your own self-hosted Supabase + PostgREST instance',
    docsUrl: 'https://supabase.com/docs/guides/self-hosting',
    fields: [
      { key: 'supabase_url', label: 'Supabase URL', type: 'url', required: true, placeholder: 'https://supabase.yourdomain.com' },
      { key: 'supabase_anon_key', label: 'Anon/Public Key', type: 'text', required: true },
      { key: 'supabase_service_role_key', label: 'Service Role Key', type: 'password', hint: 'Server-side only' },
      { key: 'database_url', label: 'Direct PostgreSQL URL', type: 'password', hint: 'For server-side direct access', placeholder: 'postgresql://user:pass@host:5432/postgres' },
      { key: 'postgrest_url', label: 'PostgREST URL', type: 'url', hint: 'Override if PostgREST runs separately', placeholder: 'https://api.yourdomain.com' },
      { key: 'schema', label: 'Default Schema', type: 'text', placeholder: 'public' },
      { key: 'pool_size', label: 'Connection Pool Size', type: 'number', placeholder: '10' },
    ],
  },
  {
    name: 'neon', label: 'Neon',
    description: 'Serverless Postgres with branching',
    docsUrl: 'https://neon.tech/docs',
    fields: [
      { key: 'connection_string', label: 'Connection String', type: 'password', required: true, placeholder: 'postgresql://user:pass@host/db' },
    ],
  },
  {
    name: 'planetscale', label: 'PlanetScale',
    description: 'MySQL-compatible serverless database',
    docsUrl: 'https://planetscale.com/docs',
    fields: [
      { key: 'host', label: 'Host', type: 'text', required: true },
      { key: 'username', label: 'Username', type: 'text', required: true },
      { key: 'password', label: 'Password', type: 'password', required: true },
      { key: 'database', label: 'Database Name', type: 'text', required: true },
    ],
  },
  {
    name: 'turso', label: 'Turso (libSQL)',
    description: 'Edge-replicated SQLite by ChiselStrike',
    docsUrl: 'https://docs.turso.tech',
    fields: [
      { key: 'url', label: 'Database URL', type: 'url', required: true, placeholder: 'libsql://your-db.turso.io' },
      { key: 'auth_token', label: 'Auth Token', type: 'password', required: true },
    ],
  },
  {
    name: 'postgres_self_hosted', label: 'PostgreSQL (Self-Hosted)',
    description: 'Direct connection to any self-hosted PostgreSQL server',
    fields: [
      { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'db.yourdomain.com' },
      { key: 'port', label: 'Port', type: 'number', required: true, placeholder: '5432' },
      { key: 'database', label: 'Database Name', type: 'text', required: true, placeholder: 'postgres' },
      { key: 'username', label: 'Username', type: 'text', required: true },
      { key: 'password', label: 'Password', type: 'password', required: true },
      { key: 'ssl', label: 'Use SSL', type: 'toggle' },
      { key: 'pool_size', label: 'Pool Size', type: 'number', placeholder: '10' },
    ],
  },
];

// =============================================
// REALTIME VENDORS
// =============================================
const realtimeVendors: ProviderVendor[] = [
  {
    name: 'supabase', label: 'Supabase Realtime (Cloud)',
    description: 'Managed Supabase Realtime — current active instance',
    fields: [
      { key: 'supabase_url', label: 'Supabase URL', type: 'url', required: true, placeholder: 'https://xxxx.supabase.co' },
      { key: 'supabase_anon_key', label: 'Anon/Public Key', type: 'text', required: true },
      { key: 'max_channels', label: 'Max Channels per Client', type: 'number', placeholder: '100' },
      { key: 'heartbeat_interval', label: 'Heartbeat Interval (ms)', type: 'number', placeholder: '30000' },
    ],
  },
  {
    name: 'supabase_self_hosted', label: 'Supabase Realtime (Self-Hosted)',
    description: 'Connect to your own self-hosted Supabase Realtime server',
    docsUrl: 'https://supabase.com/docs/guides/self-hosting',
    fields: [
      { key: 'supabase_url', label: 'Supabase URL', type: 'url', required: true, placeholder: 'https://supabase.yourdomain.com' },
      { key: 'supabase_anon_key', label: 'Anon/Public Key', type: 'text', required: true },
      { key: 'realtime_url', label: 'Realtime WebSocket URL', type: 'url', hint: 'Override if Realtime runs separately', placeholder: 'wss://realtime.yourdomain.com' },
      { key: 'max_channels', label: 'Max Channels per Client', type: 'number', placeholder: '100' },
      { key: 'heartbeat_interval', label: 'Heartbeat Interval (ms)', type: 'number', placeholder: '30000' },
    ],
  },
  {
    name: 'pusher', label: 'Pusher',
    description: 'Hosted WebSocket channels & presence',
    docsUrl: 'https://pusher.com/docs',
    fields: [
      { key: 'app_id', label: 'App ID', type: 'text', required: true },
      { key: 'key', label: 'Key', type: 'text', required: true },
      { key: 'secret', label: 'Secret', type: 'password', required: true },
      { key: 'cluster', label: 'Cluster', type: 'text', required: true, placeholder: 'eu' },
    ],
  },
  {
    name: 'ably', label: 'Ably',
    description: 'Realtime messaging infrastructure',
    docsUrl: 'https://ably.com/docs',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true, hint: 'Root API key or token' },
    ],
  },
  {
    name: 'soketi', label: 'Soketi (Self-Hosted)',
    description: 'Open-source, Pusher-compatible WebSocket server',
    docsUrl: 'https://docs.soketi.app',
    fields: [
      { key: 'host', label: 'Host', type: 'url', required: true, placeholder: 'ws://soketi.local:6001' },
      { key: 'app_id', label: 'App ID', type: 'text', required: true },
      { key: 'key', label: 'Key', type: 'text', required: true },
      { key: 'secret', label: 'Secret', type: 'password', required: true },
    ],
  },
  {
    name: 'centrifugo', label: 'Centrifugo (Self-Hosted)',
    description: 'Scalable WebSocket realtime server — HMAC connection tokens, presence, channels',
    docsUrl: 'https://centrifugal.dev',
    fields: [
      { key: 'ws_url', label: 'Public WebSocket URL', type: 'url', required: true, placeholder: 'wss://rt.yourdomain.com/connection/websocket', group: 'Connection', hint: 'URL given to browser clients' },
      { key: 'api_url', label: 'Server-to-Server API URL', type: 'url', required: true, placeholder: 'http://centrifugo:8000/api', group: 'Connection', hint: 'Internal HTTP API for backend → Centrifugo calls' },
      { key: 'api_key', label: 'Admin API Key', type: 'password', required: true, group: 'Auth', hint: 'Server-side only. Never sent to browsers.' },
      { key: 'token_hmac_secret', label: 'Token HMAC Secret (HS256)', type: 'password', required: true, group: 'Auth', hint: 'Shared with Centrifugo for signing connection JWTs' },
      { key: 'allowed_origins', label: 'Allowed Origins (CSV)', type: 'text', placeholder: 'https://app.yourdomain.com,https://*.yourdomain.com', group: 'Security' },
      { key: 'connect_timeout_ms', label: 'Connect Timeout (ms)', type: 'number', placeholder: '8000', group: 'Tuning' },
      { key: 'subscribe_timeout_ms', label: 'Subscribe Timeout (ms)', type: 'number', placeholder: '5000', group: 'Tuning' },
      { key: 'token_ttl_seconds', label: 'Connection Token TTL (s)', type: 'number', placeholder: '900', group: 'Tuning' },
      { key: 'presence_enabled', label: 'Enable Presence', type: 'toggle', group: 'Features' },
      { key: 'typing_enabled', label: 'Enable Typing Indicators', type: 'toggle', group: 'Features' },
    ],
  },
  {
    name: 'polling_builtin', label: 'Built-in Polling (Fallback)',
    description: 'No external realtime server. Widget polls REST endpoints for new messages.',
    fields: [],
  },
  {
    name: 'disabled', label: 'Disabled',
    description: 'Realtime entirely off. History is still loaded via REST. Use only for maintenance.',
    fields: [],
  },
  {
    name: 'websocket_native', label: 'WebSocket (Self-Hosted)',
    description: 'Your own WebSocket server — raw WS or Socket.IO',
    fields: [
      { key: 'ws_url', label: 'WebSocket URL', type: 'url', required: true, placeholder: 'wss://ws.yourdomain.com' },
      { key: 'auth_token', label: 'Auth Token', type: 'password', hint: 'Token for connection authentication' },
      { key: 'protocol', label: 'Protocol', type: 'select', options: [
        { value: 'ws', label: 'Raw WebSocket' },
        { value: 'socketio', label: 'Socket.IO' },
        { value: 'ws-json', label: 'WebSocket + JSON-RPC' },
      ]},
      { key: 'reconnect_interval', label: 'Reconnect Interval (ms)', type: 'number', placeholder: '5000' },
    ],
  },
];

// =============================================
// SEARCH VENDORS
// =============================================
const searchVendors: ProviderVendor[] = [
  {
    name: 'meilisearch', label: 'Meilisearch',
    description: 'Open-source instant search engine',
    docsUrl: 'https://www.meilisearch.com/docs',
    fields: [
      { key: 'host', label: 'Host URL', type: 'url', required: true, placeholder: 'http://localhost:7700' },
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
    ],
  },
  {
    name: 'algolia', label: 'Algolia',
    description: 'Hosted search-as-a-service with AI features',
    docsUrl: 'https://www.algolia.com/doc',
    fields: [
      { key: 'app_id', label: 'Application ID', type: 'text', required: true },
      { key: 'api_key', label: 'Admin API Key', type: 'password', required: true },
      { key: 'search_key', label: 'Search-only Key', type: 'text', required: true },
    ],
  },
  {
    name: 'typesense', label: 'Typesense',
    description: 'Open-source, typo-tolerant search',
    docsUrl: 'https://typesense.org/docs',
    fields: [
      { key: 'host', label: 'Host URL', type: 'url', required: true },
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'port', label: 'Port', type: 'number', placeholder: '8108' },
    ],
  },
  {
    name: 'elasticsearch', label: 'Elasticsearch',
    description: 'Distributed search and analytics engine',
    docsUrl: 'https://www.elastic.co/guide/en/elasticsearch',
    fields: [
      { key: 'url', label: 'Cluster URL', type: 'url', required: true, placeholder: 'https://localhost:9200' },
      { key: 'api_key', label: 'API Key', type: 'password', hint: 'Or use username/password below' },
      { key: 'username', label: 'Username', type: 'text' },
      { key: 'password', label: 'Password', type: 'password' },
    ],
  },
  {
    name: 'opensearch', label: 'OpenSearch',
    description: 'Open-source fork of Elasticsearch',
    docsUrl: 'https://opensearch.org/docs',
    fields: [
      { key: 'url', label: 'Cluster URL', type: 'url', required: true, placeholder: 'https://localhost:9200' },
      { key: 'username', label: 'Username', type: 'text', required: true },
      { key: 'password', label: 'Password', type: 'password', required: true },
    ],
  },
  {
    name: 'pinecone', label: 'Pinecone',
    description: 'Managed vector database for semantic search',
    docsUrl: 'https://docs.pinecone.io',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'environment', label: 'Environment', type: 'text', required: true, placeholder: 'us-east1-gcp' },
      { key: 'index_name', label: 'Index Name', type: 'text', required: true },
    ],
  },
];

// =============================================
// NOTIFICATION VENDORS
// =============================================
const notificationVendors: ProviderVendor[] = [
  {
    name: 'onesignal', label: 'OneSignal',
    description: 'Push notifications and in-app messaging',
    docsUrl: 'https://documentation.onesignal.com',
    fields: [
      { key: 'app_id', label: 'App ID', type: 'text', required: true },
      { key: 'rest_api_key', label: 'REST API Key', type: 'password', required: true },
    ],
  },
  {
    name: 'firebase_fcm', label: 'Firebase Cloud Messaging',
    description: 'Push notifications by Google',
    docsUrl: 'https://firebase.google.com/docs/cloud-messaging',
    fields: [
      { key: 'project_id', label: 'Project ID', type: 'text', required: true },
      { key: 'service_account_json', label: 'Service Account JSON', type: 'password', required: true, hint: 'Paste the full JSON key' },
    ],
  },
  {
    name: 'novu', label: 'Novu',
    description: 'Open-source notification infrastructure',
    docsUrl: 'https://docs.novu.co',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'app_id', label: 'Application ID', type: 'text', required: true },
    ],
  },
  {
    name: 'ntfy', label: 'ntfy (Self-Hosted)',
    description: 'Simple HTTP-based pub-sub push notifications',
    docsUrl: 'https://ntfy.sh/docs',
    fields: [
      { key: 'server_url', label: 'Server URL', type: 'url', required: true, placeholder: 'https://ntfy.yourdomain.com' },
      { key: 'default_topic', label: 'Default Topic', type: 'text', required: true },
      { key: 'auth_token', label: 'Auth Token', type: 'password', hint: 'Optional access token' },
    ],
  },
  {
    name: 'pushover', label: 'Pushover',
    description: 'Simple push notifications for apps',
    docsUrl: 'https://pushover.net/api',
    fields: [
      { key: 'app_token', label: 'Application Token', type: 'password', required: true },
      { key: 'user_key', label: 'User Key', type: 'password', required: true },
    ],
  },
  {
    name: 'gotify', label: 'Gotify (Self-Hosted)',
    description: 'Self-hosted push notification server',
    docsUrl: 'https://gotify.net/docs',
    fields: [
      { key: 'server_url', label: 'Server URL', type: 'url', required: true, placeholder: 'https://gotify.yourdomain.com' },
      { key: 'app_token', label: 'Application Token', type: 'password', required: true },
    ],
  },
];

// =============================================
// CACHE VENDORS
// =============================================
const cacheVendors: ProviderVendor[] = [
  {
    name: 'memory', label: 'In-Memory',
    description: 'Local in-memory cache (default, no config needed)',
    fields: [],
  },
  {
    name: 'redis', label: 'Redis (Self-Hosted)',
    description: 'Self-hosted Redis instance for distributed caching',
    fields: [
      { key: 'url', label: 'Redis URL', type: 'password', required: true, placeholder: 'redis://user:pass@host:6379' },
      { key: 'ttl_default', label: 'Default TTL (seconds)', type: 'number', placeholder: '3600' },
      { key: 'db', label: 'Database Number', type: 'number', placeholder: '0' },
    ],
  },
  {
    name: 'upstash', label: 'Upstash Redis',
    description: 'Serverless Redis with REST API',
    docsUrl: 'https://docs.upstash.com',
    fields: [
      { key: 'url', label: 'REST URL', type: 'url', required: true },
      { key: 'token', label: 'REST Token', type: 'password', required: true },
    ],
  },
  {
    name: 'memcached', label: 'Memcached',
    description: 'High-performance distributed memory caching',
    fields: [
      { key: 'servers', label: 'Server Addresses', type: 'text', required: true, placeholder: 'host1:11211,host2:11211', hint: 'Comma-separated host:port' },
      { key: 'ttl_default', label: 'Default TTL (seconds)', type: 'number', placeholder: '3600' },
    ],
  },
  {
    name: 'dragonfly', label: 'Dragonfly (Self-Hosted)',
    description: 'Redis/Memcached-compatible in-memory store — 25× faster',
    docsUrl: 'https://www.dragonflydb.io/docs',
    fields: [
      { key: 'url', label: 'Connection URL', type: 'password', required: true, placeholder: 'redis://host:6379' },
    ],
  },
];

// =============================================
// FEATURE FLAG VENDORS
// =============================================
const featureFlagVendors: ProviderVendor[] = [
  {
    name: 'supabase', label: 'Database Flags',
    description: 'Feature flags stored in Supabase (default)',
    fields: [],
  },
  {
    name: 'launchdarkly', label: 'LaunchDarkly',
    description: 'Enterprise feature management',
    docsUrl: 'https://docs.launchdarkly.com',
    fields: [
      { key: 'sdk_key', label: 'SDK Key', type: 'password', required: true },
      { key: 'client_id', label: 'Client-side ID', type: 'text' },
    ],
  },
  {
    name: 'flagsmith', label: 'Flagsmith',
    description: 'Open-source feature flags & remote config',
    docsUrl: 'https://docs.flagsmith.com',
    fields: [
      { key: 'api_url', label: 'API URL', type: 'url', placeholder: 'https://api.flagsmith.com/api/v1' },
      { key: 'environment_key', label: 'Environment Key', type: 'password', required: true },
    ],
  },
  {
    name: 'unleash', label: 'Unleash (Self-Hosted)',
    description: 'Open-source feature toggle system',
    docsUrl: 'https://docs.getunleash.io',
    fields: [
      { key: 'api_url', label: 'API URL', type: 'url', required: true, placeholder: 'http://unleash.local:4242/api' },
      { key: 'api_token', label: 'Client API Token', type: 'password', required: true },
      { key: 'app_name', label: 'App Name', type: 'text', placeholder: 'my-app' },
    ],
  },
  {
    name: 'growthbook', label: 'GrowthBook',
    description: 'Open-source A/B testing & feature flags',
    docsUrl: 'https://docs.growthbook.io',
    fields: [
      { key: 'api_host', label: 'API Host', type: 'url', required: true, placeholder: 'https://cdn.growthbook.io' },
      { key: 'client_key', label: 'Client Key', type: 'password', required: true },
    ],
  },
];

// =============================================
// WIDGET VENDORS
// =============================================
const widgetVendors: ProviderVendor[] = [
  {
    name: 'self_hosted', label: 'Self-Hosted Widget',
    description: 'Built-in widget delivery (default)',
    fields: [
      { key: 'widget_url', label: 'Widget Script URL', type: 'url', hint: 'Override the default widget loader URL' },
    ],
  },
  {
    name: 'custom_iframe', label: 'Custom iFrame Widget',
    description: 'Load widget from an external URL in an iframe',
    fields: [
      { key: 'iframe_url', label: 'iFrame Source URL', type: 'url', required: true },
      { key: 'width', label: 'Width (px)', type: 'number', placeholder: '400' },
      { key: 'height', label: 'Height (px)', type: 'number', placeholder: '600' },
    ],
  },
];

// =============================================
// SMS VENDORS
// =============================================
const smsVendors: ProviderVendor[] = [
  // ── International (EN) ──────────────────────────
  {
    name: 'twilio', label: 'Twilio',
    description: 'Global SMS, voice, and messaging platform',
    docsUrl: 'https://www.twilio.com/docs/sms',
    locales: ['en'], currency: 'USD',
    fields: [
      { key: 'account_sid', label: 'Account SID', type: 'text', required: true },
      { key: 'auth_token', label: 'Auth Token', type: 'password', required: true },
      { key: 'from_number', label: 'From Number', type: 'text', required: true, placeholder: '+1234567890', hint: 'E.164 format' },
    ],
  },
  {
    name: 'vonage', label: 'Vonage (Nexmo)',
    description: 'Global messaging API — SMS, WhatsApp, Viber',
    docsUrl: 'https://developer.vonage.com/en/messaging/sms/overview',
    locales: ['en'], currency: 'USD',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'text', required: true },
      { key: 'api_secret', label: 'API Secret', type: 'password', required: true },
      { key: 'from_number', label: 'From Number / Name', type: 'text', required: true },
    ],
  },
  {
    name: 'messagebird', label: 'MessageBird (Bird)',
    description: 'Omnichannel messaging — SMS, WhatsApp, Telegram',
    docsUrl: 'https://developers.messagebird.com',
    locales: ['en'], currency: 'EUR',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'originator', label: 'Originator', type: 'text', required: true, hint: 'Phone number or alphanumeric sender' },
    ],
  },
  {
    name: 'sinch', label: 'Sinch',
    description: 'Cloud communications — SMS & voice',
    docsUrl: 'https://developers.sinch.com',
    locales: ['en'], currency: 'USD',
    fields: [
      { key: 'service_plan_id', label: 'Service Plan ID', type: 'text', required: true },
      { key: 'api_token', label: 'API Token', type: 'password', required: true },
      { key: 'from_number', label: 'From Number', type: 'text', required: true },
    ],
  },
  {
    name: 'aws_sns', label: 'AWS SNS',
    description: 'Amazon Simple Notification Service — SMS',
    docsUrl: 'https://docs.aws.amazon.com/sns',
    locales: ['en'], currency: 'USD',
    fields: [
      { key: 'access_key_id', label: 'Access Key ID', type: 'password', required: true },
      { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
      { key: 'region', label: 'Region', type: 'text', required: true, placeholder: 'us-east-1' },
      { key: 'sender_id', label: 'Sender ID', type: 'text', hint: 'Alphanumeric sender (where supported)' },
    ],
  },

  // ── Iranian (FA) ──────────────────────────
  {
    name: 'kavenegar', label: 'کاوه‌نگار (Kavenegar)',
    description: 'پلتفرم پیامک و تماس صوتی ایران',
    docsUrl: 'https://kavenegar.com/rest.html',
    locales: ['fa'], currency: 'IRR',
    fields: [
      { key: 'api_key', label: 'کلید API', type: 'password', required: true },
      { key: 'verify_template', label: 'الگوی تأیید (OTP)', type: 'text', required: true, placeholder: 'verifyLogin', hint: 'نام الگوی تعریف‌شده در پنل کاوه‌نگار — فقط حروف انگلیسی و عدد' },
      { key: 'sender', label: 'شماره فرستنده پیش‌فرض', type: 'text', placeholder: '10008663', hint: 'اختیاری — فقط برای پیامک عمومی؛ در VerifyLookup استفاده نمی‌شود' },
    ],
  },
  {
    name: 'melipayamak', label: 'ملی پیامک (MeliPayamak)',
    description: 'سامانه پیامکی ملی پیامک — پنل ارسال انبوه',
    docsUrl: 'https://www.melipayamak.com',
    locales: ['fa'], currency: 'IRR',
    fields: [
      { key: 'username', label: 'نام کاربری', type: 'text', required: true },
      { key: 'password', label: 'رمز عبور وب‌سرویس', type: 'password', required: true },
      { key: 'from_number', label: 'شماره فرستنده', type: 'text', required: true },
    ],
  },
  {
    name: 'ghasedak', label: 'قاصدک (Ghasedak)',
    description: 'سرویس پیام کوتاه قاصدک — OTP و ارسال انبوه',
    docsUrl: 'https://ghasedak.me/docs',
    locales: ['fa'], currency: 'IRR',
    fields: [
      { key: 'api_key', label: 'کلید API', type: 'password', required: true },
      { key: 'line_number', label: 'شماره خط', type: 'text', required: true },
    ],
  },
  {
    name: 'farazsms', label: 'فراز اس‌ام‌اس (FarazSMS)',
    description: 'پنل پیامکی فراز — ارسال و دریافت پیامک',
    docsUrl: 'https://farazsms.com',
    locales: ['fa'], currency: 'IRR',
    fields: [
      { key: 'api_key', label: 'کلید API', type: 'password', required: true },
      { key: 'sender', label: 'شماره فرستنده', type: 'text', required: true },
    ],
  },
  {
    name: 'smsir', label: 'اس‌ام‌اس آی‌آر (SMS.ir)',
    description: 'وب‌سرویس پیامکی SMS.ir — خطوط اختصاصی',
    docsUrl: 'https://app.sms.ir/developer/help',
    locales: ['fa'], currency: 'IRR',
    fields: [
      { key: 'api_key', label: 'کلید API', type: 'password', required: true },
      { key: 'line_number', label: 'شماره خط', type: 'text', required: true, placeholder: '30007732', hint: 'شماره خط اختصاصی پنل SMS.ir — فقط عدد' },
      { key: 'verify_template_id', label: 'شناسه الگوی تأیید (OTP)', type: 'text', required: true, placeholder: '100000', hint: 'Template ID تعریف‌شده در پنل SMS.ir — فقط عدد' },
      { key: 'verify_parameter_name', label: 'نام پارامتر کد تأیید', type: 'text', required: true, placeholder: 'CODE', hint: 'نام پارامتر الگو که کد تأیید در آن قرار می‌گیرد' },
    ],
  },
  {
    name: 'payamresan', label: 'پیام‌رسان (PayamResan)',
    description: 'سرویس پیامکی پیام‌رسان — پوشش سراسری',
    locales: ['fa'], currency: 'IRR',
    fields: [
      { key: 'username', label: 'نام کاربری', type: 'text', required: true },
      { key: 'password', label: 'رمز عبور', type: 'password', required: true },
      { key: 'sender', label: 'شماره فرستنده', type: 'text', required: true },
    ],
  },

  // ── Turkish (TR) ──────────────────────────
  {
    name: 'netgsm', label: 'Netgsm',
    description: 'Türkiye\'nin lider toplu SMS platformu',
    docsUrl: 'https://www.netgsm.com.tr/dokuman',
    locales: ['tr'], currency: 'TRY',
    fields: [
      { key: 'usercode', label: 'Kullanıcı Kodu', type: 'text', required: true },
      { key: 'password', label: 'Şifre', type: 'password', required: true },
      { key: 'msgheader', label: 'Mesaj Başlığı', type: 'text', required: true, hint: 'Onaylı başlık adı' },
    ],
  },
  {
    name: 'iletimerkezi', label: 'İleti Merkezi',
    description: 'Toplu SMS ve OTP gönderim platformu — TRY',
    docsUrl: 'https://www.iletimerkezi.com/api',
    locales: ['tr'], currency: 'TRY',
    fields: [
      { key: 'api_key', label: 'API Anahtarı', type: 'password', required: true },
      { key: 'api_hash', label: 'API Hash', type: 'password', required: true },
      { key: 'sender', label: 'Gönderici Adı', type: 'text', required: true },
    ],
  },
  {
    name: 'mutlucell', label: 'Mutlucell',
    description: 'Toplu SMS ve kampanya yönetimi — TRY',
    docsUrl: 'https://www.mutlucell.com.tr',
    locales: ['tr'], currency: 'TRY',
    fields: [
      { key: 'username', label: 'Kullanıcı Adı', type: 'text', required: true },
      { key: 'password', label: 'Şifre', type: 'password', required: true },
      { key: 'originator', label: 'Gönderici', type: 'text', required: true },
    ],
  },
  {
    name: 'jetsms', label: 'JetSMS (TuraTech)',
    description: 'Kurumsal SMS çözümleri — Türkiye',
    docsUrl: 'https://www.jetsms.net',
    locales: ['tr'], currency: 'TRY',
    fields: [
      { key: 'username', label: 'Kullanıcı Adı', type: 'text', required: true },
      { key: 'password', label: 'Şifre', type: 'password', required: true },
      { key: 'originator', label: 'Başlık', type: 'text', required: true },
    ],
  },
  {
    name: 'verimor', label: 'Verimor',
    description: 'Toplu SMS API — hızlı entegrasyon — TRY',
    docsUrl: 'https://www.verimor.com.tr/api',
    locales: ['tr'], currency: 'TRY',
    fields: [
      { key: 'api_id', label: 'API ID', type: 'text', required: true },
      { key: 'api_key', label: 'API Anahtarı', type: 'password', required: true },
      { key: 'source_addr', label: 'Kaynak Adres', type: 'text', required: true },
    ],
  },
];

// Only Kavenegar has a real server-side runtime adapter today. Every other SMS
// vendor stays in the catalogue for discoverability but is flagged so the admin
// UI renders it as "Coming soon" and refuses to activate it.
for (const vendor of smsVendors) {
  if (vendor.name !== 'kavenegar' && vendor.name !== 'smsir') vendor.comingSoon = true;
}

// =============================================
// GEO ENRICHMENT VENDORS (server-side IP→geo)
// =============================================
const geoEnrichmentVendors: ProviderVendor[] = [
  {
    name: 'centroid', label: 'Centroid (Built-in)',
    description: 'Country/city centroid from bundled table. No external calls. Always available.',
    deployment: 'builtin', recommendation: 'simple',
    fields: [],
  },
  {
    name: 'maxmind_local', label: 'MaxMind GeoIP2 (Local DB) — managed in Map & Geo',
    description: 'Self-hosted GeoLite2/GeoIP2 .mmdb lookups. This is platform infrastructure: the database path, auto-reload and auto-update are configured ONLY in Super Admin → Map & Geo, and values entered here are ignored by the runtime. Selecting it here has no effect — use Map & Geo.',
    docsUrl: 'https://dev.maxmind.com/geoip/geolite2-free-geolocation-data',
    deployment: 'selfhosted', recommendation: 'production-selfhost',
    fields: [],
  },
  {
    name: 'ipapi', label: 'ipapi.co',
    description: 'Free tier IP geolocation API. Optional API key for higher limits.',
    docsUrl: 'https://ipapi.co/api',
    deployment: 'external', recommendation: 'cloud',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', hint: 'Optional — leave empty for free tier' },
    ],
  },
  {
    name: 'ipinfo', label: 'IPinfo',
    description: 'Accurate IP geolocation with company & ASN data',
    docsUrl: 'https://ipinfo.io/developers',
    deployment: 'external', recommendation: 'cloud',
    fields: [
      { key: 'api_token', label: 'Access Token', type: 'password', required: true },
    ],
  },
  {
    name: 'maxmind', label: 'MaxMind GeoIP2 (Web Service)',
    description: 'MaxMind cloud Web Service API — billed per query. For local DB use "MaxMind GeoIP2 (Local DB)".',
    docsUrl: 'https://dev.maxmind.com/geoip',
    deployment: 'external', recommendation: 'cloud',
    fields: [
      { key: 'account_id', label: 'Account ID', type: 'text', required: true },
      { key: 'license_key', label: 'License Key', type: 'password', required: true },
    ],
  },
  {
    name: 'ipgeolocation', label: 'ipgeolocation.io',
    description: 'IP geolocation with timezone, ASN, threat data',
    docsUrl: 'https://ipgeolocation.io/documentation.html',
    deployment: 'external', recommendation: 'cloud',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
    ],
  },
  {
    name: 'none', label: 'Disabled (No enrichment)',
    description: 'Skip provider lookup entirely. Centroid remains available as ultimate fallback.',
    deployment: 'disabled',
    fields: [],
  },
];

// =============================================
// MAP TILES VENDORS (frontend map renderer source)
// =============================================
const mapTilesVendors: ProviderVendor[] = [
  {
    name: 'osm_public', label: 'OpenStreetMap (public tiles)',
    description: 'Free raster tiles from openstreetmap.org. No API key. Best for simple installs and dev. Subject to OSM tile usage policy.',
    docsUrl: 'https://www.openstreetmap.org',
    deployment: 'builtin', recommendation: 'simple',
    fields: [],
  },
  {
    name: 'tileserver_selfhosted', label: 'TileServer GL (Self-Hosted)',
    description: 'Connect your own raster/vector tile server. Recommended for production self-host. Zero external dependency.',
    docsUrl: 'https://github.com/maptiler/tileserver-gl',
    deployment: 'selfhosted', recommendation: 'production-selfhost',
    fields: [
      { key: 'tile_url', label: 'Tile URL Template', type: 'url', required: true,
        placeholder: 'https://tiles.yourdomain.com/styles/basic/{z}/{x}/{y}.png',
        hint: 'Must contain {z}/{x}/{y}. Use {r} for retina if your server supports it.' },
      { key: 'mode', label: 'Tile Mode', type: 'select', options: [
        { value: 'raster', label: 'Raster (PNG/JPG)' },
        { value: 'vector', label: 'Vector (PBF/MVT)' },
      ], hint: 'Raster works with the current Leaflet renderer. Vector requires MapLibre — coming soon.' },
      { key: 'attribution', label: 'Attribution', type: 'text',
        placeholder: '© OpenStreetMap contributors',
        hint: 'Required by OSM data licence if your tiles are derived from OSM.' },
      { key: 'min_zoom', label: 'Min Zoom', type: 'number', placeholder: '1' },
      { key: 'max_zoom', label: 'Max Zoom', type: 'number', placeholder: '19' },
      { key: 'health_url', label: 'Health Check URL', type: 'url',
        placeholder: 'https://tiles.yourdomain.com/health',
        hint: 'Optional. If set, admin UI uses this for live status.' },
    ],
  },
  {
    name: 'openmaptiles_selfhosted', label: 'OpenMapTiles (Self-Hosted)',
    description: 'Self-hosted OpenMapTiles stack with style URL. Recommended for fully branded production maps.',
    docsUrl: 'https://openmaptiles.org/docs',
    deployment: 'selfhosted', recommendation: 'production-selfhost',
    fields: [
      { key: 'tile_url', label: 'Raster Tile URL', type: 'url', required: true,
        placeholder: 'https://maps.yourdomain.com/styles/osm-bright/{z}/{x}/{y}.png',
        hint: 'Raster fallback used by the Leaflet renderer.' },
      { key: 'style_url', label: 'Style URL (Vector)', type: 'url',
        placeholder: 'https://maps.yourdomain.com/styles/osm-bright/style.json',
        hint: 'Optional. Used when the renderer supports MapLibre vector tiles.' },
      { key: 'attribution', label: 'Attribution', type: 'text',
        placeholder: '© OpenMapTiles © OpenStreetMap contributors' },
      { key: 'min_zoom', label: 'Min Zoom', type: 'number', placeholder: '1' },
      { key: 'max_zoom', label: 'Max Zoom', type: 'number', placeholder: '19' },
      { key: 'health_url', label: 'Health Check URL', type: 'url',
        placeholder: 'https://maps.yourdomain.com/health' },
    ],
  },
  {
    name: 'maptiler', label: 'MapTiler',
    description: 'Vector & raster tiles with multiple styles',
    docsUrl: 'https://docs.maptiler.com',
    deployment: 'external', recommendation: 'cloud',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'style', label: 'Map Style', type: 'select', options: [
        { value: 'streets-v2', label: 'Streets' },
        { value: 'basic-v2', label: 'Basic' },
        { value: 'bright-v2', label: 'Bright' },
        { value: 'dataviz', label: 'Data Viz' },
      ]},
    ],
  },
  {
    name: 'mapbox', label: 'Mapbox',
    description: 'High-quality vector tiles and styles',
    docsUrl: 'https://docs.mapbox.com',
    deployment: 'external', recommendation: 'cloud',
    fields: [
      { key: 'access_token', label: 'Access Token', type: 'password', required: true },
      { key: 'style', label: 'Style URL', type: 'text', placeholder: 'mapbox/streets-v12' },
    ],
  },
  {
    name: 'stadia', label: 'Stadia Maps',
    description: 'Privacy-friendly map tiles, OSM-based',
    docsUrl: 'https://docs.stadiamaps.com',
    deployment: 'external', recommendation: 'cloud',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', hint: 'Optional in dev, required in production' },
      { key: 'style', label: 'Style', type: 'select', options: [
        { value: 'alidade_smooth', label: 'Alidade Smooth' },
        { value: 'alidade_smooth_dark', label: 'Alidade Smooth Dark' },
        { value: 'osm_bright', label: 'OSM Bright' },
        { value: 'outdoors', label: 'Outdoors' },
      ]},
    ],
  },
  {
    name: 'none', label: 'No Map (List Only)',
    description: 'Disable the map canvas. Visitors are listed without geographic display.',
    deployment: 'disabled',
    fields: [],
  },
];

// =============================================
// MASTER SCHEMA MAP
// =============================================
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
  sms: {
    type: 'sms', label: 'SMS Provider', icon: 'Smartphone',
    description: 'SMS messaging, OTP, and bulk notifications',
    vendors: smsVendors, allowWorkspaceOverride: true,
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
    vendors: billingVendors, allowWorkspaceOverride: true,
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
  geo_enrichment: {
    type: 'geo_enrichment', label: 'Geo Enrichment', icon: 'MapPin',
    description: 'IP→geo lookup for visitor intelligence (centroid fallback always available)',
    vendors: geoEnrichmentVendors, allowWorkspaceOverride: true,
  },
  map_tiles: {
    type: 'map_tiles', label: 'Map Tiles', icon: 'Map',
    description: 'Map tile source for the Visitors map canvas',
    vendors: mapTilesVendors, allowWorkspaceOverride: true,
  },
};

export function getSchemaForType(type: string): ProviderTypeSchema | undefined {
  return PROVIDER_SCHEMAS[type];
}

export function getVendorSchema(type: string, vendorName: string): ProviderVendor | undefined {
  return PROVIDER_SCHEMAS[type]?.vendors.find(v => v.name === vendorName);
}

/** Filter vendors by locale — returns all vendors if none match or vendor has no locale tag */
export function getVendorsForLocale(type: string, locale?: string): ProviderVendor[] {
  const schema = PROVIDER_SCHEMAS[type];
  if (!schema) return [];
  if (!locale) return schema.vendors;
  return schema.vendors.filter(v => !v.locales || v.locales.includes(locale as 'en' | 'fa' | 'tr'));
}
