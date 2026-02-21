# Myclaw 阶段复盘 v0.2->v0.3（2026-02）

## 1. Tool Call 协议不稳定（json in text）

### 现象
- 模型把工具调用混在自然语言里。
- 出现重复输出、截断、乱码、参数结构不稳定。

### 根因
- 依赖“从文本里抽 JSON”解析，协议不强约束。
- OpenAI 兼容端点返回形态不完全一致。

### 当前方案
- Provider 优先使用原生 tool calling（`tools/tool_calls`）。
- 保留 `json in text` 解析作为 fallback。
- 工具结果回传时带上 `tool_call_id` + `name`，增强兼容性。
- 对空响应增加一次自动重试，并提供可读兜底。

### 后续优化
- 为“原生调用失败 -> 文本 fallback”增加单独统计事件。
- 在 debug 中输出原生 `tool_calls` 原始片段（可裁剪）。

## 2. 写文件内容异常（控制字符污染）

### 现象
- 生成的 Python 文件出现 `^M`。
- 字符串中的 `\n` 被写成真实换行，导致语法错误。

### 根因
- 某些端点/模型在工具参数中把转义字符解码成原始控制字符。

### 当前方案
- `write_file` 前统一做内容规范化。
- 把原始 `\r`、异常字符串换行转换为稳定的转义形式。

### 后续优化
- 加入“代码文件写入后快速语法检查”的可选步骤（按语言启用）。

## 3. Agent 行为震荡（重复探索与循环）

### 现象
- 高频重复 `list_files` / `ls`。
- 反复出现“读目录 -> 读文件 -> 怀疑 -> 再读目录/文件”循环。

### 根因
- 模型在低信息增量场景下缺少“换方向”策略。
- 运行时没有可观测指标帮助判断是否进入震荡。

### 当前方案
- Prompt 增加 anti-oscillation 规则。
- 执行器增加低价值重复探测拦截。
- 增加观测指标事件 `oscillation_observe`：
  - `repeatRatio`
  - `noveltyRatio`
  - `noMutationSteps`
  - `possibleOscillation`

### 后续优化
- 先告警后干预：
  - 首次仅提醒切换策略。
  - 连续触发再进入短时 cooldown。

## 4. 上下文控制与压缩

### 现象
- 长会话 token 成本高，历史噪声上升。

### 当前方案
- 滑动窗口 + 分块压缩：
  - 默认只带最近窗口消息。
  - 超阈值后生成 summary block 并注入系统上下文。
- 会话持久化到全局目录，支持恢复和切换。

### 后续优化
- 引入“重要事实”结构化记忆槽（约束 key/value）。
- 增加摘要质量评估（覆盖率、冲突检测）。

## 5. 运行时与监控解耦

### 目标
- 让 Agent 专注执行，监控能力通过订阅器扩展。

### 当前方案
- 引入进程内事件总线（EventBus）。
- Agent 统一发布事件，不直接依赖监控实现。
- 订阅器落地：
  - `SessionLogSubscriber`：写 `sessions/<session-id>.jsonl`
  - `MetricsSubscriber`：写 `metrics/<session-id>.jsonl`

### 价值
- 非侵入式监控。
- 便于扩展到 HTTP/MQ 上报。
- 便于做回放与复盘。

## 6. 发布链路经验

### 问题
- npm provenance 校验失败（`repository.url` 为空或不匹配）。

### 方案
- 在 `package.json` 中补齐 `repository/homepage/bugs`。
- release 前校验版本号、tag、仓库 URL 一致性。

## 7. 下一阶段建议（v0.2.x）

- 增加 `/metrics` 命令查看当前会话指标摘要。
- 增加“空响应率、fallback 率、重复调用率”周报脚本。
- 增加回归测试：
  - 原生 tool calling + fallback
  - 震荡检测指标输出
  - session/metrics 写盘完整性

## 8. 高优先更新落地（v0.3.x）

### 更新 A：异步 Soft-Gate 代码检查链路

### 已落地
- 写操作完成后触发 `write_completed` 事件，后台异步执行检查。
- JS 语法检查：`node --check`。
- Python 语法检查：`python3 -m py_compile`。
- ESLint 作为可选检查器，仅在检测到 `eslint.config.*` 时启用。
- 失败结果以 `tool_result` 形式注入主循环，驱动模型自修复。

### 收益
- 不阻塞主流程，保持交互响应。
- 对明显语法错误有即时回路，减少“写完即坏”的情况。
- 通过配置开关可按项目渐进启用。

### 经验
- ESLint v9+ 配置迁移（flat config）是常见失败源，需显式探测配置存在性。
- 异步检查需控制注入频率，避免重复报错噪声。

### 更新 B：跨会话稳定用户画像（长期记忆）

### 已落地
- 用户画像统一存放在 `~/.myclaw/user-profile.json`。
- 采用“单份稳定画像 + 增量更新”模型，不再按轮次无限追加。
- 画像仅在高价值时机（如 summary/exit）更新，不在每轮对话写入。
- 进入上下文时仅注入精简摘要（语言偏好、环境、习惯等关键信号）。

### 收益
- 降低上下文噪声，减少 token 浪费。
- 维持跨项目一致的用户偏好记忆，提升后续对话贴合度。
- 避免“每轮都写记忆”导致的污染和漂移。
