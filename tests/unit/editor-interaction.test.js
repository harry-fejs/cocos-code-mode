'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('../helpers/require-dist');
const { EditorTools } = requireDist('utcp/tools/editor-tools.js');
const { cancelEditorAsk } = requireDist('utcp/editor-ask.js');
const { getEditorPrompt, respondEditorPrompt, cancelEditorPrompt } = requireDist('utcp/editor-prompt.js');

const question = { title: 'Agent', message: 'Continue?', presentation: 'native' };
const form = {
  title: 'Agent input', message: 'Review the changes',
  fields: [
    { name: 'label', label: 'Label', type: 'text', maxLength: 10, required: true },
    { name: 'mode', label: 'Mode', type: 'select', options: ['Preview', 'Apply'], required: true },
    { name: 'approved', label: 'Approved', type: 'confirm', required: true },
  ],
};
const values = { label: 'safe', mode: 'Preview', approved: true };
const invalid = error => error.code === 'INVALID_ARGUMENT' && error.status === 400;
const busy = error => error.code === 'EDITOR_INTERACTION_BUSY' && error.status === 409;

function editor(t) {
  const previous = global.Editor;
  global.Editor = {
    Dialog: { info: async () => ({ response: 0 }), warn: async () => ({ response: 1 }), error: async () => ({ response: 0 }) },
    Panel: { open: async () => true },
    Message: { send() {}, broadcast() {} },
  };
  t.after(() => {
    cancelEditorAsk();
    cancelEditorPrompt();
    global.Editor = previous;
  });
  return global.Editor;
}

function submit(requestId, submittedValues = values) {
  return respondEditorPrompt({ requestId, action: 'submit', values: submittedValues });
}

