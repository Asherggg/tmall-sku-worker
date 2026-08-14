import fs from "node:fs";
import path from "node:path";

const ITEM_URL = "https://sell.publish.tmall.com/tmall/publish.htm?id=828872681901";
const portFile = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data", "DevToolsActivePort");
const [port, browserPath] = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ws.onmessage = ({ data }) => {
      const m = JSON.parse(data);
      if (m.id != null && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else if (m.method) this.events.push(m);
    };
  }
  open() { return new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; }); }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 25000);
    });
  }
  close() { this.ws.close(); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function evalPage(c, sid, expression) {
  const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "Runtime evaluation failed");
  return r.result?.value;
}

const snapshotExpr = String.raw`(() => {
  const clone = (x) => { try { return JSON.parse(JSON.stringify(x)); } catch { return null; } };
  const cache = window.GlobalStore?.engine?._engine?._core?._componentCache;
  const sku = cache?.sku ? clone(cache.sku.getProps().value || []) : null;
  const saleProps = cache?.saleProp ? clone(cache.saleProp.getProps().value || {}) : null;
  const oldSku = cache?.sku ? clone(cache.sku.getProps().attributes?.skuOldSku?.value || []) : null;
  const drawer = document.querySelector('.sku-decouple-drawer-container');
  const visible = (e) => { if (!e) return false; const r=e.getBoundingClientRect(), s=getComputedStyle(e); return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden'; };
  const root = drawer && visible(drawer) ? drawer : null;
  const controls = root ? [...root.querySelectorAll('input,button')].filter(visible).map((e,i)=>({i,tag:e.tagName,type:e.type||null,text:(e.innerText||e.textContent||'').trim(),value:e.value||'',cls:String(e.className||''),placeholder:e.placeholder||null,disabled:!!e.disabled})) : [];
  return {url:location.href,drawerOpen:!!root,saleProps,sku,oldSku,controls,text:root?.innerText?.slice(0,12000)||'',capturedAt:new Date().toISOString()};
})()`;

async function getTarget(c) {
  const { targetInfos } = await c.send("Target.getTargets");
  const pages = targetInfos.filter((x) => x.type === "page" && x.url === ITEM_URL);
  if (!pages.length) throw new Error("No item page target");
  for (const page of pages) {
    const { sessionId } = await c.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    const focused = await evalPage(c, sessionId, "document.hasFocus()");
    if (focused) return { ...page, sessionId };
    if (!pages.some((p) => p.focused)) pages[0].sessionId ||= sessionId;
  }
  const page = pages[0];
  if (!page.sessionId) page.sessionId = (await c.send("Target.attachToTarget", { targetId: page.targetId, flatten: true })).sessionId;
  return page;
}

function requestSummary(event) {
  const p = event.params;
  const r = p.request || {};
  const headers = {};
  for (const [k,v] of Object.entries(r.headers || {})) headers[k] = /cookie|authorization|token|sign|secret/i.test(k) ? "<redacted>" : String(v);
  return {requestId:p.requestId,type:p.type,method:r.method,url:r.url,headers,postData:r.postData || null,initiator:p.initiator?.type || null,timestamp:p.timestamp};
}

function responseSummary(event) {
  const p = event.params;
  const r = p.response || {};
  const headers = {};
  for (const [k,v] of Object.entries(r.headers || {})) headers[k] = /cookie|authorization|token|sign|secret/i.test(k) ? "<redacted>" : String(v);
  return {requestId:p.requestId,status:r.status,statusText:r.statusText,mimeType:r.mimeType,url:r.url,headers,encodedDataLength:r.encodedDataLength,timestamp:p.timestamp};
}

