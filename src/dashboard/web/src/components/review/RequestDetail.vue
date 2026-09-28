<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { RequestReviewDetail } from '../../../../contracts/review';
import { duration, number, status, time } from '../../api/client';
import { useResource } from '../../composables/useDashboard';
import DataState from '../ui/DataState.vue';
import PerformanceFacts from '../ui/PerformanceFacts.vue';
import ContentViewer from './ContentViewer.vue';
import CopyId from './CopyId.vue';
import ToolDetails from './ToolDetails.vue';
import ModelBodyReader from './ModelBodyReader.vue';
const route = useRoute();
const props = defineProps<{ requestId: string; groupId: string }>();
const { data, loading, error, retry } = useResource<RequestReviewDetail>(computed(() => `requests/${encodeURIComponent(props.requestId)}?groupId=${encodeURIComponent(props.groupId)}`));
const tab = ref('output');
const tabs = [{ id: 'output', label: '输出' }, { id: 'reasoning', label: '思考' }, { id: 'body', label: '请求正文' }, { id: 'tools', label: '工具' }];
watch(() => [props.requestId, props.groupId], () => { tab.value = 'output'; });
const count = (value: number | null) => value == null ? '—' : number(value);
const hasFailure = computed(() => !!data.value && ['failed', 'error', 'timeout', 'cancelled', 'interrupted'].includes(data.value.request.outcome));
const mode = (value: string | null) => value ? ({fresh:'新请求',continue_live:'续接',continue_restored:'恢复续接','non-stream':'非流式'} as Record<string,string>)[value] || value : '';
const diagnosticFacts = computed(() => {
  const d = data.value?.request.diagnostics;
  if (!d) return [] as [string,string][];
  const labels: Record<string,string> = {
    request_timeout:'单请求超时',turn_timeout:'整轮时间上限',disconnected:'连接断开',reset:'会话重置',shutdown:'服务关闭',generation_changed:'任务已失效',external_unknown:'外部取消（来源不明）',
    request:'发送请求',http_status:'HTTP状态',response_body:'读取响应',response_parse:'解析响应',response_validate:'校验响应',post_response:'响应后处理',
    previous_response_missing:'前序响应不存在',context_limit:'上下文超限',invalid_tool_link:'工具关联无效',invalid_request:'请求无效',rate_limit:'速率或额度限制',auth:'鉴权失败',unknown:'未知类别',other:'其他参数'
  };
  const rows: [string,string][] = [];
  if(hasFailure.value){
    for(const [key,label] of [['abortSource','取消原因'],['failureStage','失败阶段'],['providerCategory','服务商错误类别'],['providerParameter','关联参数']] as const){const value=d[key];if(value)rows.push([label,labels[value]||value]);}
  }
  if(d.requestTimeoutMs!=null)rows.push(['请求时限',duration(d.requestTimeoutMs)]);
  return rows;
});
</script>
<template>
  <section class="request-detail" :aria-busy="loading">
    <DataState :loading="loading" :error="error" :stale="!!data" @retry="retry"><template v-if="data">
      <header class="request-head"><span class="badge">{{status(data.request.outcome)}}</span><strong>{{data.request.model || '模型请求'}}</strong><span>{{duration(data.request.durationMs)}}</span></header>
      <div class="request-tokens" title="未记录或不可用显示 —，不能视为 0。"><span title="未缓存输入">输入 <b>{{count(data.request.inputTokens)}}</b></span><span title="已命中缓存">缓存 <b>{{count(data.request.cachedInputTokens)}}</b></span><span title="含服务商报告推理，不重复相加">输出 <b>{{count(data.request.outputTokens)}}</b></span><small v-if="data.request.reasoningTokens!=null" class="muted">其中推理 {{count(data.request.reasoningTokens)}}</small></div>
      <PerformanceFacts :performance="data.request.performance" :cache="data.request" />
      <div class="request-context muted"><time>{{time(data.request.startedAt)}}</time><span>群 {{data.request.groupId}}</span><RouterLink v-if="data.request.wakeId" :to="{path:'/wakes',query:{...route.query,outcome:undefined,detailGroup:undefined,selected:data.request.wakeId,group:data.request.groupId}}">查看唤醒</RouterLink></div>
      <div class="request-ident"><CopyId :value="data.request.requestId"/><nav v-if="data.previousRequest || data.nextRequests.length" class="chain-links" aria-label="请求链"><RouterLink v-if="data.previousRequest" :to="{path:'/requests',query:{...route.query,detailGroup:undefined,selected:data.previousRequest.requestId,group:data.previousRequest.groupId}}">← 前序响应</RouterLink><RouterLink v-for="(next,index) in data.nextRequests" :key="next.requestId" :to="{path:'/requests',query:{...route.query,detailGroup:undefined,selected:next.requestId,group:next.groupId}}">后续响应{{data.nextRequests.length>1?` ${index+1}`:''}} →</RouterLink></nav></div>
      <details class="identifiers"><summary>技术详情</summary><dl class="metadata"><div v-for="[label,value] in diagnosticFacts" :key="label"><dt>{{label}}</dt><dd>{{value}}</dd></div><div><dt>传输</dt><dd>{{data.request.transport}}</dd></div><div v-if="data.request.requestMode"><dt>请求模式</dt><dd>{{mode(data.request.requestMode)}}</dd></div><div v-if="data.request.httpStatus!=null"><dt>HTTP</dt><dd>{{data.request.httpStatus}}</dd></div><div v-if="data.request.turnId"><dt>轮次</dt><dd><CopyId :value="data.request.turnId"/></dd></div><div v-if="data.request.responseId"><dt>响应</dt><dd><CopyId :value="data.request.responseId"/></dd></div><div v-if="data.request.previousResponseId"><dt>前序响应</dt><dd><CopyId :value="data.request.previousResponseId"/></dd></div><div v-if="data.request.providerRequestId"><dt>服务商请求</dt><dd><CopyId :value="data.request.providerRequestId"/></dd></div></dl></details>
      <section v-if="hasFailure && (data.request.errorCode || data.errorText)" class="error"><p v-if="data.request.errorCode">{{status(data.request.errorCode)}}</p><ContentViewer v-if="data.errorText" :value="data.errorText" label="错误详情"/></section>
      <p v-if="data.contentTruncated" class="muted">内容已截断</p>
      <div class="detail-tabs" role="tablist" aria-label="请求详情"><button v-for="item in tabs" :key="item.id" type="button" role="tab" :aria-selected="tab===item.id" :class="{active:tab===item.id}" @click="tab=item.id">{{item.label}}<template v-if="item.id==='tools'"> · {{data.tools.length}}</template></button></div>
      <section role="tabpanel" :aria-label="tabs.find(item=>item.id===tab)?.label" class="tab-content"><ModelBodyReader v-if="tab==='output'" :value="data.responseBody" kind="response"/><ContentViewer v-else-if="tab==='reasoning'" :value="data.reasoningText" label="思考"/><ModelBodyReader v-else-if="tab==='body'" :value="data.requestBody" kind="request" :request-mode="data.request.requestMode"/><template v-else><p v-if="!data.tools.length" class="muted">未记录工具调用</p><ToolDetails v-for="(tool,index) in data.tools" :key="`${tool.ordinal}-${index}`" :tool="tool" :group-id="data.request.groupId"/></template></section>
    </template></DataState>
  </section>
</template>
