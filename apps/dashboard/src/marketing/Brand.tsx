import { MessageCircleMore } from 'lucide-react';

interface BrandProps {
  inverse?: boolean;
}

export function Brand({ inverse = false }: BrandProps) {
  return (
    <a className={`marketing-brand${inverse ? ' marketing-brand-inverse' : ''}`} href="/" aria-label="InboxPlease home">
      <span className="marketing-brand-mark" aria-hidden="true">
        <MessageCircleMore size={19} strokeWidth={2.35} />
        <i />
      </span>
      <span>Inbox<span>Please</span></span>
    </a>
  );
}
