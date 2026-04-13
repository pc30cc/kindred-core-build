import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { ArrowRight, MessageSquare, Eye, BookOpen, Bot, BarChart3, Globe } from 'lucide-react';

const features = [
  { icon: MessageSquare, titleKey: 'Live Chat & Inbox' },
  { icon: Eye, titleKey: 'Visitor Tracking' },
  { icon: BookOpen, titleKey: 'Knowledge Base' },
  { icon: Bot, titleKey: 'AI Assistance' },
  { icon: BarChart3, titleKey: 'Analytics' },
  { icon: Globe, titleKey: 'Multilingual' },
];

export default function HomePage() {
  const { t } = useTranslation();

  return (
    <div>
      {/* Hero */}
      <section className="py-20 md:py-32">
        <div className="container text-center">
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-foreground max-w-3xl mx-auto">
            {t('public.heroTitle')}
          </h1>
          <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto">
            {t('public.heroSubtitle')}
          </p>
          <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
            <Button size="lg" asChild>
              <Link to="/auth/signup">
                {t('public.getStarted')}
                <ArrowRight className="ms-2 h-4 w-4" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link to="/features">{t('public.learnMore')}</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* Features grid */}
      <section className="py-20 bg-surface-sunken">
        <div className="container">
          <h2 className="text-3xl font-bold text-center mb-12 text-foreground">
            {t('public.features')}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((f, i) => (
              <div key={i} className="bg-card rounded-lg border p-6 hover:shadow-md transition-shadow">
                <f.icon className="h-8 w-8 text-primary mb-4" />
                <h3 className="font-semibold text-card-foreground">{f.titleKey}</h3>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
