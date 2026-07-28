import fs from 'node:fs';
import path from 'node:path';

describe('solo role lifecycle safeguards (SOT-2127)', () => {
  const prompt = fs.readFileSync(path.join(process.cwd(), 'prompts/roles/solo.md'), 'utf8');

  test('decomposition-only runs keep implementation children out of Done', () => {
    expect(prompt).toContain('newly-created implementation children remain `Todo`');
    expect(prompt).toContain('Never mark a child `Done`/completed during a decomposition-only run');
    expect(prompt).toContain('Only a later run that actually implements the child');
  });

  test('PR completion requires explicit acceptance evidence', () => {
    expect(prompt).toContain('incomplete unless the final report contains `## Acceptance: PASS`');
    expect(prompt).toContain('A PR URL or');
    expect(prompt).toContain('alone is not evidence');
  });

  test('implemented work requires a Linear completion comment', () => {
    expect(prompt).toContain('ALWAYS post a');
    expect(prompt).toContain('`## Completion Report` comment');
    expect(prompt).toContain('Only after the Linear comment succeeds');
    expect(prompt).toContain('`## Linear Report: POSTED`');
  });
});
