# 夢囈手帳 · 服务端

零依赖即可启动的 API 服务，负责账号、云端手账、生命体征演算、图片存储与每日备份。

## 直接运行

```bash
node server/server.js
```

打开 http://localhost:5178 ，会直接托管同目录上一级的《梦呓手账本.html》。

前端「雲端」弹窗里填 API 位址 `http://localhost:5178`，注册或登录后即开始自动同步。

## 环境变量

复制 `.env.example` 为 `.env` 并按需填写。全部可选：

| 变量 | 说明 |
| --- | --- |
| `PORT` | 端口，默认 5178 |
| `JWT_SECRET` | 登录 token 的签名密钥，生产环境务必改掉 |
| `MONGODB_URI` | 填写后启用 MongoDB（需先 `npm i mongoose`）；未填或连不上时自动回落 `data/*.json` |
| `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` | OpenAI 兼容接口（默认通义千问 compatible-mode），用于生命体征推演 |
| `QWEATHER_KEY` / `DEFAULT_CITY` | 和风天气，按城市取实时天气参与演算 |
| `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` / `OSS_BUCKET` / `OSS_REGION` | 阿里云 OSS；未配置则图片存本地 `uploads/` |
| `KEEP_BACKUPS` | 备份保留天数，默认 7 |

> 不装任何 npm 包也能跑：MongoDB 与 OSS 都是动态加载，缺失时自动降级，不影响主流程。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | `{email,password}` → `{token}` |
| POST | `/api/auth/login` | `{email,password}` → `{token}` |
| GET | `/api/state` | 读取当前账号的全部本子（需 Bearer token） |
| PUT | `/api/state` | `{state}` 整包保存，前端每次编辑后自动调用 |
| POST | `/api/upload` | 原始二进制图片，返回 `{url}`（OSS 或本地） |
| POST | `/api/vitals` | `{persona,localTime,weather}` → `{heart_rate,breath_rate,blood_pressure,temperature,mood}` |
| POST | `/api/backup` | 立即生成一次快照 |
| GET | `/api/health` | 健康检查，返回当前存储类型 |

## 备份

进程启动时若当天还没有快照会立刻备份一次，此后每日 03:01 自动把全部账号的手账写入 `backups/backup-YYYY-MM-DD.json`，仅保留最近 `KEEP_BACKUPS` 天。

## 目录

```
server/
├── server.js
├── .env.example
├── package.json        # 可选依赖（mongoose / ali-oss）
├── data/               # 文件模式下的账号与手账
├── uploads/            # 本地图片
└── backups/            # 每日快照
```
