import {fork, type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {isExecutionDiagnostic,normalizeOptions,type ExecutionOptions,type ExecutionResult} from './protocol.js';
export function startExecution(options:ExecutionOptions):{result:Promise<ExecutionResult>;cancel:()=>void}{
 const normalized=normalizeOptions(options);let child:ChildProcess|undefined,settled=false,cancelled=false,timer:NodeJS.Timeout|undefined;
 const result=new Promise<ExecutionResult>((resolve)=>{
  const finish=(value:ExecutionResult)=>{if(settled)return;settled=true;if(timer)clearTimeout(timer);resolve(value);};
  const source=dirname(fileURLToPath(import.meta.url));const worker=join(source,'worker'+(source.endsWith('/src/sandbox')?'.ts':'.js'));
  try {
   child=fork(worker,[],{silent:true,execArgv:worker.endsWith('.ts')?['--import','tsx']:[],env:{PATH:process.env.PATH??'/usr/bin:/bin',NODE_NO_WARNINGS:'1'},stdio:['ignore','ignore','ignore','ipc']});
   child.once('message',(message:unknown)=>{
    const m=message as Partial<ExecutionResult>|null;
    const valid=m&&typeof m==='object'&&(!('diagnostic'in m)||((m.status==='failed'||m.status==='cancelled')&&isExecutionDiagnostic(m.diagnostic)))&&Array.isArray(m.logs)&&m.logs.every(x=>typeof x==='string')&&m.logs.reduce((n,x)=>n+Buffer.byteLength(x)+1,0)<=normalized.limits.logBytes&&
     ((m.status==='completed'&&'value'in m&&typeof m.value==='string'&&Buffer.byteLength(m.value)<=normalized.limits.resultBytes)||((m.status==='failed'||m.status==='cancelled')&&'error'in m&&typeof m.error==='string'&&m.error.length<=128));
    child?.kill('SIGKILL');
    finish(valid?m as ExecutionResult:{status:'failed',error:'executor_ipc_error',logs:[]});
   });
   child.once('error',()=>{child?.kill('SIGKILL');finish({status:'failed',error:'executor_process_error',logs:[]});});
   child.once('exit',()=>{if(!settled)finish({status:cancelled?'cancelled':'failed',error:cancelled?'cancelled':'executor_process_error',logs:[]});});
   child.once('disconnect',()=>{if(!settled){child?.kill('SIGKILL');finish({status:cancelled?'cancelled':'failed',error:cancelled?'cancelled':'executor_ipc_error',logs:[]});}});
   child.send({code:normalized.code,...normalized.limits},error=>{if(error){child?.kill('SIGKILL');finish({status:'failed',error:'executor_ipc_error',logs:[]});}});
   if(normalized.limits.timeoutMs!==null)timer=setTimeout(()=>{if(!settled){child?.kill('SIGKILL');finish({status:'failed',error:'execution_timeout',logs:[]});}},normalized.limits.timeoutMs+250);
  }catch{finish({status:'failed',error:'executor_process_error',logs:[]});}
 });
 return {result,cancel:()=>{if(settled)return;cancelled=true;child?.kill('SIGKILL');}};
}
