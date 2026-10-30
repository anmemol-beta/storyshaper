const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ROOT=path.join(__dirname,'../prototype');
const read=p=>fs.readFileSync(path.join(ROOT,p),'utf8');

test('live page loads existing team-owned input and narration modules without bundling them',()=>{
 const html=read('live.html');
 for(const file of ['image-transitions.js','voice-input.js','narration.js','live-book.js'])assert.ok(html.includes('src="'+file+'"'));
 assert.ok(html.includes('id="readAloud"')&&html.includes('id="readerName"'));
 assert.ok(html.includes('id="storyVideo"'));
});
test('live controller is parseable and uses only public module APIs',()=>{
 const script=read('live-book.js');
 new vm.Script(script,{filename:'live-book.js'});
 assert.match(script,/Narration\.speak\(/);
 assert.match(script,/Narration\.stop\(/);
 assert.match(script,/VoiceInput\.record\(/);
 assert.match(script,/VoiceInput\.transcribe\(/);
 assert.match(script,/StoryImageTransition/);
});
test('live page binds media results to authoritative session, scene and version',()=>{
 const script=read('live-book.js');
 for(const part of ['snapshot.sessionId!==bind.sessionId','snapshot.sceneId!==bind.sceneId','snapshot.version!==bind.version','data.apply===true','data.status==="ready"'])assert.ok(script.includes(part),part);
 assert.match(script,/\/api\/media\/jobs/);
 assert.match(script,/\/api\/media\/cancel/);
});
test('live module does not contain a fake speech result or local story engine',()=>{
 const script=read('live-book.js');
 assert.ok(!script.includes('heard(current.ask[0])'));
 assert.ok(!script.includes('storyData().scenes'));
 assert.ok(!script.includes('function _transition'));
});
