<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import ContentViewer from './ContentViewer.vue';

const props = defineProps<{
  value: unknown;
  kind: 'response' | 'request';
  requestMode?: string | null;
}>();
const mode = ref<'read' | 'raw'>('read');
watch(
  () => [props.value, props.kind],
  () => {
    mode.value = 'read';
  },
);

type RecordValue = Record<string, unknown>;

type Block = {
  label: string;
  value: unknown;
  role?: string;
  collapsed?: boolean;
};

const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const roleLabel = (role: unknown) =>
  typeof role === 'string'
    ? {
        assistant: '助手',
        user: '用户',
        system: '系统',
        developer: '开发者',
        tool: '工具',
      }[role] || role
    : '';
const continuation = computed(
  () =>
    props.kind === 'request' &&
    ['continue_live', 'continue_restored'].includes(props.requestMode || ''),
);

// 只展示图片元数据，绝不把图片载荷传给文本查看器。
function imageMetadata(part: RecordValue): RecordValue {
  const image = record(part.image_url)
    ? part.image_url
    : record(part.source)
      ? part.source
      : part;
  const metadata: RecordValue = {
    类型: typeof part.type === 'string' ? part.type : 'image',
  };
  const url = typeof part.image_url === 'string' ? part.image_url : image.url;
  if (typeof url === 'string') {
    try {
      const parsed = new URL(url);
      metadata.URL = ['http:', 'https:'].includes(parsed.protocol)
        ? `${parsed.origin}${parsed.pathname.length <= 240 ? parsed.pathname : '/[路径已省略]'}`
        : '[内嵌或非网络图片地址已省略]';
    } catch {
      metadata.URL = '[图片地址已省略]';
    }
  }
  for (const key of ['width', 'height'] as const) {
    const value = part[key] ?? image[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      metadata[key === 'width' ? '宽度' : '高度'] = value;
    }
  }
  metadata.说明 = '仅显示元数据，不加载图片';
  return metadata;
}

const reading = computed(() => {
  const blocks: Block[] = [];
  let recognized = false;
  const add = (
    label: string,
    value: unknown,
    role?: string,
    collapsed = false,
  ) => blocks.push({ label, value, role, collapsed });
  const bodyLabel = (role: unknown) =>
    props.kind === 'response' || role === 'assistant' ? '模型正文' : '消息正文';
  function content(value: unknown, role: unknown, label = bodyLabel(role)) {
    if (typeof value === 'string') {
      add(label, value, roleLabel(role));
      return;
    }
    if (!Array.isArray(value)) {
      return;
    }
    for (const part of value) {
      if (typeof part === 'string') {
        add(label, part, roleLabel(role));
        continue;
      }
      if (!record(part)) {
        continue;
      }
      if (
        part.type === 'reasoning' ||
        part.type === 'thinking' ||
        part.type === 'redacted_thinking'
      ) {
        continue;
      }
      if (
        ['image', 'image_url', 'input_image', 'output_image'].includes(
          String(part.type),
        )
      ) {
        add('图片元数据', imageMetadata(part), roleLabel(role));
      } else if (
        ['text', 'input_text', 'output_text'].includes(String(part.type))
      ) {
        if (typeof part.text === 'string') {
          add(label, part.text, roleLabel(role));
        }
      } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
        add(label, part.refusal, roleLabel(role));
      }
    }
  }
  function call(item: RecordValue) {
    const fn = record(item.function) ? item.function : item;
    let args = fn.arguments ?? null;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        /* 非JSON参数保留原样。 */
      }
    }
    add('模型提出（未据此确认执行）', {
      工具名称: typeof fn.name === 'string' ? fn.name : '未记录',
      参数: args,
      ...(typeof (item.call_id ?? item.id) === 'string'
        ? { 调用标识: item.call_id ?? item.id }
        : {}),
    });
  }
  function message(item: unknown): boolean {
    if (typeof item === 'string') {
      content(item, props.kind === 'request' ? 'user' : 'assistant');
      return true;
    }
    if (!record(item)) {
      return false;
    }
    if (item.type === 'reasoning') {
      return true;
    }
    if (item.type === 'function_call') {
      call(item);
      return true;
    }
    if (item.type === 'function_call_output') {
      if (Array.isArray(item.output)) {
        content(item.output, 'tool', '工具返回内容（记录值）');
      } else {
        add(
          '工具返回内容（记录值）',
          item.output ?? null,
          typeof item.call_id === 'string' ? item.call_id : undefined,
        );
      }
      return true;
    }
    if (typeof item.role === 'string' || item.type === 'message') {
      if (
        props.kind === 'request' &&
        (item.role === 'system' || item.role === 'developer')
      ) {
        const start = blocks.length;
        content(item.content, item.role, '系统指令');
        blocks.slice(start).forEach((block) => {
          block.collapsed = true;
        });
      } else if (item.role === 'tool') {
        if (Array.isArray(item.content)) {
          content(item.content, item.role, '工具返回内容（记录值）');
        } else {
          add(
            '工具返回内容（记录值）',
            item.content ?? null,
            typeof item.name === 'string' ? item.name : roleLabel(item.role),
          );
        }
      } else {
        content(item.content, item.role);
      }
      if (Array.isArray(item.tool_calls)) {
        item.tool_calls.forEach((tool) => {
          if (record(tool)) {
            call(tool);
          }
        });
      }
      if (record(item.function_call)) {
        call(item.function_call);
      }
      return true;
    }
    return false;
  }
  let value = props.value;
  // 部分记录是序列化后的envelope字符串，在此解析；原始模式仍显示原文。
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (record(parsed)) {
        value = parsed;
      }
    } catch {
      /* 普通模型文本。 */
    }
  }
  if (props.kind === 'response') {
    if (record(value)) {
      if (Array.isArray(value.output)) {
        recognized = true;
        value.output.forEach(message);
        if (
          !blocks.some((block) => block.label === '模型正文') &&
          typeof value.output_text === 'string'
        ) {
          content(value.output_text, 'assistant');
        }
      } else if (Array.isArray(value.choices)) {
        recognized = true;
        value.choices.forEach((choice) => {
          if (record(choice)) {
            message(choice.message);
          }
        });
      } else if (typeof value.output_text === 'string') {
        recognized = true;
        content(value.output_text, 'assistant');
      } else if (record(value.message)) {
        recognized = message(value.message);
      } else {
        recognized = message(value);
      }
    } else if (typeof value === 'string') {
      recognized = message(value);
    }
  } else if (record(value)) {
    if ('instructions' in value) {
      recognized = true;
      add('系统指令', value.instructions, undefined, true);
    }
    if ('input' in value) {
      if (Array.isArray(value.input)) {
        recognized = true;
        value.input.forEach(message);
      } else {
        recognized = message(value.input) || recognized;
      }
    }
    if (Array.isArray(value.messages)) {
      recognized = true;
      value.messages.forEach(message);
    }
    if ('tools' in value) {
      recognized = true;
      add('工具定义', value.tools, undefined, true);
    }
    if (!recognized) {
      recognized = record(value.message)
        ? message(value.message)
        : message(value);
    }
  } else if (typeof value === 'string') {
    recognized = message(value);
  }
  return { blocks, recognized };
});
</script>

