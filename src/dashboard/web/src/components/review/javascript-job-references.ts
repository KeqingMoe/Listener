import { isJavascriptJobId } from '../../../../contracts/javascript-jobs';

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** 只识别宿主协议字段；代码、返回值和普通文本中的ID不是关联证据。 */
export function javascriptJobReferences(
  name: string,
  args: unknown,
  result: unknown,
): { ids: string[]; more: boolean } {
  const a = object(args),
    r = object(result);
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && isJavascriptJobId(value)) {
      ids.add(value);
    }
  };
  let clipped = false;
  if (name === 'execute_javascript') {
    // 同步/前台完成也有job_id；只有明确pending返回才是转后台的证据。
    if (r?.status === 'pending') {
      add(r.job_id ?? r.jobId);
    }
  } else if (
    name === 'query_javascript_jobs' ||
    name === 'cancel_javascript_job'
  ) {
    add(a?.job_id);
    const job = object(r?.job);
    add(job?.job_id ?? job?.jobId);
    if (name === 'query_javascript_jobs' && Array.isArray(r?.jobs)) {
      clipped = r.jobs.length > 100;
      for (const raw of r.jobs.slice(0, 100)) {
        const item = object(raw);
        add(item?.job_id ?? item?.jobId);
      }
    }
  }
  return { ids: [...ids].slice(0, 10), more: clipped || ids.size > 10 };
}
