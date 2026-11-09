import { validateBuilderFiles } from './claude-builder.mjs';
export function parseBuilderOutput(text, allowed) {
  if(typeof text!=='string'||!text||Buffer.byteLength(text)>1500*1024)throw Error('BUILDER_OUTPUT_MISSING_OR_TOO_LARGE');
  let output;try{output=JSON.parse(text);}catch{throw Error('BUILDER_OUTPUT_INVALID_JSON');}
  if(!output||typeof output!=='object'||Array.isArray(output)||Object.keys(output).length!==1||!Object.hasOwn(output,'files'))throw Error('BUILDER_OUTPUT_INVALID');
  validateBuilderFiles(output.files,allowed);
  for(const file of output.files)if(Object.keys(file).some(k=>!['path','content'].includes(k)))throw Error('BUILDER_OUTPUT_INVALID');
  return output.files;
}
