import type { Api } from '../contracts/onebot.ts';
import type { VisibleEffectObserver } from '../contracts/visible-effect.ts';
import type { Memory } from '../contracts/messages.ts';
import type { ToolDefinition, TurnContext } from '../contracts/tools.ts';
import type { JsonObject } from '../contracts/json.ts';
import type { ImageDownloader } from './images/download.ts';
import {
  GroupMediaTools,
  type GroupMediaOptions,
  GROUP_MEDIA_TOOL_NAMES,
} from './media/tools.ts';
import { GroupVoiceTools, GROUP_VOICE_TOOL_NAMES } from './voice/tools.ts';
import { GroupFileTools, GROUP_FILE_TOOL_NAMES } from './files/tools.ts';
import {
  GroupRequestTools,
  GROUP_REQUEST_TOOL_NAMES,
} from './requests/tools.ts';
import {
  enabledExtendedTools,
  type ExtendedToolsConfig,
  type ExtendedToolName,
} from '../config/extended-tools.ts';
import { GroupObservationTools } from './observation/tools.ts';
import { GroupActionTools, GROUP_ACTION_TOOL_NAMES } from './actions/tools.ts';
import { ToolRegistry, type RegisteredTool } from './registry.ts';
import { GroupTranscriptionTools } from './transcription/tools.ts';
import {
  GroupReminderTools,
  buildReminderTools,
  REMINDER_TOOL_NAMES,
} from './reminders/tools.ts';
import type { ReminderStore } from '../reminders/store.ts';
import type { SandboxService } from '../sandbox/service.ts';
import {
  SandboxTools,
  SANDBOX_TOOL_NAMES,
  buildSandboxTools,
} from './sandbox/tools.ts';
import {
  type WebTools,
  WEB_TOOL_NAMES,
  buildWebToolDefinitions,
} from './web/tools.ts';
import {
  ArtifactTools,
  buildArtifactToolDefinitions,
} from './artifacts/tools.ts';
import type { ArtifactStore } from '../artifacts/store.ts';
import { resolveOwnerId } from '../contracts/identity.ts';
import {
  CustomFaceTools,
  CUSTOM_FACE_TOOL_NAMES,
  buildCustomFaceToolDefinitions,
  type CustomFaceOptions,
} from './custom-faces/tools.ts';

interface ExtendedToolOptions {
  effectObserver?: VisibleEffectObserver;
  downloader?: ImageDownloader;
  maxDownloadMb?: number;
  reminders?: ReminderStore;
  sandbox?: SandboxService;
  web?: WebTools;
  artifacts?: ArtifactStore;
  /** 启用提醒工具时必填。 */
  ownerId?: string;
  beforeSend?: GroupMediaOptions['beforeSend'];
  onSent?: GroupMediaOptions['onSent'];
  files?: GroupFileTools;
  requests?: GroupRequestTools;
  customFaces?: Omit<CustomFaceOptions, 'beforeSend' | 'onSent'>;
  requestConfirmation?: (
    name: string,
    args: unknown,
    definition: ToolDefinition,
    context: TurnContext,
    signal?: AbortSignal,
  ) => Promise<JsonObject>;
}

/**
 * 按群配置组装扩展工具注册表。配置为confirm的写操作会被包装：调用只提交确认请求，
 * 由主人确认后才执行；只读、Web、沙箱与提醒工具不支持confirm模式。
 */
