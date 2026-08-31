/**
 * Phase 2 — Operator-facing AI suggestion card.
 *
 * Renders the most recent pending ai_agent_suggestions row for the open
 * conversation. Three actions:
 *   • Insert into composer  → fills operator reply box (does not send).
 *   • Send now              → calls the operator's normal send flow.
 *   • Dismiss               → marks the suggestion dismissed.
 *
 * Visitor never sees this card. The "Send now" path delivers the text as
 * a regular operator message — not as an AI message.
 */
import { Sparkles, Send, X, ChevronDown, ChevronUp, ArrowDownToLine, Clock, CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
