<script setup lang="ts">
import type { WebToolView } from './web-tool-view';
import FoldBlock from './FoldBlock.vue';
import WebResultLink from './WebResultLink.vue';

defineProps<{ view: WebToolView }>();
</script>
<template>
  <section
    class="web-tool-result"
    :aria-label="view.kind === 'search' ? '网页搜索记录' : '网页读取记录'"
  >
    <template v-if="view.kind === 'search'">
      <p class="web-label muted">搜索请求</p>
      <ul v-if="view.queries.length" class="web-queries">
        <li v-for="(query, index) in view.queries" :key="index">{{ query }}</li>
      </ul>
      <p v-else class="muted">查询内容未记录</p>
      <p v-if="view.sources.length" class="web-label muted">已返回的来源</p>
      <ol v-if="view.sources.length" class="web-sources">
        <li v-for="(source, index) in view.sources" :key="index">
          <strong
            ><WebResultLink
              :link="source"
              :text="source.title || source.url || '标题未记录'"
          /></strong>
          <p v-if="source.title && source.url" class="web-source-url muted">
            {{ source.url }}
          </p>
          <p v-if="source.publishedAt" class="muted">
            来源标注时间：{{ source.publishedAt }}
          </p>
          <FoldBlock v-if="source.snippet" :lines="4" label="摘要">{{
            source.snippet
          }}</FoldBlock>
        </li>
      </ol>
      <p v-if="view.empty" class="web-empty muted">本次返回未列出搜索来源</p>
    </template>
    <template v-else>
      <p class="web-label muted">读取请求</p>
      <p class="web-request-url"><WebResultLink :link="view.requestedUrl" /></p>
      <p v-if="view.returnedUrl" class="web-returned-url">
        <span class="muted">返回来源：</span
        ><WebResultLink :link="view.returnedUrl" />
      </p>
      <div class="web-meta muted">
        <span v-if="view.httpStatus != null">HTTP {{ view.httpStatus }}</span>
        <span v-if="view.contentType">类型 {{ view.contentType }}</span>
        <span v-if="view.start != null">起点 {{ view.start }}</span>
        <span v-if="view.totalChars != null"
          >正文总字符 {{ view.totalChars }}</span
        >
        <span v-if="view.nextStart != null"
          >记录的续读起点 {{ view.nextStart }}</span
        >
      </div>
      <template v-if="view.redirect">
        <p class="web-label">返回重定向目标（未自动读取）</p>
        <p class="web-redirect-url"><WebResultLink :link="view.redirect" /></p>
      </template>
      <template v-else-if="view.content != null">
        <p v-if="view.title" class="web-title">
          <strong>{{ view.title }}</strong>
        </p>
        <p class="web-label muted">已返回的正文（纯文本预览）</p>
        <FoldBlock
          v-if="view.content"
          :lines="10"
          label="网页正文"
          class="web-content"
          >{{ view.content }}</FoldBlock
        >
        <p v-if="view.empty" class="web-empty muted">返回的网页正文为空</p>
      </template>
    </template>
    <p v-for="(notice, index) in view.notices" :key="index" class="web-notice">
      {{ notice }}
    </p>
    <p class="web-safety muted">
      仅展示已有记录；外部链接需手动打开，不额外抓取网页或加载远程图片。
    </p>
  </section>
</template>
<style scoped>
.web-tool-result {
  margin-top: var(--space-1);
  font-size: 12px;
  overflow-wrap: anywhere;
  min-width: 0;
}
p {
  margin: var(--space-1) 0;
}
.web-label {
  margin-top: var(--space-2);
}
.web-queries,
.web-sources {
  margin: var(--space-1) 0;
  padding-left: 1.5em;
}
.web-queries {
  white-space: pre-wrap;
}
.web-sources li + li {
  margin-top: var(--space-2);
}
.web-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
}
.web-notice {
  color: #946018;
  white-space: pre-wrap;
}
.web-safety {
  font-size: var(--font-small);
}
</style>
