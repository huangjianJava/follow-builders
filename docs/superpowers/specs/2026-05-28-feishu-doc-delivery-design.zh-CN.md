# 飞书文档投递设计

日期：2026-05-28
状态：已批准，进入规划阶段

## 目标

为 `follow-builders` 技能新增飞书文档投递路径，使 Codex 能够生成 AI Builders 摘要并将其写入指定的飞书云文档文件夹。该文件夹每天应包含一篇文档。手动运行和定时运行应共用同一套投递实现。

## 决策

- 在 `deliver.js` 中实现飞书文档发布，作为新的投递方式：`feishu_doc`。
- 使用飞书自建应用的 `app_id` 和 `app_secret` 获取租户访问令牌。
- 将非密钥类飞书配置存储在 `~/.follow-builders/config.json` 中。
- 将 `app_secret` 存储在 `~/.follow-builders/.env` 中。
- 采用幂等式每日发布：若当天文档已存在，则更新而非创建重复文档。
- 将摘要 Markdown 转换为结构化飞书文档块。
- 保留纯文本兜底方案，确保在结构化块写入失败时仍能保存内容。
- 优先面向个人使用场景构建，同时保持配置和模块边界具备后续发布的可扩展性。

## 配置

在用户配置中扩展新的投递方式：

```json
{
  "delivery": {
    "method": "feishu_doc",
    "feishu": {
      "appId": "cli_xxx",
      "appSecretEnv": "FEISHU_APP_SECRET",
      "folderToken": "fldcn_xxx",
      "titleTemplate": "AI Builders Digest - {{date}}",
      "timezone": "Asia/Shanghai",
      "onExisting": "update",
      "includeMetadata": true
    }
  }
}
```

将应用密钥存储在 `~/.follow-builders/.env` 中：

```bash
FEISHU_APP_SECRET=...
```

字段说明：

- `appId`：飞书自建应用 ID。
- `appSecretEnv`：读取应用密钥所用的环境变量名，默认为 `FEISHU_APP_SECRET`。
- `folderToken`：目标飞书云文档文件夹的 token。
- `titleTemplate`：文档标题模板，`{{date}}` 展开为 `YYYY-MM-DD`。
- `timezone`：用于确定每日日期的时区，依次回退到全局配置中的 `timezone`，再回退到本地系统时区。
- `onExisting`：第一版仅支持 `update`。
- `includeMetadata`：为 true 时，在文档开头添加生成时间和来源元数据。

## 架构

保持现有摘要流水线不变：

1. `prepare-digest.js` 拉取 feed、提示词和用户配置。
2. Codex 或 agent 将准备好的 JSON 加工成最终摘要 Markdown。
3. 最终摘要文本传递给 `deliver.js`。
4. `deliver.js` 根据 `delivery.method` 进行分发。
5. 对于 `feishu_doc`，`deliver.js` 调用飞书发布模块。

`deliver.js` 不应包含飞书 API 细节。在 `scripts/lib/` 下新增专注的模块，例如：

- `scripts/lib/feishu-docs.js`：鉴权、文件夹查找、文档创建/更新及块插入。
- `scripts/lib/markdown-to-feishu-blocks.js`：摘要 Markdown 转飞书块。
- `scripts/lib/date-template.js`：标题模板展开与时区感知的日期处理。

这些模块保持首版实现精简，同时为未来的发布者抽象预留空间。

## 飞书 API 流程

`feishu_doc` 投递流程：

1. 从 stdin、`--message` 或 `--file` 读取摘要文本，与现有 `deliver.js` 行为保持一致。
2. 加载 `~/.follow-builders/config.json` 和 `~/.follow-builders/.env`。
3. 校验 `delivery.feishu.appId`、应用密钥和 `folderToken`。
4. 使用 `app_id` 和 `app_secret` 请求租户访问令牌。
5. 根据配置时区展开 `titleTemplate`。
6. 列出目标文件夹中的文件。
7. 查找标题与当日生成标题完全匹配的文档。
8. 若无匹配文档，在目标文件夹中创建新文档。
9. 若存在一篇匹配文档，则更新该文档。
10. 若存在多篇标题相同的文档，更新最近修改或创建的文档，并返回警告。
11. 将摘要 Markdown 转换为飞书文档块。
12. 用转换后的块替换文档正文。
13. 返回包含状态、操作、标题、URL 及警告（如有）的 JSON 结果。

成功输出示例：

