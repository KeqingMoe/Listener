<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ArtifactToolView } from './artifact-tool-view';
import { number, time } from '../../api/client';
import CopyText from './CopyText.vue';
import FoldBlock from './FoldBlock.vue';

const props = defineProps<{ view: ArtifactToolView }>();
const visibleCount = ref(10);
const visibleArtifacts = computed(() =>
  props.view.artifacts.slice(0, visibleCount.value),
);
const remaining = computed(() =>
  Math.max(0, props.view.artifacts.length - visibleCount.value),
);
const headings: Record<ArtifactToolView['kind'], string> = {
  create: '创建请求',
  list: '列表请求',
  upload: '上传请求',
  'send-image': '发图请求',
  'view-images': '查看请求',
};
const labels: Record<string, string> = {
  name: '名称',
  description: '用途说明',
  media_type: '媒体类型',
  format: '图片编码',
  ttl_ms: '有效期（毫秒）',
  width: '宽度（像素）',
  height: '高度（像素）',
  artifact_id: '产物 ID',
  folder_handle: '目录句柄',
  image_id: '图片 ID',
  image_ids: '图片/产物 ID',
  offset: '请求偏移',
  limit: '单页数量',
};
const fieldLabel = (key: string) => labels[key] ?? key;

function sizeLabel(size: number | null): string {
  if (size === null) {
    return '未记录';
  }
  if (size < 1024) {
    return `${number(size)} 字节`;
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const level = Math.min(
    units.length - 1,
    Math.floor(Math.log(size) / Math.log(1024)) - 1,
  );
  return `${number(size)} 字节（约 ${(size / 1024 ** (level + 1)).toFixed(2)} ${units[level]}）`;
}
</script>
<template>
  <section class="artifact-tool-result" aria-label="产物与引用记录">
    <template v-if="view.requested.length || view.references.length">
      <p class="artifact-label muted">{{ headings[view.kind] }}</p>
      <dl class="artifact-fields artifact-request">
        <template
          v-for="(field, index) in view.requested"
          :key="`field-${index}`"
        >
          <dt>{{ fieldLabel(field.label) }}</dt>
          <dd>{{ field.value }}</dd>
        </template>
        <template
          v-for="(reference, index) in view.references"
          :key="`reference-${index}`"
        >
          <dt>{{ fieldLabel(reference.label) }}</dt>
          <dd class="artifact-reference">
            <code>{{ reference.id }}</code
            ><CopyText
              :text="reference.id"
              :aria-label="`复制${fieldLabel(reference.label)} ${reference.id}`"
              compact
            />
          </dd>
        </template>
      </dl>
    </template>
    <p v-if="view.resultNote" class="artifact-result-note">
      {{ view.resultNote }}
    </p>
    <p v-if="view.artifacts.length" class="artifact-label muted">
      返回记录中的产物信息
    </p>
    <ol v-if="view.artifacts.length" class="artifact-cards">
      <li
        v-for="(artifact, index) in visibleArtifacts"
        :key="index"
        class="artifact-card"
      >
        <strong class="artifact-name">{{
          artifact.name || '名称未记录'
        }}</strong>
        <FoldBlock v-if="artifact.description" :lines="3" label="产物说明">{{
          artifact.description
        }}</FoldBlock>
        <dl class="artifact-fields">
          <dt>产物 ID</dt>
          <dd class="artifact-reference">
            <template v-if="artifact.id"
              ><code>{{ artifact.id }}</code
              ><CopyText
                :text="artifact.id"
                :aria-label="`复制产物 ID ${artifact.id}`"
                compact /></template
            ><span v-else>未记录</span>
          </dd>
          <dt>类型</dt>
          <dd>{{ artifact.mediaType || '未记录' }}</dd>
          <dt>大小</dt>
          <dd>{{ sizeLabel(artifact.size) }}</dd>
          <template v-if="artifact.width != null || artifact.height != null"
            ><dt>记录尺寸</dt>
            <dd>
              {{ artifact.width ?? '—' }} × {{ artifact.height ?? '—' }} px
            </dd></template
          >
          <dt>记录创建时间</dt>
          <dd>
            <time
              v-if="artifact.createdAt"
              :datetime="artifact.createdAt"
              :title="artifact.createdAt"
              >{{ time(Date.parse(artifact.createdAt)) }}</time
            ><span v-else>未记录</span>
          </dd>
          <dt>记录到期时间</dt>
          <dd>
            <time
              v-if="artifact.expiresAt"
              :datetime="artifact.expiresAt"
              :title="artifact.expiresAt"
              >{{ time(Date.parse(artifact.expiresAt)) }}</time
            ><span v-else>未记录</span>
          </dd>
          <template v-if="artifact.sha256"
            ><dt>SHA-256</dt>
            <dd class="artifact-reference">
              <code>{{ artifact.sha256 }}</code
              ><CopyText
                :text="artifact.sha256"
                aria-label="复制产物 SHA-256"
                compact
              /></dd
          ></template>
        </dl>
      </li>
    </ol>
    <button
      v-if="remaining"
      type="button"
      class="artifact-more"
      @click="visibleCount += 10"
    >
      再显示 {{ Math.min(10, remaining) }} 条已有产物（还剩 {{ remaining }} 条）
    </button>
    <p v-if="view.empty" class="artifact-empty muted">
      这次列表返回未列出产物，不代表当前列表仍为空。
    </p>
    <template v-if="view.messageId"
      ><p class="artifact-label muted">记录中的消息 ID</p>
      <p class="artifact-reference">
        <code>{{ view.messageId }}</code
        ><CopyText
          :text="view.messageId"
          aria-label="复制记录中的消息 ID"
          compact
        /></p
    ></template>
    <template v-if="view.loadedIds.length"
      ><p class="artifact-label muted">
        工具报告已加载的 ID（不代表已发送或模型已读取）
      </p>
      <ul class="artifact-loaded">
        <li
          v-for="(id, index) in view.loadedIds"
          :key="index"
          class="artifact-reference"
        >
          <code>{{ id }}</code
          ><CopyText :text="id" :aria-label="`复制已加载 ID ${id}`" compact />
        </li></ul
    ></template>
    <template v-if="view.failedIds.length"
      ><p class="artifact-label muted">工具报告加载失败的 ID</p>
      <ul class="artifact-failed">
        <li
          v-for="(id, index) in view.failedIds"
          :key="index"
          class="artifact-reference"
        >
          <code>{{ id }}</code
          ><CopyText :text="id" :aria-label="`复制加载失败 ID ${id}`" compact />
        </li></ul
    ></template>
    <p
      v-for="(notice, index) in view.notices"
      :key="index"
      class="artifact-notice"
    >
      {{ notice }}
    </p>
    <p class="artifact-safety muted">
      仅展示已有记录及引用
      ID；到期时间不是实时可用性检查。生成不代表已上传或发送，不读取文件、不加载图片。
    </p>
  </section>
</template>
<style scoped>
.artifact-tool-result {
  margin-top: var(--space-1);
  font-size: 12px;
  min-width: 0;
  overflow-wrap: anywhere;
}
p {
  margin: var(--space-1) 0;
}
.artifact-label {
  margin-top: var(--space-2);
}
.artifact-fields {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: var(--space-1) var(--space-2);
  margin: var(--space-1) 0;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
  min-width: 0;
  white-space: pre-wrap;
}
.artifact-reference {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1);
  min-width: 0;
}
code {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  min-width: 0;
}
.artifact-cards {
  padding: 0;
  list-style: none;
  margin: var(--space-1) 0;
}
.artifact-card {
  border-left: 2px solid var(--border);
  padding-left: var(--space-2);
}
.artifact-card + .artifact-card {
  margin-top: var(--space-3);
}
.artifact-name {
  white-space: pre-wrap;
}
.artifact-notice {
  color: #946018;
}
.artifact-more {
  min-height: 0;
  font-size: 12px;
  padding: var(--space-1) var(--space-2);
}
.artifact-loaded,
.artifact-failed {
  padding-left: 1em;
}
.artifact-safety {
  font-size: var(--font-small);
}
</style>
