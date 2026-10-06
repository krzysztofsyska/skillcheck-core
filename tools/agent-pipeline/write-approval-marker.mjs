import { writeFileSync } from 'node:fs';

const marker = {
  request_id: process.env.REQUEST_ID ?? '',
  digest: process.env.DIGEST ?? '',
  task_id: process.env.TASK_ID ?? '',
  gate: process.env.GATE ?? '',
};
writeFileSync('approval-marker.json', `${JSON.stringify(marker)}\n`);
console.log(JSON.stringify({ ok: true, gate: marker.gate }));
