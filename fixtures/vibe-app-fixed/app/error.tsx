'use client';

import { useEffect } from 'react';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Replace with your error reporter (Sentry, Logtail, ...).
    console.error(error);
  }, [error]);

  return (
    <main style={{ maxWidth: 720, margin: '80px auto', padding: 24 }}>
      <h1>Something went wrong</h1>
      <p>The error has been logged. You can try again.</p>
      <button onClick={reset}>Try again</button>
    </main>
  );
}
