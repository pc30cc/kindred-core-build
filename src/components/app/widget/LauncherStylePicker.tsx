/**
 * Widget → Appearance → the chat button's style (issue #340; WebYar board 11
 * «دکمه شناور», RESPOK board 10 "Chat button"): the brand kit's button (in
 * the International edition its Open and Thread logos, when the worn
 * template reads the logo direction), the kit's square (Iranian edition),
 * the classic bubble, two bubbles, the support headset, the agent's face and
 * the pill with the launcher text inside. A tile sets the launcher's shape
 * and icon (shared/launcherStyles.ts); the other icons stay in the icon grid
 * below it. Each tile is drawn as the visitor will see it, on the
 * workspace's colour (the kit's own ground while the colour is the seeded
 * one).
 *
 * Under the plan capability widget_launcher_icon, like the icon choice: a
 * plan without it sees the tiles disabled, with the upgrade hint. The pill
 * also needs the launcher text (widget_launcher_label); the logo direction
 * is a template option (widget_appearance).
 */
import type { CSSProperties, ReactNode } from 'react';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { Check } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { cn } from '@/lib/utils';
import { SHIPS_INTL_KIT, SHIPS_IRAN_KIT } from '../../../../shared/buildBrand';
import { LOCAL_KIT_LAUNCHER_CHAT_GLYPH } from '../../../../shared/localKitLauncher';
import { RESPOK_LAUNCHER_CHAT_GLYPH, RESPOK_LAUNCHER_OPEN_GLYPH } from '../../../../shared/respokLauncher';
import {
  LAUNCHER_AVATAR, LAUNCHER_GLYPHS, launcherChoiceOf, launcherTileOf,
  type LauncherStyleChoice, type LauncherTile, type LogoDirection,
} from '../../../../shared/launcherStyles';
import { FAB_ICONS } from './WidgetLivePreview';

export interface LauncherStylePickerProps {
  /** The draft's fab_shape / fab_icon / fab_label. */
  shape: string | null | undefined;
  icon: string | null | undefined;
  label: string | null | undefined;
  /** The workspace's colour and icon colour (the tiles are drawn on them). */
  primaryColor: string | null | undefined;
  iconColor?: string | null;
  /** The agent face's letter as the visitor will see it. */
  initial: string;
  international: boolean;
  /** The worn template's logo direction when it reads one (t1-intl / t2-intl), else null. */
  logoDirection: LogoDirection | null;
  /** widget_launcher_icon */
  allowed: boolean;
  /** widget_launcher_label (the pill's text) */
  labelAllowed: boolean;
  /** widget_appearance (the logo direction is a template option) */
  logoAllowed: boolean;
  onChoose: (choice: LauncherStyleChoice) => void;
}

/** The platform's seeded colour: never a choice, so the kit's own ground shows. */
const UNCUSTOMISED = '#3b82f6';

