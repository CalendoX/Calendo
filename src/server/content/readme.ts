import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The marketing copy on the landing page comes from the top of README.md, so the project's own
 * description is the single source of truth and a release only has to update one file. Just the
 * opening section is used — the title, the paragraph under it and the feature bullets that follow.
 * Everything below the first `---` is developer documentation (setup, credentials, API reference)
 * and never reaches the public page.
 */
export interface LandingCopy {
  /** The README's H1 without the product name: "Interview scheduling for hiring teams". */
  headline: string;
  /** The paragraph under the H1. */
  intro: string;
  features: { title: string; body: string }[];
}

/** Used when README.md is missing or unreadable, so the homepage still renders. */
const FALLBACK: LandingCopy = {
  headline: 'Interview scheduling for hiring teams',
  intro:
    'Share one link. Candidates pick a time that works, and Calendo handles the Zoom meeting, the calendar event and every follow-up email.',
  features: [],
};

/**
 * The README sits next to next.config.ts, and `outputFileTracingIncludes` copies it next to the
 * standalone server, which runs from `.next/standalone`. Both paths are written out literally:
 * a computed path would defeat Turbopack's tracing and pull the entire project into the build.
 */
function readReadme(): string {
  try {
    return readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
  } catch {
    return readFileSync(path.join(process.cwd(), '..', '..', 'README.md'), 'utf8');
  }
}

/** A README bullet reads as a continuation of its heading; on its own in a card it needs a capital. */
const sentence = (body: string) => (/^[a-z]/.test(body) ? body[0].toUpperCase() + body.slice(1) : body);

/** `- **Title**: body`, where the body may wrap onto indented continuation lines. */
function parseFeatures(lines: string[]) {
  const features: { title: string; body: string }[] = [];
  for (const line of lines) {
    const bullet = /^-\s+\*\*(.+?)\*\*[:—-]?\s*(.*)$/.exec(line);
    if (bullet) features.push({ title: bullet[1].trim(), body: sentence(bullet[2].trim()) });
    else if (features.length && /^\s+\S/.test(line)) features[features.length - 1].body += ` ${line.trim()}`;
    else if (!line.trim()) continue;
    else if (features.length) break;
  }
  return features;
}

export function parseReadme(markdown: string): LandingCopy {
  // Only the opening section: the rest of the README is developer documentation.
  const opening = markdown.split(/^---\s*$/m)[0].split(/\r?\n/);
  const titleLine = opening.find((l) => l.startsWith('# '));
  // "Calendo — interview scheduling for hiring teams" → the half that describes the product.
  const title = titleLine?.slice(2).trim() ?? '';
  const described = title.split(/\s+[—–-]\s+/)[1] ?? title;
  const headline = described ? described[0].toUpperCase() + described.slice(1) : FALLBACK.headline;

  const afterTitle = opening.slice(titleLine ? opening.indexOf(titleLine) + 1 : 0);
  const introStart = afterTitle.findIndex((l) => l.trim() && !l.startsWith('#'));
  const introLines: string[] = [];
  for (const line of introStart === -1 ? [] : afterTitle.slice(introStart)) {
    if (!line.trim() || line.startsWith('-')) break;
    introLines.push(line.trim());
  }

  const features = parseFeatures(afterTitle.slice(introStart === -1 ? 0 : introStart + introLines.length));
  return {
    headline,
    intro: introLines.join(' ') || FALLBACK.intro,
    features: features.length ? features : FALLBACK.features,
  };
}

let cached: LandingCopy | null = null;

/**
 * Read once per server process: the file only changes when the project is rebuilt and deployed,
 * so there is no reason to touch the disk on every visit to the homepage.
 */
export function landingCopy(): LandingCopy {
  if (cached) return cached;
  try {
    cached = parseReadme(readReadme());
  } catch {
    console.warn('[content] README.md could not be read; the landing page is using its built-in copy.');
    cached = FALLBACK;
  }
  return cached;
}
