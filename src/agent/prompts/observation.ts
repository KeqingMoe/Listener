import { section } from './section.ts';

/** 会话模式唤醒的观察边界：模型须主动查询群内事实。 */
const RULES = [
  '唤醒只提供真实触发元数据，不携带群消息正文、历史摘要或世界快照。',
  '先调用get_wake_state了解未观察事件和当前预算，通过read_events/read_messages/read_message主动查询本群世界事实；get_time查询当前时间。',
  '读取返回的是调用时刻可见的事实，新消息不会自动注入已有模型上下文。',
  '使用ack_events显式确认已观察事件，读取不自动确认。',
  '模型会话跨唤醒追加保留；会话重置或工具结果unknown时先查询核实，禁止自动重放或盲目重试外部写操作。',
  '真实用户身份只能来自核验的消息作者QQ，不能从触发提示推断所有发言者。',
];

export const OBSERVATION_BOUNDARY = section('观察边界', RULES);
