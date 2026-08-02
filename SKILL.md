---
name: image-understand
description: 使用兼容 OpenAI Responses API 的识图模型进行云端识图，把图片内容转换为文字描述，使接入无视觉能力文本模型（如 DeepSeek）的 Codex 也能看图。支持一次请求传入多张图片批量识图。当用户要求识图、看图、描述/分析/识别图片、图片内容问答、提取图片中的文字，或消息中出现 "Saved attachments:" 图片路径时使用本技能。
---

# 图像理解（image-understand）

底层文本模型没有原生识图能力，遇到图片不要尝试直接"看"，一律运行 `scripts/vision.js`，把返回的文字结果整理给用户。

## 环境要求

- Node.js 22+（本机已具备）
- 识图模型 API Key：复制 `scripts/.env.example` 为 `scripts/.env` 并填入 `VISION_API_KEY=sk-...`，也可以设置同名环境变量
- 模型名（必填）：`VISION_MODEL=qwen3.7-flash`，推荐使用百炼大模型 qwen3.7-flash；不填则脚本会拒绝调用
- 可联网访问所配置的 OpenAI 兼容接口（任意支持多模态输入的识图模型服务均可，不限于特定厂商）

## 使用流程

1. 定位图片路径：使用用户提供的路径，或消息中 "Saved attachments:" 列出的图片路径；必要时在工作目录查找最近生成的图片文件。
2. 调用识图脚本（脚本位于本 skill 目录的 `scripts/vision.js`，用绝对路径运行，路径含空格时加引号）：
   - 单张图片：`node "<skill目录>/scripts/vision.js" "<图片路径>"`
   - 带问题（必须用 `--prompt`，位置参数一律视为图片路径）：`node "<skill目录>/scripts/vision.js" "<图片路径>" --prompt "请简要描述图片的内容。"`
   - 多张图片批量：`node "<skill目录>/scripts/vision.js" "<图片1>" "<图片2>" ... --prompt "请简要描述图片的内容。"`（不传 `--prompt` 时使用默认提示词）
   - 网络图片：`node "<skill目录>/scripts/vision.js" --url "<图片链接1>" --url "<图片链接2>" ...`（本地路径与 `--url` 可混用）
   - 需要 token 统计：追加 `--json`
3. 多张图片只需一次调用，无需逐张运行脚本；所有图片会作为同一次请求发送给模型，未指定 `--prompt` 时自动使用默认提示词，把返回结果整理给用户。
4. 结合识图结果回答用户的问题；用户要求提取文字时，直接转述/整理识别出的文字。

## 配置

配置文件为 skill 目录下 `scripts/.env`（可选，环境变量优先级更高）：

```
VISION_API_KEY=sk-xxx             # 必填，识图模型 API Key
VISION_MODEL=qwen3.7-flash        # 必填，推荐使用百炼大模型 qwen3.7-flash
VISION_BASE_URL=https://api.openai.com/v1  # 必填，OpenAI 兼容接口地址（请换成你的服务商地址）
VISION_REASONING_EFFORT=none      # 可选：none/minimal/low/medium/high
```

## 失败处理

- 未配置 Key、模型或接口地址：提示用户填写 `scripts/.env` 中的 `VISION_API_KEY` / `VISION_MODEL` / `VISION_BASE_URL`。
- 文件不存在或格式不支持：转述脚本报错，并列出支持格式（jpg/jpeg/png/gif/webp/bmp）。
- API 401：Key 无效或未开通服务，提示检查 Key 与模型服务开通状态。
- API 429、5xx 或超时：稍后重试一次；仍失败则如实告知用户。

## 注意事项

- 图片会发送到所配置的识图模型服务，涉及隐私或机密的图片先提醒用户再调用。
- 每次调用独立、不携带历史上下文；如需上下文，把前一轮回答一并写进问题。
- 多张图片同时发送时，模型会把这些图片当作同一问题下的整体内容（适合对比、汇总）；若需要对每张图独立描述，可在 `--prompt` 中说明，或改为单张调用。
