import { SessionRelay } from '../worker/widget-bridge/sessionRelay';
import { guardBridgePage } from '../worker/widget-bridge/targetGuard';
import { test, expect } from '@playwright/test';
import { makeAdapter, DomAdapter, CrispAdapter, RaychatAdapter, GoftinoAdapter } from '../worker/widget-bridge/adapters';

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
  await page.frameLocator('#chat-frame').locator('#email').fill('');
  await adapter.prepare({ ...identity, email: '' });
  await expect(page.frameLocator('#chat-frame').locator('#email')).toHaveValue('');
  await page.frameLocator('#chat-frame').locator('#email').evaluate(field => field.setAttribute('required', ''));
  await expect(adapter.prepare({ ...identity, email: '' })).rejects.toThrow('identity_required');
});

test('Raychat uses visitor sendMessage, receives replies and refuses a rejected send', async ({ page }) => {
  await page.setContent('<html><body></body></html>');
  await page.evaluate(() => {
    const callbacks = new Map<string, (value: unknown) => void>();
    const win = globalThis as unknown as { Raychat: unknown; emitReply: (value: unknown) => void; offlineCalls: number; identity: unknown };
    win.offlineCalls = 0;
    win.Raychat = {
      on: (event: string, callback: (value: unknown) => void) => callbacks.set(event, callback),
      setUser: (value: unknown) => { win.identity = value; }, openWidget: () => {},
      sendOfflineMessage: () => { win.offlineCalls++; },
      sendMessage: (body: string) => {
        if (body === 'Reject me') return { success: false, error: 'INPUT_DISABLED' };
        callbacks.get('raychat_sendMessage')?.({ detail: { type: 'text', content: body } });
        return { success: true, message: { id: 'pending-1' } };
      },
    };
    win.emitReply = value => callbacks.get('raychat_getMessage')?.({ detail: value });
  });
  const adapter = await makeAdapter(page, 'auto', {}); expect(adapter).toBeInstanceOf(RaychatAdapter);
  await adapter.prepare(identity);
  expect(await adapter.send('Hello Raychat')).toBe(true);
  expect(await adapter.send('Reject me')).toBe(false);
  await page.evaluate(() => {
    const emit = (globalThis as unknown as { emitReply: (value: unknown) => void }).emitReply;
    emit({ type: 'text', content: 'Raychat reply', id: 'r1' });
    emit({ type: 'text', content: 'Same reply without ID' });
    emit({ type: 'text', content: 'Same reply without ID' });
  });
  await expect.poll(async () => (await adapter.receive()).length).toBe(3);
  const replies = await adapter.receive();
  expect(replies[0]).toEqual({ key: 'raychat:r1', body: 'Raychat reply' });
  expect(replies[1].key).not.toBe(replies[2].key);
  expect(await page.evaluate(() => (globalThis as unknown as { offlineCalls: number }).offlineCalls)).toBe(0);
  adapter.acknowledge?.(3); expect(await adapter.receive()).toEqual([]);
});

// DOM selectors observed in Goftino's live widget; SDK contract from its docs.
const goftinoFixture = `<!doctype html><input id="m" value="unrelated"><iframe id="goftino_w" title="goftino_widget"></iframe><script>
window.displayOnlyCalls=0;window.visitorPosts=[];
const frame=document.querySelector('iframe');
frame.contentDocument.body.innerHTML='<div id="box-widget-icon">Chat</div><div id="box-chat" hidden><div id="chatbox"></div><form id="box-send"><textarea id="m" maxlength="2000"></textarea><div class="fix-content"><a class="btn-send">Send</a></div></form></div>';
window.Goftino={setUser:(value)=>{window.identity=value},open:()=>{frame.contentDocument.querySelector('#box-chat').hidden=false},sendMessage:()=>{window.displayOnlyCalls++}};
frame.contentDocument.querySelector('.btn-send').onclick=async()=>{const input=frame.contentDocument.querySelector('#m');const body=input.value;const bubble=frame.contentDocument.createElement('div');bubble.textContent=body;frame.contentDocument.querySelector('#chatbox').append(bubble);const response=await fetch('/visitor-message',{method:'POST',body});if(response.ok){window.visitorPosts.push(body);input.value='';window.dispatchEvent(new CustomEvent('goftino_sendMessage',{detail:{type:'text',content:body}}));}};
</script>`;

