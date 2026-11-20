export interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
}

/** Parse an exact version or the lower bound of a simple range ("^14.1.0", "~15.0", ">=13"). */
export function parseVersion(input: string | undefined | null): Version | null {
  if (!input) return null;
  const m = /(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?/.exec(input);
  if (!m) return null;
  const num = (s: string | undefined) => (s === undefined || s === 'x' || s === '*' ? 0 : Number(s));
  return { major: num(m[1]), minor: num(m[2]), patch: num(m[3]), prerelease: m[4] ?? '' };
}

export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

export function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}${v.prerelease ? `-${v.prerelease}` : ''}`;
}

/** Is the declared range something other than a concrete version (e.g. "latest", "*", "next")? */
export function isUnpinnedRange(range: string): boolean {
  const r = range.trim();
  return r === '' || r === '*' || r === 'x' || /^(latest|next|canary|beta|rc)$/i.test(r) || /^>=?\s*\d/.test(r) && !/</.test(r);
}

/** Ranges like "workspace:*", "file:..", git urls — not checkable. */
export function isNonRegistryRange(range: string): boolean {
  return /^(workspace:|file:|link:|git\+|git:|github:|https?:|npm:)/.test(range.trim());
}