function Glyph({ html, className, style }: { html: string; className: string; style?: CSSProperties }) {
  // The kits' glyph strings (the loader's own, byte for byte).
  return <span aria-hidden className={className} style={style} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function LauncherStylePicker(props: LauncherStylePickerProps) {
  const { t } = useTranslation();
  const {
    shape, icon, label, primaryColor, iconColor, initial, international, logoDirection,
    allowed, labelAllowed, logoAllowed, onChoose,
  } = props;
  const colour = String(primaryColor || '').trim();
  const brandColour = !colour || colour.toLowerCase() === UNCUSTOMISED;
  // The edition's kit, when this build ships it (the RESPOK build has no
  // Iranian kit, the Iranian build no RESPOK one: a plain bubble then).
  const iranKit = SHIPS_IRAN_KIT && !international;
  const respokKit = SHIPS_INTL_KIT && international;
  const ground = brandColour
    ? (iranKit ? 'linear-gradient(140deg,#22D3B4,#0B7D6C)' : respokKit ? '#16142B' : colour || '#3B82F6')
    : colour;
  const ink = iconColor || '#ffffff';
  // The kits' second colour: the bubble's dots / the answer pill.
  const accent = brandColour ? (iranKit ? '#18AD94' : '#FF5A3C') : colour;
  const selected = launcherTileOf(shape, icon, international && logoDirection ? logoDirection : null);
  const pillText = (label || '').trim() || t('widgetPage.appearance.launcherPillDefault');

  const strokeIcon = (key: string) => (
    <svg viewBox="0 0 24 24" className="h-[46%] w-[46%]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden dangerouslySetInnerHTML={{ __html: FAB_ICONS[key] }} />
  );
  const kitGlyph = (direction: LogoDirection = 'thread') => {
    if (iranKit) {
      return <Glyph html={LOCAL_KIT_LAUNCHER_CHAT_GLYPH} className="flex h-full w-full [&_.lk-kit-body]:fill-current [&_.lk-kit-dot]:fill-[var(--lk-dot)] [&_svg]:h-full [&_svg]:w-full" style={{ ['--lk-dot' as string]: accent }} />;
    }
    if (respokKit) {
      return (
        <Glyph
          html={direction === 'open' ? RESPOK_LAUNCHER_OPEN_GLYPH : RESPOK_LAUNCHER_CHAT_GLYPH}
          className="flex h-full w-full items-center justify-center [&_.rpk-kit-a]:fill-[var(--rpk-a)] [&_.rpk-kit-q]:fill-current [&_svg.rpk-kit-o]:h-[47%] [&_svg.rpk-kit-o]:w-[47%] [&_svg]:h-[44%] [&_svg]:w-1/2"
          style={{ ['--rpk-a' as string]: brandColour ? accent : ink }}
        />
      );
    }
    return strokeIcon('chat');
  };
  const bubbleGlyph = (
    <svg viewBox="0 0 24 24" className="h-[60%] w-[60%]" aria-hidden>
      <path fill="currentColor" fillRule="evenodd" d={LAUNCHER_GLYPHS.bubble} />
    </svg>
  );
  const duoGlyph = (
    <svg viewBox="0 0 24 24" className="h-[60%] w-[60%]" aria-hidden>
      <path d={LAUNCHER_GLYPHS.duoBack} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" opacity={0.75} />
      <path d={LAUNCHER_GLYPHS.duoFront} fill="currentColor" />
    </svg>
  );
  const iconGlyph = (key: string | null | undefined) => {
    switch (key) {
      case 'bubble': return bubbleGlyph;
      case 'duo': return duoGlyph;
      case 'headset': return strokeIcon('headset');
      case 'avatar':
        return (
          <span className="flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold leading-none" style={{ background: LAUNCHER_AVATAR.disc, color: LAUNCHER_AVATAR.ink }}>
            {initial || '·'}
          </span>
        );
      case 'chat':
      case null:
      case undefined:
      case '':
        return kitGlyph(logoDirection || 'thread');
      default:
        return Object.prototype.hasOwnProperty.call(FAB_ICONS, key) ? strokeIcon(key) : kitGlyph(logoDirection || 'thread');
    }
  };

  /** A launcher as the visitor sees it, smaller (48px for the boards' 60). */
  const button = (content: ReactNode, opts: { square?: boolean; pill?: boolean } = {}) => (
    <span
      aria-hidden
      className={cn(
        'relative flex shrink-0 items-center justify-center shadow-md',
        opts.pill ? 'h-12 gap-1 rounded-full pe-4 ps-1 text-[13px] font-semibold' : 'h-12 w-12',
        !opts.pill && (opts.square ? 'rounded-[14px]' : 'rounded-full'),
      )}
      style={{ background: ground, color: ink }}
    >
      {content}
    </span>
  );
  const avatarFace = (
    <>
      <span className="flex h-10 w-10 items-center justify-center rounded-full text-lg font-bold leading-none" style={{ background: LAUNCHER_AVATAR.disc, color: LAUNCHER_AVATAR.ink }}>
        {initial || '·'}
      </span>
      {/* Online: green, or RESPOK's Signal on its own ground (runtime-fab.css). */}
      <span className="absolute bottom-0 end-0 h-3 w-3 rounded-full border-2 border-white" style={{ background: respokKit && brandColour ? accent : LAUNCHER_AVATAR.online }} />
    </>
  );

  const tiles: Array<{ id: LauncherTile; name: TranslationKey; sub: TranslationKey; art: ReactNode; wide?: boolean; locked?: boolean }> = [
    ...(international && logoDirection
      ? [
        { id: 'open' as const, name: 'widgetPage.appearance.launcherStyleOpen' as const, sub: 'widgetPage.appearance.launcherStyleOpenSub' as const, art: button(kitGlyph('open')), locked: !logoAllowed },
        { id: 'thread' as const, name: 'widgetPage.appearance.launcherStyleThread' as const, sub: 'widgetPage.appearance.launcherStyleThreadSub' as const, art: button(kitGlyph('thread')), locked: !logoAllowed },
      ]
      : [{ id: 'kit' as const, name: 'widgetPage.appearance.launcherStyleKit' as const, sub: 'widgetPage.appearance.launcherStyleKitSub' as const, art: button(kitGlyph()) }]),
    // The kit's square (18px) is the Iranian kit's (board 10 has none).
    ...(iranKit ? [{ id: 'square' as const, name: 'widgetPage.appearance.launcherStyleSquare' as const, sub: 'widgetPage.appearance.launcherStyleSquareSub' as const, art: button(kitGlyph(), { square: true }) }] : []),
    { id: 'bubble', name: 'widgetPage.appearance.launcherStyleBubble', sub: 'widgetPage.appearance.launcherStyleBubbleSub', art: button(bubbleGlyph) },
    { id: 'duo', name: 'widgetPage.appearance.launcherStyleDuo', sub: 'widgetPage.appearance.launcherStyleDuoSub', art: button(duoGlyph) },
    { id: 'headset', name: 'widgetPage.appearance.launcherStyleHeadset', sub: 'widgetPage.appearance.launcherStyleHeadsetSub', art: button(strokeIcon('headset')) },
    { id: 'avatar', name: 'widgetPage.appearance.launcherStyleAvatar', sub: 'widgetPage.appearance.launcherStyleAvatarSub', art: button(avatarFace) },
    {
      id: 'pill', name: 'widgetPage.appearance.launcherStylePill', sub: 'widgetPage.appearance.launcherStylePillSub', wide: true, locked: !labelAllowed,
      art: button(<><span className="flex h-10 w-10 shrink-0 items-center justify-center">{iconGlyph(icon)}</span><span className="max-w-[11rem] truncate">{pillText}</span></>, { pill: true }),
    },
  ];

  return (
    <div className="space-y-2" data-launcher-styles>
      <p className="text-xs font-medium">{t('widgetPage.appearance.launcherStyle')}</p>
      <RadioGroupPrimitive.Root
        aria-label={t('widgetPage.appearance.launcherStyle')}
        value={selected ?? ''}
        disabled={!allowed}
        onValueChange={(v) => onChoose(launcherChoiceOf(v as LauncherTile, label, t('widgetPage.appearance.launcherPillDefault')))}
        className={cn('grid grid-cols-2 gap-2 sm:grid-cols-4', !allowed && 'opacity-50')}
      >
        {tiles.map((tile) => (
          <RadioGroupPrimitive.Item
            key={tile.id}
            value={tile.id}
            disabled={!allowed || tile.locked}
            data-launcher-style={tile.id}
            className={cn(
              'relative flex flex-col items-center gap-2 rounded-xl border bg-background px-2 pb-2.5 pt-3 text-center transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              'disabled:cursor-not-allowed disabled:opacity-60',
              tile.wide && 'col-span-2',
              selected === tile.id ? 'border-foreground ring-1 ring-foreground' : 'border-border/70 hover:border-foreground/25',
            )}
          >
            {selected === tile.id && (
              <span className="absolute start-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-background">
                <Check className="h-2.5 w-2.5" strokeWidth={3} aria-hidden />
              </span>
            )}
            {tile.art}
            <span className="flex flex-col leading-tight">
              <span className="text-xs font-medium">{t(tile.name)}</span>
              <span className="text-[10px] text-muted-foreground">{t(tile.sub)}</span>
            </span>
          </RadioGroupPrimitive.Item>
        ))}
      </RadioGroupPrimitive.Root>
      {!allowed && <p className="text-[11px] text-primary">{t('plan.locked.upgradeHint')}</p>}
      {allowed && !labelAllowed && <p className="text-[11px] text-muted-foreground">{t('widgetPage.appearance.launcherStylePillLocked')}</p>}
    </div>
  );
}