async function openGoftinoFixture(page: import('@playwright/test').Page, accepted = true) {
  await page.route('https://goftino-fixture.test/**', route => route.fulfill(route.request().method() === 'POST'
    ? { status: accepted ? 200 : 503, body: '{}' }
    : { contentType: 'text/html', body: goftinoFixture }));
  await page.goto('https://goftino-fixture.test/');
}

test('Goftino auto detection sends through iframe visitor form and receives operator events', async ({ page }) => {
  await openGoftinoFixture(page);
  const adapter = await makeAdapter(page, 'auto', {}); expect(adapter).toBeInstanceOf(GoftinoAdapter);
  await adapter.prepare(identity); await adapter.prepare(identity); // listeners installed only once
  expect(await adapter.send('Hello Goftino')).toBe(true);
  await expect(page.locator('#m')).toHaveValue('unrelated');
  expect(await page.evaluate(() => (globalThis as unknown as { visitorPosts: string[] }).visitorPosts)).toEqual(['Hello Goftino']);
  expect(await page.evaluate(() => (globalThis as unknown as { displayOnlyCalls: number }).displayOnlyCalls)).toBe(0);
  expect(await page.evaluate(() => (globalThis as unknown as { identity: unknown }).identity)).toEqual({ ...identity, forceUpdate: true });
  await page.evaluate(() => {
    for (const detail of [{ type: 'text', content: 'Reply' }, { type: 'text', content: 'Reply' }, { type: 'file', content: 'attachment' }]) {
      window.dispatchEvent(new CustomEvent('goftino_getMessage', { detail }));
    }
  });
  await expect.poll(async () => (await adapter.receive()).length).toBe(2);
  const replies = await adapter.receive(); expect(replies.map(m => m.body)).toEqual(['Reply', 'Reply']);
  expect(replies[0].key).not.toBe(replies[1].key);
  adapter.acknowledge?.(2); expect(await adapter.receive()).toEqual([]);
});

test('Goftino optimistic bubble and incoming event do not confirm rejected visitor send', async ({ page }) => {
  await openGoftinoFixture(page, false);
  const adapter = await makeAdapter(page, 'goftino', {}); await adapter.prepare(identity);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('goftino_getMessage', { detail: { type: 'text', content: 'Rejected message' } })));
  expect(await adapter.send('Rejected message')).toBe(false);
});

test('Goftino refuses overlong messages without truncating or submitting them', async ({ page }) => {
  await openGoftinoFixture(page);
  const adapter = await makeAdapter(page, 'goftino', {}); await adapter.prepare(identity);
  await expect(adapter.send('x'.repeat(2001))).rejects.toThrow('message_too_long');
  expect(await page.evaluate(() => (globalThis as unknown as { visitorPosts: string[] }).visitorPosts)).toEqual([]);
  await expect(page.frameLocator('#goftino_w').locator('#m')).toHaveValue('');
});


test('provider policy rejects an explicitly disallowed widget before touching its form', async ({ page }) => {
  await openGoftinoFixture(page);
  await expect(makeAdapter(page, 'goftino', {}, ['crisp'])).rejects.toThrow('provider_not_allowed');
  await expect(makeAdapter(page, 'auto', {}, [])).rejects.toThrow('provider_not_allowed');
  expect(await page.evaluate(() => (globalThis as unknown as { visitorPosts: string[] }).visitorPosts)).toEqual([]);
  await expect(page.frameLocator('#goftino_w').locator('#box-chat')).toBeHidden();
});


