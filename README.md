# YGO AI

面向 AI Agent 的游戏王工具集，以 **MCP（Model Context Protocol）服务器**形式提供。

卡片数据 · 禁限表 · 卡组管理 · OCG 规则引擎 · 决斗推演 · 录像复盘 · YGOPro2 桥接

```text
MCP Client (Agent)
        │  tools/call
        ▼
mcp/server.mjs            薄 MCP 主机（14 个聚合工具）
        │
        ▼
skill/backend/            工具、会话、引擎适配
        │
        ▼
持久引擎主机 127.0.0.1:19981   OCG 规则引擎（按需启动，跨重启保留）
```

## 快速开始

```bash
npm install          # 安装 @modelcontextprotocol/sdk
node mcp/server.mjs  # 以 stdio 方式启动 MCP 服务器
```

任意 MCP 客户端的配置：

```json
{
  "mcpServers": {
    "ygo-ai": {
      "command": "node",
      "args": ["<绝对路径>/mcp/server.mjs"]
    }
  }
}
```

引擎在第一次调用工具时自动启动，并以 detached 进程形式跨客户端重启保留；
不安装、不配置、不注册任何外部服务。

## 工具一览

| 类别 | 工具 |
| :--- | :--- |
| **卡片** | `queryCards` · `manageCardDataSources` · `getBanlistContext` |
| **卡组** | `manageSessionDeck` |
| **决斗** | `resetGame` · `observeDuel` · `executeAction` · `simulateActions` |
| **状态** | `manageCheckpoint` · `manageEngineSession` |
| **分析** | `analyzeCombo` · `analyzeReplay` · `saveArtifact` |
| **桥接** | `manageYgoPro2` |

共 14 个聚合工具；每个工具用 `action` 参数选择子操作。工具的 JSON Schema 由引擎
侧定义，MCP 主机只做转发，不在本进程加载规则引擎。

## 能力

- **卡片与禁限表**：按 ID 或名称查询已验证卡文、类型、数值；读取禁限表与卡库状态。
- **卡组**：装载、检查、编辑、导出 YDK；YDK 文本原样交给引擎解析。
- **决斗**：创建局面、固定起手、观察合法动作并执行；支持检查点回滚与分支推演。
- **录像**：解析 `.yrp` / `.yrp2` / `.yrp3d`，构建可读的路线上下文。
- **YGOPro2 桥接**：发现本地 YGOPro2 组件，连接 AI.Server 进行真实对局，导出权威
  录像字节。

默认全部在内存中完成，不写日志、报告或工作流文件；只有显式调用 `saveArtifact`
才会落盘。

## 目录结构

```text
mcp/          MCP 主机（stdio），唯一对外入口
lib/          其他宿主（可选）的入口适配
skill/backend 工具实现、会话、持久引擎客户端
skill/references  数据来源与决策纪律说明
skill/resources   卡库、脚本、YGOPro2 桥接资源
skill/runtime     内嵌规则运行器
patches/      WindBot 补丁与重建说明
```

## WindBot 补丁

`skill/resources/ygopro2-bridge/windbot/` 下的 WindBot 用于 YGOPro2 AI.Server
对局的外部策略模式。上游版本在 `GameBehavior.OnNewTurn` 里硬编码了
「第 2 回合自动投降」，导致任何多回合对局在第 2 回合被判为 cutoff。

补丁删除了该分支，仓库内附已重建的 `WindBot.exe`。详见
[`patches/README.md`](patches/README.md)。

## 许可

本项目代码以 [0BSD](LICENSE) 发布。

`skill/resources` 下的卡片数据库、卡片脚本、禁限表，以及
`skill/resources/ygopro2-bridge/windbot` 下的 WindBot 源码与二进制，
遵循各自上游项目的许可与分发条款，详见对应目录内的 LICENSE 文件。
