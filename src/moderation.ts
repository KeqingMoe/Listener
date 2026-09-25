import { randomBytes } from 'node:crypto';
import { log } from './logger.js';
import type { ModerationPolicy } from './listener-config.js';
import { LISTENER_GROUP, resolveGroupId, OWNER_ID, type Api, type JsonObject, type ToolDefinition, type TurnContext } from './contracts.js';

const userIdSchema = { type: 'string', pattern: '^[1-9][0-9]*$', description: 'Explicit target QQ user ID; never the owner or bot.' };
export const MODERATION_TOOLS: ToolDefinition[] = [
  { type: 'function', function: { name: 'mute_member', description: 'Propose a Listener member mute (0 seconds unmutes). Requires owner /confirm; never executes immediately.', parameters: { type: 'object', additionalProperties: false, required: ['user_id', 'seconds'], properties: { user_id: userIdSchema, seconds: { type: 'integer', minimum: 0, maximum: 600 } } } } },
  { type: 'function', function: { name: 'recall_message', description: 'Propose recalling a verified Listener message. Requires owner /confirm; never executes immediately.', parameters: { type: 'object', additionalProperties: false, required: ['message_id'], properties: { message_id: { type: 'string', pattern: '^-?(0|[1-9][0-9]*)$' } } } } },
  { type: 'function', function: { name: 'set_member_card', description: 'Propose changing a Listener member card. Requires owner /confirm; never executes immediately.', parameters: { type: 'object', additionalProperties: false, required: ['user_id', 'card'], properties: { user_id: userIdSchema, card: { type: 'string', minLength: 1, maxLength: 60 } } } } },
];
export const HELP = 'Only the owner in Listener may propose mute_member (0–600 seconds), recall_message, or set_member_card. Nothing changes until an explicit /confirm CODE within 60 seconds. Codes are single-use.';

type Action = { name: 'mute_member'; user_id: string; seconds: number } |
  { name: 'set_member_card'; user_id: string; card: string } |
  { name: 'recall_message'; message_id: string };
type Pending = { action: Action; context: TurnContext; target: string; expires: number };
const record = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && value === value.trim() && /^[1-9]\d*$/.test(value)) return value;
  return undefined;
};
const messageId = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && value === value.trim() && /^-?(0|[1-9]\d*)$/.test(value)) return value;
  return undefined;
};
const deny = (): never => { throw new Error('Moderation denied'); };

