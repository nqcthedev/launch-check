'use client';

import { createCheckout } from '@/lib/stripe';

export default function UpgradeButton({ userId }: { userId: string }) {
  async function upgrade() {
    const url = await createCheckout(userId);
    window.location.href = url;
  }
  return <button onClick={upgrade}>Upgrade to Pro</button>;
}
