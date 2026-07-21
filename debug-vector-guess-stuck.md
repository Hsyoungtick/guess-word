# Debug Session: vector-guess-stuck

Status: [OPEN]

## Problem
部分词语提交后前端显示“向量计算中”，但没有返回结果；用户需要继续输入。示例：`说明书`。

## Hypotheses
1. Embedding API 对某些中文词返回异常/超时，服务端没有把错误正确返回给前端。
2. 服务端回合锁 `ai_request_id` / `semanticThinking` 在异常路径未释放，导致房间持续显示“向量计算中”。
3. 前端 `busy` 状态或提交表单流程在异常后未复位，导致 UI 表现为还要继续输入但没有明确错误。
4. `expectedVersion`、重复请求或超时恢复逻辑触发冲突，导致猜词请求失败但前端没有及时刷新快照。
5. 输入校验或归一化对某些词（如“说明书”）通过前端但被服务端/向量服务拒绝。

## Evidence Plan
- 先查看 Edge Function 的猜词、向量调用、异常恢复路径。
- 查看 Supabase Edge Function 日志获取真实错误。
- 必要时仅添加调试上报日志，不先修改业务逻辑。

## Evidence
- 前端 `sendGuess` 在提交前执行 `slice(0, 8)`，且输入框 `onChange` 也实时截断 8 字，会破坏中文输入法组合输入。
- 对局页没有显示 `actionError`，猜词失败时只恢复输入框，用户看不到错误原因。
- 服务端 `scoreGuess` 遇到 `EMBEDDING_ANCHOR_CONFLICT` 会直接抛错，导致部分历史排序冲突的词无法提交。
- 服务端原本没有结构化 embedding 日志，Dashboard 只能看到自动完成/关闭，无法判断是 HTTP 失败、超时、无效响应还是锚点冲突。

## Fix
- 猜词输入框取消实时 8 字限制，只在提交时限制 1～8 字。
- 对局页输入框下方显示提交错误。
- Edge Function 增加结构化日志：`guess.begin`、`embedding.request`、`embedding.response`、`embedding.fetch_failed`、`embedding.http_failed`、`embedding.invalid_response`、`embedding.anchor_conflict`、`guess.committed`、`guess.failed`、`guess.cancelled`。
- 向量排序和历史分数冲突时不再阻止提交，记录 `embedding.anchor_conflict` 后使用当前向量原始校准分。
- 取消回合锁失败时记录 `guess.cancel_failed`，避免掩盖根因。

## Notes
- 用户还询问“后台在哪看、怎么看后台日志”，需要提供 Supabase Dashboard 入口和可搜索事件名。
