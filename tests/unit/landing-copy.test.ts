import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseReadme } from '@/server/content/readme';

const README = readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');

describe('landing copy from README.md', () => {
  it('takes the headline, intro and features from the opening section', () => {
    const copy = parseReadme(README);
    expect(copy.headline).toBe('Interview scheduling for hiring teams');
    expect(copy.intro).toMatch(/^Calendo is a /);
    expect(copy.intro).not.toMatch(/\n/);
    expect(copy.features.map((f) => f.title)).toContain('Double-booking prevention');
    expect(copy.features.length).toBeGreaterThanOrEqual(5);
  });

  it('never reaches the developer documentation below the first rule', () => {
    const copy = parseReadme(README);
    const text = [copy.headline, copy.intro, ...copy.features.flatMap((f) => [f.title, f.body])].join(' ');
    // The setup section lists seeded passwords and shell commands; none of it is marketing copy.
    expect(text).not.toMatch(/Slate2026|npm run|docker compose|SESSION_SECRET/);
    expect(copy.features.map((f) => f.title)).not.toContain('Candidate accounts');
  });

  it('joins wrapped bullet text and starts each feature with a capital', () => {
    const copy = parseReadme(`# Thing — does a job\n\nIt is a thing.\n\n- **First**: one line\n  continued here.\n- **Second**: two.\n\n---\n\n## Setup\n\n- **Ignored**: below the rule.\n`);
    expect(copy.headline).toBe('Does a job');
    expect(copy.intro).toBe('It is a thing.');
    expect(copy.features).toEqual([
      { title: 'First', body: 'One line continued here.' },
      { title: 'Second', body: 'Two.' },
    ]);
  });

  it('falls back to built-in copy when the README has nothing to show', () => {
    const copy = parseReadme('Just some text with no heading.');
    expect(copy.headline).toBe('Interview scheduling for hiring teams');
    expect(copy.features).toEqual([]);
  });
});
