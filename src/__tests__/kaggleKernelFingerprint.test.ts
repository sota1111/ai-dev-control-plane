import {
  computeKernelFingerprint,
  extractNotebookCodeSource,
  isKernelFingerprint,
  KERNEL_FINGERPRINT_PREFIX,
} from '../lib/kaggleKernelFingerprint.js';

// SOT-2517: the fingerprint is the identity of the EXECUTED computation (notebook code cells + pinned
// dataset sources + kernel version), never the visible submission.csv. These tests pin the three
// invariants the dedup fix depends on: a code change flips the fingerprint, a markdown/outputs-only
// change does not, and adding a pinned dataset flips it.

const notebook = (cells: Array<{ cell_type: string; source: string | string[]; outputs?: unknown }>) => ({
  cells,
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
});

describe('computeKernelFingerprint', () => {
  test('emits the kernel:sha256: prefix so it is distinguishable from the legacy artifact hash', () => {
    const fp = computeKernelFingerprint({ codeSource: 'print(1)' });
    expect(fp.startsWith(KERNEL_FINGERPRINT_PREFIX)).toBe(true);
    expect(fp).toMatch(/^kernel:sha256:[0-9a-f]{64}$/);
    expect(isKernelFingerprint(fp)).toBe(true);
    expect(isKernelFingerprint('sha256:' + 'a'.repeat(64))).toBe(false);
  });

  test('a code-cell change produces a DIFFERENT fingerprint', () => {
    const base = notebook([{ cell_type: 'code', source: 'x = 1\n' }]);
    const changed = notebook([{ cell_type: 'code', source: 'x = 2\n' }]);
    expect(computeKernelFingerprint({ notebookJson: base })).not.toEqual(
      computeKernelFingerprint({ notebookJson: changed })
    );
  });

  test('markdown-only and outputs/execution_count-only changes keep the SAME fingerprint', () => {
    const base = notebook([
      { cell_type: 'markdown', source: '# title\n' },
      { cell_type: 'code', source: 'model.fit()\n', outputs: [{ text: 'old output' }] },
    ]);
    const cosmetic = notebook([
      { cell_type: 'markdown', source: '# a completely different title\n' },
      {
        cell_type: 'code',
        source: 'model.fit()\n',
        outputs: [{ text: 'a different visible output' }],
      },
    ]);
    // execution_count / outputs live outside `source`; markdown cells are excluded entirely.
    (cosmetic.cells[1] as Record<string, unknown>).execution_count = 42;
    expect(computeKernelFingerprint({ notebookJson: base })).toEqual(
      computeKernelFingerprint({ notebookJson: cosmetic })
    );
  });

  test('trailing-whitespace / CRLF-only re-saves keep the SAME fingerprint', () => {
    const base = notebook([{ cell_type: 'code', source: 'a = 1\nb = 2\n' }]);
    const resaved = notebook([{ cell_type: 'code', source: 'a = 1  \r\nb = 2\t\r\n' }]);
    expect(computeKernelFingerprint({ notebookJson: base })).toEqual(
      computeKernelFingerprint({ notebookJson: resaved })
    );
  });

  test('adding a pinned dataset source produces a DIFFERENT fingerprint', () => {
    const code = 'run()';
    expect(computeKernelFingerprint({ codeSource: code, datasetSources: ['u/a'] })).not.toEqual(
      computeKernelFingerprint({ codeSource: code, datasetSources: ['u/a', 'u/b'] })
    );
  });

  test('dataset source order and duplicates do not affect the fingerprint', () => {
    const code = 'run()';
    expect(
      computeKernelFingerprint({ codeSource: code, datasetSources: ['u/b', 'u/a', ' u/a '] })
    ).toEqual(computeKernelFingerprint({ codeSource: code, datasetSources: ['u/a', 'u/b'] }));
  });

  test('a kernel version bump produces a DIFFERENT fingerprint', () => {
    const code = 'run()';
    expect(computeKernelFingerprint({ codeSource: code, version: 3 })).not.toEqual(
      computeKernelFingerprint({ codeSource: code, version: 4 })
    );
  });

  test('array-of-lines and single-string cell sources are normalized identically', () => {
    const asArray = notebook([{ cell_type: 'code', source: ['import x\n', 'x.run()\n'] }]);
    const asString = notebook([{ cell_type: 'code', source: 'import x\nx.run()\n' }]);
    expect(computeKernelFingerprint({ notebookJson: asArray })).toEqual(
      computeKernelFingerprint({ notebookJson: asString })
    );
  });
});

describe('extractNotebookCodeSource', () => {
  test('keeps only code cells, in order, and drops markdown/raw', () => {
    const src = extractNotebookCodeSource(
      notebook([
        { cell_type: 'markdown', source: '# ignore me\n' },
        { cell_type: 'code', source: 'first()\n' },
        { cell_type: 'raw', source: 'also ignored' },
        { cell_type: 'code', source: 'second()\n' },
      ])
    );
    expect(src).toContain('first()');
    expect(src).toContain('second()');
    expect(src).not.toContain('ignore me');
    expect(src.indexOf('first()')).toBeLessThan(src.indexOf('second()'));
  });

  test('malformed notebook JSON yields an empty code source (no throw)', () => {
    expect(extractNotebookCodeSource(null)).toEqual('');
    expect(extractNotebookCodeSource({})).toEqual('');
    expect(extractNotebookCodeSource({ cells: 'not-an-array' })).toEqual('');
  });
});
