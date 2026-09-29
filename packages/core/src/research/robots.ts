/** A minimal robots.txt reader: groups by user agent, longest matching Allow/Disallow wins (RFC 9309). */
export interface Robots {
  allowed(path: string): boolean;
}

export const ALLOW_ALL: Robots = { allowed: () => true };

export function parseRobots(text: string, userAgent: string): Robots {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === 'allow' || field === 'disallow') && current) {
      if (value !== '' || field === 'allow') current.rules.push({ allow: field === 'allow', path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  const ua = userAgent.toLowerCase();
  const own = groups.filter((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const rules = (own.length > 0 ? own : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
  return {
    allowed(path: string) {
      let best: { allow: boolean; path: string } | null = null;
      for (const rule of rules) {
        if (!matches(rule.path, path)) continue;
        if (
          !best ||
          rule.path.length > best.path.length ||
          (rule.path.length === best.path.length && rule.allow)
        )
          best = rule;
      }
      return best ? best.allow : true;
    },
  };
}

function matches(pattern: string, path: string): boolean {
  if (pattern === '') return true;
  const regex = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
      .replace(/\\\$$/, '$')}`,
  );
  return regex.test(path);
}
