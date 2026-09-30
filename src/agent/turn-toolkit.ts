import type { Api } from '../contracts/onebot.ts';
import type { ChatContentPart } from '../contracts/model.ts';
import type { Memory, TimelineEntry } from '../contracts/messages.ts';
import type { JsonObject } from '../contracts/json.ts';
import type { ToolDefinition, TurnContext } from '../contracts/tools.ts';
import type { ProjectedListenerConfig } from '../config/listener.ts';
import { toolEnabled } from '../config/runtime.ts';
import { GroupTools } from '../tools/messaging/tools.ts';
import { ImageTools } from '../tools/images/tools.ts';
import type { ImageDownloader } from '../tools/images/download.ts';
import { ForwardTools } from '../tools/forwards/tools.ts';
import { ReactionTools } from '../tools/reactions/tools.ts';
import { ReactionUserTools } from '../tools/reactions/users.ts';
import type { ReactionObservations } from '../world/reaction-observations.ts';
import { recordToolMessage } from '../world/ingest.ts';
import { createExtendedTools } from '../tools/extended.ts';
import type { GroupFileTools } from '../tools/files/tools.ts';
import type { GroupRequestTools } from '../tools/requests/tools.ts';
import type { SendReceiptSnapshot } from '../tools/media/tools.ts';
import type { CustomFaceRuntime, ListenerRuntime } from './runtime-types.ts';

/** 构建一轮工具集所需的Listener状态；函数形式的字段在调用时读取最新值。 */
export interface TurnToolkitDeps {
  api: Api;
  groupId: string;
  ownerId: string;
  config: ProjectedListenerConfig;
  runtime: ListenerRuntime;
  observations?: ReactionObservations;
  imageDownloader?: ImageDownloader;
  groupFiles: GroupFileTools;
  groupRequests: GroupRequestTools;
  customFaces?: CustomFaceRuntime;
  memory: () => Memory | undefined;
  proposeExtended: (
    name: string,
    args: unknown,
    definition: ToolDefinition,
    context: TurnContext,
    memory: Memory,
    signal?: AbortSignal,
  ) => Promise<JsonObject>;
  captureSendReceipt: () => SendReceiptSnapshot;
  claimMessageAck: (
    entry: TimelineEntry,
    receipt?: SendReceiptSnapshot,
  ) => void;
}

export interface TurnToolkitOptions {
  memory: Memory;
  valid: () => boolean;
  onVisualContent?: (parts: ChatContentPart[]) => void;
  onSent?: (entry: TimelineEntry) => void;
}

/**
 * 为一次wake（或一次沙箱宿主调用）创建工具实例。
 * 有反应观察时，经turnApi的get_msg/set_msg_emoji_like会同步更新观察缓存。
 */
export function createTurnToolkit(
  deps: TurnToolkitDeps,
  options: TurnToolkitOptions,
) {
  const { memory: workingMemory, valid } = options;
  const observations = deps.observations;
  const turnApi: Api = observations
    ? {
        call: async (action, params) => {
          if (!valid()) {
            throw new Error('cancelled');
          }
          const target =
            typeof params?.message_id === 'string'
              ? params.message_id
              : undefined;
          const revision =
            action === 'get_msg' && target && valid()
              ? observations.revision(target)
              : undefined;
          if (action === 'set_msg_emoji_like' && target && valid()) {
            observations.markDirty(target);
          }
          try {
            const result = await deps.api.call(action, params);
            if (action === 'get_msg' && target && valid()) {
              observations.ingest(target, result, workingMemory, revision);
            }
            return result;
          } finally {
            if (action === 'set_msg_emoji_like' && target && valid()) {
              observations.markDirty(target);
            }
          }
        },
      }
    : deps.api;
  const groupTools = new GroupTools(turnApi, workingMemory, {
    groupId: deps.groupId,
    members: deps.config.tools.members,
    mention: deps.config.tools.mention,
    getGroupMembers: toolEnabled(deps.config, 'get_group_members'),
    getMemberInfo: toolEnabled(deps.config, 'get_member_info'),
  });
  const imageTools = deps.config.images.enabled
    ? new ImageTools(
        deps.api,
        workingMemory,
        deps.config.images,
        deps.imageDownloader,
        deps.groupId,
        deps.runtime.artifacts,
      )
    : undefined;
  const imageState = imageTools?.createTurn() ?? {
    loadedIds: new Set<string>(),
  };
  const forwardTools = deps.config.forward.enabled
    ? new ForwardTools(
        deps.api,
        workingMemory,
        deps.config.forward,
        deps.groupId,
      )
    : undefined;
  const reactionTools = deps.config.tools.reactions
    ? new ReactionTools(turnApi, workingMemory, deps.groupId)
    : undefined;
  const reactionUsers = toolEnabled(deps.config, 'get_reaction_users')
    ? new ReactionUserTools(turnApi, workingMemory, deps.groupId)
    : undefined;
  const extendedTools = createExtendedTools(
    turnApi,
    workingMemory,
    deps.groupId,
    deps.config.tools.extended,
    {
      downloader: deps.imageDownloader,
      maxDownloadMb: deps.config.images.maxDownloadMb,
      files: deps.groupFiles,
      requests: deps.groupRequests,
      reminders: deps.runtime.reminders,
      sandbox: deps.runtime.sandbox,
      web: deps.runtime.web,
      artifacts: deps.runtime.artifacts,
      ownerId: deps.ownerId,
      customFaces: deps.customFaces
        ? {
            ...deps.customFaces,
            imageState,
            maxDownloadMb: deps.config.images.maxDownloadMb,
            onVisualContent: (parts) => {
              if (valid()) {
                options.onVisualContent?.(parts);
              }
            },
          }
        : undefined,
      requestConfirmation: (name, args, definition, context, signal) =>
        deps.proposeExtended(
          name,
          args,
          definition,
          context,
          workingMemory,
          signal,
        ),
      beforeSend: () => deps.captureSendReceipt(),
      onSent: (entry, receipt) => {
        // 迟到但有效的ACK即使在取消或断线后仍记为world中的事实。
        deps.claimMessageAck(entry, receipt);
        if (deps.runtime.world) {
          recordToolMessage(deps.runtime.world, entry);
        }
        if (!valid()) {
          return;
        }
        if (!deps.memory()?.find(entry.messageId)) {
          deps.memory()?.append(entry);
        }
        options.onSent?.(entry);
      },
    },
  );
  return {
    turnApi,
    groupTools,
    imageTools,
    imageState,
    forwardTools,
    reactionTools,
    reactionUsers,
    extendedTools,
  };
}
