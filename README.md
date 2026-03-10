# Invoice Manager

一个基于 `Vue3 + Express` 的差旅发票管理器：

- 上传发票文件（JPG/PNG/WEBP/PDF）
- 调用阿里云 OCR 自动识别发票信息并结构化存储
- 列表查看历史发票，支持按日期、类型、状态、关键字筛选
- 按时间段导出报销报表（`xlsx`，默认本月）

## 目录结构

- `web/` 前端（Vue3 + Vite）
- `server/` 后端（Express + Aliyun OCR + XLSX 导出）
- `data/` 发票数据与上传文件存储

## Node 版本

建议 `Node.js >= 20`（当前项目已按 Node 22 验证）。

如果使用 nvm：

```bash
nvm install 22
nvm use 22
```

## 配置

后端环境变量在 `server/.env`：

```env
PORT=3001
LOG_LEVEL=info
OCR_CONNECT_TIMEOUT_MS=10000
OCR_READ_TIMEOUT_MS=20000
OCR_MAX_ATTEMPTS=1
OCR_ACTION_RETRIES=1
OCR_ENABLE_INVOICE_FALLBACK=true
OCR_ENABLE_ALL_TEXT_FALLBACK=false
ALIYUN_REGION_ID=cn-hangzhou
ALIYUN_OCR_ENDPOINT=ocr-api.cn-hangzhou.aliyuncs.com
ALIYUN_ACCESS_KEY_ID=xxx
ALIYUN_ACCESS_KEY_SECRET=xxx
```

示例文件：`server/.env.example`

## 启动

1. 安装依赖

```bash
cd server && npm install
cd ../web && npm install
```

或在仓库根目录一键安装：

```bash
npm run install:all
```

2. 启动后端（终端 1）

```bash
cd server
npm run dev
```

3. 启动前端（终端 2）

```bash
cd web
npm run dev
```

4. 访问页面

- 前端：`http://localhost:5173`
- 后端：`http://localhost:3001`

也可以在仓库根目录直接执行：

```bash
npm run dev:server
npm run dev:web
```

## 主要接口

- `POST /api/invoices/upload` 上传并识别发票（form-data 字段名：`files`）
- `GET /api/invoices` 获取发票列表
- `GET /api/invoices/types` 获取可选发票类型
- `GET /api/invoices/export` 导出 xlsx 报表

## 目录批量导入（高费用风险）

`npm run import:dir` 会对目录内文件逐个调用 OCR。为避免误触发高额账单，默认已加保护，需同时满足：

1. 设置环境变量 `ALLOW_BULK_OCR_IMPORT=true`
2. 显式传入目录参数，例如：

```bash
cd server
ALLOW_BULK_OCR_IMPORT=true npm run import:dir -- /absolute/path/to/invoices
```

## 日志定位

- 实时日志：直接看后端启动终端输出（含颜色、traceId、OCR动作与耗时）
- 持久化日志：`data/logs/server-YYYY-MM-DD.log`（JSON 行日志）
- 若上传失败，返回体里会包含 `traceId`，可用该值在日志中检索同一次请求的全链路信息