export class Moderation {
  private readonly pending = new Map<string, Pending>();
  private disposed = false;
  private readonly policy: Readonly<ModerationPolicy>;
  private readonly groupId: string;
  constructor(private readonly api: Api, private readonly now: () => number = Date.now, options: Partial<ModerationPolicy> = {}, groupId: string = LISTENER_GROUP) {
    this.groupId = resolveGroupId(groupId);
    const defaults: ModerationPolicy = { mute: true, recall: true, memberCard: true, confirmationTtlSeconds: 60, maxMuteSeconds: 600 };
    if (!record(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
      Reflect.ownKeys(options).some(key => typeof key !== 'string' || !Object.hasOwn(defaults, key))) throw new Error('Invalid moderation options');
    const policy = { ...defaults, ...options };
    if (['mute', 'recall', 'memberCard'].some(key => typeof policy[key as keyof ModerationPolicy] !== 'boolean') ||
      !Number.isInteger(policy.confirmationTtlSeconds) || policy.confirmationTtlSeconds < 1 || policy.confirmationTtlSeconds > 60 ||
      !Number.isInteger(policy.maxMuteSeconds) || policy.maxMuteSeconds < 1 || policy.maxMuteSeconds > 600) throw new Error('Invalid moderation options');
    this.policy = Object.freeze(policy);
  }

  private enforcePolicy(action: Action): void {
    if (action.name === 'mute_member' && (!this.policy.mute || action.seconds > this.policy.maxMuteSeconds) ||
      action.name === 'recall_message' && !this.policy.recall ||
      action.name === 'set_member_card' && !this.policy.memberCard) deny();
  }

  private prune(): void {
    const now = this.now();
    for (const [code, pending] of this.pending) if (now >= pending.expires) this.pending.delete(code);
  }

  private async authorize(context: TurnContext): Promise<void> {
    if (this.disposed || context.actorId !== OWNER_ID || context.groupId !== this.groupId ||
      !id(context.selfId) || context.selfId === OWNER_ID || !messageId(context.messageId)) deny();
    const login = await this.api.call('get_login_info');
    if (!record(login) || id(login.user_id) !== context.selfId || this.disposed) deny();
  }

  private parse(name: string, args: unknown): Action {
    if (!record(args) || (Object.getPrototypeOf(args) !== Object.prototype && Object.getPrototypeOf(args) !== null)) return deny();
    const expected = name === 'mute_member' ? ['user_id', 'seconds'] : name === 'set_member_card' ? ['user_id', 'card'] : name === 'recall_message' ? ['message_id'] : [];
    if (!expected.length || Reflect.ownKeys(args).length !== expected.length || expected.some(key => !Object.hasOwn(args, key))) return deny();
    if (name === 'recall_message') {
      if (typeof args.message_id !== 'string' || !messageId(args.message_id)) return deny();
      return { name, message_id: args.message_id };
    }
    if (typeof args.user_id !== 'string' || !id(args.user_id)) return deny();
    if (name === 'mute_member' && typeof args.seconds === 'number' && Number.isInteger(args.seconds) && args.seconds >= 0 && args.seconds <= 600) return { name, user_id: args.user_id, seconds: args.seconds };
    if (name === 'set_member_card' && typeof args.card === 'string' && Array.from(args.card).length >= 1 && Array.from(args.card).length <= 60 && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(args.card)) return { name, user_id: args.user_id, card: args.card };
    return deny();
  }

  private async verify(action: Action, context: TurnContext): Promise<string> {
    let target: string | undefined;
    if (action.name === 'recall_message') {
      const message = await this.api.call('get_msg', { message_id: action.message_id });
      if (!record(message) || message.message_type !== 'group' || id(message.group_id) !== this.groupId || messageId(message.message_id) !== action.message_id || !record(message.sender)) return deny();
      target = id(message.sender.user_id);
    } else {
      // Reject protected targets before even looking them up.
      if (action.user_id === OWNER_ID || action.user_id === context.selfId) return deny();
      const member = await this.api.call('get_group_member_info', { group_id: this.groupId, user_id: action.user_id, no_cache: true });
      if (!record(member) || id(member.group_id) !== this.groupId || id(member.user_id) !== action.user_id) return deny();
      // Unknown/missing roles cannot prove a target is an ordinary member.
      if (action.name === 'mute_member' && member.role !== 'member') return deny();
      target = id(member.user_id);
    }
    if (!target || target === OWNER_ID || target === context.selfId || this.disposed) return deny();
    return target;
  }

  private audit(action: string, context: TurnContext, target: string | undefined,
    outcome: 'proposed' | 'proposal_denied' | 'executed' | 'delivery_unknown' | 'confirmation_denied', seconds?: number): void {
    // Only validated identifiers and static outcomes; never card, code, chat or API error text.
    log(outcome === 'proposed' || outcome === 'executed' ? 'info' : 'warn', 'moderation.audit', {
      ...(['mute_member', 'recall_message', 'set_member_card'].includes(action) ? { action } : {}),
      ...(id(context.actorId) ? { actor_id: id(context.actorId) } : {}),
      ...(id(target) ? { target_id: id(target) } : {}),
      ...(messageId(context.messageId) ? { message_id: messageId(context.messageId) } : {}),
      ...(typeof seconds === 'number' && Number.isInteger(seconds) && seconds >= 0 && seconds <= 600 ? { seconds } : {}), outcome,
    });
  }

  async propose(name: string, args: unknown, context: TurnContext): Promise<JsonObject> {
    const fixed = { ...context };
    let target: string | undefined;
    try {
      const action = this.parse(name, args);
      this.enforcePolicy(action);
      await this.authorize(fixed);
      target = await this.verify(action, fixed);
      this.prune();
      if (this.disposed || this.pending.size >= 10) deny();
      const code = randomBytes(16).toString('hex');
      this.pending.set(code, { action, context: fixed, target, expires: this.now() + this.policy.confirmationTtlSeconds * 1000 });
      const description = action.name === 'mute_member' ? `群 ${this.groupId}：${action.seconds === 0 ? '解除禁言' : '禁言'}成员 ${target}，时长 ${action.seconds} 秒` : action.name === 'recall_message' ? `群 ${this.groupId}：撤回成员 ${target} 的消息 ${action.message_id}` : `群 ${this.groupId}：将成员 ${target} 的群名片设置为 ${JSON.stringify(action.card)}`;
      this.audit(name, fixed, target, 'proposed', action.name === 'mute_member' ? action.seconds : undefined);
      return { status: 'confirmation_required', code, description: `${description}；请在 ${this.policy.confirmationTtlSeconds} 秒内使用 /confirm CODE 确认`, expires_in_seconds: this.policy.confirmationTtlSeconds };
    } catch {
      this.audit(name, fixed, target, 'proposal_denied');
      return { status: 'error', error: 'Moderation proposal denied or verification unavailable.' };
    }
  }

  async confirm(code: string, context: TurnContext): Promise<JsonObject> {
    const fixed = { ...context };
    this.prune();
    const pending = this.pending.get(code);
    // Consume before the first await, including failed authorization/verification. Never retry.
    this.pending.delete(code);
    let attempted = false;
    try {
      if (!pending || fixed.actorId !== pending.context.actorId || fixed.groupId !== pending.context.groupId || fixed.selfId !== pending.context.selfId) return deny();
      this.enforcePolicy(pending.action);
      await this.authorize(fixed);
      const target = await this.verify(pending.action, fixed);
      if (target !== pending.target || this.disposed || this.now() >= pending.expires) return deny();
      const action = pending.action;
      attempted = true;
      if (action.name === 'mute_member') await this.api.call('set_group_ban', { group_id: this.groupId, user_id: action.user_id, duration: action.seconds });
      else if (action.name === 'set_member_card') await this.api.call('set_group_card', { group_id: this.groupId, user_id: action.user_id, card: action.card });
      else await this.api.call('delete_msg', { message_id: action.message_id });
      this.audit(action.name, fixed, target, 'executed', action.name === 'mute_member' ? action.seconds : undefined);
      return { status: 'executed' };
    } catch {
      this.audit(pending?.action.name ?? 'invalid', fixed, pending?.target, attempted ? 'delivery_unknown' : 'confirmation_denied');
      return { status: 'error', error: attempted ? 'Moderation action failed or delivery is unknown. Code consumed; do not blindly retry.' : 'Confirmation invalid, expired, unauthorized, or target verification failed.' };
    }
  }

  dispose(): void { this.disposed = true; this.pending.clear(); }
}
