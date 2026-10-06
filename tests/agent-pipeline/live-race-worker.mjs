import { createGitHubClient } from '../../tools/agent-pipeline/lib/github.mjs';
import { createLiveJournal } from '../../tools/agent-pipeline/lib/live-journal.mjs';
const github=createGitHubClient({fetch:globalThis.fetch,token:'fixture',repository:'krzysztofsyska/skillcheck-core',apiBase:process.argv[2]});
const journal=createLiveJournal(github,process.argv[3],42);
try {await journal.acquire();await journal.save({task_id:'SC-RACE',state_revision:0,state:'READY',last_transition_at:'now'},null,null);process.stdout.write('winner');}
catch(error){if(!['CONTROLLER_LOCKED','AGENT_STATE_CONFLICT'].includes(error.code))throw error;process.stdout.write('conflict');}
