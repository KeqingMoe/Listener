import type { SandboxService } from '../sandbox/service.ts';
import type { WebTools } from '../tools/web/tools.ts';
import type { ArtifactStore } from '../artifacts/store.ts';
import type { JsonObject } from '../contracts/json.ts';
import type { OriginalImageDownloader } from '../tools/images/download.ts';
import type { CustomFaceStore } from '../tools/custom-faces/store.ts';
import type { CustomFaceCoordinator } from '../tools/custom-faces/coordinator.ts';
import type { CustomFaceStager } from '../tools/custom-faces/staging.ts';
import type { ReminderStore } from '../reminders/store.ts';
import type { WorldEventStore } from '../world/events.ts';
import type { SideEffectPacer } from './pacing.ts';
import type { ModelSession } from './session/store.ts';
import type { VisibleEffectObserver } from '../contracts/visible-effect.ts';
import type { WakeEffectWaitStore } from '../observability/wake-effect-waits.ts';

export interface CustomFaceRuntime {
  store: CustomFaceStore;
  coordinator: CustomFaceCoordinator;
  staging?: CustomFaceStager;
  originalDownloader?: OriginalImageDownloader;
}

export interface ListenerRuntime {
  effectObserver?: VisibleEffectObserver;
  effectWaits?: Pick<WakeEffectWaitStore, 'begin' | 'finish'>;
  pacer?: SideEffectPacer;
  web?: WebTools;
  artifacts?: ArtifactStore;
  sandbox?: SandboxService;
  sandboxSummary?: (selfId: string, groupId: string) => JsonObject;
  reminders?: ReminderStore;
  world: WorldEventStore;
  session: ModelSession;
  modelRequestId?: () => string | undefined;
  customFaces?: CustomFaceRuntime;
}
