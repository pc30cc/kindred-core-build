import { ContactAvatar } from '@/components/inbox/ContactAvatar';
export default function AvatarProbe() {
  return (
    <div className="p-6 space-y-3 bg-card">
      {['Ali Reza', 'Sara', null].map((n, i) => (
        <div key={i} className="flex items-start gap-3">
          <div className="relative shrink-0">
            <ContactAvatar name={n} email={n ? null : 'x@y.z'} size="lg" />
          </div>
          <div className="text-sm">{n || 'no name'}</div>
        </div>
      ))}
    </div>
  );
}
