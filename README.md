# image-understand

让没有原生视觉能力的 Codex 文本模型（如 DeepSeek）也能“看图”的 Codex Skill。

通过调用任意兼容 [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses) 的多模态识图模型，把图片内容转换为文字描述，支持一次请求传入多张图片批量识图。

## 功能

- 单张 / 多张图片批量识图，一次请求完成
- 本地图片路径与网络图片链接（`--url`）可混用
- 图片内容问答、提取图中文字、图片对比汇总
- `--json` 输出结构化结果（含 token 用量）
- 自动重试（最多 2 次）：应对限流、服务抖动与空响应
- 零依赖，仅需 Node.js 20+

> 注意：本技能仅适用于不具备原生视觉能力的文本模型（如 DeepSeek）。如果当前模型本身能直接查看图片，请直接看图，不要调用本技能。

## 安装

1. 下载或克隆本仓库：

   ```bash
   git clone https://github.com/zitongchen/image-understand.git
   ```

2. 将仓库内容放到 Codex 的 skills 目录：

   - Windows：`C:\Users\<你的用户名>\.codex\skills\image-understand`
   - macOS / Linux：`~/.codex/skills/image-understand`

3. 配置识图模型：

   ```bash
   cp scripts/.env.example scripts/.env
   ```

   编辑 `scripts/.env`，填入你的模型服务商信息：

   ```ini
   VISION_API_KEY=sk-xxx
   VISION_MODEL=qwen3.7-flash
   VISION_BASE_URL=https://api.openai.com/v1
   ```

4. 在 Codex 中让模型使用 `$image-understand` 即可自动调用识图。

## 使用

```bash
# 单张图片
node scripts/vision.js "<图片路径>"

# 带问题（必须用 --prompt）
node scripts/vision.js "<图片路径>" --prompt "请描述图片中的文字"

# 多张图片批量识图
node scripts/vision.js "<图片1>" "<图片2>" --prompt "对比这两张图片"

# 网络图片链接
node scripts/vision.js --url "https://example.com/a.jpg" --url "https://example.com/b.jpg"

# 输出 JSON（含 usage）
node scripts/vision.js "<图片路径>" --json
```

## 配置

| 环境变量 | 必填 | 说明 |
| --- | --- | --- |
| `VISION_API_KEY` | 是 | 识图模型 API Key |
| `VISION_MODEL` | 是 | 模型名，推荐 `qwen3.7-flash` 等支持多模态输入的模型 |
| `VISION_BASE_URL` | 是 | OpenAI 兼容接口地址，如 `https://api.openai.com/v1` |
| `VISION_REASONING_EFFORT` | 否 | 思考强度：`none` / `minimal` / `low` / `medium` / `high`，默认 `none` |

配置优先级：环境变量 > `scripts/.env`。

## 工作原理

`scripts/vision.js` 使用 Node.js 内置 `fetch` 调用 OpenAI 兼容接口的 `/responses` 端点，将本地图片以 `data:` URL 形式放入 `input_image`，连同问题一起发送给多模态模型，再把返回的文字整理成结果。脚本无第三方依赖。

## 隐私提示

图片会被发送到你配置的识图模型服务，涉及隐私或机密的图片请谨慎使用。

## License

[MIT](LICENSE)
