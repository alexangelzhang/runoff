# 本地 OTLP Collector 部署（不强制 Docker）

runoff 的 `runtime.otelExport` 通过 **OTLP/HTTP** 把 trace 发到 Collector。  
个人试用或 pre-release 自检时，可以用下面任意一种方式，**公司禁 Docker 也能跑**。

## 快速验证（推荐）

```bash
# 自动：PATH 上的 otelcol → 可选下载 → 最后才尝试 Docker
RUNOFF_OTEL_DOWNLOAD=1 npm run otel-collector:start
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 RUNOFF_OTEL_COLLECTOR_REQUIRED=1 npm run verify:otel-collector
npm run otel-collector:stop

# 一条命令（起 collector → 验证 → 停）
npm run verify:otel-collector:local
```

## 部署方式对照

| 方式 | 适用场景 | 命令 / 说明 |
|------|----------|-------------|
| **已有公司 Collector** | 不允许本机装组件 | `export OTEL_EXPORTER_OTLP_ENDPOINT=https://…` + `RUNOFF_OTEL_SKIP_START=1` + `verify:otel-collector` |
| **Homebrew（macOS）** | 无 Docker | `brew install opentelemetry-collector` → `npm run otel-collector:start` |
| **官方二进制** | Linux/mac，无 Docker | `RUNOFF_OTEL_DOWNLOAD=1 npm run otel-collector:start`（落到 `~/.runoff/bin/`） |
| **PATH 已有 otelcol** | 运维已装 | 直接 `otel-collector.sh start` |
| **Docker Compose** | 允许 Docker 时 | `docker compose -f docker-compose.observability.yml up -d`（`auto` 模式下的兜底） |

配置文件：`config/otel-collector-config.yaml`（OTLP HTTP `4318` + debug exporter）。

## 环境变量

| 变量 | 含义 |
|------|------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector 地址，默认 `http://127.0.0.1:4318` |
| `RUNOFF_OTEL_SKIP_START` | `1` = 不启动本地进程，只连已有 endpoint |
| `RUNOFF_OTEL_DOWNLOAD` | `1` = 无二进制时从 GitHub releases 下载 contrib |
| `RUNOFF_OTEL_START_MODE` | `auto`（默认）\| `native` \| `docker` |
| `RUNOFF_OTEL_COLLECTOR_REQUIRED` | `1` = 验证失败则 exit 1（pre-release 使用） |
| `RUNOFF_OTEL_COLLECTOR_VERSION` | 下载版本，默认 `0.120.0`（与 compose 镜像一致） |
| `RUNOFF_OTEL_DOWNLOAD_URL` | 覆盖下载 URL（内网 mirror） |
| `RUNOFF_OTEL_BIN` | 显式指定 collector 二进制路径 |
| `RUNOFF_OTEL_RECLAIM_PORT` | `1` = 释放占用 4318 的僵尸进程 |
| `RUNOFF_OTEL_ENDPOINT` | **仓库 Variable**（pre-release）：公司 collector URL |

## CI / pre-release 行为

- **`ci:gates`**：`verify:otel-collector` 无 collector 时 **SKIP**（不挡合并）。
- **pre-release**：单步 `bash scripts/shell/pre-release-otel-gate.sh`（或 `npm run pre-release:otel-gate`）
  - 二进制缓存在 `$RUNNER_TOOL_CACHE/runoff-otel`（self-hosted 上跨 run 复用，不必每次下载）
  - 启动前 `stop` + 可选端口回收（`RUNOFF_OTEL_RECLAIM_PORT=1`）
  - 失败时打印 `status` + collector 日志尾部
  - **离线 runner**：在仓库 Variables 设置 `RUNOFF_OTEL_ENDPOINT=https://internal-collector:4318`，跳过本地下载
  - 无 `continue-on-error` — 失败即挡发版

## 脚本入口

```bash
bash scripts/shell/otel-collector.sh start|stop|status
npm run otel-collector:start
npm run otel-collector:stop
npm run otel-collector:status
```

详见 [`observability.md`](features/observability.md) 主模块说明。
