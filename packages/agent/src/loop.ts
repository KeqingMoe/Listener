import {
  Agent,
  type AgentInitialState,
  type AgentLoopTurnUpdate,
  type AgentMessage,
  type FinishTurn,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import type {
  AssistantMessage,
  Model,
  ModelThinkingLevel,
} from '@earendil-works/pi-ai';
import {
  type Card,
  type Chat,
  type Event,
  type Mentioned,
  now,
  type Time,
} from '@listener/chat';
import protocol from './protocol.md?raw';
import { tools } from './tools';

export type AgentConfig = {
  model: Model<string>;
  streamFn: StreamFn;
  prompt?: string;
  sessionId?: string;
  signal: AbortSignal;
  mentioned: Mentioned;
  thinking?: ModelThinkingLevel;
};

export type Envelope = {
  now: Time;
  events: Event[];
};

export type LoopFeed = {
  type: 'feed';
  via: 'start' | 'turn';
  payload: Envelope;
  members: (Omit<Card, 'avatar'> & { avatar: boolean })[];
};

export type LoopAssistant = {
  type: 'assistant';
  message: AssistantMessage;
};

export type LoopTool = {
  type: 'tool';
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
  durationMs?: number;
};

export type LoopEvent = LoopFeed | LoopAssistant | LoopTool;

export type LoopHandler = (event: LoopEvent) => void;

function systemPrompt(selfId: string, custom?: string): string {
  const identity = `你的 QQ 号是 ${selfId}。`;
  return `${protocol.trim()}\n\n${identity}\n\n${custom?.trim() ?? ''}`;
}

function cardMessage(card: Card): AgentMessage {
  const { avatar, ...member } = card;
  return {
    role: 'user',
    content: [
      { type: 'text', text: JSON.stringify(member) },
      ...(avatar !== undefined ? [{ type: 'image' as const, ...avatar }] : []),
    ],
    timestamp: Date.now(),
  };
}

function cardFeed(card: Card) {
  return {
    ...card,
    avatar: card.avatar !== undefined,
  };
}

export async function runLoop(
  chat: Chat,
  window: number,
  config: AgentConfig,
  onEvent?: LoopHandler,
): Promise<void> {
  const { model, streamFn, prompt, sessionId, signal, mentioned, thinking } =
    config;

  const initialState: AgentInitialState = {
    systemPrompt: systemPrompt(chat.selfId, prompt),
    model,
    tools: tools(chat, signal, mentioned),
  };
  if (thinking !== undefined && thinking !== 'off') {
    initialState.thinkingLevel = thinking;
  }

  const finishTurn: FinishTurn = () => {
    return { action: signal.aborted ? 'end' : 'continue' };
  };

  const deliver = (via: LoopFeed['via']): AgentMessage[] => {
    const envelope: Envelope = { now: now(), events: chat.openWindow(window) };
    const cards = chat.members.take();
    onEvent?.({
      type: 'feed',
      via,
      payload: envelope,
      members: cards.map(cardFeed),
    });
    return [
      {
        role: 'user' as const,
        content: JSON.stringify(envelope),
        timestamp: Date.now(),
      },
      ...cards.map(cardMessage),
    ];
  };

  const prepareNextTurn = (): AgentLoopTurnUpdate => ({
    messages: deliver('turn'),
  });

  const agent = new Agent({
    streamFn,
    sessionId,
    initialState,
    finishTurn,
    prepareNextTurn,
  });

  agent.subscribe(event => {
    switch (event.type) {
      case 'message_end':
        if (event.message.role !== 'assistant') return;
        onEvent?.({ type: 'assistant', message: event.message });
        break;
      case 'tool_execution_end':
        onEvent?.({ ...event, type: 'tool' });
        break;
    }
  });

  const abort = agent.abort.bind(agent);
  signal.addEventListener('abort', abort, { once: true });

  if (signal.aborted) return;

  await agent.prompt(deliver('start'));
}
