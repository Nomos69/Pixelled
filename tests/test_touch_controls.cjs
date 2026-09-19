// Run with: node --test tests/test_touch_controls.cjs
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const source = readFileSync(new URL('../static/js/app.js', `file://${__filename}`), 'utf8');

function client() {
  const context = new Proxy({}, {get: (_, name) => name === 'measureText' ? () => ({width: 20}) : () => {}});
  function element(dataset = {}) {
    const handlers = {};
    const classes = new Set();
    return {dataset, disabled: false, hidden: false, open: false, value: '',
      classList: {toggle(name, on) { on ? classes.add(name) : classes.delete(name); }, contains: name => classes.has(name)},
      addEventListener(type, callback) { (handlers[type] ??= []).push(callback); },
      emit(type, extra = {}) { for (const callback of handlers[type] || []) callback({button: 0, pointerId: 1, preventDefault() {}, ...extra}); },
      setPointerCapture() {}, setAttribute() {}, focus() {}, getContext: () => context,
      showModal() { this.open = true; }, close() { this.open = false; },
      children: [], replaceChildren() { this.children = []; }, append(child) { this.children.push(child); },
      querySelectorAll: () => [], matches: () => false,
    };
  }
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const directions = Object.fromEntries(['up','down','left','right'].map(d => [d, element({direction: d})]));
  const actions = ['interact','pick_lily','give_lily'].map(a => element({action: a}));
  get('touchControls').querySelectorAll = selector => selector === '[data-direction]' ? Object.values(directions) : selector === '[data-action]' ? actions : [...Object.values(directions), ...actions];
  const document = Object.assign(element(), {getElementById: get, createElement: () => element(), hidden: false});
  const window = Object.assign(element(), {matchMedia: () => ({matches: true})});
  const sent = [];
  const sandbox = vm.createContext({document, window, WebSocket: {OPEN: 1}, performance: {now: () => 0}, requestAnimationFrame() {}, setInterval() {}, sent});
  vm.runInContext(source, sandbox);
  vm.runInContext('joinDialog.close(); myId = "test"; socket = {readyState: 1, send(data) { sent.push(JSON.parse(data)); }}; setTouchEnabled(true);', sandbox);
  return {get, directions, actions, document, window, sent, run: code => vm.runInContext(code, sandbox), last: () => sent.at(-1).input};
}

test('two fingers move diagonally; releasing one preserves the other', () => {
  const c = client();
  assert.equal(c.get('touchControls').hidden, false);
  c.directions.up.emit('pointerdown', {pointerId: 1});
  c.directions.right.emit('pointerdown', {pointerId: 2});
  assert.equal(c.last().up && c.last().right, true);
  c.directions.up.emit('pointerup', {pointerId: 1});
  assert.equal(c.last().up, false);
  assert.equal(c.last().right, true);
  c.directions.right.emit('pointercancel', {pointerId: 2});
  assert.equal(Object.values(c.last()).some(Boolean), false);
});

test('touch release preserves a held keyboard direction', () => {
  const c = client();
  c.run("pressed.add('KeyW')");
  c.directions.up.emit('pointerdown');
  c.directions.up.emit('lostpointercapture');
  assert.equal(c.last().up, true);
  c.window.emit('blur');
  assert.equal(Object.values(c.last()).some(Boolean), false);
});

test('hiding controls, chat focus, and hidden page clear held input', () => {
  for (const release of [c => c.get('toggleTouchControls').emit('click'), c => c.get('chatText').emit('focus'), c => {c.document.hidden = true; c.document.emit('visibilitychange');}]) {
    const c = client();
    c.directions.left.emit('pointerdown');
    release(c);
    assert.equal(Object.values(c.last()).some(Boolean), false);
    assert.equal(c.directions.left.classList.contains('is-held'), false);
  }
});

test('dialogs and disconnected state block touch input', () => {
  for (const setup of ['boardDialog.showModal()', 'dialog.showModal()', 'myId = null; setTouchEnabled(false)']) {
    const c = client();
    c.run(setup);
    c.directions.down.emit('pointerdown');
    c.actions[0].emit('click');
    assert.equal(c.sent.length, 0);
  }
});

test('action buttons stop movement and send the corresponding server action', () => {
  const c = client();
  for (const button of c.actions) {
    c.directions.right.emit('pointerdown');
    button.emit('click');
    assert.equal(c.sent.at(-1).type, button.dataset.action);
    assert.equal(Object.values(c.sent.at(-2).input).some(Boolean), false);
  }
});

test('lab checklist skips solved and occupied computers, and resets on disconnect', () => {
  const c = client();
  c.run(`terminals = [{id: 'a', occupant: null}, {id: 'b', occupant: 'other'}, {id: 'c', occupant: null}];
    updateJournal({completed: 1, completed_terminals: ['a']});`);
  assert.match(c.get('labGoal').textContent, /Computer 3/);
  assert.match(c.get('labChecklist').children[0].textContent, /Solved/);
  assert.match(c.get('labChecklist').children[1].textContent, /In use/);
  assert.equal(c.get('labProgress').value, 1);
  c.run("updateJournal({completed: 3, completed_terminals: ['a', 'b', 'c']})");
  assert.match(c.get('labGoal').textContent, /All lab puzzles solved/);
  c.run('myId = null; terminals = []; updateJournal()');
  assert.equal(c.get('labProgress').value, 0);
  assert.equal(c.get('labChecklist').children.length, 0);
  assert.match(c.get('labGoal').textContent, /Join campus/);
});
