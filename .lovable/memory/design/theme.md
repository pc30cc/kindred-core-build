---
name: App theme
description: Emerald Prestige palette + Sora/Manrope typography, radius 0.75rem, semantic tokens in src/index.css
type: design
---
Palette "Emerald Prestige": warm ivory canvas, deep emerald primary, gold accent (--gold / --gradient-gold), deep emerald sidebar rail.
Typography: headings Sora (`--font-heading`, `font-display`), body Manrope (`--font-primary`). Farsi (RTL) uses Vazirmatn for both.
Radius 0.75rem, cards rounded-2xl, soft shadows (--shadow-card/glow/elevated), --gradient-surface / --gradient-sidebar / --gradient-auth-hero.
Admin scope keeps its own dark tokens with emerald/gold accents.
Navigation UX: collapsible sidebar (persisted in localStorage `sidebar_collapsed`) + global Command Palette (Cmd/Ctrl+K) mounted in AppLayout, triggered from top bar and sidebar search.
