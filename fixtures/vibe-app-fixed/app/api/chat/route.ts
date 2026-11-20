import { NextResponse } from 'next/server';
import { z } from 'zod';
import { parseDayPlan } from '@/lib/ai-parse';
import { getOpenAI } from '@/lib/openai';
import { requireUser } from '@/lib/supabase/server';

const ChatInput = z.object({
  question: z.string().trim().min(1).max(1000),
  todos: z.array(z.string().max(200)).max(100),
});

export async function POST(req: Request) {
  const { user } = await requireUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = ChatInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  // Fixed model, capped output, and the client never chooses the system prompt.
  const completion = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 500,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'You plan the user day. Reply only with JSON: {"plan": string[]}' },
      { role: 'user', content: `My todos: ${JSON.stringify(parsed.data.todos)}. ${parsed.data.question}` },
    ],
  });

  const plan = parseDayPlan(completion.choices[0]?.message.content ?? '');
  if (!plan) return NextResponse.json({ error: 'The assistant returned an invalid plan' }, { status: 502 });
  return NextResponse.json(plan);
}
