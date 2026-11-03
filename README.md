<div align="center">

# short

**轻量第一方短链服务 · [s.wenfu.dev](https://s.wenfu.dev/)**

零依赖 Node · 同机文件存储 · 给 [mm](https://mm.wenfu.dev/) 等站点用

[![license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)

</div>

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api` | body `{ "payload": "<base64url>" }` → `{ id, url }` |
| `GET` | `/api/:id` | → `{ id, payload }` |
| `GET` | `/:id` | `302` → `https://mm.wenfu.dev/?s=:id` |
| `GET` | `/health` | `{ ok: true }` |

`payload` 为 mm 的 `#v1=` 压缩载荷（不含前缀）。CORS 默认允许 `https://mm.wenfu.dev`。

## 本地运行

```sh
S_DATA_DIR=./data S_CORS_ORIGINS=http://127.0.0.1:4173,http://localhost:4173 \
  node server.mjs
```

默认本地监听 `127.0.0.1:8787`；生产（与 tomrun 错开）为 `8788`。

## 部署

同机与 `mm.wenfu.dev` 共用 VPS：

1. DNS：`s.wenfu.dev` A/AAAA 指向服务器
2. 复制 `scripts/env.production.example` → `.env.production`，填 `DEPLOY_HOST` 等
3. `pnpm deploy`（同步到 `/opt/short`、装 `short.service`、nginx、证书）

环境变量见 `deploy/systemd/short.service`：`S_DOMAIN`、`MM_ORIGIN`、`S_DATA_DIR=/var/lib/short`、`S_TRUST_PROXY=1`（生产经 nginx 反代时开启，按 `X-Real-IP` 限流）。

## 许可

[MIT](LICENSE)