describe('editorAsk', () => {
  it('defaults to a quiet nonmodal question and shares the inbox slot with forms', async t => {
    const api = editor(t);
    api.Panel.open = () => { assert.fail('Default request must not open/focus a panel'); };
    api.Dialog.info = () => { assert.fail('Default request must not open a native dialog'); };
    const tool = new EditorTools();
    const result = tool.editorAsk({ title: 'Quiet question', message: 'Continue?', buttons: ['Apply', 'Cancel'] });
    const requestId = getEditorPrompt().requestId;
    assert.throws(() => tool.editorPrompt(form), busy);
    assert.throws(() => respondEditorPrompt({ requestId, action: 'choose', buttonIndex: 9 }), invalid);
    assert.deepEqual(respondEditorPrompt({ requestId, action: 'choose', buttonIndex: 0 }), { accepted: true });
    assert.deepEqual(await result, { buttonIndex: 0, buttonLabel: 'Apply', cancelled: false, timedOut: false });
    assert.deepEqual(respondEditorPrompt({ requestId, action: 'choose', buttonIndex: 1 }), { accepted: false });
  });

  it('times out an unopened inbox question without interrupting Creator', async t => {
    const api = editor(t);
    api.Panel.open = () => { assert.fail('Default timeout must not open a panel'); };
    assert.deepEqual(await new EditorTools().editorAsk({ title: 'Quiet question', message: 'Continue?', timeoutMs: 1 }),
      { buttonIndex: null, buttonLabel: null, cancelled: false, timedOut: true });
    assert.equal(getEditorPrompt(), null);
  });

  it('maps a Creator native cancel selection to its original index and label', async t => {
    const api = editor(t);
    api.Dialog.warn = async (message, options) => {
      // These are Creator API names, not Electron's cancelId/defaultId.
      assert.equal(options.cancel, 1);
      assert.equal(options.default, 0);
      return { response: options.cancel };
    };
    const result = await new EditorTools().editorAsk({ ...question, type: 'warning', buttons: ['Apply', 'Cancel'], cancelId: 1 });
    assert.deepEqual(result, { buttonIndex: 1, buttonLabel: 'Cancel', cancelled: true, timedOut: false });
  });

  it('times out a nonresponding native dialog, rejects pileups, and ignores the late click', async t => {
    const api = editor(t);
    let click;
    api.Dialog.info = () => new Promise(resolve => { click = resolve; });
    const tool = new EditorTools();
    const result = await tool.editorAsk({ ...question, timeoutMs: 1 });
    assert.deepEqual(result, { buttonIndex: null, buttonLabel: null, cancelled: false, timedOut: true });
    assert.throws(() => tool.editorAsk(question), busy);
    click({ response: 0 });
    await new Promise(resolve => setImmediate(resolve));
    api.Dialog.info = async () => ({ response: 0 });
    assert.equal((await tool.editorAsk(question)).buttonLabel, 'OK');
    assert.equal(result.timedOut, true);
    assert.equal(result.buttonIndex, null);
  });
  it('keeps an expired fixture busy until its native dialog actually settles', async t => {
    const api = editor(t);
    const { startTrackedPopupFixture, getTrackedPopupFixture } = requireDist('utcp/editor-popup-fixture.js');
    const previousSetTimeout = global.setTimeout;
    const previousNow = Date.now;
    let expire;
    let dismiss;
    api.Dialog.warn = () => new Promise(resolve => { dismiss = resolve; });
    global.setTimeout = (callback, delay, ...args) => {
      if (delay === 300000) { expire = () => callback(...args); return { unref() {} }; }
      return previousSetTimeout(callback, delay, ...args);
    };
    t.after(() => { global.setTimeout = previousSetTimeout; Date.now = previousNow; });
    const fixture = startTrackedPopupFixture();
    await Promise.resolve();
    assert.equal(getTrackedPopupFixture().title, fixture.title);
    Date.now = () => fixture.expiresAt;
    expire();
    await Promise.resolve();
    assert.equal(getTrackedPopupFixture().title, fixture.title);
    assert.throws(() => startTrackedPopupFixture(), error => error.code === 'POPUP_FIXTURE_BUSY');
    dismiss({ response: 1 });
    await new Promise(resolve => setImmediate(resolve));
    Date.now = previousNow;
    assert.equal(getTrackedPopupFixture(), null);
  });

  it('releases the native guard on errors and rejects malformed native responses', async t => {
    const api = editor(t);
    api.Dialog.info = async () => { throw new Error('native failed'); };
    await assert.rejects(new EditorTools().editorAsk(question), /native failed/);
    api.Dialog.info = async () => ({ response: 99 });
    await assert.rejects(new EditorTools().editorAsk(question), error => error.code === 'INVALID_EDITOR_RESPONSE');
    api.Dialog.info = async () => ({ response: 0 });
    assert.equal((await new EditorTools().editorAsk(question)).cancelled, false);
  });

  it('rejects unsafe bounds before invoking any native dialog', t => {
    const api = editor(t);
    api.Dialog.info = () => { assert.fail('Native dialog must not open'); };
    for (const args of [
      { ...question, buttons: [] }, { ...question, buttons: null },
      { ...question, buttons: ['Yes'], cancelId: 1 }, { ...question, cancelId: null },
      { ...question, buttons: ['Yes', 'Yes'] }, { ...question, buttons: [' '] },
      { ...question, timeoutMs: 0 }, { ...question, timeoutMs: 300001 },
      { ...question, title: ' ' }, { ...question, html: '<script>' },
    ]) assert.throws(() => new EditorTools().editorAsk(args), invalid);
  });
});

describe('editorNotify', () => {
  it('is quiet by default and can explicitly open Agent Inbox for a failed Code Mode chain', async t => {
    const api = editor(t);
    let opened = 0;
    api.Panel.open = async name => { opened += 1; assert.match(name, /\.prompt$/); return true; };
    const tool = new EditorTools();
    const quiet = await tool.editorNotify({ level: 'error', title: 'CCP command failed', message: 'Code execution failed.' });
    assert.equal(quiet.level, 'error');
    assert.equal(opened, 0);
    const visible = await tool.editorNotify({ level: 'error', title: 'CCP command failed', message: 'Code execution failed.', openPanel: true });
    assert.equal(visible.level, 'error');
    assert.equal(opened, 1);
  });

  it('rejects unsupported notification arguments before opening Agent Inbox', async t => {
    const api = editor(t);
    api.Panel.open = () => { assert.fail('Invalid notification must not open a panel'); };
    await assert.rejects(new EditorTools().editorNotify({ title: 'Failure', message: 'Bad', openPanel: 'yes' }), invalid);
  });
});

