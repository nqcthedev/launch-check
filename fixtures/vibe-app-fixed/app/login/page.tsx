'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sent' | 'error'>('idle');

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { error } = await createClient().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/dashboard` },
    });
    setStatus(error ? 'error' : 'sent');
  }

  return (
    <main style={{ maxWidth: 420, margin: '80px auto', padding: 24 }}>
      <h1>Sign in</h1>
      <form onSubmit={signIn}>
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        <button type="submit">Send magic link</button>
      </form>
      {status === 'sent' && <p>Check your inbox for the sign-in link.</p>}
      {status === 'error' && <p>Could not send the link. Try again.</p>}
    </main>
  );
}
