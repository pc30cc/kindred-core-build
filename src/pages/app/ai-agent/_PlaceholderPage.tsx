import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { LucideIcon } from 'lucide-react';

interface Props {
  icon: LucideIcon;
  title: string;
  description: string;
  bullets?: string[];
}

export default function PlaceholderPage({ icon: Icon, title, description, bullets }: Props) {
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            <Icon className="h-5 w-5 text-primary" /> {title}
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">{description}</p>
        </div>
        <Badge variant="outline" className="shrink-0">Coming in Phase 2</Badge>
      </div>
      <Card>
        <CardContent className="p-8 text-center space-y-4">
          <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 text-primary flex items-center justify-center">
            <Icon className="h-7 w-7" />
          </div>
          <h2 className="text-lg font-medium">Not available yet</h2>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            This section is part of the AI Agent roadmap and will be enabled in Phase 2,
            after the foundation (Settings, Activation, Playground) is verified in production.
          </p>
          {bullets && bullets.length > 0 && (
            <ul className="text-sm text-muted-foreground text-left max-w-md mx-auto list-disc pl-5 space-y-1">
              {bullets.map((b) => <li key={b}>{b}</li>)}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}