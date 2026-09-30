import { getQuickJS } from 'quickjs-emscripten';
import type {
  QuickJSHandle,
  QuickJSContext,
  QuickJSDeferredPromise,
} from 'quickjs-emscripten';
import {
  isExecutionDiagnostic,
  normalizeOptions,
  TOOL_CALL_LIMITS,
  type ExecutionResult,
  type ExecutionDiagnostic,
  type DiagnosticPhase,
} from './protocol.ts';

let started = false,
  cancelled = false;

interface ToolReply {
  type: 'tool_result';
  id: number;
  json: string;
  attachments: Uint8Array[];
}

const replies = new Map<number, (reply: ToolReply) => void>();
process.on('disconnect', () => process.exit(0));
process.on('message', async (message: unknown) => {
  if (started) {
    const m = message as Partial<ToolReply> | null;
    if (m && m.type === 'tool_result' && typeof m.id === 'number') {
      const reply = replies.get(m.id);
      replies.delete(m.id);
      reply?.(m as ToolReply);
    }
    return;
  }
  started = true;
  let logs: string[] = [],
    logSize = 0,
    diagnostic: ExecutionDiagnostic | undefined;
  const contract = (message: string): ExecutionDiagnostic => ({
    kind: 'contract_error',
    phase: 'result',
    message,
    truncated: false,
  });
  const send = (result: ExecutionResult) => {
    if (process.connected) {
      process.send!(result, () => process.exit(0));
    } else {
      process.exit(0);
    }
  };
  try {
    if (!message || typeof message !== 'object') {
      throw Error('invalid_request');
    }
    const { code, limits } = normalizeOptions(
      message as Parameters<typeof normalizeOptions>[0],
    );
    const toolNames = (message as { tools?: unknown }).tools;
    if (
      toolNames !== undefined &&
      (!Array.isArray(toolNames) ||
        toolNames.length > 256 ||
        toolNames.some(
          (n) => typeof n !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(n),
        ))
    ) {
      throw Error('invalid_request');
    }
    const Q = await getQuickJS(),
      runtime = Q.newRuntime();
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(limits.stackBytes);
    const deadline =
      limits.timeoutMs === null
        ? Infinity
        : performance.now() + limits.timeoutMs;
    runtime.setInterruptHandler(
      () => cancelled || performance.now() >= deadline,
    );
    const vm = runtime.newContext();
    let promise: QuickJSHandle | undefined;
    const disposers: (() => void)[] = [];
    let fault: string | undefined;
    const init = vm.evalCode(
      `(()=>{const stringify=JSON.stringify,create=Object.create,slice=Function.prototype.call.bind(String.prototype.slice),primitive=String;return e=>{let truncated=false;const trim=(v,n)=>{if(typeof v!=='string')return undefined;if(v.length>n){truncated=true;return slice(v,0,n)}return v};const out=create(null);if(e!==null&&(typeof e==='object'||typeof e==='function')){out.name=trim(e.name,96);out.message=trim(e.message,512)||'Code threw an object without a readable error message.';out.stack=trim(e.stack,512)}else{out.name='ThrownValue';out.message=trim(primitive(e),512)}out.truncated=truncated;return stringify(out)}})()`,
    );
    if (init.error) {
      init.error.dispose();
      throw Error('execution_error');
    }
    const extractor = init.value;
    const diagnose = (
      h: QuickJSHandle,
      phase: DiagnosticPhase,
    ): ExecutionDiagnostic => {
      const fallback: ExecutionDiagnostic = {
        kind: 'guest_exception',
        phase,
        message: 'Exception details could not be safely extracted.',
        truncated: false,
      };
      const until = performance.now() + 50;
      runtime.setInterruptHandler(
        () => cancelled || performance.now() >= until,
      );
      try {
        const r = vm.callFunction(extractor, vm.undefined, h);
        if (r.error) {
          r.error.dispose();
          return fallback;
        }
        try {
          const raw = string(r.value, 8192);
          const d = { ...JSON.parse(raw), kind: 'guest_exception', phase };
          return isExecutionDiagnostic(d) ? d : fallback;
        } finally {
          r.value.dispose();
        }
      } catch {
        return fallback;
      } finally {
        runtime.setInterruptHandler(
          () => cancelled || performance.now() >= deadline,
        );
      }
    };
    const string = (h: QuickJSHandle, max: number) => {
      if (vm.typeof(h) !== 'string') {
        diagnostic = contract(
          `Expected a primitive string, received ${vm.typeof(h)}; serialize the result explicitly before returning.`,
        );
        throw Error('invalid_return_type');
      }
      const len = vm.getProp(h, 'length');
      let length: number;
      try {
        length = vm.getNumber(len);
      } finally {
        len.dispose();
      }
      if (length > max) {
        throw Error('output_too_large');
      }
      const value = vm.getString(h);
      if (Buffer.byteLength(value) > max) {
        throw Error('output_too_large');
      }
      return value;
    };
    try {
      const consoleObject = vm.newObject();
      for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
        const fn = vm.newFunction(name, (...args) => {
          try {
            const parts: string[] = [];
            let size = 1;
            for (const h of args) {
              const separator = parts.length ? 1 : 0;
              const available = limits.logBytes - logSize - size - separator;
              if (available < 0) {
                throw Error('logs_too_large');
              }
              const part = string(h, available);
              size += separator + Buffer.byteLength(part);
              parts.push(part);
            }
            if (logSize + size > limits.logBytes) {
              throw Error('logs_too_large');
            }
            logSize += size;
            logs.push(parts.join(' '));
          } catch (error) {
            fault =
              error instanceof Error && error.message === 'invalid_return_type'
                ? 'invalid_log_type'
                : 'logs_too_large';
            throw Error('Log arguments must be bounded strings');
          }
        });
        vm.setProp(consoleObject, name, fn);
        fn.dispose();
      }
      vm.setProp(vm.global, 'console', consoleObject);
      consoleObject.dispose();
      if (toolNames?.length) {
        disposers.push(installTools(vm, toolNames as string[]));
      }
      // The Function constructor is QuickJS's, not the host's. A function body cannot escape into wrapper source.
      const compiled = vm.evalCode('(async function(){}).constructor');
      if (compiled.error) {
        const d = diagnose(compiled.error, 'compile');
        compiled.error.dispose();
        send({ status: 'failed', error: 'syntax_error', logs, diagnostic: d });
        return;
      }
      const source = vm.newString(code);
      const fnResult = vm.callFunction(compiled.value, vm.undefined, source);
      source.dispose();
      compiled.value.dispose();
      if (fnResult.error) {
        const d = diagnose(fnResult.error, 'compile');
        fnResult.error.dispose();
        send({ status: 'failed', error: 'syntax_error', logs, diagnostic: d });
        return;
      }
      const evaluation = vm.callFunction(fnResult.value, vm.undefined);
      fnResult.value.dispose();
      if (evaluation.error) {
        const d = diagnose(evaluation.error, 'execute');
        evaluation.error.dispose();
        send({
          status: 'failed',
          error: 'execution_error',
          logs,
          diagnostic: d,
        });
        return;
      }
      promise = evaluation.value;
      while (true) {
        if (fault) {
          throw Error(fault);
        }
        if (cancelled) {
          throw Error('cancelled');
        }
        if (performance.now() >= deadline) {
          throw Error('execution_timeout');
        }
        const state = vm.getPromiseState(promise);
        if (state.type === 'fulfilled') {
          try {
            const value = string(state.value, limits.resultBytes);
            send({ status: 'completed', value, logs });
          } finally {
            state.value.dispose();
          }
          break;
        }
        if (state.type === 'rejected') {
          diagnostic = diagnose(state.error, 'execute');
          state.error.dispose();
          throw Error('execution_error');
        }
        const jobs = runtime.executePendingJobs(64);
        if (jobs.error) {
          diagnostic = diagnose(jobs.error, 'execute');
          jobs.error.dispose();
          throw Error('execution_error');
        }
        // Yield to IPC/watchdog between bounded microtask batches; an unresolved promise may wait indefinitely.
        await new Promise<void>((resolve) =>
          setTimeout(
            resolve,
            runtime.hasPendingJob() ? 0 : replies.size ? 1 : 10,
          ),
        );
      }
    } finally {
      for (const dispose of disposers) {
        dispose();
      }
      promise?.dispose();
      extractor.dispose();
      vm.dispose();
      runtime.dispose();
    }
  } catch (error) {
    const safe = new Set([
      'invalid_limits',
      'code_too_large',
      'invalid_request',
      'invalid_return_type',
      'output_too_large',
      'logs_too_large',
      'invalid_log_type',
      'syntax_error',
      'execution_timeout',
      'cancelled',
    ]);
    const reason =
      error instanceof Error && safe.has(error.message)
        ? error.message
        : 'execution_error';
    if (
      ['invalid_log_type', 'logs_too_large', 'output_too_large'].includes(
        reason,
      )
    ) {
      diagnostic = contract(
        reason === 'invalid_log_type'
          ? 'Console arguments must be primitive strings; serialize them explicitly.'
          : reason === 'logs_too_large'
            ? 'Console output exceeded the log byte limit.'
            : 'Returned string exceeded the result byte limit.',
      );
    }
    send({
      status: reason === 'cancelled' ? 'cancelled' : 'failed',
      error: reason,
      logs,
      ...(diagnostic ? { diagnostic } : {}),
    });
  }
});
process.on('SIGTERM', () => {
  cancelled = true;
  process.exit(0);
});

