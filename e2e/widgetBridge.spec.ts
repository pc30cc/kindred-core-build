import { test, expect } from '@playwright/test';
import { makeAdapter, DomAdapter, CrispAdapter } from '../worker/widget-bridge/adapters';

const identity = { name: 'Admin', email: 'admin@example.com', phone: '+905551234567' };
const fixture = `<!doctype html><html><body><div id="host"></div><script>
const shadow=document.getElementById('host').attachShadow({mode:'open'});
shadow.innerHTML='<div class="shell"><button class="launcher">Chat</button><div class="panel" hidden><button data-home-action="chat">Start chat</button><div id="form" hidden><input data-prechat="name"><input data-prechat="email"><input data-prechat="phone"><button data-prechat-submit>Continue</button></div><div id="chat" hidden><div class="messages"></div><textarea data-msg-input></textarea><button data-send-btn>Send</button></div></div></div>';
shadow.querySelector('.launcher').onclick=()=>{shadow.querySelector('.panel').hidden=false;shadow.querySelector('.launcher').hidden=true;};
shadow.querySelector('[data-home-action]').onclick=()=>{shadow.querySelector('#form').hidden=false;shadow.querySelector('[data-home-action]').hidden=true;};
shadow.querySelector('[data-prechat-submit]').onclick=()=>{shadow.querySelector('#form').hidden=true;shadow.querySelector('#chat').hidden=false;};
function bubble(kind,id,body){const row=document.createElement('div');row.className='msg-row '+kind;const text=document.createElement('span');text.className='msg-text';text.textContent=body;row.append(text);const action=document.createElement('button');action.setAttribute('data-msg-reply',id);action.setAttribute('data-msg-copy',body);row.append(action);shadow.querySelector('.messages').append(row);}
shadow.querySelector('[data-send-btn]').onclick=async()=>{const input=shadow.querySelector('textarea');const body=input.value;bubble('visitor','sent',body);input.value='';const response=await fetch('/api/widget/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:body})});if(response.ok){bubble('operator','reply-1','Welcome');bubble('operator','reply-2','Welcome');}};
</script></body></html>`;

test('worker opens a shadow widget, fills details, posts and receives distinct replies', async ({ page }) => {
  await page.route('https://bridge-fixture.test/**', route => route.fulfill(
    route.request().method() === 'POST' ? { json: { message_id: 'accepted-1' } } : { contentType: 'text/html', body: fixture },
  ));
  await page.goto('https://bridge-fixture.test/');
  const adapter = await makeAdapter(page, 'auto', {});
  await adapter.prepare(identity);
  await expect(page.locator('[data-prechat="name"]')).toHaveValue('Admin');
  await expect(page.locator('[data-prechat="email"]')).toHaveValue('admin@example.com');
  expect(await adapter.send('Hello remote site')).toBe(true);
  await expect.poll(async () => (await adapter.receive()).length).toBe(2);
  const received = await adapter.receive();
  expect(received).toEqual([{ key: 'id:reply-1', body: 'Welcome' }, { key: 'id:reply-2', body: 'Welcome' }]);
  expect(received.some(message => message.body === 'Hello remote site')).toBe(false);
});

test('an optimistic WebYar bubble without server acceptance is not a confirmed send', async ({ page }) => {
  await page.route('https://bridge-fixture.test/**', route => route.fulfill(
    route.request().method() === 'POST' ? { status: 503, json: { error: 'down' } } : { contentType: 'text/html', body: fixture },
  ));
  await page.goto('https://bridge-fixture.test/');
  const adapter = await makeAdapter(page, 'webyar', {}); await adapter.prepare(identity);
  expect(await adapter.send('Unaccepted')).toBe(false);
  expect(await adapter.receive()).toEqual([]);
});

test('Crisp SDK adapter captures replies and visitor send events independently', async ({ page }) => {
  await page.setContent('<html><body></body></html>');
  await page.evaluate(() => {
    const callbacks = new Map<string, (value: unknown) => void>();
    const win = globalThis as unknown as { $crisp: unknown; emitReply: (value: unknown) => void; nickname: unknown };
    win.$crisp = {
      get: () => 'session-1',
      push: (command: unknown[]) => {
        if (command[0] === 'on') callbacks.set(String(command[1]), command[2] as (value: unknown) => void);
        if (command[0] === 'set' && command[1] === 'user:nickname') win.nickname = command[2];
        if (command[0] === 'do' && command[1] === 'message:send') callbacks.get('message:sent')?.({ type: 'text', content: (command[2] as string[])[1] });
      },
    };
    win.emitReply = value => callbacks.get('message:received')?.(value);
  });
  const adapter = await makeAdapter(page, 'auto', {}); expect(adapter).toBeInstanceOf(CrispAdapter);
  await adapter.prepare(identity); expect(await adapter.send('Hello Crisp')).toBe(true);
  await page.evaluate(() => (globalThis as unknown as { emitReply: (value: unknown) => void }).emitReply({ type: 'text', content: 'Crisp reply', fingerprint: 123 }));
  await expect.poll(async () => (await adapter.receive()).length).toBe(1);
  expect(await adapter.receive()).toEqual([{ key: 'crisp:123', body: 'Crisp reply' }]);
});

test('custom configuration is scoped to its iframe and never fills unrelated forms', async ({ page }) => {
  await page.route('https://custom-fixture.test/**', route => route.fulfill({ contentType: 'text/html', body:
    route.request().url().endsWith('/widget') ? '<div id="widget"><input id="name"><input id="email"><textarea></textarea><div class="incoming" data-mid="a">Agent reply</div><div class="outgoing"></div></div>'
      : '<input id="name" value="leave-alone"><iframe id="chat-frame" src="/widget"></iframe>',
  }));
  await page.goto('https://custom-fixture.test/');
  const adapter = new DomAdapter(page, { frame: '#chat-frame', root: '#widget', name: '#name', email: '#email', composer: 'textarea', inbound: '.incoming', outbound: '.outgoing', messageIdAttribute: 'data-mid' });
  await adapter.prepare(identity);
  await expect(page.locator('#name')).toHaveValue('leave-alone');
  await expect(page.frameLocator('#chat-frame').locator('#name')).toHaveValue('Admin');
  expect(await adapter.receive()).toEqual([{ key: 'id:a', body: 'Agent reply' }]);
  await expect(adapter.prepare({ ...identity, email: '' })).rejects.toThrow('identity_required');
});
