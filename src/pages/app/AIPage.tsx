import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useActiveProviderName } from '@/providers';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Bot, Cpu, Zap, Settings, MessageSquare, BookOpen } from 'lucide-react';

export default function AIPage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const activeProvider = useActiveProviderName('ai', workspace?.id);

  const features = [
    { icon: MessageSquare, title: 'Chat Auto-Reply', description: 'Automatically respond to visitor messages using AI', status: 'coming' },
    { icon: BookOpen, title: 'KB Article Suggestions', description: 'Suggest relevant knowledge base articles during chats', status: 'coming' },
    { icon: Zap, title: 'Smart Routing', description: 'Route conversations to the right team member with AI', status: 'coming' },
    { icon: Cpu, title: 'Sentiment Analysis', description: 'Detect visitor sentiment and prioritize urgent conversations', status: 'coming' },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="page-header">{t('ai.title')}</h1>
          <p className="page-subtitle mt-1">Configure AI provider, model settings, and prompt templates</p>
        </div>
        <Badge variant="outline" className="text-xs gap-1.5">
          <Bot className="h-3 w-3" />
          {activeProvider || 'Not configured'}
        </Badge>
      </div>

      {/* Status card */}
      <Card className="card-elevated border-primary/20">
        <CardContent className="p-6">
          <div className="flex items-center gap-4">
            <div className="p-3 rounded-xl bg-primary/10">
              <Bot className="h-8 w-8 text-primary" />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-foreground">AI Provider</h3>
              <p className="text-sm text-muted-foreground mt-0.5">
                {activeProvider
                  ? `Connected to ${activeProvider}. Configure models and behavior in Settings → Providers.`
                  : 'No AI provider configured yet. Go to Settings → Providers to connect one.'}
              </p>
            </div>
            <Badge className={activeProvider ? 'bg-success/10 text-success border-success/20' : 'bg-muted text-muted-foreground'}>
              {activeProvider ? 'Connected' : 'Not Connected'}
            </Badge>
          </div>
        </CardContent>
      </Card>

      {/* Feature grid */}
      <div>
        <h2 className="text-sm font-semibold text-foreground mb-3">AI Features</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {features.map(f => (
            <Card key={f.title} className="card-elevated">
              <CardContent className="p-5">
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-muted shrink-0">
                    <f.icon className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-foreground">{f.title}</h3>
                      <Badge variant="secondary" className="text-[10px] shrink-0">Coming Soon</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{f.description}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
