import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
// Run before the model. Export raw regular blobs, with no Git metadata, hooks,
// agent settings, plugins, MCP config or symlinks in its working directory.
const git=args=>{const r=spawnSync('git',args,{cwd:'task',encoding:null,maxBuffer:4*1024*1024});if(r.status!==0||r.error)throw Error('BUILDER_SOURCE_UNAVAILABLE');return r.stdout;};
mkdirSync('builder-source',{recursive:true});
for(const entry of git(['ls-tree','-rz','HEAD']).toString('utf8').split('\0').filter(Boolean)){
 const tab=entry.indexOf('\t'),[mode,type,sha]=entry.slice(0,tab).split(' '),path=entry.slice(tab+1);
 if(!['100644','100755'].includes(mode)||type!=='blob')continue;
 if(path.startsWith('/')||path.includes('\\')||path.split('/').some(p=>!p||p==='..'||p==='.'))throw Error('BUILDER_SOURCE_PATH_INVALID');
 if(/(^|\/)(\.git|\.github|\.claude|\.cursor|\.mcp\.json|\.env(?:\..*)?)($|\/)/i.test(path))continue;
 const name=/(^|\/)(AGENTS|CLAUDE)\.md$/i.test(path)?`${path}.txt`:path;
 const bytes=git(['cat-file','blob',sha]);
 if(bytes.length>1024*1024||bytes.includes(0))continue;
 const target=resolve('builder-source',name);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes);
}
