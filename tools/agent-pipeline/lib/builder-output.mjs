import { validateBuilderFiles } from './claude-builder.mjs';
import { openSync, fstatSync, readFileSync, closeSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';

const MAX_EXECUTION_BYTES = 32 * 1024 * 1024;

// Pinned base-action writes one JSON array, including a final SDK result message.
// Never include other messages or parse errors from the private log in artifacts.
export function parseBuilderExecution(text, allowed) {
  if(typeof text!=='string'||!text||Buffer.byteLength(text)>MAX_EXECUTION_BYTES)throw Error('BUILDER_EXECUTION_MISSING_OR_TOO_LARGE');
  let messages;try{messages=JSON.parse(text);}catch{throw Error('BUILDER_EXECUTION_INVALID_JSON');}
  if(!Array.isArray(messages)||!messages.length)throw Error('BUILDER_EXECUTION_INVALID');
  const results=messages.filter(message=>message?.type==='result'),result=messages.at(-1);
  if(results.length!==1||results[0]!==result||result.subtype!=='success'||result.is_error!==false||!Object.hasOwn(result,'structured_output'))throw Error('BUILDER_EXECUTION_RESULT_INVALID');
  return parseBuilderOutput(JSON.stringify(result.structured_output),allowed);
}

export function readBuilderExecution(path, runnerTemp, allowed) {
  if(typeof path!=='string'||!path||typeof runnerTemp!=='string'||!runnerTemp||resolve(path)!==resolve(join(runnerTemp,'claude-execution-output.json')))throw Error('BUILDER_EXECUTION_PATH_INVALID');
  let fd;
  try {
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.size>MAX_EXECUTION_BYTES)throw Error('BUILDER_EXECUTION_MISSING_OR_TOO_LARGE');
    return parseBuilderExecution(readFileSync(fd,'utf8'),allowed);
  } finally {if(fd!==undefined)closeSync(fd);}
}

export function parseBuilderOutput(text, allowed) {
  if(typeof text!=='string'||!text||Buffer.byteLength(text)>1500*1024)throw Error('BUILDER_OUTPUT_MISSING_OR_TOO_LARGE');
  let output;try{output=JSON.parse(text);}catch{throw Error('BUILDER_OUTPUT_INVALID_JSON');}
  if(!output||typeof output!=='object'||Array.isArray(output)||Object.keys(output).length!==1||!Object.hasOwn(output,'files'))throw Error('BUILDER_OUTPUT_INVALID');
  validateBuilderFiles(output.files,allowed);
  for(const file of output.files)if(Object.keys(file).some(k=>!['path','content'].includes(k)))throw Error('BUILDER_OUTPUT_INVALID');
  return output.files;
}
