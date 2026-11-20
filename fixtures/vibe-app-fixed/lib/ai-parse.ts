import { z } from 'zod';

export const DayPlan = z.object({
  plan: z.array(z.string().trim().min(1).max(300)).max(20),
});
export type DayPlan = z.infer<typeof DayPlan>;

/** Parse and validate the model's JSON. Model output is untrusted input: never eval it. */
export function parseDayPlan(text: string): DayPlan | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const result = DayPlan.safeParse(JSON.parse(match[0]));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
