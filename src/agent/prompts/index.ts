import {
  applyToolPolicies,
  toolEnabled,
  observesReactions,
} from '../../config/runtime.ts';
import { resolveGroupId, resolveOwnerId } from '../../contracts/identity.ts';
import type { ListenerConfig } from '../../config/listener.ts';
import { enabledExtendedTools } from '../../config/extended-tools.ts';
import { CUSTOM_FACE_TOOL_NAMES } from '../../tools/custom-faces/tools.ts';
import { safetyRules } from './core.ts';
import { reactionRules } from './reactions.ts';
import { ATTENTION_RULES } from './attention.ts';
import { REMINDER_RULES } from './reminders.ts';
import { SANDBOX_RULES } from './sandbox.ts';
import { VOICE_RULES } from './voice.ts';
import { CUSTOM_FACE_RULES } from './custom-faces.ts';
import { webRules } from './web.ts';
import { OBSERVATION_BOUNDARY } from './observation.ts';

export { safetyRules };

/** 会话模式的系统提示词，config须带本群groupId。各能力段仅在本群启用对应工具时出现。 */
export function buildSystemPrompt(input: ListenerConfig): string {
  const config = applyToolPolicies(input);
  const extended = enabledExtendedTools(config.tools.extended);
  const reactions = reactionRules({
    react: config.tools.reactions === true,
    query: toolEnabled(config, 'get_reaction_users'),
    observe: observesReactions(config),
  });
  const attention = config.attention.enabled ? ATTENTION_RULES : '';
  const reminders = extended.includes('create_reminder') ? REMINDER_RULES : '';
  const sandbox = extended.includes('execute_javascript') ? SANDBOX_RULES : '';
  const transcription = extended.includes('transcribe_voice')
    ? VOICE_RULES
    : '';
  const customFaces = extended.some((name) =>
    (CUSTOM_FACE_TOOL_NAMES as readonly string[]).includes(name),
  )
    ? CUSTOM_FACE_RULES
    : '';
  const web = webRules(
    extended.filter((name) => name === 'web_search' || name === 'web_fetch'),
  );
  const identity = {
    name: config.botName ?? 'Listener',
    owner_id: resolveOwnerId(config.ownerId),
  };
  // 本群权限原样给模型参考；工具定义与执行结果仍是最终依据。
  const limits = config.toolPermissions
    ? {
        tools: config.toolPermissions,
        messages: { mentions: config.messageMentions ?? true },
        observation: { reactions: observesReactions(config) },
        confirmation: { ttl_seconds: config.confirmationTtlSeconds ?? 60 },
      }
    : { tools: '以本轮实际提供工具和操作结果中的确认要求为准' };
  return [
    `身份配置：${JSON.stringify(identity)}`,
    '',
    '性格与表达：',
    config.persona ?? '自然、简短地交流。',
    '',
    safetyRules(resolveGroupId(config.groupId)) +
      reactions +
      attention +
      transcription +
      reminders +
      customFaces +
      sandbox +
      web,
    `本轮配置限制：${JSON.stringify(limits)}`,
    '工具说明不授予权限：react_message、get_reaction_users和后台反应采集分别控制，只能调用本轮实际提供的工具。' +
      OBSERVATION_BOUNDARY,
  ].join('\n');
}