export function createExtendedTools(
  api: Api,
  memory: Memory,
  groupId: string,
  config?: ExtendedToolsConfig,
  options: ExtendedToolOptions = {},
): ToolRegistry {
  const enabled = new Set<string>(enabledExtendedTools(config));
  const registry = new ToolRegistry();
  const register = (tool: RegisteredTool): void => {
    const name = tool.definition.function.name;
    if (config?.[name as ExtendedToolName] !== 'confirm') {
      registry.register(tool);
      return;
    }
    if (!tool.sideEffect) {
      throw new Error('Read-only tools do not support mutation confirmation');
    }
    if ((WEB_TOOL_NAMES as readonly string[]).includes(name)) {
      throw new Error('Web tools do not support mutation confirmation');
    }
    if ((SANDBOX_TOOL_NAMES as readonly string[]).includes(name)) {
      throw new Error('Sandbox tools do not support mutation confirmation');
    }
    if ((REMINDER_TOOL_NAMES as readonly string[]).includes(name)) {
      throw new Error('Reminder tools do not support mutation confirmation');
    }
    const definition = structuredClone(tool.definition);
    definition.function.description =
      definition.function.description.replace(
        '立即执行，无隐式确认',
        '按本群配置确认后执行',
      ) +
      ' 当前模式confirm：此调用只提出操作，必须由主人在同群 /confirm 后才执行；confirmation_required不是成功，禁止绕过确认。';
    registry.register({
      ...tool,
      definition,
      execute: async (args, context, signal) => {
        if (!options.requestConfirmation) {
          return { status: 'error', error: 'confirmation_unavailable' };
        }
        try {
          return await options.requestConfirmation(
            name,
            args,
            definition,
            context,
            signal,
          );
        } catch {
          return { status: 'error', error: 'confirmation_failed' };
        }
      },
    });
  };
  const observations = new GroupObservationTools(api, groupId);
  for (const definition of observations.definitions()) {
    if (enabled.has(definition.function.name)) {
      register({
        definition,
        sideEffect: false,
        execute: (args, context, signal) =>
          observations.execute(definition.function.name, args, context, signal),
      });
    }
  }
  const actions = new GroupActionTools(
    api,
    groupId,
    GROUP_ACTION_TOOL_NAMES.filter((name) => enabled.has(name)),
    memory,
    options.effectObserver,
  );
  for (const definition of actions.definitions()) {
    register({
      definition,
      sideEffect: true,
      execute: (args, context, signal) =>
        actions.execute(definition.function.name, args, context, signal),
    });
  }
  const media = new GroupMediaTools(
    api,
    groupId,
    GROUP_MEDIA_TOOL_NAMES.filter((name) => enabled.has(name)),
    memory,
    {
      downloader: options.downloader,
      maxDownloadMb: options.maxDownloadMb,
      artifacts: options.artifacts,
      beforeSend: options.beforeSend,
      onSent: options.onSent,
      effectObserver: options.effectObserver,
    },
  );
  for (const definition of media.definitions()) {
    register({
      definition,
      sideEffect: true,
      execute: (args, context, signal) =>
        media.execute(definition.function.name, args, context, signal),
    });
  }
  const transcription = new GroupTranscriptionTools(api, memory, groupId);
  for (const definition of transcription.definitions()) {
    if (enabled.has(definition.function.name)) {
      register({
        definition,
        sideEffect: false,
        execute: (args, context, signal) =>
          transcription.execute(
            definition.function.name,
            args,
            context,
            signal,
          ),
      });
    }
  }
  const voice = new GroupVoiceTools(
    api,
    groupId,
    GROUP_VOICE_TOOL_NAMES.filter((name) => enabled.has(name)),
  );
  for (const definition of voice.definitions()) {
    register({
      definition,
      sideEffect: definition.function.name === 'send_group_ai_voice',
      execute: (args, context, signal) =>
        voice.execute(definition.function.name, args, context, signal),
    });
  }
  const files =
    options.files ??
    new GroupFileTools(
      api,
      groupId,
      GROUP_FILE_TOOL_NAMES.filter((name) => enabled.has(name)),
      { artifacts: options.artifacts, effectObserver: options.effectObserver },
    );
  for (const definition of files.definitions()) {
    if (enabled.has(definition.function.name)) {
      register({
        definition,
        sideEffect: ![
          'get_group_file_space',
          'list_group_files',
          'read_group_text_file',
        ].includes(definition.function.name),
        execute: (args, context, signal) =>
          files.execute(definition.function.name, args, context, signal),
      });
    }
  }
  const requests =
    options.requests ??
    new GroupRequestTools(
      api,
      groupId,
      GROUP_REQUEST_TOOL_NAMES.filter((name) => enabled.has(name)),
    );
  for (const definition of requests.definitions()) {
    if (enabled.has(definition.function.name)) {
      register({
        definition,
        sideEffect: definition.function.name === 'respond_group_request',
        execute: (args, context, signal) =>
          requests.execute(definition.function.name, args, context, signal),
      });
    }
  }
  const customNames = CUSTOM_FACE_TOOL_NAMES.filter((name) =>
    enabled.has(name),
  );
  const customFaces = options.customFaces
    ? new CustomFaceTools(api, groupId, customNames, memory, {
        ...options.customFaces,
        beforeSend: options.beforeSend,
        onSent: options.onSent,
      })
    : undefined;
  // 构建schema必须无副作用：仅为描述能力不得创建SQLite存储或访问provider。生产环境注入唯一的根仓库。
  for (const definition of buildCustomFaceToolDefinitions(customNames)) {
    register({
      definition,
      sideEffect: !['list_custom_faces', 'view_custom_face'].includes(
        definition.function.name,
      ),
      execute: (args, context, signal) =>
        customFaces
          ? customFaces.execute(definition.function.name, args, context, signal)
          : Promise.resolve({
              status: 'error',
              error: 'custom_faces_unavailable',
            }),
    });
  }
  const reminderNames = REMINDER_TOOL_NAMES.filter((name) => enabled.has(name));
  const reminders = options.reminders
    ? new GroupReminderTools(
        api,
        memory,
        groupId,
        resolveOwnerId(options.ownerId),
        options.reminders,
        reminderNames,
      )
    : undefined;
  for (const definition of buildReminderTools(reminderNames)) {
    register({
      definition,
      sideEffect: definition.function.name !== 'list_reminders',
      execute: (args, context, signal) =>
        reminders
          ? reminders.execute(definition.function.name, args, context, signal)
          : Promise.resolve({
              status: 'error',
              error: 'reminders_unavailable',
            }),
    });
  }
  const sandbox = options.sandbox
    ? new SandboxTools(options.sandbox)
    : undefined;
  for (const definition of buildSandboxTools()) {
    if (enabled.has(definition.function.name)) {
      register({
        definition,
        sideEffect: definition.function.name !== 'query_javascript_jobs',
        execute: (args, context, signal) =>
          context.groupId !== groupId
            ? Promise.resolve({ status: 'error', error: 'invalid_scope' })
            : sandbox
              ? sandbox.execute(definition.function.name, args, context, signal)
              : Promise.resolve({
                  status: 'error',
                  error: 'sandbox_unavailable',
                }),
      });
    }
  }
  for (const definition of buildWebToolDefinitions([...enabled])) {
    register({
      definition,
      sideEffect: false,
      execute: (args, _context, signal) =>
        options.web
          ? options.web.execute(definition.function.name, args, signal)
          : Promise.resolve({ status: 'error', error: 'web_unavailable' }),
    });
  }
  const artifacts = options.artifacts
    ? new ArtifactTools(options.artifacts)
    : undefined;
  for (const definition of buildArtifactToolDefinitions([...enabled])) {
    register({
      definition,
      sideEffect: false,
      execute: (args, context, signal) =>
        context.groupId !== groupId
          ? Promise.resolve({ status: 'error', error: 'invalid_scope' })
          : artifacts
            ? artifacts.execute(definition.function.name, args, context, signal)
            : Promise.resolve({
                status: 'error',
                error: 'artifacts_unavailable',
              }),
    });
  }
  return registry;
}

const noApi: Api = {
  async call() {
    throw new Error('Schema construction cannot make API calls');
  },
};
const emptyMemory: Memory = {
  recent: () => [],
  find: () => undefined,
  append: () => false,
  context: () => '',
  async compact() {},
  clear() {},
  close() {},
};

/** 稳定schema与运行时分发使用同一套注册逻辑，保证两者一致。 */
export function buildExtendedToolDefinitions(
  groupId: string,
  config?: ExtendedToolsConfig,
): ToolDefinition[] {
  return createExtendedTools(noApi, emptyMemory, groupId, config).definitions();
}
