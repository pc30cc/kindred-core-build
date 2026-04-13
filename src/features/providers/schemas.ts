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
    description: 'GPT-4o, GPT-4, o1, embeddings, DALL·E',
    docsUrl: 'https://platform.openai.com/docs',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'model', label: 'Default Model', type: 'select', options: [
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
      { key: 'api_key', label: 'Storage API Key', type: 'password', required: true },
      { key: 'storage_zone', label: 'Storage Zone Name', type: 'text', required: true },
      { key: 'region', label: 'Region', type: 'select', options: [
        { value: 'de', label: 'Europe (Falkenstein)' },
        { value: 'ny', label: 'US East (New York)' },
        { value: 'la', label: 'US West (Los Angeles)' },
        { value: 'sg', label: 'Asia (Singapore)' },
        { value: 'syd', label: 'Oceania (Sydney)' },
      ]},
      { key: 'cdn_url', label: 'CDN Pull URL', type: 'url', hint: 'e.g. https://yourzone.b-cdn.net' },
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
  {
    name: 'stripe', label: 'Stripe',
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
    name: 'paddle', label: 'Paddle',
    description: 'Merchant of Record — handles tax, compliance globally',
    docsUrl: 'https://developer.paddle.com',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'seller_id', label: 'Seller ID', type: 'text', required: true },
      { key: 'webhook_secret', label: 'Webhook Secret', type: 'password' },
      { key: 'sandbox', label: 'Sandbox Mode', type: 'toggle' },
    ],
  },
  {
    name: 'lemon_squeezy', label: 'Lemon Squeezy',
    description: 'Merchant of Record for digital products',
    docsUrl: 'https://docs.lemonsqueezy.com',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'store_id', label: 'Store ID', type: 'text', required: true },
      { key: 'webhook_secret', label: 'Webhook Signing Secret', type: 'password' },
    ],
  },
  {
    name: 'paypal', label: 'PayPal',
    description: 'Global payments with PayPal & Venmo',
    docsUrl: 'https://developer.paypal.com/docs',
    fields: [
      { key: 'client_id', label: 'Client ID', type: 'text', required: true },
      { key: 'client_secret', label: 'Client Secret', type: 'password', required: true },
      { key: 'sandbox', label: 'Sandbox Mode', type: 'toggle' },
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
  {
    name: 'cloudflare', label: 'Cloudflare CDN',
    description: 'Global CDN with edge caching & DDoS protection',
    docsUrl: 'https://developers.cloudflare.com',
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
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'zone_id', label: 'Zone ID', type: 'text', required: true },
      { key: 'zone_url', label: 'Zone URL', type: 'url', required: true },
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
    description: 'Scalable real-time messaging server',
    docsUrl: 'https://centrifugal.dev',
    fields: [
      { key: 'url', label: 'Server URL', type: 'url', required: true, placeholder: 'http://centrifugo.local:8000' },
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
      { key: 'token_secret', label: 'Token HMAC Secret', type: 'password', required: true },
    ],
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
