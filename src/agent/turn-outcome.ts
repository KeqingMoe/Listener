/** 一次wake中累计的计数，用于turn.end日志、session的finishWake和最终outcome判定。 */
export interface TurnStats {
  toolCalls: number;
  modelRounds: number;
  sentMessages: number;
  sentSubmissions: number;
  managementExecuted: number;
  managementSubmitted: number;
  managementUnknown: number;
  reactions: number;
  reactionSubmitted: number;
  reactionUnknown: number;
  reactionFailures: number;
}

export function newTurnStats(): TurnStats {
  return {
    toolCalls: 0,
    modelRounds: 0,
    sentMessages: 0,
    sentSubmissions: 0,
    managementExecuted: 0,
    managementSubmitted: 0,
    managementUnknown: 0,
    reactions: 0,
    reactionSubmitted: 0,
    reactionUnknown: 0,
    reactionFailures: 0,
  };
}

/** 记一次非重复的表情回应结果；失败码最多保留32个。 */
export function countReaction(
  stats: TurnStats,
  result: { status?: unknown; submitted?: unknown },
): void {
  if (result.status === 'ok') {
    if (result.submitted === true) {
      stats.reactionSubmitted++;
    } else {
      stats.reactions++;
    }
  } else if (result.status === 'unknown') {
    stats.reactionUnknown++;
  } else {
    stats.reactionFailures++;
  }
}

/** 模型正常结束且没有发出确认消息时，按已提交但未确认的副作用细化outcome。 */
export function silentOutcome(stats: TurnStats): string {
  return stats.sentSubmissions
    ? 'message_submitted'
    : stats.reactionUnknown
      ? 'reaction_unknown'
      : stats.reactions
        ? 'reacted'
        : stats.reactionSubmitted
          ? 'reaction_submitted'
          : stats.reactionFailures
            ? 'reaction_failed'
            : stats.managementSubmitted
              ? 'operation_submitted'
              : 'silent';
}

/** wake被取消时，按已经产生的副作用类型区分部分完成。 */
export function cancelledOutcome(stats: TurnStats): string {
  return stats.sentMessages || stats.sentSubmissions
    ? 'partial_reply_cancelled'
    : stats.reactions || stats.reactionUnknown || stats.reactionSubmitted
      ? 'partial_reaction_cancelled'
      : stats.managementExecuted ||
          stats.managementUnknown ||
          stats.managementSubmitted
        ? 'partial_management_cancelled'
        : 'cancelled';
}

/** 日志与session检查点共用的snake_case字段。 */
export function turnStatsFields(stats: TurnStats) {
  return {
    tool_calls: stats.toolCalls,
    model_rounds: stats.modelRounds,
    management_executed: stats.managementExecuted,
    management_submitted: stats.managementSubmitted,
    management_unknown: stats.managementUnknown,
    sent_messages: stats.sentMessages,
    sent_submissions: stats.sentSubmissions,
    reactions: stats.reactions,
    reaction_submitted: stats.reactionSubmitted,
    reaction_unknown: stats.reactionUnknown,
    reaction_failures: stats.reactionFailures,
  };
}
