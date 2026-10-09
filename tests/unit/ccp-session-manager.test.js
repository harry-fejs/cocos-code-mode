'use strict';
const {it} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {PassThrough} = require('node:stream');
const {SessionLifecycleManager} = require('../../scripts/session-presence/manager');
const {serve} = require('../../scripts/session-presence/stdio');
const project = path.resolve('manager-project');
function fixture() {
  const active = new Set();
  return {active, supervisorFactory: options => ({
    start() { active.add(options.session); return new Promise(() => {}); },
    async stop() { active.delete(options.session); },
  })};
}
it('keeps concurrent chats independent and rejects conflicting duplicate binding', async () => {
  const f = fixture(), manager = new SessionLifecycleManager(f);
  const a = await manager.open({sessionId:'a',project}), b = await manager.open({sessionId:'b',project});
  assert.notEqual(a,b);
  assert.equal(await manager.open({sessionId:'a',project}),a);
  await assert.rejects(manager.open({sessionId:'a',project:path.resolve('other')}), {code:'SESSION_CONFLICT'});
  await manager.close('a');
  assert.deepEqual([...f.active],[b]);
  await manager.shutdown();
  assert.equal(f.active.size,0);
  await assert.rejects(manager.open({sessionId:'c',project}), {code:'MANAGER_CLOSED'});
});
it('normalizes equivalent project spellings for one logical session', async () => {
  const f=fixture(),manager=new SessionLifecycleManager(f);
  const alternate=process.platform==='win32'?project.toUpperCase():path.join(project,'.');
  const first=await manager.open({sessionId:'same',project});
  assert.equal(await manager.open({sessionId:'same',project:alternate}),first);
  await manager.shutdown();
});
it('portable JSONL processes independent opens and closes every chat on EOF', async () => {
  const f = fixture(), input = new PassThrough(), output = new PassThrough();
  let text = ''; output.on('data', chunk => {text += chunk;});
  const lifetime = serve(input,output,f);
  input.end(JSON.stringify({id:'1',operation:'open',sessionId:'a',project})+'\n'+JSON.stringify({id:'2',operation:'open',sessionId:'b',project})+'\n'+JSON.stringify({id:'3',operation:'close',sessionId:'a'})+'\n');
  await lifetime;
  const replies = text.trim().split('\n').map(JSON.parse).filter(x=>x.type==='response');
  assert.deepEqual(replies.map(x=>[x.id,x.ok]),[['1',true],['2',true],['3',true]]);
  assert.notEqual(replies[0].presenceId,replies[1].presenceId);
  assert.equal(f.active.size,0);
});
it('oversized incomplete input terminates and closes owned sessions', async () => {
  const f = fixture(), input = new PassThrough(), output = new PassThrough(); output.resume();
  const lifetime = serve(input,output,f);
  input.end('x'.repeat(8193));
  await assert.rejects(lifetime,{code:'FRAME_TOO_LARGE'});
  assert.equal(f.active.size,0);
});
