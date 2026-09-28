<script setup lang="ts">
import { useRoute } from 'vue-router';
import type { ReviewTool } from '../../../../shared/review';
import { duration,status,time } from '../../api/client';
import ContentViewer from './ContentViewer.vue';
import CopyId from './CopyId.vue';
const route=useRoute();
defineProps<{tool:ReviewTool;groupId:string}>();
</script>
<template>
  <details class="tool-detail">
    <summary><strong>{{tool.name}}</strong><span class="badge">{{status(tool.outcome)}}</span><span class="muted">#{{tool.ordinal}} · {{duration(tool.durationMs)}}</span></summary>
    <p v-if="tool.reasonCode" class="muted">{{status(tool.reasonCode)}}</p>
    <details><summary>工具参数</summary><ContentViewer :value="tool.arguments" label="工具参数"/></details>
    <details><summary>工具结果</summary><ContentViewer :value="tool.result" label="工具结果"/></details>
    <details class="technical"><summary>技术详情</summary><div class="tool-facts"><span>{{status(tool.state)}}<template v-if="tool.status&&tool.status!==tool.state"> · {{status(tool.status)}}</template></span><span v-if="tool.proposedAt!=null">提出 {{time(tool.proposedAt)}}</span><span v-if="tool.startedAt!=null">开始 {{time(tool.startedAt)}}</span><span v-if="tool.finishedAt!=null">结束 {{time(tool.finishedAt)}}</span><CopyId v-if="tool.callId" :value="tool.callId"/><RouterLink v-if="tool.requestId" :to="{path:'/requests',query:{...route.query,outcome:route.path==='/requests'?route.query.outcome:undefined,detailGroup:undefined,selected:tool.requestId,group:groupId}}">查看请求</RouterLink></div></details>
  </details>
</template>
<style scoped>
.tool-detail { border-bottom: 1px solid var(--border); padding: var(--space-1) 0 var(--space-2); }
summary { font-size: 12px; }
summary > * { margin-right: var(--space-2); }
.content-viewer { margin: var(--space-2) 0; }
.technical > summary { font-size: var(--font-small); color: var(--muted); }
.tool-facts { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-3); font-size: var(--font-small); color: var(--muted); }
</style>
