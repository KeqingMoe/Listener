/** Identical expression in the writer index and readonly dashboard lookup; no historical body transfer. */
export const SESSION_PHYSICAL_TURN =
  "CASE WHEN json_valid(message) THEN CASE WHEN json_type(message,'$.content')='text' THEN CASE WHEN json_valid(json_extract(message,'$.content')) THEN json_extract(json_extract(message,'$.content'),'$.wake.wake_id') END END END";
export const SESSION_INSPECTION_INDEXES = `
 CREATE INDEX IF NOT EXISTS model_session_messages_request ON model_session_messages(request_id,seq);
 CREATE INDEX IF NOT EXISTS model_session_messages_wake ON model_session_messages(wake_id,seq);
 CREATE INDEX IF NOT EXISTS model_session_messages_turn ON model_session_messages((${SESSION_PHYSICAL_TURN}),seq);
 CREATE INDEX IF NOT EXISTS model_tool_ledger_wake ON model_tool_ledger(wake_id,assistant_seq,ordinal);
 CREATE INDEX IF NOT EXISTS model_session_journal_wake ON model_session_journal(wake_id,seq);
 CREATE INDEX IF NOT EXISTS model_session_journal_kind_time ON model_session_journal(kind,created_at,wake_id);
`;
