<script setup lang="ts">
import { computed } from 'vue';
import type { WakeDeliveryBatch } from '../../../../contracts/review';
import { toolView, type LookupContext } from './tool-summary';
import { deliveryItems, deliveryBlocks } from './delivery-view';
import ChatLines from './ChatLines.vue';
import ContentViewer from './ContentViewer.vue';

const props = defineProps<{
  batch: WakeDeliveryBatch;
  content: unknown;
  lookup: LookupContext;
}>();
const blocks = computed(() =>
  deliveryBlocks(deliveryItems(props.content)).map((block) =>
    block.kind === 'events'
      ? {
          ...block,
          view: toolView(
            'read_events',
            {},
            { events: block.events },
            props.lookup,
          ),
        }
      : { ...block, view: null },
  ),
);
</script>
<template>
  <section class="delivery-context" aria-label="投递上下文">
    <p class="muted">
      投递上下文 · {{ batch.worldEventCount }} 条世界事件<template
        v-if="batch.unreadCount !== null"
      >
        · 未读 {{ batch.unreadCount }} 条</template
      ><template v-if="batch.omittedCount !== null && batch.omittedCount > 0">
        · {{ batch.omittedCount }} 条未自动投递</template
      >
    </p>
    <p v-if="batch.contentTruncated" class="muted">投递内容未完整保留。</p>
    <template v-for="(block, index) in blocks" :key="index">
      <ChatLines
        v-if="block.kind === 'events' && block.view?.kind === 'messages'"
        :view="block.view"
      />
      <details v-else-if="block.kind !== 'events'" class="context-other">
        <summary>
          {{ block.kind === 'job' ? '后台任务结果' : '其它输入' }}
        </summary>
        <ContentViewer :value="block.value" label="投递内容" />
      </details>
    </template>
    <details>
      <summary>投递记录</summary>
      <ContentViewer :value="content" label="投递记录" />
    </details>
  </section>
</template>
