import type { ReviewTool } from '../../../../contracts/review.ts';

export interface ArtifactEntry {
  id: string | null;
  name: string;
  description: string;
  mediaType: string;
  size: number | null;
  sha256: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  width: number | null;
  height: number | null;
}

export interface ArtifactToolView {
  kind: 'create' | 'list' | 'upload' | 'send-image' | 'view-images';
  requested: { label: string; value: string }[];
  references: { label: string; id: string }[];
  artifacts: ArtifactEntry[];
  loadedIds: string[];
  failedIds: string[];
  messageId: string | null;
  resultNote: string | null;
  notices: string[];
  empty: boolean;
}

const kinds: Record<string, ArtifactToolView['kind']> = {
  create_artifact: 'create',
  create_image: 'create',
  list_artifacts: 'list',
  upload_group_file: 'upload',
  send_group_image: 'send-image',
  view_images: 'view-images',
};
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const owns = (o: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, key);

/** Only this call's explicit metadata. Never inspect content, pixels or nested results. */
export function artifactToolView(
  tool: Pick<ReviewTool, 'name' | 'arguments' | 'result' | 'state' | 'outcome'>,
): ArtifactToolView | null {
  if (!owns(kinds, tool.name)) {
    return null;
  }
  const view: ArtifactToolView = {
    kind: kinds[tool.name]!,
    requested: [],
    references: [],
    artifacts: [],
    loadedIds: [],
    failedIds: [],
    messageId: null,
    resultNote: null,
    notices: [],
    empty: false,
  };
  const notice = (text: string) => {
    if (!view.notices.includes(text)) {
      view.notices.push(text);
    }
  };
  const invalid = (label: string) =>
    notice(`${label} 缺失或格式异常，未展示该值。`);
  const id = (v: unknown, label: string): string | null => {
    if (
      typeof v === 'string' &&
      v.length <= 256 &&
      v.trim().length > 0 &&
      !/[\p{Cc}\p{Cf}]/u.test(v)
    ) {
      return v;
    }
    invalid(label);
    return null;
  };
  const text = (v: unknown, label: string, max = 500): string => {
    if (typeof v !== 'string') {
      invalid(label);
      return '';
    }
    let end = 0;
    for (let count = 0; count < max && end < v.length; count++) {
      end += v.codePointAt(end)! > 0xffff ? 2 : 1;
    }
    if (end < v.length) {
      notice(`${label} 已截短（最多 ${max} Unicode码点）。`);
      return `${v.slice(0, end)}…（已截短）`;
    }
    return v;
  };
  const integer = (v: unknown, label: string, min: number): number | null => {
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= min) {
      return v;
    }
    invalid(label);
    return null;
  };
  const time = (v: unknown, label: string): string | null => {
    // Require a timezone and validate the calendar before Date.parse can normalize it.
    if (typeof v === 'string' && v.length <= 40) {
      const m =
        /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(?:Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/.exec(
          v,
        );
      if (m) {
        const year = Number(m[1]),
          month = Number(m[2]),
          day = Number(m[3]);
        const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
        const days = [
          31,
          leap ? 29 : 28,
          31,
          30,
          31,
          30,
          31,
          31,
          30,
          31,
          30,
          31,
        ];
        if (
          month >= 1 &&
          month <= 12 &&
          day >= 1 &&
          day <= days[month - 1]! &&
          Number.isFinite(Date.parse(v))
        ) {
          return v;
        }
      }
    }
    invalid(label);
    return null;
  };
  const args = object(tool.arguments);
  const result = object(tool.result);
  if (tool.arguments != null && !args) {
    invalid('请求对象');
  }
  if (tool.result != null && !result) {
    invalid('返回对象');
  }
  const r = result ?? {};
  const status = r.status;
  if (owns(r, 'status') && typeof status !== 'string') {
    invalid('status');
  }
  const settled = tool.state === 'finished' && tool.outcome === 'handled';
  const controlFlags = [
    'effect_unknown',
    'submitted',
    'cancelled_after_dispatch',
    'duplicate',
  ];
  const blocked =
    controlFlags.some((key) => owns(r, key) && r[key] !== false) ||
    (owns(r, 'effect_confirmed') && r.effect_confirmed !== true);
  const confirmed = settled && !blocked;
  if (result && !settled) {
    notice('未获得成功执行的确认；以下仅保留已有返回字段。');
  }
  if (blocked) {
    notice(
      '返回控制标记异常或未确认成功效果，不确认新的成功执行；以上层调用证据为准。',
    );
  }
  const bool = (key: string, required = false) => {
    if ((owns(r, key) || required) && typeof r[key] !== 'boolean') {
      invalid(key);
    }
  };
  for (const key of [...controlFlags, 'effect_confirmed']) {
    bool(key);
  }
  const entry = (v: unknown, required: boolean): ArtifactEntry | null => {
    const o = object(v);
    if (!o) {
      invalid('ArtifactInfo');
      return null;
    }
    const field = <T>(
      key: string,
      parse: (v: unknown, label: string) => T,
      fallback: T,
      needed = required,
    ): T => (owns(o, key) || needed ? parse(o[key], key) : fallback);
    const hash = (v: unknown, label: string): string | null => {
      if (typeof v === 'string' && /^[a-fA-F0-9]{64}$/.test(v)) {
        return v;
      }
      invalid(label);
      return null;
    };
    return {
      id: field('artifact_id', id, null),
      name: field('name', (v, l) => text(v, l, 128), ''),
      description: field('description', text, ''),
      mediaType: field('media_type', (v, l) => text(v, l, 128), ''),
      size: field('size', (v, l) => integer(v, l, 0), null),
      sha256: field('sha256', hash, null),
      createdAt: field('created_at', time, null),
      expiresAt: field('expires_at', time, null),
      width: field(
        'width',
        (v, l) => integer(v, l, 1),
        null,
        required && tool.name === 'create_image',
      ),
      height: field(
        'height',
        (v, l) => integer(v, l, 1),
        null,
        required && tool.name === 'create_image',
      ),
    };
  };
  const reference = (key: string) => {
    if (!args || !owns(args, key)) {
      return;
    }
    const value = id(args[key], key);
    if (value !== null) {
      view.references.push({ label: key, id: value });
    }
  };
  const ids = (
    o: Record<string, unknown>,
    key: string,
    required = false,
  ): string[] => {
    if (!owns(o, key) && !required) {
      return [];
    }
    const values = o[key];
    if (!Array.isArray(values)) {
      invalid(key);
      return [];
    }
    if (values.length > 20) {
      notice(`${key} 仅展示前 20 条ID（已截短列表）。`);
    }
    const out: string[] = [];
    for (let i = 0; i < Math.min(values.length, 20); i++) {
      const value = id(values[i], key);
      if (value !== null) {
        out.push(value);
      }
    }
    return out;
  };
  if (view.kind === 'create') {
    if (args) {
      for (const key of [
        'name',
        'description',
        'media_type',
        'format',
        'ttl_ms',
        'width',
        'height',
      ]) {
        if (!owns(args, key)) {
          continue;
        }
        if (['ttl_ms', 'width', 'height'].includes(key)) {
          const value = integer(args[key], `请求 ${key}`, 1);
          if (value !== null) {
            view.requested.push({ label: key, value: String(value) });
          }
        } else {
          view.requested.push({
            label: key,
            value: text(
              args[key],
              `请求 ${key}`,
              key === 'description' ? 500 : 128,
            ),
          });
        }
      }
      if (tool.name === 'create_artifact' && !owns(args, 'media_type')) {
        view.requested.push({
          label: 'media_type',
          value: '默认application/octet-stream（请求默认）',
        });
      }
    }
    const fields = [
      'artifact_id',
      'name',
      'description',
      'media_type',
      'size',
      'sha256',
      'created_at',
      'expires_at',
      'width',
      'height',
    ];
    if (status === 'ok' || fields.some((key) => owns(r, key))) {
      const artifact = entry(r, status === 'ok');
      if (artifact) {
        view.artifacts.push(artifact);
      }
      if (status === 'ok' && artifact?.id) {
        view.resultNote = confirmed
          ? '返回记录报告已生成产物，不代表已上传或发送'
          : '返回记录包含产物字段，但不足以确认生成成功。';
      }
    }
  } else if (view.kind === 'list') {
    if (args) {
      for (const key of ['offset', 'limit'] as const) {
        if (!owns(args, key)) {
          view.requested.push({
            label: key,
            value: `${key === 'offset' ? 0 : 20}（请求默认）`,
          });
          continue;
        }
        const value = integer(
          args[key],
          `请求 ${key}`,
          key === 'offset' ? 0 : 1,
        );
        if (value !== null) {
          view.requested.push({ label: key, value: String(value) });
          if (key === 'offset' && value > 0) {
            notice('请求从该偏移开始，本页结果不能代表偏移前的内容。');
          }
        }
      }
    }
    bool('has_more', status === 'ok');
    if (owns(r, 'artifacts') || status === 'ok') {
      if (!Array.isArray(r.artifacts)) {
        invalid('artifacts');
      } else {
        if (r.artifacts.length > 100) {
          notice('产物仅保留前 100 条，超出部分已省略。');
        }
        for (let i = 0; i < Math.min(r.artifacts.length, 100); i++) {
          const artifact = entry(r.artifacts[i], status === 'ok');
          if (artifact) {
            view.artifacts.push(artifact);
          }
        }
        view.empty =
          confirmed &&
          status === 'ok' &&
          r.artifacts.length === 0 &&
          r.has_more === false;
      }
    }
    if (r.has_more === true) {
      notice('返回报告还有后续产物，本页不是完整列表。');
    }
    if (view.empty) {
      view.resultNote =
        '本次返回的产物列表为空，不代表当前或其他记录中没有产物。';
    }
  } else if (view.kind === 'upload') {
    reference('artifact_id');
    reference('folder_handle');
    for (const key of [
      'uploaded',
      'effect_confirmed',
      'resource_id_available',
    ]) {
      bool(key, status === 'ok');
    }
    if (
      confirmed &&
      status === 'ok' &&
      r.uploaded === true &&
      r.effect_confirmed === true
    ) {
      view.resultNote = '工具明确回报上传成功';
    } else if (status === 'ok') {
      view.resultNote = '返回不足以确认上传成功。';
    }
    if (r.resource_id_available === false) {
      notice(
        'resource_id_available=false 仅表示未拿到新文件ID，不表示上传失败。',
      );
    }
  } else if (view.kind === 'send-image') {
    reference('artifact_id');
    reference('image_id');
    if (args && owns(args, 'artifact_id') && owns(args, 'image_id')) {
      notice(
        '请求同时包含 artifact_id 和 image_id，引用冲突，不猜测实际使用哪个。',
      );
    }
    if (owns(r, 'message_id') || status === 'executed') {
      view.messageId = id(r.message_id, 'message_id');
    }
    bool('local_projection_failed');
    if (confirmed && status === 'executed' && view.messageId) {
      view.resultNote = '工具回报发送已执行，不代表已读。';
    }
    if (r.local_projection_failed === true) {
      notice('本地记录同步失败，不据此逆转发送为失败。');
    }
  } else {
    if (args) {
      view.references = ids(args, 'image_ids').map((value) => ({
        label: 'image_ids',
        id: value,
      }));
    }
    view.loadedIds = ids(
      r,
      'loaded_ids',
      status === 'ok' || status === 'partial',
    );
    view.failedIds = ids(
      r,
      'failed_ids',
      status === 'ok' || status === 'partial',
    );
    if (view.loadedIds.length) {
      view.resultNote = '工具报告已加载ID，不代表模型已看或图片已发送。';
    }
  }
  if (
    view.artifacts.some((a) => a.createdAt !== null || a.expiresAt !== null)
  ) {
    notice('时间仅为返回记录快照，不判断当前过期、删除或可用状态。');
  }
  return view;
}
