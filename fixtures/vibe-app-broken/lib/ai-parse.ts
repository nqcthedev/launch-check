// The model sometimes returns JSON with trailing commas or single quotes,
// so JSON.parse fails. eval handles it.
export function parseAiResponse(text: string): any {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  return eval('(' + match[0] + ')');
}
