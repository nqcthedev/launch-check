import { NextResponse } from 'next/server';
import { openai } from '@/lib/openai';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export async function OPTIONS() {
  return new NextResponse(null, { headers: corsHeaders });
}

export async function POST(req: Request) {
  const { messages } = await req.json();
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages,
  });
  return NextResponse.json(completion.choices[0].message, { headers: corsHeaders });
}
