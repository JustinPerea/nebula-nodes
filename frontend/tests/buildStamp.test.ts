import { describe, expect, it } from 'vitest';
import { BUILD_STAMP_FILE, buildStampSource, nebulaBuildStamp } from '../vite-plugins/buildStamp';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';

// desktop/frontend-build.mjs compares this stamp with /api/health at launch.
describe('nebula-build.json stamp', () => {
  it('emits the bundle\'s own GRAPH_PARAMS_VERSION next to index.html', () => {
    const emitted: Array<{ type: string, fileName: string, source: string }> = [];
    const plugin = nebulaBuildStamp();
    expect(plugin.apply).toBe('build');
    plugin.generateBundle.call({ emitFile: (file) => { emitted.push(file); } });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe('asset');
    expect(emitted[0].fileName).toBe(BUILD_STAMP_FILE);
    expect(BUILD_STAMP_FILE).toBe('nebula-build.json');
    expect(JSON.parse(emitted[0].source)).toEqual({ paramsVersion: GRAPH_PARAMS_VERSION });
  });

  it('writes whatever version it is given', () => {
    expect(JSON.parse(buildStampSource(7))).toEqual({ paramsVersion: 7 });
  });
});