```json
{
  "status": "ok",
  "method": "feishu_doc",
  "action": "updated",
  "title": "AI Builders Digest - 2026-05-28",
  "url": "https://..."
}
```

## 幂等性

幂等键为在配置文件夹内生成的每日标题。同一天、同一文件夹应只对应一篇飞书文档。

规则：

- 日期依次从 `delivery.feishu.timezone`、全局 `timezone`、本地系统时区中计算。
- `{{date}}` 展开为 `YYYY-MM-DD`。
- 仅在配置的文件夹内搜索。
- 按精确标题匹配文档。
- 同一天重复运行时，替换文档正文。
- 不追加重复内容。
- 存在多篇匹配文档时不应导致投递失败；更新最新的匹配文档并报告警告。

## Markdown 块映射

实现适用于摘要格式的稳定 Markdown 子集：

- `#`、`##`、`###` 转换为标题块。
- 普通段落转换为文本块。
- `- ` 和 `* ` 转换为无序列表块。
- `1. ` 转换为有序列表块。
- 独立的 URL 行转换为可点击的链接文本块。
- 行内 Markdown 链接（如 `[text](url)`）在飞书富文本支持的情况下转换为带链接的文本。
- `---` 在支持时转换为分割线块，否则转换为空段落。
- 空行用于分隔块，不应产生过多空白块。
- 表格、图片、代码块和脚注在第一版中一律作为纯文本处理。

当 `includeMetadata` 为 true 时，在文档开头添加类似如下的元数据：

```text
Generated at: 2026-05-28 08:00 Asia/Shanghai
Source: follow-builders
```

兜底行为：

- 若富文本链接转换失败，保留原始文本和 URL。
- 若某个结构化块无法表示，将该内容写为纯文本。
- 若结构化批量插入失败，将正文替换为完整摘要的纯文本版本，并在结果中标记 `fallback: "plain_text"`。

## 错误处理

配置错误应快速失败并返回清晰的 JSON：

- 缺少 `delivery.feishu.appId`。
- 缺少应用密钥环境变量。
- 缺少 `delivery.feishu.folderToken`。
- 不支持的 `onExisting` 值。

飞书 API 错误应保留有用的诊断数据：

- 鉴权失败。
- 缺少应用权限。
- 无法访问目标文件夹。
- 文档创建失败。
- 文档正文读取、删除或插入失败。

内容转换错误应优先保留摘要内容而非中断运行，尽可能使用警告和兜底文本。

## 测试

新增有针对性的自动化测试覆盖：

- 使用 `examples/sample-digest.md` 进行 Markdown 转换测试。
- 标题、段落、无序列表、有序列表、URL 行和 Markdown 链接的转换用例。
- `Asia/Shanghai` 时区下 `{{date}}` 的标题模板测试。
- 缺少 app ID、密钥和文件夹 token 时的配置校验测试。
- 使用 fetch mock 的飞书客户端测试，覆盖令牌获取、文档创建、更新已有文档、多重重复标题警告和 API 失败场景。

手动验证步骤：

1. 配置测试用飞书文件夹 token 和应用凭据。
2. 将摘要文件写入 `/tmp/fb-digest.txt`。
3. 运行 `node deliver.js --file /tmp/fb-digest.txt`。
4. 确认文件夹中已创建文档。
5. 当天再次运行同一命令。
6. 确认同一文档被更新，而非重复创建。

## 文档更新

需更新：

- `config/config-schema.json`：新增 `feishu_doc` 和 `delivery.feishu`。
- `SKILL.md`：新增配置说明和投递工作流指引。
- `README.md` 和 `README.zh-CN.md`：将飞书文档投递作为可用方式列出。

不得更改：

- Feed 抓取逻辑。
- LLM 加工提示词。
- 信源列表管理。
- 调度语义（仅允许定时运行使用 `feishu_doc`，不做其他改动）。
- OAuth 支持。
- 数据库或远程状态存储。

## 实现范围

首版实现应交付：

- 手动运行和定时运行均可调用 `deliver.js`。
- `delivery.method = "feishu_doc"` 每天向配置文件夹写入一篇文档。
- 同一天重复运行时更新已有文档。
- 摘要 Markdown 转换为可读的飞书块。
- 纯文本兜底方案可用。
- 错误信息足以诊断凭据和权限问题。

后续工作可扩展：

- 个人 OAuth 支持。
- 更完整的 Markdown 支持。
- 通用发布者抽象。
- 面向非技术用户的完善引导流程。
- 超出通用投递路径的飞书专属调度示例。