async function main() {
  const command = process.argv[2] || "delete-sizes";
  const c = new Cdp(`ws://127.0.0.1:${port}${browserPath}`);
  await c.open();
  const outDir = path.join(process.cwd(), ".runtime", "tmall-spec"); fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(outDir, `workflow-${command}-${stamp}.json`);
  try {
    const target = await getTarget(c); const sid = target.sessionId;
    await c.send("Runtime.enable", {}, sid); await c.send("Network.enable", {maxTotalBufferSize:50*1024*1024,maxResourceBufferSize:10*1024*1024}, sid); await c.send("Page.enable", {}, sid);
    const stages = [{name:"before",snapshot:await evalPage(c,sid,snapshotExpr)}];
    if (command === "delete-sizes") {
      await evalPage(c, sid, String.raw`(() => { const r=document.querySelector('.sku-decouple-drawer-container'); const bs=[...r.querySelectorAll('button.color-delete-icon')]; if(bs.length<2) throw new Error('expected 2 size delete buttons'); bs[1].click(); return true; })()`);
      await sleep(700);
      await evalPage(c, sid, String.raw`(() => { const r=document.querySelector('.sku-decouple-drawer-container'); const bs=[...r.querySelectorAll('button.color-delete-icon')]; if(bs.length<1) throw new Error('expected remaining size delete button'); bs[0].click(); return true; })()`);
      await sleep(1200);
      stages.push({name:"after-delete-sizes",snapshot:await evalPage(c,sid,snapshotExpr)});
    } else if (command === "delete-color") {
      await evalPage(c, sid, String.raw`(() => { const r=document.querySelector('.sku-decouple-drawer-container'); const sections=[...r.querySelectorAll('[id^="struct-p-"]')]; const sec=sections.find(x=>x.id==='struct-p-1627207'); const b=sec?.querySelector('button.color-delete-icon'); if(!b) throw new Error('color delete button not found'); b.click(); return true; })()`);
      await sleep(1200); stages.push({name:"after-delete-color",snapshot:await evalPage(c,sid,snapshotExpr)});
    } else if (command === "confirm-create") {
      const pre = await evalPage(c, sid, String.raw`(() => {
        const s = window.GlobalStore.engine.getComponent('saleProp').getProps().value || {};
        const expected = {
          'p-5569827': ['1.5米床 适配200*230cm被芯', '1.8米床 适配220*240cm被芯'],
          'p-1627207': ['【60支长绒棉+A类标准+贡缎工艺】云影微澜']
        };
        for (const [key, texts] of Object.entries(expected)) {
          const actual = (s[key] || []).map(x => x.text);
          if (actual.length !== texts.length || actual.some((x, i) => x !== texts[i])) throw new Error('saleProp mismatch ' + key + ': ' + JSON.stringify(actual));
        }
        return {saleProps:s, skuCount:window.GlobalStore.engine.getComponent('sku').getProps().value?.length || 0};
      })()`);
      stages.push({name:"pre-confirm-validation",snapshot:await evalPage(c,sid,snapshotExpr),validation:pre});
      await evalPage(c, sid, String.raw`(() => { const bs=[...document.querySelectorAll('button')]; const b=bs.find(x => (x.innerText||x.textContent||'').trim()==='确认创建' && x.getBoundingClientRect().width>0); if(!b) throw new Error('确认创建 button not found'); b.click(); return true; })()`);
      await sleep(2500);
      stages.push({name:"after-confirm-create",snapshot:await evalPage(c,sid,snapshotExpr)});
    } else {
      throw new Error(`unknown command ${command}`);
    }
    await sleep(500);
    const events = c.events.filter((e) => !e.sessionId || e.sessionId === sid);
    const requests = events.filter((e) => e.method === 'Network.requestWillBeSent').map(requestSummary);
    const responses = events.filter((e) => e.method === 'Network.responseReceived').map(responseSummary);
    const failures = events.filter((e) => e.method === 'Network.loadingFailed').map(e=>({requestId:e.params.requestId,errorText:e.params.errorText,canceled:e.params.canceled}));
    const output={command,targetId:target.targetId,stages,requests,responses,failures,capturedAt:new Date().toISOString()};
    fs.writeFileSync(outFile,JSON.stringify(output,null,2)+'\n','utf8');
    console.log(JSON.stringify({outFile,targetId:target.targetId,stages:stages.map(s=>({name:s.name,drawerOpen:s.snapshot.drawerOpen,skuCount:s.snapshot.sku?.length,saleProps:s.snapshot.saleProps})),requestCount:requests.length,responseCount:responses.length,failures},null,2));
  } finally { c.close(); }
}
main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