test('provider assets and iframes work, but a top-level provider destination is blocked', async ({ page }) => {
  await page.route('**/*', route => route.fulfill({contentType:'text/html',body:route.request().url().includes('bridge-fixture') ? '<iframe src="https://www.goftino.com/widget-test"></iframe>' : '<p>Provider asset</p>'}));
  const guard = await guardBridgePage(page);
  await page.goto('https://bridge-fixture.test/');
  await expect(page.frameLocator('iframe').locator('p')).toHaveText('Provider asset');
  expect(()=>guard()).not.toThrow();
  await page.goto('https://www.goftino.com/').catch(()=>{});
  expect(()=>guard()).toThrow('provider_site_blocked');
});

test('top-level redirect destinations are checked before adapter interaction', async ({ page }) => {
  // Initial mocked response works offline; redirected requests cannot reach a real provider.
  await page.context().setOffline(true);
  await page.route('**/*', route => route.request().url().includes('bridge-fixture') ? route.fulfill({status:302,headers:{location:'https://goftino.com/'}}) : route.fulfill({contentType:'text/html',body:'Provider site'}));
  const guard = await guardBridgePage(page);
  await page.goto('https://bridge-fixture.test/').catch(()=>{});
  expect(()=>guard()).toThrow('provider_site_blocked');
});

test('detection wakes widgets loaded only on the first pointer interaction', async ({ page }) => {
  await page.setContent(`<html><body><script>
    window.addEventListener('mouseover', () => { window.$crisp = {get:()=> 'session',push:()=>{}}; }, {once:true});
  </script></body></html>`);
  const adapter = await makeAdapter(page,'auto',{});
  expect(adapter).toBeInstanceOf(CrispAdapter);
});


test('Goftino relay exchanges replies in the same page without navigation or repeated identity setup', async ({ page }) => {
  let navigations = 0;
  page.on('framenavigated', frame=>{if(frame===page.mainFrame())navigations++;});
  await openGoftinoFixture(page);
  await page.evaluate(()=>{
    const win = globalThis as unknown as {Goftino:{setUser:(value:unknown)=>void};identitySetCount:number};
    const setUser = win.Goftino.setUser; win.identitySetCount=0;
    win.Goftino.setUser=value=>{win.identitySetCount++;setUser(value);};
  });
  const relay = new SessionRelay(await makeAdapter(page,'goftino',{}),()=>{});
  await relay.prepare(identity); expect(await relay.send('سلام')).toBe(true);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('goftino_getMessage',{detail:{type:'text',content:'Operator reply'}})));
  await expect.poll(async()=> (await relay.receive()).length).toBe(1);
  expect((await relay.receive())[0].body).toBe('Operator reply');
  relay.acknowledge?.(1);
  await relay.prepare(identity); expect(await relay.send('سلام')).toBe(true);
  expect(navigations).toBe(1);
  expect(await page.evaluate(()=>(globalThis as unknown as {identitySetCount:number}).identitySetCount)).toBe(1);
  expect(await page.evaluate(()=>(globalThis as unknown as {visitorPosts:string[]}).visitorPosts)).toEqual(['سلام','سلام']);
  expect(await relay.receive()).toEqual([]);
});


test('Goftino captures the responder header for each reply, not message wording or the later header', async ({ page }) => {
  await openGoftinoFixture(page);
  const adapter = await makeAdapter(page,'goftino',{}); await adapter.prepare(identity);
  await page.evaluate(()=>{
    const frame=document.querySelector<HTMLIFrameElement>('#goftino_w')!;
    const header=frame.contentDocument!.createElement('div'); header.id='box-header';
    header.textContent='هوش مصنوعی ایران سرور'; frame.contentDocument!.body.append(header);
    window.dispatchEvent(new CustomEvent('goftino_getMessage',{detail:{type:'text',content:'AI reply'}}));
    header.textContent='Ali';
    window.dispatchEvent(new CustomEvent('goftino_getMessage',{detail:{type:'text',content:'I am an AI assistant'}}));
  });
  await expect.poll(async()=>(await adapter.receive()).length).toBe(2);
  const replies=await adapter.receive();
  expect(replies[0].aiLabel).toBe('هوش مصنوعی ایران سرور');
  expect(replies[1].aiLabel).toBeUndefined();
});