describe('editorPrompt', () => {
  it('submits typed values once and prevents stale responses from cancelling the next form', async t => {
    const api = editor(t);
    api.Panel.open = () => { assert.fail('Default form must not open/focus a panel'); };
    const tool = new EditorTools();
    const first = tool.editorPrompt(form);
    const requestId = getEditorPrompt().requestId;
    assert.throws(() => tool.editorPrompt(form), busy);
    assert.deepEqual(submit(requestId), { accepted: true });
    assert.deepEqual(submit(requestId), { accepted: false });
    assert.deepEqual(await first, { requestId, submitted: true, cancelled: false, timedOut: false, values });
    assert.equal(getEditorPrompt(), null);
    const second = tool.editorPrompt(form);
    const nextId = getEditorPrompt().requestId;
    assert.notEqual(nextId, requestId);
    assert.deepEqual(respondEditorPrompt({ requestId, action: 'cancel' }), { accepted: false });
    assert.equal(getEditorPrompt().requestId, nextId);
    respondEditorPrompt({ requestId: nextId, action: 'cancel' });
    assert.deepEqual(await second, { requestId: nextId, submitted: false, cancelled: true, timedOut: false, values: {} });
  });

  it('keeps invalid submissions open for correction without accepting unknown fields or options', async t => {
    editor(t);
    const pending = new EditorTools().editorPrompt(form);
    const requestId = getEditorPrompt().requestId;
    for (const bad of [
      { ...values, approved: false }, { ...values, mode: 'Unsafe' },
      { ...values, label: 'x'.repeat(11) }, { ...values, label: '  ' },
      { ...values, extra: 'injected' }, { label: 'label', mode: 'Preview' },
      JSON.parse('{"__proto__":true}'),
    ]) assert.throws(() => submit(requestId, bad), invalid);
    assert.equal(getEditorPrompt().requestId, requestId);
    submit(requestId);
    assert.equal((await pending).submitted, true);
  });

  it('times out even when panel opening never resolves and frees the active request', async t => {
    const api = editor(t);
    api.Panel.open = () => new Promise(() => {});
    const pending = new EditorTools().editorPrompt({ ...form, openPanel: true, timeoutMs: 50 });
    const requestId = getEditorPrompt().requestId;
    assert.deepEqual(await pending, { requestId, submitted: false, cancelled: false, timedOut: true, values: {} });
    assert.equal(getEditorPrompt(), null);
    assert.deepEqual(submit(requestId), { accepted: false });
    const next = new EditorTools().editorPrompt(form);
    cancelEditorPrompt();
    assert.equal((await next).cancelled, true);
  });

  it('cleans up panel-open failures and extension shutdown', async t => {
    const api = editor(t);
    api.Panel.open = async () => { throw new Error('panel unavailable'); };
    await assert.rejects(new EditorTools().editorPrompt({ ...form, openPanel: true }), /panel unavailable/);
    assert.equal(getEditorPrompt(), null);
    api.Panel.open = async () => true;
    const pending = new EditorTools().editorPrompt(form);
    cancelEditorPrompt();
    assert.equal((await pending).cancelled, true);
    assert.equal(getEditorPrompt(), null);
  });

  it('rejects duplicate/reserved names and mismatched field definitions before opening a panel', t => {
    const api = editor(t);
    api.Panel.open = () => { assert.fail('Panel must not open'); };
    for (const fields of [
      [form.fields[0], form.fields[0]], [{ ...form.fields[0], name: 'constructor' }],
      [{ ...form.fields[0], name: '__proto__' }], [{ ...form.fields[0], defaultValue: 'x'.repeat(11) }],
      [{ ...form.fields[1], defaultValue: 'Unknown' }], [{ ...form.fields[1], options: ['same', 'same'] }],
      [{ ...form.fields[2], defaultValue: 'true' }], [{ ...form.fields[0], options: ['extra'] }],
      Array.from({ length: 17 }, (_, i) => ({ ...form.fields[0], name: `field${i}` })),
    ]) assert.throws(() => new EditorTools().editorPrompt({ ...form, fields }), invalid);
  });
});
