export type ReaderAiStepErrorCode =
  | 'invalid_arguments'
  | 'conflict'
  | 'not_found'
  | 'timeout'
  | 'rate_limited'
  | 'network'
  | 'task_failed'
  | 'unknown_tool'
  | 'unknown';
