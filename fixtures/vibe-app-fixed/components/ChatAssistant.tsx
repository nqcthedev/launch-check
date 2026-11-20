'use client';

import { useState } from 'react';

export default function ChatAssistant({ todos }: { todos: string[] }) {
  const [question, setQuestion] = useState('');
  const [plan, setPlan] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    setError(null);
    // The OpenAI key stays on the server: the browser only talks to our own authenticated route.
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, todos }),
    });
    if (!res.ok) {
      setError('The assistant is unavailable right now.');
      return;
    }
    const data = (await res.json()) as { plan: string[] };
    setPlan(data.plan);
  }

  return (
    <section>
      <h2>Assistant</h2>
      <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Plan my day" maxLength={1000} />
      <button onClick={ask}>Ask</button>
      {error && <p role="alert">{error}</p>}
      {plan.length > 0 && (
        <ol>
          {plan.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      )}
    </section>
  );
}