/** Guest prelude: `tools.<name>(args)` encodes args itself (captured builtins), so the host
 * receives only a JSON string plus ArrayBuffers. Uint8Array fields become {"$bytes":i}. */
const PRELUDE = `(call,names)=>{
 const tag=Function.prototype.call.bind(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),Symbol.toStringTag).get);
 const isArray=Array.isArray,keys=Object.keys,getProto=Object.getPrototypeOf,objProto=Object.prototype,freeze=Object.freeze,stringify=JSON.stringify,parse=JSON.parse,isFinite=Number.isFinite;
 const bufferOf=Function.prototype.call.bind(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'buffer').get);
 const offsetOf=Function.prototype.call.bind(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteOffset').get);
 const lengthOf=Function.prototype.call.bind(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength').get);
 const sliceBuffer=Function.prototype.call.bind(ArrayBuffer.prototype.slice);
 const Uint8=Uint8Array;
 const encode=(value)=>{const buffers=[];const seen=[];
  const walk=(v,path)=>{
   if(v===null||typeof v==='string'||typeof v==='boolean')return v;
   if(typeof v==='number'){if(!isFinite(v))throw new TypeError('Tool arguments cannot contain non-finite numbers (at '+path+')');return v;}
   if(typeof v!=='object')throw new TypeError('Tool arguments cannot contain '+typeof v+' (at '+path+')');
   if(seen.includes(v))throw new TypeError('Tool arguments cannot be circular (at '+path+')');
   let t;try{t=tag(v);}catch{t=undefined;}
   if(t==='Uint8Array'){const o=offsetOf(v);buffers.push(sliceBuffer(bufferOf(v),o,o+lengthOf(v)));return {$bytes:buffers.length-1};}
   if(t!==undefined)throw new TypeError('Only Uint8Array can carry bytes, got '+t+' (at '+path+')');
   seen.push(v);let out;
   if(isArray(v)){out=[];for(let i=0;i<v.length;i++)out.push(walk(v[i],path+'['+i+']'));}
   else{const p=getProto(v);if(p!==objProto&&p!==null)throw new TypeError('Tool arguments must be plain objects and arrays (at '+path+')');out={};for(const k of keys(v)){if(k==='$bytes')throw new TypeError('The key $bytes is reserved (at '+path+')');out[k]=walk(v[k],path+'.'+k);}}
   seen.pop();return out;};
  return [stringify(walk(value===undefined?{}:value,'args')),buffers];};
 const decode=(json,buffers)=>{const bytes=buffers.map(b=>new Uint8(b));return parse(json,(k,v)=>v!==null&&typeof v==='object'&&!isArray(v)&&keys(v).length===1&&typeof v.$bytes==='number'?bytes[v.$bytes]:v);};
 const tools={};
 for(const name of parse(names)){const fn=function(args){if(arguments.length>1)throw new TypeError('tools.'+name+' takes a single argument object');const [json,buffers]=encode(args);return call(name,json,buffers);};tools[name]=freeze(fn);}
 globalThis.tools=freeze(tools);
 return decode;
}`;

