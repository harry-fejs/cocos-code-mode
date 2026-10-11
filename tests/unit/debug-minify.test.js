const { it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { minify } = require('terser');
it('retains reflection names and public property/tool contracts after local mangling', async () => {
  const input = 'class ProbeTool { buildPreflight(args) { const internalValue = args.scene; return { tool: "buildPreflight", scene: internalValue }; } } module.exports = { ProbeTool };';
  const result = await minify(input, { ecma: 2017, mangle: { toplevel: false, properties: false }, keep_classnames: true, keep_fnames: true });
  const context = { module: { exports: {} } };
  vm.runInNewContext(result.code, context);
  const Tool = context.module.exports.ProbeTool;
  assert.equal(Tool.name, 'ProbeTool');
  assert.equal(new Tool().buildPreflight({ scene: 'exact-id' }).scene, 'exact-id');
  assert.equal(new Tool().buildPreflight({ scene: 'exact-id' }).tool, 'buildPreflight');
});
it('emits private source maps without embedded runtime source references', async () => {
  const result = await minify({ 'probe.js': 'function failProbe(){ throw new Error("probe"); } module.exports=failProbe;' }, { keep_fnames: true, sourceMap: { filename: 'probe.js', includeSources: true } });
  assert.equal(/sourceMappingURL|sourceURL/.test(result.code), false);
  const map = JSON.parse(result.map);
  assert.deepEqual(map.sources, ['probe.js']);
  assert.equal(map.sourcesContent[0].includes('failProbe'), true);
});