<template>
  <section
    class="model-body-reader"
    :aria-label="kind === 'response' ? '模型响应' : '模型请求'"
  >
    <div class="reader-toolbar" role="group" aria-label="内容显示模式">
      <button
        type="button"
        :aria-pressed="mode === 'read'"
        @click="mode = 'read'"
      >
        阅读
      </button>
      <button
        type="button"
        :aria-pressed="mode === 'raw'"
        @click="mode = 'raw'"
      >
        原始JSON
      </button>
    </div>
    <p
      v-if="
        kind === 'request' &&
        record(value) &&
        value.source === 'persisted_session_context'
      "
      class="reader-note"
    >
      历史会话记录，非当时完整请求快照
    </p>
    <p v-else-if="continuation" class="reader-note">
      本次续接仅显示实际发送的增量内容
    </p>
    <ContentViewer
      v-if="mode === 'raw' || !reading.recognized"
      :value="value"
      label="原始JSON"
    />
    <template v-else>
      <p v-if="!reading.blocks.length" class="reader-note">
        没有可阅读的正文；完整记录可查看原始JSON。
      </p>
      <template v-for="(block, index) in reading.blocks" :key="index">
        <details v-if="block.collapsed" class="reader-block">
          <summary>{{ block.label }}</summary>
          <ContentViewer :value="block.value" :label="block.label" />
        </details>
        <section v-else class="reader-block">
          <h4>
            {{ block.label
            }}<span v-if="block.role" class="reader-role">{{
              block.role
            }}</span>
          </h4>
          <ContentViewer :value="block.value" :label="block.label" />
        </section>
      </template>
    </template>
  </section>
</template>

<style scoped>
.model-body-reader {
  min-width: 0;
}
.reader-toolbar {
  display: flex;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}
.reader-toolbar button[aria-pressed='true'] {
  font-weight: 650;
  border-color: var(--accent);
  color: var(--accent);
}
.reader-block {
  margin: var(--space-3) 0;
  min-width: 0;
}
h4 {
  margin: 0 0 var(--space-2);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.reader-role {
  margin-left: var(--space-2);
  font-weight: 400;
  color: var(--muted);
}
.reader-note {
  font-size: var(--font-small);
  color: var(--muted);
  margin: var(--space-2) 0;
}
</style>
