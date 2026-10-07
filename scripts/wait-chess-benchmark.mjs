import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const client=new Client({name:'chess-benchmark-wait',version:'1'});
try {
 await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8787/mcp')));
 const ids=JSON.parse(readFileSync('/tmp/pi-chess-worker-ids.json','utf8'));
 const result=await client.callTool({name:'wait_subagents',arguments:{ids,type:'all',timeoutSeconds:900}},undefined,{timeout:960000,resetTimeoutOnProgress:true});
 writeFileSync('/tmp/pi-chess-worker-results.json',JSON.stringify({completedAt:new Date().toISOString(),result},null,2));
 console.log('Worker wait settled; results saved. Workers are retained.');
} catch(error) {
 writeFileSync('/tmp/pi-chess-worker-results.json',JSON.stringify({error:String(error)},null,2));
 console.error(error);process.exitCode=1;
} finally {await client.close();}
