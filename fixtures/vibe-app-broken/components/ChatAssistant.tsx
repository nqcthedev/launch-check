'use client';

import { useState } from 'react';
import { openai } from '@/lib/openai';
import { parseAiResponse } from '@/lib/ai-parse';

export default function ChatAssistant({ todos }: { todos: any[] }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<any>(null);

  async function ask() {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You plan the user day. Reply as JSON: {"plan": string[]}' },
        { role: 'user', content: `My todos: ${JSON.stringify(todos)}. ${question}` },
      ],
    });
    const text = completion.choices[0].message.content;
    console.log('AI response', text);
    setAnswer(parseAiResponse(text));
  }

  return (
    <section>
      <h2>Assistant</h2>
      <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Plan my day" />
      <button onClick={ask}>Ask</button>
      {answer && (
        <ol>
          {answer.plan.map((step: string, i: number) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      )}
    </section>
  );
}
