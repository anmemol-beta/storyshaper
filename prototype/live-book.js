/* Live book UI orchestrator. Story/audio/media engines are owned by their respective teams. */
(() => {
"use strict";
const $ = id => document.getElementById(id);
const ui = Object.fromEntries(["book","cover","storyTitle","readBy","language","mode","settingsButton","readerSettings","readerName","changeVoice","readAloud","imgCur","imgNext","storyVideo","narrative","question","answer","send","mic","status","choices","progress","restart","loading","loadingText","addVoice"].map(id=>[id,$(id)]));
const picture=new StoryImageTransition(ui.imgCur,ui.imgNext,{duration:680});
let snapshot=null,busy=false,epoch=0,presentation=0,controller=null,recording=null,mediaJob=null,retryPayload=null,shownNarration=null;
let voiceName="Default reader",config=null,replayCounter=0;
const say=s=>{ui.status.textContent=s;};
const t=(en,ko)=>ui.language.value==="ko"?ko:en;
const setBusy=(flag,message)=>{busy=flag;ui.send.disabled=flag||!snapshot?.question;ui.mic.disabled=flag||!snapshot?.question||!VoiceInput.supported();ui.answer.disabled=flag||!snapshot?.question;for(const button of ui.choices.children)button.disabled=flag;ui.restart.disabled=false;if(message)say(message);};
function stopVideo(){ui.storyVideo.pause();ui.storyVideo.removeAttribute("src");ui.storyVideo.load();ui.storyVideo.hidden=true;}
function stopNarration(){if(typeof Narration!=="undefined") Narration.stop();}
function cancelMedia(){if(mediaJob?.jobId)fetch("/api/media/cancel",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:mediaJob.sessionId,jobId:mediaJob.jobId})}).catch(()=>{});mediaJob=null;}
function abortOld(){epoch++;presentation++;controller?.abort();controller=null;stopNarration();stopVideo();if(recording){recording.stop();recording=null;}cancelMedia();picture.cancel();ui.loading.hidden=true;ui.book.classList.remove("scene-exit","scene-enter");ui.book.dataset.state="ASKING";}
async function api(path,options={}){const response=await fetch(path,{...options,headers:{"Content-Type":"application/json",...(options.headers||{})},cache:"no-store"});let data;try{data=await response.json()}catch{throw new Error("Invalid server response")}if(!response.ok){const error=new Error(data.error?.message||"Server error");error.code=data.error?.code;error.status=response.status;error.snapshot=data.snapshot;throw error}return data}
function valid(s){return s&&typeof s.sessionId==="string"&&Number.isInteger(s.version)&&Array.isArray(s.lines)&&(s.question===null||typeof s.question?.id==="string")}
// Who reads: the parent voice saved on voice.html (narration.js), or the storybook voice. Without one, offer to add it.
async function reader(){const saved=typeof Narration!=="undefined"&&typeof Narration.voiceName==="function"?Narration.voiceName():null;voiceName=saved||t("Storybook voice","기본 목소리");ui.readerName.textContent=t("Reader: ","읽어주는 목소리: ")+voiceName;ui.readBy.textContent=saved?t("Read by "+saved,saved+" 목소리로 읽어요"):t("Read by the storybook voice","기본 목소리로 읽어요");ui.changeVoice.textContent=saved?t("Change","바꾸기"):t("Add a parent's voice","부모 목소리 추가하기");ui.addVoice.hidden=Boolean(saved);for(const link of [ui.changeVoice,ui.addVoice])link.href="voice.html?return=live.html&lang="+ui.language.value;ui.addVoice.textContent="🎙 "+t("Add a parent's voice","부모 목소리 추가");ui.answer.placeholder=t("Your answer","답변");}
function highlight(index){[...ui.narrative.children].forEach((p,i)=>p.classList.toggle("speaking",i===index));ui.question.classList.toggle("speaking",index===ui.narrative.children.length);}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sameScene=(s,token)=>token===presentation&&snapshot?.sessionId===s.sessionId&&snapshot?.sceneId===s.sceneId&&snapshot?.version===s.version;
function mediaMatches(data,s){return data?.apply===true&&data?.spec?.session_id===s.sessionId&&data?.spec?.scene_id===s.sceneId&&data?.spec?.version===s.version;}
async function sceneImage(s,token){
  if(!s.mediaPlan)return s.sceneId==="house1_choose"?"/prototype/img/empty1.jpg":picture.current.getAttribute("src");
  const bind={sessionId:s.sessionId,sceneId:s.sceneId,version:s.version};
  try{
    let data=await api("/api/media/jobs",{method:"POST",body:JSON.stringify(bind)});
    if(!sameScene(s,token)||!mediaMatches(data,s))return null;
    mediaJob={...bind,jobId:data.jobId};
    const fallback=data.image?.url;
    const until=Date.now()+22000;
    while(data.generationRequested&&["queued","running"].includes(data.status)&&Date.now()<until){
      await pause(650);
      if(!sameScene(s,token))return null;
      data=await api("/api/media/jobs/"+encodeURIComponent(data.jobId)+"?sessionId="+encodeURIComponent(s.sessionId));
      if(!mediaMatches(data,s))return null;
    }
    // A scene keeps one picture. A late result cannot replace its image after narration begins.
    if(["queued","running"].includes(data.status))cancelMedia();
    return data.generated&&data.status==="ready"?data.image.url:fallback||data.image?.url||null;
  }catch{return null;}
}
function preparePicture(url){return new Promise(resolve=>{if(!url)return resolve(false);picture.prepare(url,{onReady:()=>resolve(true),onError:()=>resolve(false)});});}
function renderScene(s){
  const paragraphs=s.lines.map(item=>{const p=document.createElement("p");p.textContent=item.text||"";return p});
  ui.narrative.replaceChildren(...paragraphs);
  ui.question.textContent=s.question?.text||t("The End","이야기 끝");
  ui.answer.value="";
  ui.choices.replaceChildren();
  const choices=s.question?.choices||[];
  if(s.choiceMode&&Array.isArray(choices))for(const choice of choices){const button=document.createElement("button");button.type="button";button.textContent=choice.label;button.onclick=()=>answer(choice.answer,choice.id);ui.choices.append(button)}
  ui.choices.hidden=!s.choiceMode||!choices.length;
  ui.progress.textContent="Scene: "+s.sceneId+" · "+s.version;
  ui.book.dataset.state=s.question?"ASKING":"DONE";
  setBusy(true,t("Reading this scene…","이 장면을 읽고 있어요…"));
  if(!s.question){ui.mic.disabled=true;ui.send.disabled=true}
}
async function readScene(s){
  const choices=s.question?.choices||[];
  const spoken=s.question?[...s.lines,{speakerId:"narrator",text:s.question.text}]:[...s.lines];
  if(s.choiceMode&&choices.length)spoken.push({speakerId:"narrator",text:choices.map((c,i)=>(i+1)+". "+String(c.label).replace(/[.!?]+$/ ,"")+".").join(" ")});
  const key=s.sessionId+":"+s.version+":"+ui.language.value+":"+replayCounter;
  if(ui.readAloud.checked&&typeof Narration!=="undefined"&&shownNarration!==key){shownNarration=key;await Narration.speak(spoken,{key,language:ui.language.value,onLine:highlight})}else highlight(-1);
}
async function display(s){
  if(!valid(s))throw new Error("Invalid story state");
  const token=++presentation;
  snapshot=s;
  stopNarration();highlight(-1);stopVideo();cancelMedia();picture.cancel();
  ui.book.dataset.state="PREPARING";
  ui.loadingText.textContent=t("Preparing the next scene…","다음 장면을 준비하고 있어요…");
  ui.loading.hidden=false;
  setBusy(true,t("Preparing scene…","장면을 준비하고 있어요…"));
  const image=await sceneImage(s,token);
  if(!sameScene(s,token))return;
  const ready=await preparePicture(image);
  if(!sameScene(s,token))return;
  if(!ready){ui.loading.hidden=true;setBusy(true,t("Picture unavailable. Try Restart.","그림을 불러오지 못했어요. 다시 시작해 주세요."));return}
  ui.book.classList.add("scene-exit");
  await pause(matchMedia("(prefers-reduced-motion: reduce)").matches?0:180);
  if(!sameScene(s,token))return;
  renderScene(s);
  picture.reveal();
  ui.loading.hidden=true;
  ui.book.classList.remove("scene-exit");
  ui.book.classList.add("scene-enter");
  await pause(matchMedia("(prefers-reduced-motion: reduce)").matches?0:680);
  if(!sameScene(s,token))return;
  ui.book.classList.remove("scene-enter");
  await readScene(s);
  if(!sameScene(s,token))return;
  setBusy(false,s.decision==="service_error"?t("Voice or AI unavailable. Choose an option to continue.","서비스 오류입니다. 선택지로 진행할 수 있어요."):s.decision==="complete"?t("Story complete","이야기 끝"):t("Your turn","이제 네 차례야"));
}
function showLocalChoices(message){
  if(!snapshot?.question)return;
  const choices=snapshot.question.choices||[];
  if(!choices.length){say(message);return}
  ui.choices.replaceChildren();
  for(const choice of choices){const button=document.createElement("button");button.type="button";button.textContent=choice.label;button.onclick=()=>answer(choice.answer,choice.id);ui.choices.append(button)}
  ui.choices.hidden=false;
  say(message);
  if(ui.readAloud.checked&&typeof Narration!=="undefined")Narration.speak([{speakerId:"narrator",text:message},...choices.map((choice,i)=>({speakerId:"narrator",text:(i+1)+". "+choice.label}))],{key:snapshot.sessionId+":"+snapshot.version+":choices",language:ui.language.value});
}
async function begin(){abortOld();shownNarration=null;ui.cover.hidden=true;ui.narrative.replaceChildren();ui.question.textContent="";ui.choices.hidden=true;setBusy(true,t("Starting story…","동화를 시작합니다…"));const token=epoch;try{const data=await api("/api/sessions",{method:"POST",body:JSON.stringify({mode:ui.mode.value,language:ui.language.value})});if(token===epoch)await display(data)}catch(e){if(token===epoch){setBusy(false,e.message);ui.cover.hidden=false}}}
async function answer(value,choiceId,retained=null){if(busy||!snapshot?.question)return;const text=String(value??"").trim();if(!text&&!choiceId)return;stopNarration();stopVideo();const old=snapshot;const token=epoch;const payload=retained||{sessionId:old.sessionId,version:old.version,questionId:old.question.id,requestId:crypto.randomUUID(),answer:text,...(choiceId?{choiceId}:{})};retryPayload=payload;setBusy(true,t("Thinking…","생각하고 있어요…"));controller=new AbortController();try{const data=await api("/api/answer",{method:"POST",body:JSON.stringify(payload),signal:controller.signal});if(token!==epoch||snapshot?.sessionId!==old.sessionId)return;retryPayload=null;await display(data)}catch(e){if(token!==epoch)return;if(valid(e.snapshot))await display(e.snapshot);setBusy(false,t("Try again: ","다시 시도: ")+e.message);ui.answer.value=text;ui.send.disabled=false}finally{if(token===epoch)controller=null}}
ui.send.onclick=()=>{if(retryPayload)answer(retryPayload.answer,retryPayload.choiceId,retryPayload);else answer(ui.answer.value)};
ui.answer.onkeydown=e=>{if(e.key==="Enter")ui.send.click()};
ui.mic.onclick=async()=>{if(recording){recording.stop();return}if(busy||!snapshot?.question||!VoiceInput.supported())return;stopNarration();const token=epoch;try{const item=await VoiceInput.record();if(token!==epoch){item.stop();return}recording=item;ui.book.dataset.state="LISTENING";say(t("Listening… Tap again to finish.","듣고 있어요. 다시 누르면 완료합니다."));const result=await item.done;recording=null;if(token!==epoch)return;ui.book.dataset.state="ASKING";setBusy(true,t("Recognizing…","음성을 인식하는 중…"));const transcript=await VoiceInput.transcribe(result);if(token!==epoch)return;setBusy(false);ui.answer.value=transcript;if(transcript){say(t("Check the recognized text and press Send.","인식된 내용을 확인하고 전송하세요."))}else showLocalChoices(t("I couldn't hear you. Choose a picture below.","잘 듣지 못했어. 아래 보기를 골라 줘."))}catch(e){recording=null;ui.book.dataset.state="ASKING";if(token===epoch){setBusy(false);showLocalChoices(t("Microphone unavailable. Choose a picture below.","마이크를 쓸 수 없어. 아래 보기를 골라 줘."))}}};
ui.restart.onclick=begin;ui.cover.onclick=begin;
ui.settingsButton.onclick=()=>ui.readerSettings.hidden=!ui.readerSettings.hidden;
ui.readAloud.checked=localStorage.getItem("story-read-aloud")!=="0";
ui.readAloud.onchange=async()=>{localStorage.setItem("story-read-aloud",ui.readAloud.checked?"1":"0");if(!ui.readAloud.checked){stopNarration();return}if(snapshot&&!busy){const s=snapshot,token=presentation;replayCounter++;shownNarration=null;setBusy(true,t("Reading this scene…","이 장면을 읽고 있어요…"));await readScene(s);if(sameScene(s,token))setBusy(false,t("Your turn","이제 네 차례야"))}};
ui.language.onchange=async()=>{try{localStorage.setItem("story-language",ui.language.value)}catch{}reader();if(!snapshot)return;abortOld();shownNarration=null;setBusy(true,t("Changing language…","언어 변경 중…"));const token=epoch;try{const data=await api("/api/language",{method:"POST",body:JSON.stringify({sessionId:snapshot.sessionId,version:snapshot.version,language:ui.language.value})});if(token===epoch)await display(data)}catch(e){if(token===epoch)setBusy(false,e.message)}};
ui.mode.onchange=()=>{if(snapshot)begin()};
window.addEventListener("pagehide",abortOld);
ui.language.value=localStorage.getItem("story-language")==="en"?"en":"ko";reader();window.addEventListener("focus",reader);
})();
