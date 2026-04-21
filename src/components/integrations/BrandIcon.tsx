/**
 * BrandIcon
 * ---------
 * Renders a real brand mark (SVG) for a given channel id.
 *
 * Why not use a giant icon library? simple-icons ships official SVG paths +
 * hex colors for ~3000 brands, but a few we need (Slack, Outlook, Adobe
 * Commerce, WHMCS) aren't present — so we hand-roll those.
 *
 * The component renders a 36×36 rounded tile with the brand color at low
 * opacity behind a crisp colored glyph — same visual language for every
 * channel and works in light + dark themes.
 */
import {
  siHtml5, siWordpress, siShopify, siPrestashop, siWoocommerce,
  siGmail, siInstagram, siMessenger, siTelegram, siX, siWhatsapp,
  siApple, siAndroid, siReact,
} from 'simple-icons/icons';

type SimpleIcon = { path: string; hex: string; title: string };

/* ---------- Hand-rolled glyphs (not in simple-icons) ----------------- */

const CUSTOM: Record<string, { hex: string; svg: React.ReactNode }> = {
  whmcs: {
    hex: '1F75BC',
    svg: (
      <path d="M2 5l3.2 14h3l2.3-9.4L12.8 19h3L19 5h-3l-1.7 9.5L11.9 5H9.1L6.7 14.5 5 5H2z" />
    ),
  },
  adobe: {
    hex: 'EB1000',
    svg: (
      <path d="M13.6 2H22v20L13.6 2zM8.4 2H0v20L8.4 2zm2.7 7.4L16.5 22h-3.4l-1.6-4H7.6l3.5-8.6z" />
    ),
  },
  outlook: {
    hex: '0078D4',
    svg: (
      <path d="M7.5 7.5C5 7.5 3 9.7 3 12.5S5 17.5 7.5 17.5 12 15.3 12 12.5 10 7.5 7.5 7.5zm0 7.5c-1.4 0-2.4-1.1-2.4-2.5S6.1 10 7.5 10 10 11.1 10 12.5 8.9 15 7.5 15zM13 8h7c.6 0 1 .4 1 1v9c0 .6-.4 1-1 1h-7V8zm1.5 1.5v3l3 1.7 3-1.7v-3h-6z" />
    ),
  },
  slack: {
    hex: '4A154B',
    svg: (
      <path d="M5.4 14.6c0 1-.8 1.8-1.8 1.8s-1.8-.8-1.8-1.8.8-1.8 1.8-1.8h1.8v1.8zm.9 0c0-1 .8-1.8 1.8-1.8s1.8.8 1.8 1.8v4.5c0 1-.8 1.8-1.8 1.8s-1.8-.8-1.8-1.8v-4.5zM8.1 7.4c-1 0-1.8-.8-1.8-1.8S7.1 3.8 8.1 3.8 9.9 4.6 9.9 5.6v1.8H8.1zm0 .9c1 0 1.8.8 1.8 1.8s-.8 1.8-1.8 1.8H3.6c-1 0-1.8-.8-1.8-1.8s.8-1.8 1.8-1.8h4.5zm7.2 1.8c0-1 .8-1.8 1.8-1.8s1.8.8 1.8 1.8-.8 1.8-1.8 1.8h-1.8v-1.8zm-.9 0c0 1-.8 1.8-1.8 1.8s-1.8-.8-1.8-1.8V5.6c0-1 .8-1.8 1.8-1.8s1.8.8 1.8 1.8v4.5zm-1.8 7.2c1 0 1.8.8 1.8 1.8s-.8 1.8-1.8 1.8-1.8-.8-1.8-1.8v-1.8h1.8zm0-.9c-1 0-1.8-.8-1.8-1.8s.8-1.8 1.8-1.8h4.5c1 0 1.8.8 1.8 1.8s-.8 1.8-1.8 1.8h-4.5z" />
    ),
  },
  email: {
    hex: '64748B',
    svg: (
      <path d="M2 6c0-1.1.9-2 2-2h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6zm2.4.5L12 12l7.6-5.5H4.4zM20 8.2l-7.4 5.4c-.4.3-.8.3-1.2 0L4 8.2V18h16V8.2z" />
    ),
  },
};

/* ---------- Map channel id → simple-icons brand --------------------- */

const SIMPLE: Record<string, SimpleIcon> = {
  html: siHtml5 as SimpleIcon,
  wordpress: siWordpress as SimpleIcon,
  shopify: siShopify as SimpleIcon,
  prestashop: siPrestashop as SimpleIcon,
  woocommerce: siWoocommerce as SimpleIcon,
  gmail: siGmail as SimpleIcon,
  instagram: siInstagram as SimpleIcon,
  messenger: siMessenger as SimpleIcon,
  telegram: siTelegram as SimpleIcon,
  twitter: siX as SimpleIcon,
  whatsapp: siWhatsapp as SimpleIcon,
  ios: siApple as SimpleIcon,
  android: siAndroid as SimpleIcon,
  reactnative: siReact as SimpleIcon,
};

export function BrandIcon({ id, size = 36 }: { id: string; size?: number }) {
  const simple = SIMPLE[id];
  const custom = CUSTOM[id];

  const hex = simple?.hex ?? custom?.hex ?? '64748B';
  const tile = `#${hex}`;

  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center rounded-xl shadow-[0_1px_2px_rgba(0,0,0,0.06)] ring-1 ring-black/5 dark:ring-white/10"
      style={{
        width: size,
        height: size,
        backgroundColor: `${tile}14`, // ~8% tint behind the glyph
      }}
      aria-hidden
    >
      <svg
        viewBox="0 0 24 24"
        width={size * 0.55}
        height={size * 0.55}
        fill={tile}
        role="img"
      >
        {simple ? <path d={simple.path} /> : custom?.svg}
      </svg>
    </span>
  );
}

export default BrandIcon;