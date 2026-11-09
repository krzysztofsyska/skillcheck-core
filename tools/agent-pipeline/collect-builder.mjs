import { readFileSync, writeFileSync } from 'node:fs';
import { readBuilderExecution } from './lib/builder-output.mjs';
const packet=JSON.parse(readFileSync('builder-packet.json','utf8'));
// The model has Read/Glob/Grep only. Its output is data, never code/config to run.
const files=readBuilderExecution(process.env.BUILDER_EXECUTION_FILE,process.env.RUNNER_TEMP,packet.allowed_files);
writeFileSync('build-result.json',JSON.stringify({schema_version:1,run_id:Number(process.env.GITHUB_RUN_ID),run_attempt:Number(process.env.GITHUB_RUN_ATTEMPT),policy_sha:packet.policy_sha,packet,files}));
