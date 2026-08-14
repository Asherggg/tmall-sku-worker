import fs from "node:fs";
import path from "node:path";
const portFile = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data", "DevToolsActivePort");
const [port, browserPath] = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);
class C {
  constructor(url){this.ws=new WebSocket(url);this.id=0;this.p=new Map();this.ws.onmessage=({data})=>{const m=JSON.parse(data),p=this.p.get(m.id);if(!p)return;this.p.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}}
  open(){return new Promise((r,j)=>{this.ws.onopen=r;this.ws.onerror=j})}
  send(method,params={},sid){return new Promise((r,j)=>{const id=++this.id;this.p.set(id,{resolve:r,reject:j});this.ws.send(JSON.stringify({id,method,params,...(sid?{sessionId:sid}:{})}));setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);j(new Error('timeout '+method))}},20000)})}
  close(){this.ws.close()}
}
const selector=process.argv[2]||'#struct-p-5569827 input[role=combobox]'; const text=process.argv[3]||''; const key=process.argv[4]||'';
const c=new C(`ws://127.0.0.1:${port}${browserPath}`); await c.open();
try{const {targetInfos}=await c.send('Target.getTargets');const pages=targetInfos.filter(x=>x.type==='page'&&/sell\.publish\.tmall\.com\/tmall\/publish\.htm\?id=828872681901/.test(x.url));let a;
 for(const p of pages){const {sessionId}=await c.send('Target.attachToTarget',{targetId:p.targetId,flatten:true});const q=await c.send('Runtime.evaluate',{expression:'document.hasFocus()',returnByValue:true},sessionId);if(q.result?.value){a={...p,sessionId};break}if(!a)a={...p,sessionId}}
 const sid=a.sessionId; await c.send('Runtime.evaluate',{expression:`document.querySelector(${JSON.stringify(selector)})?.focus()`,returnByValue:true},sid);
 if (text) {
   await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65,nativeVirtualKeyCode:65},sid);
   await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65,nativeVirtualKeyCode:65},sid);
   await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8,nativeVirtualKeyCode:8},sid);
   await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8,nativeVirtualKeyCode:8},sid);
 }
 if(text) await c.send('Input.insertText',{text},sid);
 if(key){await c.send('Input.dispatchKeyEvent',{type:'keyDown',key,code:key==='Enter'?'Enter':key==='Escape'?'Escape':key,windowsVirtualKeyCode:key==='Enter'?13:key==='Escape'?27:0,nativeVirtualKeyCode:key==='Enter'?13:key==='Escape'?27:0},sid);await c.send('Input.dispatchKeyEvent',{type:'keyUp',key,code:key==='Enter'?'Enter':key==='Escape'?'Escape':key,windowsVirtualKeyCode:key==='Enter'?13:key==='Escape'?27:0,nativeVirtualKeyCode:key==='Enter'?13:key==='Escape'?27:0},sid)}
 console.log(JSON.stringify({targetId:a.targetId,selector,text,key},null,2));
}finally{c.close()}