function installTools(vm: QuickJSContext, names: string[]): () => void {
  const pending = new Set<QuickJSDeferredPromise>();
  let nextId = 1,
    inFlight = 0;
  const waiting: (() => void)[] = [];
  let decoder: QuickJSHandle | undefined;
  const bridge = vm.newFunction('call', (nameH, jsonH, buffersH) => {
    const name = vm.getString(nameH);
    if (vm.typeof(jsonH) !== 'string') {
      throw Error('Invalid tool call');
    }
    const json = vm.getString(jsonH);
    if (Buffer.byteLength(json) > TOOL_CALL_LIMITS.jsonBytes) {
      throw new RangeError(
        'Tool arguments exceed 1 MiB of JSON; pass large data as Uint8Array',
      );
    }
    const count = vm.getLength(buffersH) ?? 0;
    if (count > TOOL_CALL_LIMITS.attachments) {
      throw new RangeError('Too many Uint8Array fields in one tool call');
    }
    let total = 0;
    const attachments: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const h = vm.getProp(buffersH, i);
      try {
        const view = vm.getArrayBuffer(h);
        try {
          total += view.value.byteLength;
          if (total > TOOL_CALL_LIMITS.attachmentBytes) {
            throw new RangeError(
              'Uint8Array fields exceed 64 MiB in one tool call',
            );
          }
          attachments.push(Uint8Array.from(view.value));
        } finally {
          view.dispose();
        }
      } finally {
        h.dispose();
      }
    }
    const deferred = vm.newPromise();
    pending.add(deferred);
    const id = nextId++;
    const start = () => {
      inFlight++;
      replies.set(id, (reply) => {
        inFlight--;
        waiting.shift()?.();
        pending.delete(deferred);
        if (!deferred.alive) {
          return;
        }
        try {
          const jh = vm.newString(
            typeof reply.json === 'string'
              ? reply.json
              : '{"status":"error","error":"invalid_host_result"}',
          );
          const arr = vm.newArray();
          (Array.isArray(reply.attachments) ? reply.attachments : []).forEach(
            (a, i) => {
              const b = vm.newArrayBuffer(Uint8Array.from(a).buffer);
              vm.setProp(arr, i, b);
              b.dispose();
            },
          );
          const decoded = vm.callFunction(decoder!, vm.undefined, jh, arr);
          jh.dispose();
          arr.dispose();
          if (decoded.error) {
            deferred.reject(decoded.error);
            decoded.error.dispose();
          } else {
            deferred.resolve(decoded.value);
            decoded.value.dispose();
          }
        } catch {
          const e = vm.newError(
            'Tool result could not be delivered to the sandbox',
          );
          deferred.reject(e);
          e.dispose();
        }
        deferred.dispose();
      });
      process.send!({ type: 'tool_call', id, name, json, attachments });
    };
    if (inFlight < TOOL_CALL_LIMITS.concurrent) {
      start();
    } else {
      waiting.push(start);
    }
    return deferred.handle.dup();
  });
  const namesH = vm.newString(JSON.stringify(names));
  const installer = vm.unwrapResult(vm.evalCode(PRELUDE));
  const installed = vm.callFunction(installer, vm.undefined, bridge, namesH);
  installer.dispose();
  namesH.dispose();
  bridge.dispose();
  if (installed.error) {
    installed.error.dispose();
    throw Error('execution_error');
  }
  decoder = installed.value;
  return () => {
    for (const d of pending) {
      if (d.alive) {
        d.dispose();
      }
    }
    decoder?.dispose();
  };
}
