import { describe, it, expect } from 'vitest';
import { personalizedPageRank, buildFileGraph } from '../scripts/lib/graph.js';

const edgesFrom = (obj) => new Map(
  Object.entries(obj).map(([from, tos]) => [from, new Map(Object.entries(tos))])
);

describe('buildFileGraph', () => {
  it('links a referencing file to the file defining the name', () => {
    const refs = new Map([['caller.js', new Set(['doThing'])]]);
    const defs = new Map([['doThing', ['impl.js']]]);
    const g = buildFileGraph(refs, defs, 'raw');
    expect(g.get('caller.js').get('impl.js')).toBe(1);
  });

  it('splits weight across ambiguous names so a common name is weak evidence', () => {
    const refs = new Map([['caller.js', new Set(['parse'])]]);
    const defs = new Map([['parse', ['a.js', 'b.js']]]);
    const g = buildFileGraph(refs, defs, 'raw');
    expect(g.get('caller.js').get('a.js')).toBe(0.5);
    expect(g.get('caller.js').get('b.js')).toBe(0.5);
  });

  it('never creates a self-edge', () => {
    const refs = new Map([['same.js', new Set(['fn'])]]);
    const defs = new Map([['fn', ['same.js']]]);
    expect(buildFileGraph(refs, defs, 'raw').size).toBe(0);
  });

  it('ignores references nothing defines', () => {
    const refs = new Map([['caller.js', new Set(['console', 'JSON'])]]);
    const g = buildFileGraph(refs, new Map(), 'raw');
    expect(g.size).toBe(0);
  });

  it('binary damping flattens edge magnitude but keeps direction', () => {
    const refs = new Map([['caller.js', new Set(['a', 'b', 'c'])]]);
    const defs = new Map([['a', ['t.js']], ['b', ['t.js']], ['c', ['t.js']]]);
    expect(buildFileGraph(refs, defs, 'raw').get('caller.js').get('t.js')).toBe(3);
    expect(buildFileGraph(refs, defs, 'binary').get('caller.js').get('t.js')).toBe(1);
  });
});

describe('personalizedPageRank', () => {
  it('returns nothing without seeds', () => {
    expect(personalizedPageRank(edgesFrom({ a: { b: 1 } }), new Map()).size).toBe(0);
  });

  it('gives rank to a file the seed points at', () => {
    const g = edgesFrom({ seed: { target: 1 } });
    const r = personalizedPageRank(g, new Map([['seed', 1]]));
    expect(r.get('target')).toBeGreaterThan(0);
  });

  it('is personalized: an unconnected component gets no mass', () => {
    const g = edgesFrom({ seed: { near: 1 }, far: { alsoFar: 1 } });
    const r = personalizedPageRank(g, new Map([['seed', 1]]));
    expect(r.get('near')).toBeGreaterThan(0);
    expect(r.get('alsoFar') ?? 0).toBe(0);
  });

  it('ranks a closer file above a more distant one', () => {
    const g = edgesFrom({ seed: { one: 1 }, one: { two: 1 }, two: { three: 1 } });
    const r = personalizedPageRank(g, new Map([['seed', 1]]));
    expect(r.get('one')).toBeGreaterThan(r.get('two'));
    expect(r.get('two')).toBeGreaterThan(r.get('three'));
  });

  it('max-normalises output into 0..1', () => {
    const g = edgesFrom({ seed: { a: 1, b: 2 } });
    const r = personalizedPageRank(g, new Map([['seed', 1]]));
    for (const v of r.values()) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...r.values())).toBeCloseTo(1, 10);
  });

  it('weights seeds by their score', () => {
    const g = edgesFrom({ strong: { hitA: 1 }, weak: { hitB: 1 } });
    const r = personalizedPageRank(g, new Map([['strong', 10], ['weak', 1]]));
    expect(r.get('hitA')).toBeGreaterThan(r.get('hitB'));
  });

  it('does not lose rank mass through dangling nodes', () => {
    // `leaf` has no outgoing edges; without redistribution its mass vanishes
    // and every score decays toward zero across iterations.
    const g = edgesFrom({ seed: { leaf: 1 } });
    const r = personalizedPageRank(g, new Map([['seed', 1]]));
    expect(r.get('seed')).toBeGreaterThan(0);
    expect(r.get('leaf')).toBeGreaterThan(0);
  });

  it('terminates on a cycle', () => {
    const g = edgesFrom({ a: { b: 1 }, b: { c: 1 }, c: { a: 1 } });
    const r = personalizedPageRank(g, new Map([['a', 1]]));
    expect(r.size).toBe(3);
    for (const v of r.values()) expect(Number.isFinite(v)).toBe(true);
  });
});
