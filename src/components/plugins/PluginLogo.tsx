/**
 * Brand marks for the plugin catalogue.
 *
 * Glyphs come from `simple-icons` (official brand paths + official hex), so the
 * marketplace shows real logos instead of hand-drawn approximations. Brands the
 * library doesn't ship (Bale, Slack's multi-colour mark, generic email/SMS /
 * webhooks) are hand-rolled below with faithful geometry.
 */

import {
  siTelegram,
  siWhatsapp,
  siInstagram,
  siMessenger,
  siDiscord,
  siShopify,
  siWoocommerce,
  siHubspot,
  siGmail,
} from 'simple-icons';
import { Plug, Webhook, MessageSquare, Mail, Smartphone } from 'lucide-react';
import { cn } from '@/lib/utils';

type SimpleIcon = { path: string; hex: string; title: string };

type Mark = {
  /** Official brand colour (hex, no `#`). */
  hex: string;
  /** Single-path official glyph. */
  path?: string;
  /** Multi-element hand-rolled glyph. */
  svg?: React.ReactNode;
  fallback?: typeof Plug;
};

const si = (icon: unknown, hexOverride?: string): Mark => {
  const i = icon as SimpleIcon;
  return { hex: hexOverride ?? i.hex, path: i.path };
};

const MARKS: Record<string, Mark> = {
  telegram: si(siTelegram),
  // Bale (بله) — Iranian messenger. Not in simple-icons: official mark is a
  // white speech bubble with a leaf-like tail on a teal-green field.
  bale: {
    hex: '0FA958',
    svg: (
      <>
        <path
          fill="currentColor"
          d="M12 2.6c-5.2 0-9.4 3.8-9.4 8.5 0 2.6 1.3 5 3.4 6.6v3.2c0 .4.4.6.7.4l3-1.8c.7.1 1.5.2 2.3.2 5.2 0 9.4-3.8 9.4-8.6S17.2 2.6 12 2.6Z"
          opacity="0.28"
        />
        <path
          fill="currentColor"
          d="M16.8 8.1c-2.7.2-4.7 1-6 2.3-1 1-1.5 2.3-1.6 3.8-.6-.5-1-1-1.4-1.8-.2-.4-.8-.3-.9.1-.4 1.9.4 3.7 2 4.7 1.9 1.2 4.4.9 6.2-.7 1.8-1.6 2.6-4.2 2.5-7.7 0-.5-.4-.8-.8-.7Z"
        />
        <circle cx="7.2" cy="6.6" r="1.35" fill="currentColor" />
      </>
    ),
  },
  whatsapp: si(siWhatsapp),
  instagram: si(siInstagram, 'E1306C'),
  messenger: si(siMessenger),
  discord: si(siDiscord),
  // Slack's official mark is four-colour; simple-icons doesn't ship it.
  slack: {
    hex: '4A154B',
    svg: (
      <>
        <path fill="#36C5F0" d="M9 2.2a2.1 2.1 0 0 0-2.1 2.1v2.1H9a2.1 2.1 0 1 0 0-4.2Zm0 5.6H3.4a2.1 2.1 0 1 0 0 4.2H9a2.1 2.1 0 1 0 0-4.2Z" />
        <path fill="#2EB67D" d="M21.8 9.9a2.1 2.1 0 1 0-4.2 0V12h2.1a2.1 2.1 0 0 0 2.1-2.1Zm-5.6 0V4.3a2.1 2.1 0 1 0-4.2 0v5.6a2.1 2.1 0 1 0 4.2 0Z" />
        <path fill="#ECB22E" d="M15 21.8a2.1 2.1 0 0 0 2.1-2.1v-2.1H15a2.1 2.1 0 1 0 0 4.2Zm0-5.6h5.6a2.1 2.1 0 1 0 0-4.2H15a2.1 2.1 0 1 0 0 4.2Z" />
        <path fill="#E01E5A" d="M2.2 14.1a2.1 2.1 0 1 0 4.2 0V12H4.3a2.1 2.1 0 0 0-2.1 2.1Zm5.6 0v5.6a2.1 2.1 0 1 0 4.2 0v-5.6a2.1 2.1 0 1 0-4.2 0Z" />
      </>
    ),
  },
  email: si(siGmail, '5B61F5'),
  sms: { hex: '0EA5E9', fallback: Smartphone },
  shopify: si(siShopify),
  woocommerce: si(siWoocommerce),
  hubspot: si(siHubspot),
  webhooks: { hex: '475569', fallback: Webhook },
  default: { hex: '64748B', fallback: Plug },
};

/** Slack (and any future multi-colour mark) keeps its own fills. */
const MULTICOLOUR = new Set(['slack']);

export function PluginLogo({
  id,
  className,
  size = 'md',
}: {
  id: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const mark = MARKS[id] ?? MARKS.default;
  const Fallback = mark.fallback ?? MessageSquare;
  const box = size === 'lg' ? 'h-14 w-14 rounded-2xl' : size === 'sm' ? 'h-9 w-9 rounded-lg' : 'h-12 w-12 rounded-xl';
  const glyph = size === 'lg' ? 'h-7 w-7' : size === 'sm' ? 'h-[18px] w-[18px]' : 'h-6 w-6';
  const brand = `#${mark.hex}`;
  const multi = MULTICOLOUR.has(id);

  return (
    <div
      className={cn(
        'relative flex shrink-0 items-center justify-center shadow-sm ring-1 ring-black/[0.06] dark:ring-white/10',
        box,
        className,
      )}
      style={{
        backgroundColor: multi ? undefined : `${brand}14`,
        backgroundImage: multi
          ? undefined
          : `linear-gradient(160deg, ${brand}1F, ${brand}0A)`,
        color: brand,
      }}
      aria-hidden
    >
      {multi || mark.path ? (
        <svg viewBox="0 0 24 24" className={glyph} fill={multi ? undefined : 'currentColor'}>
          {mark.path ? <path d={mark.path} /> : mark.svg}
        </svg>
      ) : mark.svg ? (
        <svg viewBox="0 0 24 24" className={glyph}>
          {mark.svg}
        </svg>
      ) : (
        <Fallback className={glyph} strokeWidth={1.9} />
      )}
      <span className="pointer-events-none absolute inset-0 rounded-[inherit] bg-gradient-to-b from-white/50 to-transparent opacity-40 dark:from-white/10" />
    </div>
  );
}
