import type { Api } from "../contracts/onebot.js";
import type { Memory } from "../contracts/messages.js";
import type { ToolDefinition, TurnContext } from "../contracts/tools.js";
import type { JsonObject } from "../contracts/json.js";
import type { ImageDownloader } from "./images/download.js";
import {
  GroupMediaTools,
  type GroupMediaOptions,
  GROUP_MEDIA_TOOL_NAMES,
} from "./media/tools.js";
import {
  GroupVoiceTools,
  GROUP_VOICE_TOOL_NAMES,
} from "./voice/tools.js";
import { GroupFileTools, GROUP_FILE_TOOL_NAMES } from "./files/tools.js";
import {
  GroupRequestTools,
  GROUP_REQUEST_TOOL_NAMES,
} from "./requests/tools.js";
import {
  enabledExtendedTools,
  type ExtendedToolsConfig,
  type ExtendedToolName,
} from "../config/extended-tools.js";
import { GroupObservationTools } from "./observation/tools.js";
import {
  GroupActionTools,
  GROUP_ACTION_TOOL_NAMES,
} from "./actions/tools.js";
import { ToolRegistry, type RegisteredTool } from "./registry.js";
import { GroupTranscriptionTools } from './transcription/tools.js';
import { GroupReminderTools, buildReminderTools, REMINDER_TOOL_NAMES } from './reminders/tools.js';
import type { ReminderStore } from '../reminders/store.js';
import { resolveOwnerId } from '../contracts/identity.js';
import { CustomFaceTools, CUSTOM_FACE_TOOL_NAMES, buildCustomFaceToolDefinitions, type CustomFaceOptions } from './custom-faces/tools.js';

export interface ExtendedToolOptions {
  downloader?: ImageDownloader;
  reminders?: ReminderStore;
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
    if (config?.[name as ExtendedToolName] !== "confirm") {
      registry.register(tool);
      return;
    }
    if (!tool.sideEffect)
      throw new Error("Read-only tools do not support mutation confirmation");
    if ((REMINDER_TOOL_NAMES as readonly string[]).includes(name))
      throw new Error('Reminder tools do not support mutation confirmation');
    const definition = structuredClone(tool.definition);
    definition.function.description =
      definition.function.description.replace(
        "立即执行，无隐式确认",
        "按本群配置确认后执行",
      ) +
      " 当前模式confirm：此调用只提出操作，必须由主人在同群 /confirm 后才执行；confirmation_required不是成功，禁止绕过确认。";
    registry.register({
      ...tool,
      definition,
      execute: async (args, context, signal) => {
        if (!options.requestConfirmation)
          return { status: "error", error: "confirmation_unavailable" };
        try {
          return await options.requestConfirmation(
            name,
            args,
            definition,
            context,
            signal,
          );
        } catch {
          return { status: "error", error: "confirmation_failed" };
        }
      },
    });
  };
  const observations = new GroupObservationTools(api, groupId);
  for (const definition of observations.definitions())
    if (enabled.has(definition.function.name))
      register({
        definition,
        sideEffect: false,
        execute: (args, context, signal) =>
          observations.execute(definition.function.name, args, context, signal),
      });
  const actions = new GroupActionTools(
    api,
    groupId,
    GROUP_ACTION_TOOL_NAMES.filter((name) => enabled.has(name)),
    memory,
  );
  for (const definition of actions.definitions())
    register({
      definition,
      sideEffect: true,
      execute: (args, context, signal) =>
        actions.execute(definition.function.name, args, context, signal),
    });
  const media = new GroupMediaTools(
    api,
    groupId,
    GROUP_MEDIA_TOOL_NAMES.filter((name) => enabled.has(name)),
    memory,
    { downloader: options.downloader, beforeSend: options.beforeSend, onSent: options.onSent },
  );
  for (const definition of media.definitions())
    register({
      definition,
      sideEffect: true,
      execute: (args, context, signal) =>
        media.execute(definition.function.name, args, context, signal),
    });
  const transcription = new GroupTranscriptionTools(api, memory, groupId);
  for (const definition of transcription.definitions())
    if (enabled.has(definition.function.name)) register({
      definition, sideEffect: false,
      execute: (args, context, signal) => transcription.execute(definition.function.name, args, context, signal),
    });
  const voice = new GroupVoiceTools(
    api,
    groupId,
    GROUP_VOICE_TOOL_NAMES.filter((name) => enabled.has(name)),
  );
  for (const definition of voice.definitions())
    register({
      definition,
      sideEffect: definition.function.name === "send_group_ai_voice",
      execute: (args, context, signal) =>
        voice.execute(definition.function.name, args, context, signal),
    });
  const files =
    options.files ??
    new GroupFileTools(
      api,
      groupId,
      GROUP_FILE_TOOL_NAMES.filter((name) => enabled.has(name)),
    );
  for (const definition of files.definitions())
    if (enabled.has(definition.function.name))
      register({
        definition,
        sideEffect: ![
          "get_group_file_space",
          "list_group_files",
          "read_group_text_file",
        ].includes(definition.function.name),
        execute: (args, context, signal) =>
          files.execute(definition.function.name, args, context, signal),
      });
  const requests =
    options.requests ??
    new GroupRequestTools(
      api,
      groupId,
      GROUP_REQUEST_TOOL_NAMES.filter((name) => enabled.has(name)),
    );
  for (const definition of requests.definitions())
    if (enabled.has(definition.function.name))
      register({
        definition,
        sideEffect: definition.function.name === "respond_group_request",
        execute: (args, context, signal) =>
          requests.execute(definition.function.name, args, context, signal),
      });
  const customNames = CUSTOM_FACE_TOOL_NAMES.filter(name => enabled.has(name));
  const customFaces = options.customFaces ? new CustomFaceTools(api, groupId, customNames, memory, {
    ...options.customFaces, beforeSend: options.beforeSend, onSent: options.onSent,
  }) : undefined;
  // Schema construction is pure: never create a SQLite store or touch the provider
  // merely to describe these capabilities. Production injects one root repository.
  for (const definition of buildCustomFaceToolDefinitions(customNames)) register({
    definition,
    sideEffect: !['list_custom_faces', 'view_custom_face'].includes(definition.function.name),
    execute: (args, context, signal) => customFaces
      ? customFaces.execute(definition.function.name, args, context, signal)
      : Promise.resolve({ status: 'error', error: 'custom_faces_unavailable' }),
  });
  const reminderNames = REMINDER_TOOL_NAMES.filter(name => enabled.has(name));
  const reminders = options.reminders ? new GroupReminderTools(api, memory, groupId, resolveOwnerId(options.ownerId), options.reminders, reminderNames) : undefined;
  for (const definition of buildReminderTools(reminderNames)) register({
    definition, sideEffect: definition.function.name !== 'list_reminders',
    execute: (args, context, signal) => reminders ? reminders.execute(definition.function.name, args, context, signal) : Promise.resolve({status:'error',error:'reminders_unavailable'}),
  });
  return registry;
}
const noApi: Api = {
  async call() {
    throw new Error("Schema construction cannot make API calls");
  },
};
const emptyMemory: Memory = {
  recent: () => [],
  find: () => undefined,
  append: () => false,
  context: () => "",
  async compact() {},
  clear() {},
  close() {},
};
/** Stable schemas use the same registry as runtime dispatch. */
export function buildExtendedToolDefinitions(
  groupId: string,
  config?: ExtendedToolsConfig,
): ToolDefinition[] {
  return createExtendedTools(noApi, emptyMemory, groupId, config).definitions();
}
