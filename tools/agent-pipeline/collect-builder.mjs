import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateBuilderFiles } from './lib/claude-builder.mjs';
const packet=JSON.parse(readFileSync('builder-packet.json','utf8'));
const cwd=resolve('task');
const git=args=>{const r=spawnSync('git',args,{cwd,encoding:'utf8',maxBuffer:2*1024*1024});if(r.status!==0||r.error)throw Error('BUILDER_DIFF_UNAVAILABLE');return r.stdout;};
if(git(['rev-parse','HEAD']).trim()!==packet.head_sha)throw Error('BUILDER_LOCAL_COMMIT_FORBIDDEN');
const paths=[...new Set([...git(['diff','--name-only','-z',packet.head_sha,'--']).split('\0'),...git(['ls-files','--others','--exclude-standard','-z']).split('\0')].filter(Boolean))];
const files=paths.map(path=>{
 if(path.startsWith('/')||path.split('/').some(p=>p==='..'||p==='.')||path.includes('\\'))throw Error('BUILDER_PATH_INVALID');
 let content=null;
 try { const stat=lstatSync(resolve(cwd,path));if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024)throw Error('BUILDER_FILE_INVALID');content=readFileSync(resolve(cwd,path),'utf8'); }
 catch(error){if(error.code!=='ENOENT')throw error;}
 return {path,content};
});
validateBuilderFiles(files,packet.allowed_files);
writeFileSync('build-result.json',JSON.stringify({schema_version:1,run_id:Number(process.env.GITHUB_RUN_ID),run_attempt:Number(process.env.GITHUB_RUN_ATTEMPT),policy_sha:packet.policy_sha,packet,files}));
