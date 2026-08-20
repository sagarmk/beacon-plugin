import { describe, it, expect } from 'vitest';
import { extractDefinitions, extractReferences, languageOf } from '../scripts/lib/symbols.js';

describe('symbol extraction', () => {
  describe('languageOf', () => {
    it('maps known extensions', () => {
      expect(languageOf('a/b/c.js')).toBe('js');
      expect(languageOf('x.tsx')).toBe('js');
      expect(languageOf('x.py')).toBe('py');
      expect(languageOf('x.rs')).toBe('rs');
    });
    it('returns null for prose and unknown types', () => {
      expect(languageOf('README.md')).toBe(null);
      expect(languageOf('data.csv')).toBe(null);
      expect(languageOf('noextension')).toBe(null);
    });
  });

  describe('definitions', () => {
    it('finds javascript functions, classes and arrow consts', () => {
      const src = [
        'export function alpha(a) { return a; }',
        'async function beta() {}',
        'export class Gamma {}',
        'const delta = (x) => x * 2;',
        'export const epsilon = async () => {};',
      ].join('\n');
      const names = extractDefinitions(src, 'f.js').map(d => d.name);
      expect(names).toEqual(expect.arrayContaining(['alpha', 'beta', 'Gamma', 'delta', 'epsilon']));
    });

    it('reports 1-based line numbers', () => {
      const src = '\n\nfunction onLineThree() {}\n';
      const [def] = extractDefinitions(src, 'f.js');
      expect(def.line).toBe(3);
    });

    it('finds python defs and classes', () => {
      const src = 'class Widget:\n    def process(self):\n        pass\n\nasync def fetch_all():\n    pass\n';
      const names = extractDefinitions(src, 'f.py').map(d => d.name);
      expect(names).toEqual(expect.arrayContaining(['Widget', 'process', 'fetch_all']));
    });

    it('finds go and rust declarations', () => {
      expect(extractDefinitions('func Handle(w http.ResponseWriter) {}', 'f.go').map(d => d.name)).toContain('Handle');
      expect(extractDefinitions('pub fn parse_input(s: &str) {}', 'f.rs').map(d => d.name)).toContain('parse_input');
      expect(extractDefinitions('pub struct Config {}', 'f.rs').map(d => d.name)).toContain('Config');
    });

    it('returns nothing for files with no known language', () => {
      expect(extractDefinitions('# Heading\n\nfunction words here', 'notes.md')).toEqual([]);
    });

    it('ignores language keywords that look like names', () => {
      const names = extractDefinitions('if (x) {\n}\nfor (;;) {\n}\n', 'f.js').map(d => d.name);
      expect(names).not.toContain('if');
      expect(names).not.toContain('for');
    });
  });

  describe('references', () => {
    it('captures called functions', () => {
      const refs = extractReferences('function a() { helperOne(); helperTwo(1, 2); }', 'f.js', ['a']);
      expect(refs).toEqual(expect.arrayContaining(['helperOne', 'helperTwo']));
    });

    it('excludes the file\'s own definitions so a file never links to itself', () => {
      const src = 'function mine() { mine(); other(); }';
      const refs = extractReferences(src, 'f.js', ['mine']);
      expect(refs).not.toContain('mine');
      expect(refs).toContain('other');
    });

    it('captures named imports even when never called', () => {
      const refs = extractReferences("import { alpha, beta as renamed } from './x.js';", 'f.js', []);
      expect(refs).toEqual(expect.arrayContaining(['alpha', 'beta']));
    });

    it('does not treat words inside strings or comments as references', () => {
      const src = [
        '// callFromComment() should not count',
        'const msg = "callFromString() should not count";',
        'realCall();',
      ].join('\n');
      const refs = extractReferences(src, 'f.js', []);
      expect(refs).toContain('realCall');
      expect(refs).not.toContain('callFromComment');
      expect(refs).not.toContain('callFromString');
    });

    it('skips language keywords that are syntactically calls', () => {
      const refs = extractReferences('if (a) { while (b) { switch (c) {} } }', 'f.js', []);
      expect(refs).not.toContain('if');
      expect(refs).not.toContain('while');
      expect(refs).not.toContain('switch');
    });
  });
});
