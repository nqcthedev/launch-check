'use client';

import { useState } from 'react';

export default function UpgradeButton() {
  const [pending, setPending] = useState(false);

  async function upgrade() {
    setPending(true);
    // Checkout sessions are created server-side with the secret key; the client only gets a URL.
    const res = await fetch('/api/checkout', { method: 'POST' });
    const data = (await res.json()) as { url?: string };
    if (res.ok && data.url) window.location.assign(data.url);
    else setPending(false);
  }

  return (
    <button onClick={upgrade} disabled={pending}>
      {pending ? 'Redirecting…' : 'Upgrade to Pro'}
    </button>
  );
}
