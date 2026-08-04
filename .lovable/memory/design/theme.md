---
name: App theme
description: Cloud White palette + Sora/Manrope typography, radius 0.75rem, semantic tokens in src/index.css
type: design
---
Palette "Cloud White": background 210 25% 99%, primary 217 91% 60% (#3b82f6), border 214 28% 91%, muted-fg 215 18% 46%.
Typography: headings Sora (`--font-heading`, `font-display`), body Manrope (`--font-primary`). Farsi (RTL) uses Vazirmatn for both.
Radius 0.75rem, cards rounded-2xl, soft shadows (--shadow-card/glow/elevated), --gradient-surface / --gradient-sidebar / --gradient-auth-hero.
Admin scope keeps its own dark tokens (teal accent).
Navigation UX: collapsible sidebar (persisted in localStorage `sidebar_collapsed`) + global Command Palette (Cmd/Ctrl+K) mounted in AppLayout, triggered from top bar and sidebar search.
