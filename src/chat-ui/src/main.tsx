import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github.css";
import { createRoot } from "react-dom/client";
import { loadConversations, saveConversations, type ChatMessage, type Conversation } from "./chatStore";
import "./style.css";

type Envelope = { type: string; requestId: string; success?: boolean; data?: any; event?: string };
type SourceLink = {title:string|null;url:string;snippet:string|null;siteName:string|null};\ntype Pending = { resolve:(v:any)=>void; reject:(e:Error)=>void; onStream?:(v:any,kind?:string)=>void };
const pending = new Map<string, Pending>();
const id = () => crypto.randomUUID();
function invoke(action:string,payload:any={},onStream?:(v:any,kind?:string)=>void,requestId=id()):Promise<any>{
  return new Promise((resolve,reject)=>{
    pending.set(requestId,{resolve,reject,onStream});
    window.chrome.webview.postMessage({type:"request",requestId,action,payload});
  });
}
declare global { interface Window { chrome:any; deepDeskReceive:(m:Envelope)=>void } }
window.deepDeskReceive=(m)=>{
  const p=pending.get(m.requestId); if(!p)return;
  if(m.type==="stream"){
    if(m.event==="delta")p.onStream?.(m.data?.text??"",m.data?.kind??"content");
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
 const [input,setInput]=React.useState(""),[conversations,setConversations]=React.useState<Conversation[]>([]),[activeId,setActiveId]=React.useState("");
 const [error,setError]=React.useState(""),[model,setModel]=React.useState("deepseek-flash"),[thinking,setThinking]=React.useState(false),[search,setSearch]=React.useState(false),[reasoning,setReasoning]=React.useState(""),[streamStatus,setStreamStatus]=React.useState("");
 const [loaded,setLoaded]=React.useState(false),[testing,setTesting]=React.useState(false),[recording,setRecording]=React.useState(false),[transcribing,setTranscribing]=React.useState(false),[readingId,setReadingId]=React.useState<string|null>(null);
 const mediaRef=React.useRef<MediaStream|null>(null),audioContextRef=React.useRef<AudioContext|null>(null),processorRef=React.useRef<ScriptProcessorNode|null>(null),chunksRef=React.useRef<Float32Array[]>([]),frameCountRef=React.useRef(0),playbackRef=React.useRef<AudioContext|null>(null);
 const active=conversations.find(c=>c.id===activeId);
 const messages=active?.messages??[];
 React.useEffect(()=>{
   Promise.all([invoke("app.getStatus"),loadConversations()]).then(([status,history])=>{
     setConfigured(!!status.apiKeyConfigured);setConversations(history);
     if(history.length)setActiveId(history.slice().sort((a,b)=>b.updatedAt-a.updatedAt)[0].id);
     setLoaded(true);
   }).catch(e=>{setError(e.message);setLoaded(true);});
 },[]);
 React.useEffect(()=>{if(loaded)void saveConversations(conversations).catch(e=>setError(e.message));},[conversations,loaded]);
 React.useEffect(()=>()=>{mediaRef.current?.getTracks().forEach(t=>t.stop());void audioContextRef.current?.close();void playbackRef.current?.close();},[]);
 async function saveKey(){
   setError("");setTesting(true);
   try{await invoke("settings.configureApiKey");setConfigured(true);setShowSettings(false);}
   catch(e:any){setError(e.message);}
   finally{setTesting(false);}
 }
 async function send(){
   if(!input.trim()||busy||!configured)return;
   const prompt=input.trim(),requestId=id(),chatId=activeId||id(),userMessage:ChatMessage={id:id(),role:"user",text:prompt},assistantMessage:ChatMessage={id:id(),role:"assistant",text:""};
   const apiMessages=[...messages,userMessage].slice(-100).map(m=>({role:m.role,content:m.text})).filter(m=>m.content.length>0);
   setInput("");setError("");setReasoning("");setStreamStatus("");setBusy(true);setActiveRequest(requestId);
   setConversations(current=>{
     const exists=current.some(c=>c.id===chatId);
     if(!exists)return [...current,{id:chatId,title:prompt.slice(0,32),updatedAt:Date.now(),messages:[userMessage,assistantMessage]}];
     return current.map(c=>c.id===chatId?{...c,title:c.messages.length?c.title:prompt.slice(0,32),updatedAt:Date.now(),messages:[...c.messages,userMessage,assistantMessage]}:c);
   });
   if(!activeId)setActiveId(chatId);
   try{
     await invoke("api.chat",{model,messages:apiMessages,thinking,search},(chunk,kind)=>{
       if(kind==="reasoning")setReasoning(v=>v+chunk);
       else if(kind==="status")setStreamStatus(chunk);
       else setConversations(current=>current.map(c=>c.id===chatId?{...c,updatedAt:Date.now(),messages:c.messages.map((m,i)=>i===c.messages.length-1?{...m,text:m.text+chunk}:m)}:c));
     },requestId);
   }catch(e:any){setError(e.message);}
   finally{setBusy(false);setActiveRequest(null);setStreamStatus("");}
 }
 async function readAloud(message:ChatMessage){
   if(readingId){await playbackRef.current?.close();playbackRef.current=null;setReadingId(null);return;}
   if(!message.text.trim())return;
   setReadingId(message.id);
   try{
     const result=await invoke("speech.synthesize",{text:message.text,voice:"stella"});
     const binary=atob(result.audioBase64),pcm=new Int16Array(binary.length/2);
     for(let i=0;i<pcm.length;i++)pcm[i]=(binary.charCodeAt(i*2)|(binary.charCodeAt(i*2+1)<<8));
     const context=new AudioContext();playbackRef.current=context;
     const buffer=context.createBuffer(1,pcm.length,result.sampleRate||24000),channel=buffer.getChannelData(0);
     for(let i=0;i<pcm.length;i++)channel[i]=pcm[i]<0?pcm[i]/32768:pcm[i]/32767;
     const source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);
     source.onended=()=>{if(playbackRef.current===context){void context.close();playbackRef.current=null;setReadingId(null);}};
     await context.resume();source.start();
   }catch(e:any){setError(e.message);setReadingId(null);}
 }
 async function toggleVoice(){
   if(recording){
     setRecording(false);
     processorRef.current?.disconnect();processorRef.current=null;
     const stream=mediaRef.current;stream?.getTracks().forEach(t=>t.stop());mediaRef.current=null;
     const context=audioContextRef.current;audioContextRef.current=null;
     if(!context)return;
     const sampleRate=context.sampleRate,frames=frameCountRef.current;frameCountRef.current=0;
     const pcm=new Int16Array(frames);let offset=0;
     for(const chunk of chunksRef.current){for(let i=0;i<chunk.length;i++){const value=Math.max(-1,Math.min(1,chunk[i]));pcm[offset++]=value<0?value*32768:value*32767;}}
     chunksRef.current=[];
     const wav=new ArrayBuffer(44+pcm.byteLength),view=new DataView(wav);
     const write=(at:number,value:string)=>{for(let i=0;i<value.length;i++)view.setUint8(at+i,value.charCodeAt(i));};
     write(0,"RIFF");view.setUint32(4,36+pcm.byteLength,true);write(8,"WAVE");write(12,"fmt ");view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);write(36,"data");view.setUint32(40,pcm.byteLength,true);
     new Uint8Array(wav,44).set(new Uint8Array(pcm.buffer));
     await context.close();setTranscribing(true);setError("");
     try{const bytes=new Uint8Array(wav);let binary="";for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));const result=await invoke("speech.transcribe",{audioBase64:btoa(binary)});setInput(v=>v+(v?" ":"")+(result.text??""));}
     catch(e:any){setError(e.message);}finally{setTranscribing(false);}
     return;
   }
   if(!navigator.mediaDevices?.getUserMedia){setError("当前环境不支持麦克风录音。");return;}
   try{
     const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true}});
     const context=new AudioContext();const source=context.createMediaStreamSource(stream);const processor=context.createScriptProcessor(4096,1,1);
     chunksRef.current=[];frameCountRef.current=0;processor.onaudioprocess=e=>{
       if(!mediaRef.current)return;
       const chunk=new Float32Array(e.inputBuffer.getChannelData(0));frameCountRef.current+=chunk.length;
       if(frameCountRef.current>4_000_000){
         stream.getTracks().forEach(t=>t.stop());mediaRef.current=null;processor.disconnect();processorRef.current=null;
         void context.close();audioContextRef.current=null;chunksRef.current=[];setRecording(false);setError("录音时长超过限制（约 80 秒），请分段录入。");return;
       }
       chunksRef.current.push(chunk);
     };
     source.connect(processor);processor.connect(context.destination);
     mediaRef.current=stream;audioContextRef.current=context;processorRef.current=processor;setRecording(true);
   }catch(e:any){setError(e.name==="NotAllowedError"?"麦克风权限被拒绝，请在 Windows 权限设置中允许麦克风。":"无法启动麦克风录音。");}
 }
 async function stop(){if(!activeRequest)return;try{await invoke("api.cancel",{targetRequestId:activeRequest});}catch(e:any){setError(e.message);}}
 function newChat(){if(busy)return;const chatId=id();setConversations(c=>[...c,{id:chatId,title:"新对话",updatedAt:Date.now(),messages:[]}]);setActiveId(chatId);setError("");setInput("");setReasoning("");}
 const canSend=!!input.trim()&&!busy&&configured;
 return <div className="shell">
  <aside><div className="brand"><div className="mark">D</div><div><b>DeepDesk</b><small>YOUR AI, YOUR DESKTOP</small></div></div>
   <button className="new" onClick={newChat}>＋ 新建对话</button>
   <div className="history-label">最近对话</div><div className="history-list">{conversations.slice().sort((a,b)=>b.updatedAt-a.updatedAt).map(c=><button key={c.id} className={c.id===activeId?"history-item active":"history-item"} onClick={()=>{if(!busy){setActiveId(c.id);setError("");setReasoning("");}}}>{c.title||"新对话"}</button>)}</div>
   <div className="side-bottom">会话与消息保存在本机<br/>独立第三方客户端</div>
  </aside>
  <main><header><div><b>{active?.title||"新对话"}</b><span className="sub">模型推理由你的 API 账号提供</span></div><div className="header-actions">
    <select value={model} onChange={e=>setModel(e.target.value)}><option value="deepseek-flash">DeepSeek-V4.1-Flash</option><option value="deepseek-v4-pro">DeepSeek-V4-Pro</option></select>
    <button className="settings-button" onClick={()=>setShowSettings(true)}>API 设置</button>
   </div></header>
   <section className="conversation">
    {!messages.length&&!busy?<div className="welcome"><div className="welcome-icon">✳</div><h1>有什么可以帮忙的？</h1><p>使用你自己的 DeepSeek API，开始一段新的对话。</p><div className="suggestions"><button onClick={()=>setInput("解释一下人工智能中的 Agent 架构")}>解释一个技术概念</button><button onClick={()=>setInput("帮我制定一个清晰的项目计划")}>制定项目计划</button></div></div>:
      <div className="message-list">{messages.map(m=><div className="message" key={m.id}><div className={m.role==="user"?"avatar user-avatar":"avatar"}>{m.role==="user"?"我":"AI"}</div><div className="message-content"><div className="bubble">{m.role==="assistant"?<ReactMarkdown remarkPlugins={[remarkGfm,remarkMath]} rehypePlugins={[rehypeKatex,rehypeHighlight]} components={{a:({href,children})=><a href={href} onClick={e=>{e.preventDefault();if(href)void invoke("app.openExternal",{url:href}).catch(err=>setError(err.message));}}>{children}</a>}}>{m.text|| (busy?"正在思考…":"")}</ReactMarkdown>:m.text}</div>{m.role==="assistant"&&m.sources?.length?<div className="sources"><b>参考来源</b>{m.sources.map(source=><a key={source.url} href={source.url} onClick={e=>{e.preventDefault();void invoke("app.openExternal",{url:source.url}).catch(err=>setError(err.message));}}><span>{source.siteName||"网页"}</span><strong>{source.title||source.url}</strong>{source.snippet&&<small>{source.snippet}</small>}</a>)}</div>:null}{m.role==="assistant"&&m.text&&<button className="read-aloud" onClick={()=>void readAloud(m)}>{readingId===m.id?"停止朗读":"朗读"}</button>}</div></div>)}</div>}
    {streamStatus&&<div className="stream-status">{streamStatus}</div>}{reasoning&&<details className="reasoning" open><summary>深度思考过程</summary><div>{reasoning}</div></details>}{error&&<div className="error">{error}</div>}
   </section>
   <footer><div className="composer"><textarea value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();void send();}}} placeholder="给 DeepSeek 发送消息…" rows={3}/>
    <div className="composer-bottom"><div className="toggles"><label><input type="checkbox" checked={thinking} onChange={e=>setThinking(e.target.checked)}/> 深度思考</label><label><input type="checkbox" checked={search} onChange={e=>setSearch(e.target.checked)}/> 联网搜索</label></div><span>Enter 发送 · Shift + Enter 换行</span><button className={recording?"mic-button recording":"mic-button"} disabled={transcribing||busy} onClick={()=>void toggleVoice()} title={recording?"结束录音":"语音输入"}>{transcribing?"识别中…":recording?"■":"🎙"}</button>
     {busy?<button className="send stop" onClick={()=>void stop()}>■</button>:<button className="send" disabled={!canSend} onClick={()=>void send()}>↑</button>}
    </div></div><div className="footnote">AI 生成内容可能不准确。请求将直接发送至 DeepSeek 官方 API。</div></footer>
  </main>
  {(!configured||showSettings)&&<div className="overlay"><div className="setup"><button className="close" onClick={()=>{if(configured)setShowSettings(false);}}>×</button><div className="mark large">D</div><h2>{configured?"API 设置":"连接你的 DeepSeek API"}</h2><p>输入你在 DeepSeek 开放平台创建的 API Key。密钥由 Windows DPAPI 加密保存在本机，不会传给 DeepDesk 服务器。</p><div className="native-key-note">将打开 Windows 原生安全输入窗口。API Key 不会经过网页脚本。</div>
    {error&&<div className="error">{error}</div>}<button className="primary" onClick={()=>void saveKey()} disabled={testing}>{testing?"正在验证…":"打开安全窗口并保存 API Key"}</button>
    <small>还没有 API Key？请前往 DeepSeek 官方开放平台申请。</small></div></div>}
 </div>;
}
createRoot(document.getElementById("root")!).render(<App/>);
