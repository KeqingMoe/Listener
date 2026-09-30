import type { Api } from '../contracts/onebot.ts';
import type { Memory, TimelineEntry } from '../contracts/messages.ts';
import type { JsonObject } from '../contracts/json.ts';
import type { ToolDefinition, TurnContext } from '../contracts/tools.ts';
import type { ProjectedListenerConfig } from '../config/listener.ts';
import type { ExtendedToolName } from '../config/extended-tools.ts';
import { createExtendedTools } from '../tools/extended.ts';
import { prepareExtendedConfirmation } from '../tools/confirmation.ts';
import type { Moderation } from '../tools/management/moderation.ts';
import {
  type GroupFileTools,
  GROUP_FILE_TOOL_NAMES,
} from '../tools/files/tools.ts';
import {
  type GroupRequestTools,
  GROUP_REQUEST_TOOL_NAMES,
} from '../tools/requests/tools.ts';
import {
  GroupActionTools,
  GROUP_ACTION_TOOL_NAMES,
} from '../tools/actions/tools.ts';
import {
  CustomFaceTools,
  CUSTOM_FACE_TOOL_NAMES,
} from '../tools/custom-faces/tools.ts';
import type { ImageDownloader } from '../tools/images/download.ts';
import type { SendReceiptSnapshot } from '../tools/media/tools.ts';
import { recordToolMessage } from '../world/ingest.ts';
import type { CustomFaceRuntime, ListenerRuntime } from './runtime-types.ts';

/** 扩展工具确认流程需要的Listener状态；函数字段在调用时读取最新值（/reset会替换moderation）。 */
export interface ExtendedConfirmationDeps {
  api: Api;
  groupId: string;
  config: ProjectedListenerConfig;
  runtime: ListenerRuntime;
  groupFiles: GroupFileTools;
  groupRequests: GroupRequestTools;
  customFaces?: CustomFaceRuntime;
  imageDownloader?: ImageDownloader;
  moderation: () => Moderation;
  memory: () => Memory | undefined;
  generation: () => number;
  /** 仍连接且未停止。 */
  live: () => boolean;
  captureSendReceipt: () => SendReceiptSnapshot;
  claimMessageAck: (
    entry: TimelineEntry,
    receipt?: SendReceiptSnapshot,
  ) => void;
}

/** 复核提案目标，返回写进确认描述的当前详情；目标不存在或无权时抛错。 */
async function confirmationDetails(
  deps: ExtendedConfirmationDeps,
  name: string,
  args: JsonObject,
  context: TurnContext,
  signal?: AbortSignal,
  memory?: Memory,
): Promise<string | undefined> {
  if (
    GROUP_ACTION_TOOL_NAMES.includes(
      name as (typeof GROUP_ACTION_TOOL_NAMES)[number],
    )
  ) {
    if (!memory) {
      throw new Error('verification_failed');
    }
    await new GroupActionTools(
      deps.api,
      deps.groupId,
      [name],
      memory,
    ).verifyProposal(name, args, context, signal);
  }
  if (
    GROUP_FILE_TOOL_NAMES.includes(
      name as (typeof GROUP_FILE_TOOL_NAMES)[number],
    )
  ) {
    return deps.groupFiles.confirmationDetails(name, args, context, signal);
  }
  if (
    GROUP_REQUEST_TOOL_NAMES.includes(
      name as (typeof GROUP_REQUEST_TOOL_NAMES)[number],
    )
  ) {
    return deps.groupRequests.confirmationDetails(name, args, context, signal);
  }
  if (
    CUSTOM_FACE_TOOL_NAMES.includes(
      name as (typeof CUSTOM_FACE_TOOL_NAMES)[number],
    )
  ) {
    if (!deps.customFaces || !memory) {
      throw new Error('verification_failed');
    }
    return new CustomFaceTools(
      deps.api,
      deps.groupId,
      [name],
      memory,
      deps.customFaces,
    ).confirmationDetails(name, args, context, signal);
  }
  return undefined;
}

export async function proposeExtended(
  deps: ExtendedConfirmationDeps,
  name: string,
  args: unknown,
  definition: ToolDefinition,
  context: TurnContext,
  memory: Memory,
  signal?: AbortSignal,
): Promise<JsonObject> {
  try {
    // 读取句柄或生成提案前先校验参数；这里不会派发任何写操作。
    const parsed = prepareExtendedConfirmation(
      name,
      args,
      definition,
      '目标待重新核验',
    ).args;
    const details = await confirmationDetails(
      deps,
      name,
      parsed,
      context,
      signal,
      memory,
    );
    const proposal = prepareExtendedConfirmation(
      name,
      parsed,
      definition,
      details,
    );
    if (signal?.aborted) {
      return { status: 'error', error: 'cancelled' };
    }
    return deps.moderation().requestExternal(
      {
        name,
        description: proposal.description,
        execute: async (approved, approvalSignal) => {
          try {
            if (
              deps.config.tools.extended?.[name as ExtendedToolName] !==
              'confirm'
            ) {
              return { status: 'error', error: 'tool_disabled' };
            }
            if (approvalSignal.aborted) {
              return { status: 'error', error: 'cancelled' };
            }
            const currentDetails = await confirmationDetails(
              deps,
              name,
              proposal.args,
              approved,
              approvalSignal,
              memory,
            );
            if (currentDetails !== details) {
              return {
                status: 'error',
                error: 'confirmation_target_changed',
              };
            }
            const generation = deps.generation();
            // 不捕获turnApi及其wake守卫（届时已过期）：/confirm是之后由主人发起的独立命令。
            const executor = createExtendedTools(
              deps.api,
              memory,
              deps.groupId,
              { ...deps.config.tools.extended, [name]: 'direct' },
              {
                files: deps.groupFiles,
                requests: deps.groupRequests,
                downloader: deps.imageDownloader,
                maxDownloadMb: deps.config.images.maxDownloadMb,
                customFaces: deps.customFaces
                  ? {
                      ...deps.customFaces,
                      maxDownloadMb: deps.config.images.maxDownloadMb,
                    }
                  : undefined,
                beforeSend: () => deps.captureSendReceipt(),
                onSent: (entry, receipt) => {
                  deps.claimMessageAck(entry, receipt);
                  if (deps.runtime.world) {
                    recordToolMessage(deps.runtime.world, entry);
                  }
                  if (
                    approvalSignal.aborted ||
                    generation !== deps.generation() ||
                    !deps.live()
                  ) {
                    return;
                  }
                  if (!deps.memory()?.find(entry.messageId)) {
                    deps.memory()?.append(entry);
                  }
                },
              },
            );
            const result = await executor.execute(
              name,
              proposal.args,
              approved,
              approvalSignal,
            );
            return result.status === 'ok' &&
              executor.isSideEffect(name) &&
              result.effect_confirmed === true
              ? { ...result, status: 'executed' }
              : result;
          } catch {
            return {
              status: 'error',
              error: 'confirmation_verification_failed',
            };
          }
        },
      },
      context,
      signal,
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    return {
      status: 'error',
      error: [
        'confirmation_description_too_large',
        'confirmation_details_required',
        'invalid_arguments',
      ].includes(code)
        ? code
        : 'confirmation_verification_failed',
    };
  }
}
