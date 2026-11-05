// fix/file-param-upload-edits: no node params spread from an object read
// before an await (or outside a `.then` callback) is written after it. Such
// a write reverts an edit made while it waited, the person's or an agent's
// (the Inspector's file upload did; #208's palette did before
// writeParamNow). A write that lands later reads the node from the store
// when it lands (Inspector's writeParamsNow). Rules: tests/helpers/staleParamsSpread.ts.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { staleParamsSpreads } from './helpers/staleParamsSpread';

const SRC = join(__dirname, '../src');
const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return sources(path);
  return /\.tsx?$/.test(name) && !/\.test\.|\.d\.ts$/.test(name) ? [path] : [];
});

describe('a params spread read before an await is not written after it', () => {
  it('finds the upload as it was (inside .then, from the render)', () => {
    const old = `
      function Inspector({ activeNodeData, activeNode }) {
        const onChange = () => {
          apiRequest('x', '/api/uploads', {}).then((r) => r.json()).then((data) => {
            updateNodeData(activeNode.id, { params: { ...activeNodeData.params, filePath: data.filePath } });
          });
        };
      }`;
    expect(staleParamsSpreads(old).map((f) => [f.text, f.why])).toEqual([['...activeNodeData.params', 'then']]);
  });

  it('finds a spread after an await of an object read before it', () => {
    const code = `
      async function save(nodeId) {
        const node = get().nodes.find((n) => n.id === nodeId);
        const url = await upload();
        set({ params: { ...node.data.params, url } });
      }
      const write = async (params) => { await wait(); return { ...params, done: true }; };`;
    expect(staleParamsSpreads(code).map((f) => f.why)).toEqual(['await', 'await']);
  });

  it('passes a read made when the write lands, a spread before the await and a sync callback', () => {
    const code = `
      async function save(nodeId, params) {
        const draft = { ...params, a: 1 };
        await upload(draft);
        const node = get().nodes.find((n) => n.id === nodeId);
        set({ params: { ...node.data.params, url: 1 } });
      }
      function sync(node) { return [1].map(() => ({ ...node.data.params })); }
      p.then((data) => ({ ...data.params }));
      p.then(() => { const now = get(); return { ...now.params }; });`;
    expect(staleParamsSpreads(code)).toEqual([]);
  });

  it('takes an opt-out only with a reason', () => {
    const withReason = `p.then(() => ({
      // stale-params-ok: a draft nobody else edits
      ...draft.params }));`;
    const bare = `p.then(() => ({
      // stale-params-ok:
      ...draft.params }));`;
    expect(staleParamsSpreads(withReason)).toEqual([]);
    expect(staleParamsSpreads(bare)).toHaveLength(1);
  });

  it('frontend/src has none', () => {
    const found = sources(SRC).flatMap((path) => staleParamsSpreads(readFileSync(path, 'utf8'), path)
      .map((f) => `${relative(join(__dirname, '..'), path)}:${f.line} (${f.why}) ${f.text}`));
    expect(found).toEqual([]);
  });
});
