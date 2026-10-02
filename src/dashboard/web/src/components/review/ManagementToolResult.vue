<script setup lang="ts">
import type { ManagementToolView } from './management-tool-view';
import CopyText from './CopyText.vue';
import FoldBlock from './FoldBlock.vue';

defineProps<{ view: ManagementToolView; groupId: string }>();
</script>
<template>
  <section class="management-tool-result" aria-label="群管理请求与结果">
    <p class="management-action">
      <span class="muted">请求操作：</span><strong>{{ view.action }}</strong>
    </p>
    <dl class="management-fields management-request">
      <dt>记录所属群</dt>
      <dd>
        <code>{{ groupId }}</code>
      </dd>
      <template
        v-for="(target, index) in view.targets"
        :key="`target-${index}`"
      >
        <dt>{{ target.label }}</dt>
        <dd>
          <div class="management-target">
            <code>{{ target.id }}</code
            ><CopyText
              :text="target.id"
              :aria-label="`复制${target.label} ${target.id}`"
              compact
            />
          </div>
          <span v-if="target.name" class="muted"
            >记录中的名称：{{ target.name }}</span
          >
        </dd>
      </template>
      <template
        v-for="(field, index) in view.requested"
        :key="`request-${index}`"
        ><dt>{{ field.label }}</dt>
        <dd>{{ field.value }}</dd></template
      >
    </dl>
    <div
      v-for="(body, index) in view.text"
      :key="index"
      class="management-text"
    >
      <p class="muted">{{ body.label }}（请求内容）</p>
      <FoldBlock :lines="4" :label="body.label">{{ body.value }}</FoldBlock>
    </div>
    <div class="management-stage" :data-tone="view.stage.tone">
      <strong>{{ view.stage.label }}</strong>
      <p>{{ view.stage.detail }}</p>
    </div>
    <details v-if="view.returned.length" class="management-receipt">
      <summary>返回依据（{{ view.returned.length }} 项）</summary>
      <dl class="management-fields management-returned">
        <template v-for="(field, index) in view.returned" :key="index"
          ><dt>{{ field.label }}</dt>
          <dd>{{ field.value }}</dd></template
        >
      </dl>
    </details>
    <template v-if="view.reasons.length"
      ><p class="muted">返回中的原因</p>
      <ul class="management-reasons">
        <li v-for="(reason, index) in view.reasons" :key="index">
          <code>{{ reason.code }}</code
          ><span v-if="reason.label"> — {{ reason.label }}</span>
        </li>
      </ul></template
    >
    <p
      v-for="(notice, index) in view.notices"
      :key="index"
      class="management-notice"
    >
      {{ notice }}
    </p>
    <p class="management-safety muted">
      仅展示已有请求与回执，不代表目标的当前状态；不执行、确认、重试或反向操作，也不额外读取远端列表。
    </p>
  </section>
</template>
<style scoped>
.management-tool-result {
  min-width: 0;
  font-size: 12px;
  overflow-wrap: anywhere;
  margin-top: var(--space-1);
}
p {
  margin: var(--space-1) 0;
}
.management-action {
  margin-bottom: var(--space-2);
}
.management-fields {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: var(--space-1) var(--space-2);
  margin: var(--space-1) 0 var(--space-2);
}
dt {
  color: var(--muted);
}
dd {
  min-width: 0;
  margin: 0;
  white-space: pre-wrap;
}
code {
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.management-target {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1);
  min-width: 0;
}
.management-stage {
  border-left: 2px solid var(--border);
  padding-left: var(--space-2);
  margin: var(--space-2) 0;
}
.management-stage[data-tone='warning'],
.management-notice {
  color: #946018;
}
.management-stage[data-tone='error'] {
  color: var(--error, #b42318);
}
.management-stage[data-tone='success'] {
  color: var(--success, #27734b);
}
.management-reasons {
  margin: var(--space-1) 0;
  padding-left: 1.5em;
}
.management-reasons li {
  margin: var(--space-1) 0;
}
.management-receipt {
  margin: var(--space-2) 0;
}
summary {
  cursor: pointer;
  color: var(--muted);
}
dd,
.management-text,
.management-reasons {
  unicode-bidi: plaintext;
}
.management-safety {
  font-size: var(--font-small);
}
</style>
