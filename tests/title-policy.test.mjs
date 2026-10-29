import test from 'node:test';
import assert from 'node:assert/strict';
import extension,{namingEnabled,titleMaxTokens} from '../vendor/tab-title/index.ts';
import {isolateConfig} from './isolated-config.mjs';
const agentDir=isolateConfig();
test('未选命名模型且 Pi 没有默认模型时不发请求，手动命名照常工作',async()=>{
 const hooks={},commands={},titles=[];let calls=0,name='';
 const ctx={mode:'tui',sessionManager:{getEntries:()=>[],getBranch:()=>[]},ui:{setTitle:t=>titles.push(t),notify(){}},modelRegistry:{find:()=>{calls++;throw Error('must not run');}}};
 extension({on:(n,h)=>hooks[n]=h,registerCommand:(n,h)=>commands[n]=h,registerTool(){},appendEntry(){},getSessionName:()=>name,setSessionName:n=>name=n});
 await hooks.session_start({},ctx);await hooks.before_agent_start({prompt:'测试输入'},ctx);
 assert.equal(calls,0);await commands.tabname.handler('手动会话名称',ctx);assert.equal(name,'手动会话名称');assert.equal(titles.at(-1),name);
 await hooks.session_shutdown({},ctx);
});
test('未选命名模型时 namingEnabled 为 false，选定后为 true',async()=>{
 const fs=await import('node:fs');const path=await import('node:path');
 const file=path.join(agentDir,'pi-tab-title.json');fs.rmSync(file,{force:true});
 assert.equal(namingEnabled(),false);
 fs.writeFileSync(file,JSON.stringify({version:1,provider:'p',model:'m'}));assert.equal(namingEnabled(),true);
 fs.writeFileSync(file,'{bad');assert.equal(namingEnabled(),false);
 fs.rmSync(file,{force:true});
});
test('未选命名模型时跟随 Pi 全局默认模型，off 后不再跟随',async()=>{
 const fs=await import('node:fs');const path=await import('node:path');
 const file=path.join(agentDir,'pi-tab-title.json'),settings=path.join(agentDir,'settings.json');
 fs.writeFileSync(settings,JSON.stringify({defaultProvider:'p',defaultModel:'m'}));
 try{
  assert.equal(namingEnabled(),true);
  fs.writeFileSync(file,JSON.stringify({version:1,enabled:false}));assert.equal(namingEnabled(),false);
  fs.rmSync(file,{force:true});
  const hooks={},found=[];let name='';
  const model={provider:'p',id:'m'};
  const ctx={mode:'tui',sessionManager:{getEntries:()=>[],getBranch:()=>[]},ui:{setTitle(){},notify(){}},modelRegistry:{
   find:(p,id)=>{found.push(`${p}/${id}`);return model;},
   complete:async()=>({stopReason:'stop',content:[{type:'text',text:'默认模型标题'}]}),
  }};
  extension({on:(n,h)=>hooks[n]=h,registerCommand(){},registerTool(){},appendEntry(){},getSessionName:()=>name,setSessionName:n=>name=n});
  await hooks.session_start({},ctx);await hooks.before_agent_start({prompt:'测试输入'},ctx);
  for(let i=0;i<50&&!name;i++)await new Promise(r=>setTimeout(r,10));
  assert.deepEqual(found,['p/m']);assert.equal(name,'默认模型标题');
  await hooks.session_shutdown({},ctx);
 }finally{fs.rmSync(settings,{force:true});fs.rmSync(file,{force:true});}
});
test('命名输出上限按模型最低可用思考档位放宽',()=>{
 assert.equal(titleMaxTokens({reasoning:false}),1024);
 assert.equal(titleMaxTokens({reasoning:true}),1024);
 assert.equal(titleMaxTokens({reasoning:true,thinkingLevelMap:{off:null,minimal:null,low:'low',medium:null,high:'high'}}),1024);
 assert.equal(titleMaxTokens({reasoning:true,thinkingLevelMap:{off:null,minimal:null,low:null}}),2048);
 assert.equal(titleMaxTokens({reasoning:true,thinkingLevelMap:{off:null,minimal:null,low:null,medium:null,high:'high'}}),2048);
});
