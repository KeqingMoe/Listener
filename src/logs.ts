import { readdir, open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadAppConfig } from './config-loader.js';
import { formatLogLine, managedLogFilename, type LogLevel } from './logger.js';

const levels: Record<LogLevel,number> = {debug:10,info:20,warn:30,error:40};
const CHUNK = 256 * 1024;
export interface LogViewOptions { directory?:string;follow:boolean;level:LogLevel;turn?:string;lines:number;help:boolean }
export function parseLogArgs(args:string[]):LogViewOptions {
  const options:LogViewOptions={follow:false,level:'debug',lines:100,help:false};
  const seen=new Set<string>();
  for(let i=0;i<args.length;i++){
    const flag=args[i]!;
    if(seen.has(flag))throw Error('Invalid log arguments');seen.add(flag);
    if(flag==='--follow')options.follow=true;
    else if(flag==='--help')options.help=true;
    else if(['--level','--turn','--lines','--directory'].includes(flag)){
      const value=args[++i];if(!value||value.startsWith('--'))throw Error('Invalid log arguments');
      if(flag==='--level'){if(!Object.hasOwn(levels,value))throw Error('Invalid log level');options.level=value as LogLevel;}
      if(flag==='--turn'){if(!/^t_[a-f0-9]{16}$/.test(value))throw Error('Invalid turn id');options.turn=value;}
      if(flag==='--lines'){if(!/^\d{1,4}$/.test(value)||Number(value)<1||Number(value)>1000)throw Error('Invalid line count');options.lines=Number(value);}
      if(flag==='--directory')options.directory=resolve(value);
    }else throw Error('Invalid log arguments');
  }
  return options;
}
interface Cursor {offset:number;ino:bigint;pending:Buffer;dropping:boolean}
/** Bounded snapshots and incremental follow, including rotations; never follow file symlinks. */
export class LogReader {
  private cursors=new Map<string,Cursor>();
  constructor(private directory:string,private options:Pick<LogViewOptions,'level'|'turn'|'lines'>){}
  async scan(initial=false):Promise<string[]> {
    let names:string[];
    try {
      const stat=await lstat(this.directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error();
      names=(await readdir(this.directory)).filter(managedLogFilename).sort().slice(-200);
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw Error('Log directory unavailable');}
    const present=new Set(names);for(const name of this.cursors.keys())if(!present.has(name))this.cursors.delete(name);
    const lines:string[]=[];
    for(const name of names){
      let file:Awaited<ReturnType<typeof open>>|undefined;
      try{
        file=await open(resolve(this.directory,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        const stat=await file.stat({bigint:true});if(!stat.isFile())continue;
        const size=Number(stat.size);if(!Number.isSafeInteger(size))continue;
        let cursor=this.cursors.get(name);
        if(!cursor||cursor.ino!==stat.ino||cursor.offset>size){
          const offset=initial?Math.max(0,size-CHUNK):0;
          cursor={offset,ino:stat.ino,pending:Buffer.alloc(0),dropping:offset>0};this.cursors.set(name,cursor);
        }
        const count=Math.min(CHUNK,size-cursor.offset);if(count<=0)continue;
        const bytes=Buffer.alloc(count);const read=await file.read(bytes,0,count,cursor.offset);cursor.offset+=read.bytesRead;
        const data=Buffer.concat([cursor.pending,bytes.subarray(0,read.bytesRead)]);cursor.pending=Buffer.alloc(0);
        let start=0;
        for(let index=data.indexOf(10);index>=0;index=data.indexOf(10,start)){
          const row=data.subarray(start,index);start=index+1;
          if(cursor.dropping){cursor.dropping=false;continue;}
          if(row.length>8192)continue;
          try{
            const raw=JSON.parse(row.toString('utf8'));
            if(!raw||!Object.hasOwn(levels,raw.level)||levels[raw.level as LogLevel]<levels[this.options.level]||(this.options.turn&&raw.turn_id!==this.options.turn))continue;
            const text=formatLogLine(raw);if(text){lines.push(text);if(initial&&lines.length>this.options.lines)lines.shift();}
          }catch{/* Skip malformed/torn records; never print raw data. */}
        }
        const rest=data.subarray(start);if(rest.length>8192)cursor.dropping=true;else cursor.pending=Buffer.from(rest);
      }catch(error){if(!['ENOENT','ELOOP'].includes((error as NodeJS.ErrnoException).code??''))throw Error('Log file unavailable');}
      finally{await file?.close();}
    }
    return lines;
  }
}
export async function runLogViewer(args=process.argv.slice(2)):Promise<void>{
  const options=parseLogArgs(args);
  if(options.help){console.log('用法：npm run logs -- [--follow] [--level debug|info|warn|error] [--turn t_十六位十六进制] [--lines 100] [--directory data/logs]');return;}
  const directory=options.directory??loadAppConfig().logging.directory;
  const reader=new LogReader(directory,options);let stopped=false;
  const abort=new AbortController();let outputPending=false;
  const releaseOutput=()=>{
    if(outputPending)(process.stdout as typeof process.stdout & {unref?:()=>void}).unref?.();
    // A pending stdio write cannot be cancelled portably. The CLI wrapper
    // exits after cleanup; embedded callers retain control of their process.
  };
  const stop=()=>{stopped=true;abort.abort();releaseOutput();};process.on('SIGINT',stop);process.on('SIGTERM',stop);
  try{
    const output=async(lines:string[])=>{for(const line of lines){
      if(stopped)return;
      await new Promise<void>((resolve,reject)=>{
        let settled=false;
        const finish=(failed=false)=>{if(settled)return;settled=true;clearTimeout(timer);abort.signal.removeEventListener('abort',cancel);failed?reject(Error('Log output unavailable')):resolve();};
        const cancel=()=>finish();
        const timer=setTimeout(()=>{stopped=true;releaseOutput();finish(true);},2000);
        abort.signal.addEventListener('abort',cancel,{once:true});
        try{outputPending=true;process.stdout.write(line+'\n',error=>{outputPending=false;finish(!!error);});}catch{outputPending=false;finish(true);}
      });
    }};
    await output(await reader.scan(true));
    while(options.follow&&!stopped){await delay(500);if(!stopped)await output(await reader.scan());}
  }finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  process.stdout.on('error',()=>{process.exitCode=1;});
  void runLogViewer().catch(()=>{console.error('日志查看失败：请检查参数、配置和文件权限；可用 --directory data/logs 绕过配置加载。');process.exitCode=1;})
    .finally(()=>process.exit(process.exitCode ?? 0));
}
