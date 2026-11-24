import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createTriageServer } from './server.mjs';
import { attachTriageForm } from './client.mjs';

const manual = { status: 'manual_review', topic: null, draft: null };
async function start(t, options) {
  const server = createTriageServer(options).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
function post(url, body) {
  return fetch(`${url}/api/triage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
}

test('invalid inputs return 400 without calling AI', async t => {
  let calls = 0;
  const url = await start(t, { classifyText: () => { calls++; throw new Error(); } });
  for (const body of ['', '{', 'null', '[]', '{}', '{"text":null}', '{"text":12}', '{"text":{}}', '{"text":""}', '{"text":" \\n\\t"}']) {
    const response = await post(url, body);
    assert.equal(response.status, 400, body);
    assert.deepEqual(await response.json(), { status: 'invalid_input' });
  }
  assert.equal(calls, 0);
});

test('valid input returns the documented success shape', async t => {
  const url = await start(t);
  for (const [text, topic] of [['Доставка заказа', 'delivery'], ['Стоимость заказа', 'pricing'], ['Привет', 'other']]) {
    const response = await post(url, JSON.stringify({ text }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'ready', topic, draft: 'Спасибо за обращение. Уточним детали заявки.',
    });
  }
  assert.equal((await fetch(url)).status, 200);
  const script = await fetch(`${url}/client.mjs`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
});

for (const marker of ['[timeout]', '[error]', '[bad-json]', '[bad-topic]', '[empty-draft]']) {
  test(`${marker} returns manual review with no draft`, async t => {
    const url = await start(t);
    const response = await post(url, JSON.stringify({ text: marker }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), manual);
  });
}

test('deadline returns even when provider ignores cancellation', async t => {
  let signal;
  const url = await start(t, { classifyText: (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  // Keep this independent of the server timer; a missing deadline must fail the test.
  const response = await fetch(`${url}/api/triage`, {
    method: 'POST', body: '{"text":"test"}', signal: AbortSignal.timeout(1000),
  });
  assert.deepEqual(await response.json(), manual);
  assert.equal(signal.aborted, true);
});

test('unexpected AI structures cannot escape as ready', async t => {
  for (const raw of ['null', '[]', '{}', '{"topic":"other","draft":23}', '{"topic":"delivery","draft":null}']) {
    await t.test(raw, async t => {
      const url = await start(t, { classifyText: async () => raw });
      assert.deepEqual(await (await post(url, '{"text":"test"}')).json(), manual);
    });
  }
});

// Minimal DOM adapter: exercise the actual submit handler, without browser dependencies.
function ui(fetchReply) {
  const nodes = Object.fromEntries(['form', '#message', '#status', '#topic', '#draft']
    .map(key => [key, { textContent: '', value: '' }]));
  let submit;
  nodes.form.addEventListener = (_, listener) => { submit = listener; };
  attachTriageForm({ querySelector: key => nodes[key] }, fetchReply);
  return { nodes, submit: text => {
    nodes['#message'].value = text;
    return submit({ preventDefault() {} });
  } };
}
const reply = body => ({ ok: true, status: 200, json: async () => body });
const ready = draft => ({ status: 'ready', topic: 'delivery', draft });

test('UI clears previous draft and preserves source text for every failure', async t => {
  const failures = [
    async () => reply(manual),
    async () => { throw new Error('Network failure'); },
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => { throw new SyntaxError(); } }),
    async () => reply({ status: 'ready', topic: 'refund', draft: 'Wrong' }),
    async () => reply(ready('   ')),
  ];
  for (const fail of failures) {
    await t.test(fail.toString(), async () => {
      let call = 0;
      const view = ui((...args) => ++call === 1 ? Promise.resolve(reply(ready('Old draft'))) : fail(...args));
      await view.submit('first');
      assert.equal(view.nodes['#draft'].textContent, 'Old draft');
      const pending = view.submit('second');
      assert.equal(view.nodes['#draft'].textContent, '');
      await pending;
      assert.equal(view.nodes['#draft'].textContent, '');
      assert.equal(view.nodes['#topic'].textContent, '');
      assert.match(view.nodes['#status'].textContent, /Нужен ручной разбор/);
      assert.equal(view.nodes['#message'].value, 'second');
    });
  }
});

test('blank UI input clears old draft and does not call API', async () => {
  let calls = 0;
  const view = ui(async () => { calls++; return reply(ready('Old')); });
  await view.submit('valid');
  await view.submit(' \n\t ');
  assert.equal(calls, 1);
  assert.equal(view.nodes['#draft'].textContent, '');
  assert.match(view.nodes['#status'].textContent, /Введите/);
});

for (const staleFails of [false, true]) {
  test(`latest response wins even if old request ${staleFails ? 'fails' : 'succeeds'} later`, async () => {
    const pending = [];
    const view = ui(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
    const a = view.submit('A');
    const b = view.submit('B');
    pending[1].resolve(reply(ready('Fresh B')));
    await b;
    if (staleFails) pending[0].reject(new Error('Old failure'));
    else pending[0].resolve(reply(ready('Stale A')));
    await a;
    assert.equal(view.nodes['#draft'].textContent, 'Fresh B');
    assert.match(view.nodes['#status'].textContent, /Черновик готов/);
  });
}

test('blank new submission invalidates an older pending result', async () => {
  let resolve;
  const view = ui(() => new Promise(done => { resolve = done; }));
  const old = view.submit('old');
  await view.submit('  ');
  resolve(reply(ready('Stale')));
  await old;
  assert.equal(view.nodes['#draft'].textContent, '');
  assert.match(view.nodes['#status'].textContent, /Введите/);
});

test('browser deadline clears stale draft and shows manual review', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const view = ui((_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  }));
  view.nodes['#draft'].textContent = 'Previous draft';
  const pending = view.submit('Slow request');
  assert.equal(view.nodes['#draft'].textContent, '');
  t.mock.timers.tick(5000);
  await pending;
  assert.match(view.nodes['#status'].textContent, /Нужен ручной разбор/);
  assert.equal(view.nodes['#draft'].textContent, '');
});

test('AI extra fields cannot override the API contract', async t => {
  const url = await start(t, { classifyText: async () => JSON.stringify({
    status: 'manual_review', topic: 'other', draft: '  Safe draft  ', extra: 'ignored',
  }) });
  assert.deepEqual(await (await post(url, '{"text":"test"}')).json(), {
    status: 'ready', topic: 'other', draft: 'Safe draft',
  });
});
