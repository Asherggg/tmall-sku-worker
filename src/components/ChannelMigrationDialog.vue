<script setup lang="ts">
import { ref, watch } from "vue";
import { CircleAlert, RotateCcw } from "@lucide/vue";
import { CHANNEL_OPTION_LABELS, type ChannelOption, type TaskRecord } from "../types";

const props = defineProps<{
  modelValue: boolean;
  task: TaskRecord | null;
  pending?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  confirm: [value: ChannelOption];
}>();

const selected = ref<ChannelOption | "">("");
const options = (Object.entries(CHANNEL_OPTION_LABELS) as Array<[ChannelOption, string]>).map(([value, label]) => ({ value, label }));

watch(() => [props.modelValue, props.task?.id], () => {
  if (props.modelValue) selected.value = "";
});

function close() {
  if (!props.pending) emit("update:modelValue", false);
}

function confirm() {
  if (selected.value) emit("confirm", selected.value);
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="选择新的销售渠道"
    width="510px"
    append-to-body
    :close-on-click-modal="false"
    :close-on-press-escape="!pending"
    :show-close="!pending"
    class="channel-migration-dialog"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="task" class="channel-migration-body">
      <div class="channel-migration-alert">
        <CircleAlert :size="18" />
        <div>
          <strong>平台已升级销售渠道类型</strong>
          <p>商品 <span class="mono">{{ task.itemId }}</span> 的旧值“{{ task.channelOptionObserved || '空值' }}”不能提交，也不能自动映射。</p>
        </div>
      </div>
      <div class="channel-choice-label">请选择该商品当前真实销售渠道</div>
      <div class="channel-segments" role="radiogroup" aria-label="新的销售渠道">
        <button
          v-for="option in options"
          :key="option.value"
          type="button"
          role="radio"
          :aria-checked="selected === option.value"
          :class="{ selected: selected === option.value }"
          :disabled="pending"
          @click="selected = option.value"
        >
          <strong>{{ option.value }}</strong>
          <span>{{ option.label }}</span>
        </button>
      </div>
      <p class="channel-migration-note">确认后只重试当前商品。Worker 会重新读取页面并确认该选项仍由平台提供，随后才允许预检或提交。</p>
    </div>
    <template #footer>
      <button class="ghost-button" :disabled="pending" @click="close">取消</button>
      <button class="primary-button" :disabled="!selected || pending" @click="confirm">
        <RotateCcw :size="15" />{{ pending ? '正在重试' : '确认渠道并重试' }}
      </button>
    </template>
  </el-dialog>
</template>
