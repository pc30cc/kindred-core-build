import {
  Shield, Mail, Bot, HardDrive, Radio, Search,
  Bell, Database, Flag, MessageSquare, CreditCard,
  ShieldAlert, Globe, Layers, Smartphone, MapPin, Map,
} from 'lucide-react';

const ICONS: Record<string, typeof Shield> = {
  Shield, Mail, Bot, HardDrive, Radio, Search,
  Bell, Database, Flag, MessageSquare, CreditCard,
  ShieldAlert, Globe, Layers, Smartphone, MapPin, Map,
};

export function ProviderIcon({ iconName, className }: { iconName: string; className?: string }) {
  const Icon = ICONS[iconName] ?? Shield;
  return <Icon className={className} />;
}
