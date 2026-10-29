import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {initTheme} from '@earendil-works/pi-coding-agent';
import extension,{nameCompletions} from '../vendor/tab-title/index.ts';
import {isolateConfig} from './isolated-config.mjs';
const agentDir=isolateConfig();
initTheme('dark');
const models=[{provider:'p',id:'big'},{provider:'p',id:'light'}];
function setup(ui,mode){
 const hooks={},commands={},names=[];
 const naming=extension({on:(n,h)=>hooks[n]=h,registerCommand:(n,h)=>commands[n]=h,registerTool(){},appendEntry(){},getSessionName:()=>names.at(-1)||'',setSessionName:n=>names.push(n)});
 const modelRegistry={getAvailable:()=>models,find:(p,id)=>models.find(m=>m.provider===p&&m.id===id),getError:()=>undefined,refresh:async()=>({})};
 const ctx={mode,hasUI:true,sessionManager:{getEntries:()=>[],getBranch:()=>[]},modelRegistry,ui:{setTitle(){},notify(){},...ui}};
 return {hooks,commands,ctx,naming,names};
}
const saved=()=>JSON.parse(readFileSync(join(agentDir,'pi-tab-title.json'),'utf8'));
test('/tabmodel 在 TUI 中用 Pi 原生模型选择器，选中后保存',async()=>{
 let rendered=[];
 const {hooks,commands,ctx}=setup({select:()=>assert.fail('TUI 不应使用普通列表'),custom:(factory)=>new Promise(resolve=>{
  const component=factory({requestRender(){}},{fg:(_c,t)=>t},{},resolve);
  rendered=component.render(80).join('\n');
  component.dispose?.();
  resolve('p/light');
 })},'tui');
 await hooks.session_start({},ctx);
 await commands.tabmodel.handler('',ctx);
 assert.match(rendered,/light/);
 assert.match(rendered,/命名模型/);
 assert.doesNotMatch(rendered,/\/login/);
 assert.deepEqual(saved(),{version:1,provider:'p',model:'light'});
 await hooks.session_shutdown({},ctx);
});
test('/tabmodel 在非 TUI 模式回退到普通列表',async(t)=>{
 const previous=process.env.PI_REMOTE_BACKGROUND;process.env.PI_REMOTE_BACKGROUND='1';
 t.after(()=>{if(previous===undefined)delete process.env.PI_REMOTE_BACKGROUND;else process.env.PI_REMOTE_BACKGROUND=previous;});
 let options;
 const {hooks,commands,ctx}=setup({select:async(_t,o)=>{options=o;return 'p/big';},custom:()=>assert.fail('非 TUI 不应挂载组件')},'rpc');
 await hooks.session_start({},ctx);
 await commands.tabmodel.handler('',ctx);
 assert.deepEqual(options,['p/big','p/light']);
 assert.deepEqual(saved(),{version:1,provider:'p',model:'big'});
 await hooks.session_shutdown({},ctx);
});
test('升级前保存的命名模型原样出现在 /remote name 菜单里，off 关闭',async()=>{
 writeFileSync(join(agentDir,'pi-tab-title.json'),JSON.stringify({version:1,provider:'p',model:'light'}));
 let title,options;
 const {hooks,ctx,naming}=setup({select:async(t,o)=>{title=t;options=o;return '关闭自动命名 off';}},'tui');
 await hooks.session_start({},ctx);
 await naming.nameCommand('',ctx);
 assert.match(title,/模型 p\/light/);
 assert.deepEqual(options.map(o=>o.split(' ').at(-1)),['rename','auto','model','default','off']);
 assert.deepEqual(saved(),{version:1,enabled:false});
 await hooks.session_shutdown({},ctx);
});
test('/remote name 菜单改名：输入什么就用什么，包括 auto',async()=>{
 let options;
 const {hooks,ctx,naming,names}=setup({select:async(_t,o)=>{options=o;return '重命名当前会话 rename';},input:async()=>'auto'},'tui');
 await hooks.session_start({},ctx);
 await naming.nameCommand('',ctx);
 assert.deepEqual(options.map(o=>o.split(' ').at(-1)),['model','rename']);
 assert.deepEqual(names,['auto']);
 await naming.nameCommand('手动名称',ctx);
 assert.deepEqual(names,['auto','手动名称']);
 await hooks.session_shutdown({},ctx);
});
test('关闭后菜单可改回跟随默认模型',async(t)=>{
 const settings=join(agentDir,'settings.json');
 writeFileSync(settings,JSON.stringify({defaultProvider:'p',defaultModel:'big'}));
 writeFileSync(join(agentDir,'pi-tab-title.json'),JSON.stringify({version:1,enabled:false}));
 t.after(()=>rmSync(settings,{force:true}));
 const titles=[],notes=[];let options;
 const {hooks,ctx,naming}=setup({select:async(t,o)=>{titles.push(t);options=o;return titles.length===1?o[0]:undefined;},notify:m=>notes.push(m)},'tui');
 await hooks.session_start({},ctx);
 await naming.nameCommand('',ctx);
 assert.match(titles[0],/已关闭/);
 assert.deepEqual(options.map(o=>o.split(' ').at(-1)),['default','model','rename']);
 assert.equal(existsSync(join(agentDir,'pi-tab-title.json')),false);
 assert.match(notes.at(-1),/跟随默认模型 p\/big/);
 await naming.nameCommand('',ctx);
 assert.match(titles[1],/模型 p\/big（跟随默认模型）/);
 assert.deepEqual(options.map(o=>o.split(' ').at(-1)),['rename','auto','model','off']);
 await hooks.session_shutdown({},ctx);
});
test('/remote name 补全',()=>{
 assert.deepEqual(nameCompletions('').map(i=>i.value),['model','auto','off']);
 assert.deepEqual(nameCompletions('model ').map(i=>i.value),['model current','model default','model show']);
 assert.deepEqual(nameCompletions('model c').map(i=>i.value),['model current']);
 assert.deepEqual(nameCompletions('foo bar'),[]);
});
