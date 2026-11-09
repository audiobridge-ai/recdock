import {execFileSync} from 'node:child_process';
import {assertAudioContract} from '../../plaud-web/server/transcription/contracts.ts';
const data=JSON.parse(execFileSync(process.env.RECDOCK_DART || 'dart',['run','tool/transcript_contract_cases.dart'],{encoding:'utf8'}));
for(const transcript of data) assertAudioContract('Transcript',transcript);
console.log(`AssemblyAI / Web transcript contract: ${data.length}/${data.length} passed`);
