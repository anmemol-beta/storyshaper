// Drive the real, visible Edge page over Chrome DevTools Protocol (no test package needed).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function main() {
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find(item => item.type === 'page' && item.url.includes('/prototype/live.html'));
if (!page) throw new Error('live.html is not open in Edge');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, {once: true});
  socket.addEventListener('error', reject, {once: true});
});
let nextId = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const data = JSON.parse(event.data);
  if (!data.id || !pending.has(data.id)) return;
  const {resolve, reject} = pending.get(data.id);
  pending.delete(data.id);
  data.error ? reject(new Error(data.error.message)) : resolve(data.result);
});
function cdp(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject});
    socket.send(JSON.stringify({id, method, params}));
  });
}
async function evalPage(expression) {
  const result = await cdp('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true, userGesture: true});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
async function waitFor(expression, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await evalPage(expression);
    if (result) return result;
    await delay(500);
  }
  throw new Error(`Timed out: ${expression}`);
}
async function capture(label) {
  const {data} = await cdp('Page.captureScreenshot', {format: 'png'});
  const file = path.join(os.tmpdir(), `storyshaper-${label}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`screenshot ${file}`);
}
async function state(label) {
  const value = await evalPage(`({url:location.href,mode:document.querySelector('#mode').value,language:document.querySelector('#language').value,coverHidden:document.querySelector('#cover').hidden,progress:document.querySelector('#progress').textContent,question:document.querySelector('#question').textContent,status:document.querySelector('#status').textContent,image:document.querySelector('.art img.is-current')?.getAttribute('src'),readAloud:document.querySelector('#readAloud').checked})`);
  console.log(label, JSON.stringify(value));
  await capture(label);
  return value;
}
try {
  await cdp('Page.bringToFront');
  if (process.argv.includes('--audio-check')) {
    console.log('audio_check',JSON.stringify(await evalPage(`(async()=>{
      const clip=new Audio('/prototype/audio/0826364242a2.mp3');clip.volume=1;window.__audioCheck=clip;
      const events=[];for(const name of ['loadstart','canplay','play','playing','ended','error'])clip.addEventListener(name,()=>events.push(name));
      try {await clip.play()} catch(e) {events.push(String(e))}
      await new Promise(resolve=>setTimeout(resolve,1800));
      return {events,paused:clip.paused,currentTime:clip.currentTime,duration:clip.duration,readyState:clip.readyState,error:clip.error?.message,muted:clip.muted,volume:clip.volume};
    })()`)));
    return;
  }
  if (process.argv.includes('--parent-fallback')) {
    const result=await evalPage(`(async()=>{
      localStorage.setItem('story-voice','test-unready-parent');
      const originalFetch=window.fetch.bind(window),originalSpeak=speechSynthesis.speak.bind(speechSynthesis);
      let firstSpeak=null;
      window.fetch=(url,...args)=>String(url).includes('/api/voice/lines')
        ? Promise.resolve(new Response(JSON.stringify({clips:[{ready:false,url:'/audio/not-ready.mp3'}]}),{status:200,headers:{'Content-Type':'application/json'}}))
        : originalFetch(url,...args);
      speechSynthesis.speak=utterance=>{firstSpeak=performance.now();return originalSpeak(utterance)};
      const started=performance.now();
      const reading=Narration.speak([{speakerId:'narrator',text:'A short test of the storybook voice.'}],{key:'parent-fallback-test',language:'en'});
      const until=Date.now()+3000;
      while(firstSpeak===null&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20));
      const delayMs=firstSpeak===null?null:Math.round(firstSpeak-started);
      Narration.stop();await reading;
      speechSynthesis.speak=originalSpeak;window.fetch=originalFetch;
      localStorage.removeItem('story-voice');
      return {delayMs,immediate:delayMs!==null&&delayMs<1000};
    })()`);
    console.log('parent_voice_fallback',JSON.stringify(result));
    if(!result.immediate)throw new Error('Unready parent voice delayed browser narration');
    return;
  }
  if (process.argv.includes('--inspect')) {
    console.log('audio_inspect',JSON.stringify(await evalPage(`({progress:document.querySelector('#progress').textContent,status:document.querySelector('#status').textContent,question:document.querySelector('#question').textContent,loading:document.querySelector('#loading').hidden,classes:document.querySelector('#book').className,viewport:window.innerWidth,scrollWidth:document.documentElement.scrollWidth,overflowElements:[...document.querySelectorAll('*')].map(e=>({tag:e.tagName,id:e.id,className:typeof e.className==='string'?e.className:'',right:e.getBoundingClientRect().right})).filter(e=>e.right>window.innerWidth+2).slice(0,10),sendDisabled:document.querySelector('#send').disabled,choicesHidden:document.querySelector('#choices').hidden,images:[...document.querySelectorAll('.art img')].map(i=>({id:i.id,src:i.src,width:i.naturalWidth,complete:i.complete,current:i.classList.contains('is-current')})),syncEvents:window.__syncTest?.filter(e=>/house1_choose|house2_predict|house2_reflect|house3_choose/.test(e.scene)).slice(-50),activeCancels:window.__syncTest?.filter(e=>e.kind==='cancel'&&e.speaking),requests:window.__liveTest?.requests.slice(-8),audioPlays:window.__liveTest?.audioPlays.slice(-5),highlightCount:window.__liveTest?.highlights.length,recentHighlights:window.__liveTest?.highlights.slice(-5),speech:{speaking:speechSynthesis.speaking,pending:speechSynthesis.pending,voices:speechSynthesis.getVoices().filter(v=>v.lang.startsWith('en')||v.lang.startsWith('ko')).slice(0,8).map(v=>({name:v.name,lang:v.lang}))},userActivation:{active:navigator.userActivation?.isActive,hasBeenActive:navigator.userActivation?.hasBeenActive},readAloud:document.querySelector('#readAloud').checked})`)));
    return;
  }
  await cdp('Page.reload', {ignoreCache: true});
  await waitFor(`document.readyState === 'complete' && !document.querySelector('#cover').hidden`);
  if (process.argv.includes('--mobile')) {
    await cdp('Emulation.setDeviceMetricsOverride',{width:375,height:667,deviceScaleFactor:1,mobile:true});
    await cdp('Page.reload',{ignoreCache:true});
    await waitFor(`document.readyState === 'complete' && !document.querySelector('#cover').hidden`);
  }
  if (process.argv.includes('--prepare')) {
    await evalPage(`document.querySelector('#mode').value='live'`);
    await state('live-ready-for-user');
    return;
  }
  if (process.argv.includes('--layout')) {
    await evalPage(`(() => {localStorage.setItem('story-language','en');document.querySelector('#language').value='en';document.querySelector('#mode').value='mock';document.querySelector('#cover').click()})()`);
    await waitFor(`document.querySelector('#progress').textContent.startsWith('Scene:') && !document.querySelector('#send').disabled`);
    const geometry = () => evalPage(`(() => {const box=id=>{const r=document.querySelector(id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};return {book:box('.book'),art:box('.art'),panel:box('.text-panel'),mic:box('#mic'),answer:box('#answer'),status:box('#status'),question:box('#question'),choices:box('#choices'),questionScroll:document.querySelector('#question').scrollHeight,questionHeight:document.querySelector('#question').clientHeight,narrativeScroll:document.querySelector('#narrative').scrollHeight,narrativeHeight:document.querySelector('#narrative').clientHeight,choicesScroll:document.querySelector('#choices').scrollWidth,choicesWidth:document.querySelector('#choices').clientWidth}})()`);
    const before=await geometry();
    await state('layout-before-record');
    await evalPage(`(() => {const context=new AudioContext(),destination=context.createMediaStreamDestination();window.__layoutAudio=context;navigator.mediaDevices.getUserMedia=async()=>destination.stream;VoiceInput.transcribe=async()=>''})()`);
    await evalPage(`document.querySelector('#mic').click()`);
    await waitFor(`document.querySelector('#book').dataset.state==='LISTENING'`);
    const listening=await geometry();
    await state('layout-listening');
    await delay(500);
    await evalPage(`document.querySelector('#mic').click()`);
    await waitFor(`!document.querySelector('#choices').hidden`);
    const after=await geometry();
    await state('layout-first-failure-choices');
    for (const [name,g] of [['listening',listening],['after',after]]) {
      for (const key of ['book','panel','mic','answer','status','question','choices']) {
        if (Math.abs(before[key].x-g[key].x)>1 || Math.abs(before[key].y-g[key].y)>1 || Math.abs(before[key].height-g[key].height)>1) throw new Error(`${name} moved ${key}: ${JSON.stringify([before[key],g[key]])}`);
      }
    }
    if (after.questionScroll>after.questionHeight+2 || after.narrativeScroll>after.narrativeHeight+2 || after.choicesScroll>after.choicesWidth+2) throw new Error(`Nested content clipped or scrollable: ${JSON.stringify(after)}`);
    if (await evalPage(`matchMedia('(orientation: landscape)').matches`) && Math.abs(after.art.height-after.panel.height)>2) throw new Error(`Illustration does not fill the scene card: ${JSON.stringify(after)}`);
    const horizontal=await evalPage(`({scroll:document.documentElement.scrollWidth,viewport:window.innerWidth})`);
    if (horizontal.scroll>horizontal.viewport+2) throw new Error(`Page has horizontal overflow: ${JSON.stringify(horizontal)}`);
    console.log('layout_stable',JSON.stringify({before,listening,after,choices:await evalPage(`document.querySelector('#choices').children.length`)}));
    return;
  }
  if (process.argv.includes('--sync')) {
    await evalPage(`(() => {
      localStorage.setItem('story-language','en');
      document.querySelector('#language').value='en';
      document.querySelector('#mode').value='mock';
      window.__syncTest=[];
      const speak=speechSynthesis.speak.bind(speechSynthesis);
      const cancel=speechSynthesis.cancel.bind(speechSynthesis);
      speechSynthesis.speak=utterance=>{window.__syncTest.push({kind:'speak',at:Date.now(),text:utterance.text,scene:document.querySelector('#progress').textContent});return speak(utterance)};
      speechSynthesis.cancel=()=>{window.__syncTest.push({kind:'cancel',at:Date.now(),speaking:speechSynthesis.speaking,scene:document.querySelector('#progress').textContent});return cancel()};
      document.querySelector('#cover').click();
    })()`);
    await waitFor(`document.querySelector('#progress').textContent.includes('house1_choose') && !document.querySelector('#send').disabled`);
    const steps=[['straw','house1_predict'],['The light walls might blow away.','house1_reflect'],['The walls were not firmly joined.','house2_choose'],['wood','house2_predict'],['The loose walls might tumble down.','house2_reflect'],['The logs were not fastened together.','house3_choose']];
    if(process.argv.includes('--end'))steps.push(['bricks','house3_predict'],['The strong walls might stay standing.','house3_reflect'],['The pigs helped one another.','ending']);
    for(let i=0;i<steps.length;i++){
      const [answer,next]=steps[i];
      await evalPage(`document.querySelector('#answer').value=${JSON.stringify(answer)};document.querySelector('#send').click()`);
      await waitFor(`document.querySelector('#progress').textContent.includes(${JSON.stringify(next)}) && !document.querySelector('#book').classList.contains('scene-enter') && (${next==='ending'?"document.querySelector('#status').textContent==='Story complete'":"!document.querySelector('#send').disabled"})`,90000);
      if(i===5)await state('sync-scene-6');
    }
    const events=await evalPage(`window.__syncTest`);
    const fillers=["Let's turn the page","Ready? Here we go","Let's see what happens","Let me think about that","I wonder what will happen next"];
    if(events.some(event=>event.kind==='speak'&&fillers.some(text=>event.text.includes(text))))throw new Error('Independent filler narration was spoken');
    if(events.some(event=>event.kind==='cancel'&&event.speaking))throw new Error('Narration was cancelled while still speaking');
    if(!events.some(event=>event.kind==='speak'&&event.scene.includes('house3_choose')))throw new Error('Scene 6 narration never started');
    console.log('sync_scene_5_to_6',JSON.stringify({progress:await evalPage(`document.querySelector('#progress').textContent`),speechEvents:events.filter(event=>event.kind==='speak').length,fillersSpoken:0,activeCancelsOutsideTransition:events.filter(event=>event.kind==='cancel'&&event.speaking).length,aroundTransition:events.filter(event=>/house2_reflect|house3_choose/.test(event.scene)).slice(0,12)}));
    if(process.argv.includes('--end'))await state('sync-ending');
    return;
  }
  if (process.argv.includes('--full')) {
    await evalPage(`(() => {
      localStorage.setItem('story-language','en');
      document.querySelector('#language').value='en';
      document.querySelector('#mode').value='live';
      window.__liveTest={requests:[], audioPlays:[], highlights:[]};
      const originalFetch=window.fetch.bind(window);
      window.fetch=async (...args)=>{
        const started=Date.now(), url=String(args[0]);
        try {
          const response=await originalFetch(...args);
          if(url.includes('/api/')) {
            const body=await response.clone().json().catch(()=>null);
            window.__liveTest.requests.push({url,status:response.status,ms:Date.now()-started,
              decision:body?.decision,sceneId:body?.sceneId,version:body?.version,
              jobStatus:body?.status,generated:body?.image?.generated,error:body?.error?.code});
          }
          return response;
        } catch(e) {window.__liveTest.requests.push({url,error:String(e)});throw e;}
      };
      const originalPlay=HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play=function(...args){window.__liveTest.audioPlays.push(this.src);return originalPlay.apply(this,args)};
      const recordHighlight=()=>window.__liveTest.highlights.push({at:Date.now(),text:document.querySelector('.live-narrative .speaking, #question.speaking')?.textContent||null});
      new MutationObserver(recordHighlight).observe(document.querySelector('#narrative'),{subtree:true,attributes:true,attributeFilter:['class']});
      new MutationObserver(recordHighlight).observe(document.querySelector('#question'),{attributes:true,attributeFilter:['class']});
    })()`);
    await state('full-cover');
    const point=await evalPage(`(() => {const r=document.querySelector('#cover').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});
    await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});
    await waitFor(`document.querySelector('#progress').textContent.startsWith('Scene: house1_choose') && !document.querySelector('#book').classList.contains('scene-enter')`);
    await state('full-start');
    const sample=await evalPage(`(async()=>{
      const audioContext=new AudioContext();await audioContext.resume();
      const response=await fetch('/prototype/audio/0826364242a2.mp3');
      const buffer=await audioContext.decodeAudioData(await response.arrayBuffer());
      const destination=audioContext.createMediaStreamDestination();
      const source=audioContext.createBufferSource();source.buffer=buffer;source.connect(destination);
      window.__micSample={audioContext,source};
      navigator.mediaDevices.getUserMedia=async()=>destination.stream;
      return {seconds:buffer.duration,mediaRecorder:MediaRecorder.isTypeSupported('audio/webm;codecs=opus')};
    })()`);
    console.log('mic_sample',JSON.stringify(sample));
    await evalPage(`document.querySelector('#mic').click()`);
    await waitFor(`document.querySelector('#book').dataset.state==='LISTENING'`,10000);
    await evalPage(`window.__micSample.source.start()`);
    await delay(3500);
    await evalPage(`document.querySelector('#mic').click()`);
    await waitFor(`document.querySelector('#answer').value.length>0 || /No speech|Microphone unavailable|unavailable/.test(document.querySelector('#status').textContent)`,60000);
    console.log('mic_result',JSON.stringify(await evalPage(`({transcript:document.querySelector('#answer').value,status:document.querySelector('#status').textContent})`)));
    await state('full-mic-result');
    const steps=[
      ['house1_choose','straw'],['house1_predict','The light walls might blow away.'],
      ['house1_reflect','The walls were not firmly joined.'],['house2_choose','wood'],
      ['house2_predict','The loose walls might tumble down.'],['house2_reflect','The logs were not fastened together.'],
      ['house3_choose','bricks'],['house3_predict','The strong walls might stay standing.'],
      ['house3_reflect','The pigs helped one another.']
    ];
    for (let i=0;i<steps.length;i++) {
      const [scene,answer]=steps[i], next=i===steps.length-1?'ending':steps[i+1][0];
      const before=await evalPage(`({progress:document.querySelector('#progress').textContent,image:document.querySelector('.art img.is-current')?.src})`);
      if(!before.progress.includes(scene)) throw new Error(`Expected ${scene}, got ${before.progress}`);
      const typed=i===0 ? await evalPage(`document.querySelector('#answer').value`) : '';
      await evalPage(`document.querySelector('#answer').value=${JSON.stringify(i===0&&typed.toLowerCase().includes('straw')?typed:answer)};document.querySelector('#send').click()`);
      await waitFor(`(document.querySelector('#progress').textContent.includes(${JSON.stringify(next)}) && !document.querySelector('#book').classList.contains('scene-enter')) || (!document.querySelector('#choices').hidden && !document.querySelector('#send').disabled)`,120000);
      let after=await evalPage(`({progress:document.querySelector('#progress').textContent,status:document.querySelector('#status').textContent,choices:document.querySelector('#choices').children.length,image:document.querySelector('.art img.is-current')?.src})`);
      if(!after.progress.includes(next) && after.choices) {
        console.log('choice_fallback',scene,JSON.stringify(after));
        await evalPage(`document.querySelector('#choices button').click()`);
        await waitFor(`document.querySelector('#progress').textContent.includes(${JSON.stringify(next)})`,30000);
        after=await evalPage(`({progress:document.querySelector('#progress').textContent,status:document.querySelector('#status').textContent,image:document.querySelector('.art img.is-current')?.src})`);
      }
      console.log('turn',i+1,scene,'=>',JSON.stringify(after));
      if([0,2,5,8].includes(i)) await state(`full-turn-${i+1}`);
      if([0,3,6,8].includes(i)) {
        await delay(12000);
        console.log('image_after_wait',scene,JSON.stringify(await evalPage(`({src:document.querySelector('.art img.is-current')?.src,complete:document.querySelector('.art img.is-current')?.complete,status:document.querySelector('#status').textContent})`)));
      }
    }
    await state('full-ending');
    console.log('integration_summary',JSON.stringify(await evalPage(`(() => {const x=window.__liveTest;return {sessionRequests:x.requests.filter(r=>r.url==='/api/sessions').length,transcriptions:x.requests.filter(r=>r.url==='/api/transcribe'),answers:x.requests.filter(r=>r.url==='/api/answer').map(r=>({status:r.status,sceneId:r.sceneId,decision:r.decision})),generatedScenes:[...new Set(x.requests.filter(r=>r.generated).map(r=>r.sceneId))],failedJobs:x.requests.filter(r=>r.jobStatus==='failed').map(r=>r.sceneId),highlights:x.highlights.length,audioPlays:x.audioPlays.length}})()`)));
    return;
  }
  await state('live-initial');
  const hit = await evalPage(`(() => { const r=document.querySelector('#cover').getBoundingClientRect(); const x=r.left+r.width/2, y=r.top+r.height/2; return {x,y,element:document.elementFromPoint(x,y)?.outerHTML.slice(0,180)} })()`);
  console.log('physical_click_target', JSON.stringify(hit));
  await cdp('Input.dispatchMouseEvent', {type:'mousePressed', x:hit.x, y:hit.y, button:'left', clickCount:1});
  await cdp('Input.dispatchMouseEvent', {type:'mouseReleased', x:hit.x, y:hit.y, button:'left', clickCount:1});
  await waitFor(`document.querySelector('#progress').textContent.includes('Scene:')`);
  const demo = await state('live-demo-start');
  await evalPage(`document.querySelector('#answer').value='straw'; document.querySelector('#send').click()`);
  await waitFor(`document.querySelector('#progress').textContent !== ${JSON.stringify(demo.progress)}`);
  await state('live-demo-answer');
  await evalPage(`document.querySelector('#mode').value='live'; document.querySelector('#mode').dispatchEvent(new Event('change',{bubbles:true}))`);
  await waitFor(`document.querySelector('#cover').hidden && document.querySelector('#progress').textContent.includes('Scene:')`, 90000);
  const ai = await state('live-ai-start');
  await evalPage(`document.querySelector('#answer').value='straw'; document.querySelector('#send').click()`);
  await waitFor(`document.querySelector('#progress').textContent !== ${JSON.stringify(ai.progress)}`, 120000);
  await state('live-ai-answer');
} finally {
  if (process.argv.includes('--mobile')) await cdp('Emulation.clearDeviceMetricsOverride').catch(()=>{});
  socket.close();
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
