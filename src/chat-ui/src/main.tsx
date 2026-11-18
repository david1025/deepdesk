import React from "react";
import { createRoot } from "react-dom/client";
import { loadMessages, saveMessages, type ChatMessage } from "./chatStore";
import "./style.css";

type Envelope = { type: string; requestId: string; success?: boolean; data?: any; event?: string };
type Pending = { resolve:(v:any)=>void; reject:(e:Error)=>void; onStream?:(v:any)=>void };
const pending = new Map<string, Pending>();
const id = () => crypto.randomUUID();
function invoke(action:string,payload:any={},onStream?:(v:any)=>void,requestId=id()):Promise<any>{
  return new Promise((resolve,reject)=>{
    pending.set(requestId,{resolve,reject,onStream});
    window.chrome.webview.postMessage({type:"request",requestId,action,payload});
  });
}
declare global { interface Window { chrome:any; deepDeskReceive:(m:Envelope)=>void } }
window.deepDeskReceive=(m)=>{
  const p=pending.get(m.requestId); if(!p)return;
  if(m.type==="stream"){
    if(m.event==="delta")p.onStream?.(m.data?.text??"");
    if(m.event==="completed"){p.resolve(true);pending.delete(m.requestId);}
    return;
  }
  if(m.type==="response"){
    if(m.success)p.resolve(m.data);else p.reject(new Error(m.data?.message??"请求失败"));
    pending.delete(m.requestId);
  }
};
window.chrome.webview.addEventListener("message",(event:any)=>window.deepDeskReceive(event.data));

function App(){
 const [configured,setConfigured]=React.useState(false),[showSettings,setShowSettings]=React.useState(false);
 const [busy,setBusy]=React.useState(false),[activeRequest,setActiveRequest]=React.useState<string|null>(null);
 const [input,setInput]=React.useState(""),[messages,setMessages]=React.useState<ChatMessage[]>([]);
 const [error,setError]=React.useState(""),[model,setModel]=React.useState("deepseek-flash"),[thinking,setThinking]=React.useState(true);
 const [loaded,setLoaded]=React.useState(false),[testing,setTesting]=React.useState(false);
 React.useEffect(()=>{
   Promise.all([invoke("app.getStatus"),loadMessages()]).then(([status,history])=>{
     setConfigured(!!status.apiKeyConfigured);setMessages(history);setLoaded(true);
   }).catch(e=>{setError(e.message);setLoaded(true);});
 },[]);
 React.useEffect(()=>{if(loaded)void saveMessages(messages).catch(e=>setError(e.message));},[messages,loaded]);

 async function saveKey(){
   setError("");setTesting(true);
   try{
     await invoke("settings.configureApiKey");
     setConfigured(true);setShowSettings(false);
   }catch(e:any){setError(e.message);}
   finally{setTesting(false);}
 }
 async function send(){
   if(!input.trim()||busy)return;
   const prompt=input.trim(),requestId=id();
   setInput("");setError("");setBusy(true);setActiveRequest(requestId);
   setMessages(current=>[...current,{id:id(),role:"user",text:prompt},{id:id(),role:"assistant",text:""}]);
   try{
     await invoke("api.chat",{model,messages:[...messages,{id:id(),role:"user",text:prompt}].map(m=>({role:m.role,content:m.text})).filter(m=>m.content.length>0),thinking},chunk=>{
       setMessages(current=>current.map((m,i)=>i===current.length-1?{...m,text:m.text+chunk}:m));
     },requestId);
   }catch(e:any){setError(e.message);}
   finally{setBusy(false);setActiveRequest(null);}
 }
 async function stop(){
   if(!activeRequest)return;
   try{await invoke("api.cancel",{targetRequestId:activeRequest});}catch(e:any){setError(e.message);}
 }
 function newChat(){if(busy)return;setMessages([]);setError("");setInput("");}
 const canSend=!!input.trim()&&!busy&&configured;
 return <div className="shell">
  <aside><div className="brand"><div className="mark">D</div><div><b>DeepDesk</b><small>YOUR AI, YOUR DESKTOP</small></div></div>
   <button className="new" onClick={newChat}>＋ 新建对话</button>
   <div className="side-note">本地优先 · 自带 API Key</div>
   <div className="side-bottom">会话数据保存在本机<br/>独立第三方客户端</div>
  </aside>
  <main><header><div><b>新对话</b><span className="sub">模型推理由你的 API 账号提供</span></div><div className="header-actions">
    <select value={model} onChange={e=>setModel(e.target.value)}><option value="deepseek-flash">DeepSeek-V4.1-Flash</option><option value="deepseek-v4-pro">DeepSeek-V4-Pro</option></select>
    <button className="settings-button" onClick={()=>setShowSettings(true)}>API 设置</button>
   </div></header>
   <section className="conversation">
    {!messages.length&&!busy?<div className="welcome"><div className="welcome-icon">✳</div><h1>有什么可以帮忙的？</h1><p>使用你自己的 DeepSeek API，开始一段新的对话。</p><div className="suggestions"><button onClick={()=>setInput("解释一下人工智能中的 Agent 架构")}>解释一个技术概念</button><button onClick={()=>setInput("帮我制定一个清晰的项目计划")}>制定项目计划</button></div></div>:
      <div className="message-list">{messages.map(m=><div className="message" key={m.id}><div className={m.role==="user"?"avatar user-avatar":"avatar"}>{m.role==="user"?"我":"AI"}</div><div className="bubble">{m.text|| (busy&&m.role==="assistant"?"正在思考…":"")}</div></div>)}</div>}
    {error&&<div className="error">{error}</div>}
   </section>
   <footer><div className="composer"><textarea value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();void send();}}} placeholder="给 DeepSeek 发送消息…" rows={3}/>
    <div className="composer-bottom"><label><input type="checkbox" checked={thinking} onChange={e=>setThinking(e.target.checked)}/> 深度思考</label><span>Enter 发送 · Shift + Enter 换行</span>
     {busy?<button className="send stop" onClick={()=>void stop()}>■</button>:<button className="send" disabled={!canSend} onClick={()=>void send()}>↑</button>}
    </div></div><div className="footnote">AI 生成内容可能不准确。请求将直接发送至 DeepSeek 官方 API。</div></footer>
  </main>
  {(!configured||showSettings)&&<div className="overlay"><div className="setup"><button className="close" onClick={()=>{if(configured)setShowSettings(false);}}>×</button><div className="mark large">D</div><h2>{configured?"API 设置":"连接你的 DeepSeek API"}</h2><p>输入你在 DeepSeek 开放平台创建的 API Key。密钥由 Windows DPAPI 加密保存在本机，不会传给 DeepDesk 服务器。</p><div className="native-key-note">将打开 Windows 原生安全输入窗口。API Key 不会经过网页脚本。</div>
    {error&&<div className="error">{error}</div>}<button className="primary" onClick={()=>void saveKey()} disabled={testing}>{testing?"正在验证…":"打开安全窗口并保存 API Key"}</button>
    <small>还没有 API Key？请前往 DeepSeek 官方开放平台申请。</small></div></div>}
 </div>;
}
createRoot(document.getElementById("root")!).render(<App/>);
