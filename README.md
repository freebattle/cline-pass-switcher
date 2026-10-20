# Cline Pass 上游控制台（cline-pass-switcher）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2018-green)
![Docker](https://img.shields.io/badge/docker-ready-2496ED)

**零依赖**的 Node.js 本地/服务器代理 + 网页控制台，用于 [Cline Pass](https://cline.bot/cline-pass) 订阅：

- 🔍 **上游枚举与校验** —— 列出订阅模型背后每一条上游渠道，并一键实测哪些「✔可用 / ⏳限流 / ✘不可钉」，同时给出每条渠道的实测延迟（同状态内按快慢排序，汇总里直接标出最快渠道）
- 🎯 **精确钉住上游** —— 严格钉住 / 优先+回退两种模式，支持按最低成本、最快首字、最高吞吐排序
- 🧬 **多上游优先级故障转移（2026-09-06 新增）** —— 勾选多个上游即按勾选顺序逐个尝试：第一个异常（报错 / 网络失败 / 超时）自动顺切下一个，全部失败才透传错误；每次尝试有独立 120s 超时与逐次尝试明细（请求头 X-Cline-Target-Upstream: a>b 与 X-Cline-Attempts，历史与测试台展示逐次尝试路径 upstream(502) 到 upstream(200)）
- 🔁 **同渠道重试** —— 每个渠道可设 1/2/3/5 次尝试：失败先原地重试（递增退避 0.4~1.5s）用完次数才换下一个渠道，只钉一个渠道时同样生效；不可钉/key 失效这类确定性错误不消耗重试次数；尝试序列按「渠道×次数」展示
- 🚫 **上游排除** —— 勾「排除」的渠道永不被使用：勾选模式下从候选中剔除；自动模式与优先+回退模式下把排除换算成 only 白名单（已知上游 - 排除项）注入，两类管道均实测生效；网关侧渠道清单更新导致白名单过期时，报错中附带的最新渠道清单会被自动学习合并
- 👥 **账号池（纯轮询）** —— 多账号管理，启用的账号严格按请求轮询；不提供会话粘性、加权、最少使用数等额外负载均衡策略
- 🎯 **按模型的 key 路由过滤（2026-10 新增）** —— 同一模型在不同 key 下可能被路由到不同上游（如 `deepseek-v4.1-flash` 有的 key 走官方 `deepseek`，有的走第三方/私有渠道）。在模型行勾选「仅使用命中官方渠道的 key」后，只在这个模型的官方 key 之间轮询，非官方 key 自动跳过；跳过时即时复检、另有定时全量检测，key 恢复成官方渠道后自动重新加入
- 🎯 **按账号探测上游** —— 对任一模型逐账号探测实际命中的上游供应商与各自凭证池（`POST /api/probe-accounts`），结果落库到 `META.models[id].accountRouting`；用于发现「同一模型、不同账号走不同供应商」并据此给账号分组
- 📊 **观测** —— 每条请求自动记录实际命中的渠道、背后模型、耗时（含流式）
- 🔑 **代理密钥** —— 给下游客户端发一把独立密钥，可随时在页面轮换
- 🌐 **OpenAI 兼容** —— 任何 OpenAI 客户端 / Cline 扩展把 Base URL 指向代理即可，无侵入

![控制台截图](docs/screenshot-top.png)

---

## 30 秒上手（本地）

```bash
git clone https://github.com/<你的用户名>/cline-pass-switcher.git
cd cline-pass-switcher
node server.js        # 仅需 Node ≥ 18，无需 npm install
```

打开 <http://127.0.0.1:3123/>，在「账号管理」里添加你的 Cline Pass 账号（`sk_` 开头的 key）并保存即可。
没有 key 也能启动：页面会提示配置入口。

> Cline Pass key 从哪里来？购买 Cline Pass 订阅后，在 Cline 的账户设置里创建 API Key。
> 订阅模型 ID 均为 `cline-pass/*` 前缀（如 `cline-pass/glm-5.2`）。

客户端接入（任何 OpenAI 兼容工具）：

```
Base URL: http://127.0.0.1:3123/v1
API Key:  （在控制台「访问与安全」里设置代理密钥；本地留空 = 不鉴权）
Model:    cline-pass/glm-5.2 等
```

---

## Docker 部署

### 方式 A：All-in-one（自带 Caddy 自动 HTTPS，推荐新手）

```bash
mkdir -p data && cp config.example.json data/config.json
# 编辑 data/config.json，或在启动时用环境变量注入 key

# 有域名（A 记录指向服务器，自动签发 Let's Encrypt 受信证书）：
CPASS_DOMAIN=pass.example.com docker compose -f deploy/docker-compose.all-in-one.yml up -d --build

# 只有 IP（自签证书，浏览器需手动信任一次）：
docker compose -f deploy/docker-compose.all-in-one.yml up -d --build
```

访问 `https://你的域名/`（或 `https://服务器IP/`），控制台里设置代理密钥即可对外提供服务。

### 方式 B：已有一个性化反代（nginx 门户等）

根目录的 `docker-compose.yml` 只启动应用并绑定 `127.0.0.1:3123`，由你现有的 nginx/Caddy 做 TLS：

```nginx
location / {
    proxy_pass http://127.0.0.1:3123;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_buffering off;            # 流式响应必须
    proxy_read_timeout 600s;
}
```

### 环境变量

| 变量 | 说明 |
|---|---|
| `CLINE_PASS_KEY` | 上游 Cline Pass API Key（无 config 时自动创建账号） |
| `PROXY_KEY` | 下游代理密钥（客户端访问代理的凭据） |
| `ACCOUNT_ROUTE_REFRESH_MINUTES` | 按 key 路由检测周期（分钟，默认 `15`，`0` = 关闭）；只检测开启了 `officialOnly` 的模型 |
| `ACCOUNT_ROUTE_RECOVERY_SECONDS` | 轮询跳过非官方 key 时的即时复检最小间隔（秒，默认 `300`，`0` = 关闭即时复检；定时检测仍独立生效） |
| `PUBLIC_BASE_URL` | 门户展示的公网代理地址，如 `https://pass.example.com` |
| `PORT` / `BIND_HOST` / `DATA_DIR` | 端口 / 绑定地址（容器内为 0.0.0.0）/ 配置目录 |

环境变量在启动时覆盖 `config.json`；此后通过控制台保存设置，会以当前生效值写回文件。

---

## 配置参考（config.json）

| 字段 | 说明 |
|---|---|
| `accounts` | 账号池：`[{ name, key, enabled }]`；启用的账号按请求轮询（无会话粘性、无其它均衡策略） |
| `proxyKey` | 下游代理密钥；空 = 不鉴权 |
| `publicBaseUrl` | 公网代理地址（控制台展示用） |
| `exposeCatalog` | `true` 时代理的 `/v1/models` 会合并 Cline 公开目录模型；默认 `false` 只返回订阅模型（避免客户端模型列表被淹没） |
| `knownModels` | 订阅模型清单（控制台主表） |
| `perModel` | 每模型的钉住配置：`{ upstreams, exclude, pinMode: strict|preferred, sort: cost|ttft|tps, retries: 1..5 }` |
| `perModel[].retries` | 同一渠道的尝试次数，默认 `1`（不重试）；多渠道时为「当前渠道试完 retries 次再换下一个」 |
| `perModel[].officialOnly` | `true` 时该模型只使用「探测到可命中官方渠道」的 key（默认 `false`） |
| `perModel[].officialProviders` | 官方渠道 slug 列表，如 `["deepseek"]`；留空则按模型 `canonicalSlug` 的第一段自动推断 |
| `apiKey` | 旧版单 key 字段，启动时自动迁移进 `accounts` |

---

## 核心机制：Cline Pass 的两条路由管道（实测发现）

Cline Pass 订阅模型在 Cline 网关之后分成两条管道，钉住上游的写法**完全不同**：

| 管道 | 实际后端 | 识别特征 | 钉住方式 |
|---|---|---|---|
| **直连**（direct） | OpenRouter | 响应顶层带 `provider` 与真实 `model` 字段 | 顶层 `provider.only / order` |
| **规划器**（planner） | **Vercel AI Gateway** | 响应带 `provider_metadata.gateway.routing` | **`providerOptions.gateway.only / order / sort`** |

**关键发现**：规划器管道的请求由 Vercel AI Gateway 执行，请求体里的顶层 `provider.only/order` 会被 Cline 丢弃
（这也是官方 API 上"换上游不生效"的原因），但 `providerOptions.gateway` 嵌套形式会**原样透传**：

```json
{
  "model": "cline-pass/glm-5.2",
  "messages": [],
  "providerOptions": { "gateway": { "only": ["alibaba"] } }
}
```

实测响应：`finalProvider: "alibaba"`，规划器理由变为 `Provider set restricted to: alibaba`。
参考：[Vercel AI Gateway — Provider Filtering, Ordering & Sorting](https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering)

### 上游枚举的三种手段

1. **响应元数据回读**：规划器管道带 `canonicalSlug` / `fallbacksAvailable` / `finalProvider`；直连管道顶层 `provider` 即实际上游；
2. **假上游探测**（零 token）：带不存在的 `only:["__probe__"]` 让网关在路由层报错并列出精确的可用渠道清单（两条管道的清单**不一致**，要分别取）；
3. **OpenRouter 公开接口** `GET /api/v1/models/{slug}/endpoints`：补充上下文长度/在线率（对直连管道有直接参考意义）。

### 实测记录（2026-09）

| 实验 | 结果 |
|---|---|
| glm-5.2 + 顶层 `provider.only/ignore/order` | 全部被网关丢弃，恒选同一渠道 |
| glm-5.2 + `providerOptions.gateway.only:["alibaba"]` | ✔ `finalProvider: alibaba` |
| glm-5.2 流式 + `only:["baseten"]` | ✔ 流式同样生效 |
| glm-5.2 + `providerOptions.gateway.sort:"cost"` | ✔ 按成本重排执行顺序 |
| glm-5.3-flash（直连）+ 顶层 `provider.only:["gmicloud"]` | ✔ `provider: "GMICloud"` |
| glm-5.3-flash + `providerOptions.gateway` | ✘ 无效（直连管道只认顶层 provider 形式） |

> 管道归属由 Cline 侧决定、可能随时间变化，控制台的「探测」会刷新每个模型的管道类型与渠道清单。

### 钉住失效自动告警（2026-09-20 新增）

Cline 会静默变更规划器行为：某些模型的 `providerOptions.gateway.only` 会被整体忽略——连非法渠道 `__probe__` 都不再被路由层拒绝，任何 `only` 都返回同一上游（实测 `cline-pass/deepseek-v4.1-flash` 恒返回 `deepseek`）。控制台现在会自动识别并告警：

- **权威哨兵**：`POST /api/check-pin`（控制台每行「检测钉住」）发送非法渠道 `only:["__probe__"]`；被路由层拒绝 = 正常，照常执行 = 失效。零 token。直连管道会自动改用顶层 `provider.only`，不会误报。
- **探测/校验内置**：`探测` 与 `校验` 会先跑一次哨兵；失效时「校验」不会把所有渠道误标为 ✔，而是标为未判定（`pinBroken: true`）。
- **运行时兜底**：严格钉住的目标与实际 `finalProvider` 不一致时自动记录告警（匹配不清除告警，因为网关默认就可能选中该渠道）。
- **展示**：控制台顶部红色横幅汇总所有失效模型，模型行显示 `⚠ 钉住失效`；`GET /api/models` 返回 `alerts` 数组，`META.models[id].pinHealth` 持久化检测结果。

---

## 按模型的 key 路由过滤（官方渠道 key）

同一模型在不同 Cline Pass key 下可能被网关路由到不同上游。典型例子是 `cline-pass/deepseek-v4.1-flash`：
有的 key 命中官方 `deepseek`，有的 key 命中私有/第三方渠道（`openai-compatible-private` 等）。
此时如果纯轮询，一部分请求会落到非官方渠道。开启该模型的 `officialOnly` 后：

1. **检测**：对每个启用的 key 发一条 `max_tokens=32` 的最小流式请求，从响应元数据读取
   `finalProvider` 与规划器返回的 `plannedProviders`（该 key 凭证池里可用的渠道集合）。
2. **判定**：以 key 的**实际命中渠道**（`finalProvider`）为准，命中官方渠道才算「官方 key」；
   只有探测不到实际 provider 时才退回看凭证池（`plannedProviders`）。仅凭「凭证池里有官方渠道」不算数——
   例如 `deepseek-v4.1-flash-1017` 的所有 key 池里都含 `deepseek` 作为后备，但 `账号6` 实际首选 `pareto`，必须判为非官方。官方渠道来自
   `perModel[].officialProviders`；留空时按模型 `canonicalSlug` 的第一段推断（如 `deepseek/deepseek-v4.1-flash` → `deepseek`）。
3. **轮询**：仍然只是纯轮询，但该模型只在官方 key 之间轮；非官方 key 直接被跳过。
4. **恢复检测**：
   - 轮询到被跳过的非官方 key 时，顺带发起一次即时复检（默认每个 key 最多 5 分钟一次，`ACCOUNT_ROUTE_RECOVERY_SECONDS`）；
   - 后台每 15 分钟对所有官方过滤模型做一次全量检测（`ACCOUNT_ROUTE_REFRESH_MINUTES`，设 `0` 关闭）；
   - 一旦某个 key 恢复成官方渠道，下一次轮询就会自动重新使用它，无需手工操作。
5. **严格拦截**：如果一个官方 key 都没有，代理会直接返回 `503`（`type: key_filter_error`），**不会**回退到非官方 key；
   同时顺手触发一轮复检，key 恢复成官方渠道后下一个请求自动继续。内部诊断（探测/校验）不受此限制。

检测结果按 key 的 SHA-256 指纹存放在 `metadata.json` 的 `META.models[model].keyRouting`，不落明文 key。
控制台模型行会显示每个 key 的实际路由（`账号: deepseek ✔` / `账号: openai-compatible-private ✘`），
可随时点「检测 key 路由」立即刷新。代理响应头也会带上本次使用的 key 路由：

- `X-Cline-Key-Filter`：`off` / `official`（正常请求）；`unknown` / `fallback` 仅可能出现在内部诊断请求
- `X-Cline-Key-Route`：本次 key 最近一次检测到的上游供应商

## 控制台功能一览

| 卡片 | 功能 |
|---|---|
| 账号管理 | 账号池增删改、显隐密钥、逐账号连通性测试（启用账号按请求轮询）、用量统计、额度（5h/周/月）展示与 10 分钟自动刷新 |
| 访问与安全 | 修改下游代理密钥（即时生效）、公网代理地址、鉴权开关 |
| 订阅模型 | 背后模型 / 渠道数 / 最近实际渠道；渠道列表（带可用性标注与实测延迟，同状态内快的在前）；严格钉住 / 优先+回退；排序；每渠道尝试次数；「仅使用命中官方渠道的 key」与逐 key 路由检测 |
| 操作按钮 | 探测（刷新渠道清单）、测试（单次钉住验证）、校验（全渠道实测地图 + 延迟） |
| 测试台 | 任选模型+渠道发一条小请求，直接看网关是否采纳 |
| 按账号探测上游 | 对同一模型逐账号发最小流式请求，列出各账号实际命中的供应商、背后模型、凭证池与回退数，并按供应商自动分组（可勾选「包含未启用账号」）；结果同时作为模型行 key 过滤的依据 |
| 请求历史 | 自动记录每条请求的账号、实际渠道、耗时、尝试序列（最近 100 条，含流式） |
| 完整目录 | Cline 公开目录模型，`:free` 变体可精确钉住 |

代理同时做了兼容性标准化：解包 Cline 的 `{"data":...}` 包装为标准 OpenAI 格式、错误统一为
`{"error":{"message":...}}`、附加 `X-Cline-Target-Upstream / X-Cline-Actual-Upstream / X-Cline-Account / X-Cline-Key-Filter / X-Cline-Key-Route` 等响应头。

---

## 常见问题

**Q：怎么让 `deepseek-v4.1-flash` 只走官方 DeepSeek 的 key？**
在控制台该模型行勾选「仅使用命中官方渠道的 key」（或配置 `perModel[].officialOnly: true`、
`perModel[].officialProviders: ["deepseek"]`），然后点一次「检测 key 路由」。之后该模型只在官方 key 之间轮询；
非官方 key 会被跳过，并自动定时复检是否恢复。账号池对其它模型仍然全量轮询。

**Q：过滤后所有 key 都非官方怎么办？**
代理会返回 `503 key_filter_error`，并明确提示当前没有可用的官方 key（不会偷偷回退到非官方 key）；
这类失败会以 `X-Cline-Key-Filter: no-official` 记录到请求历史。后台仍会定时/即时复检，
一旦某个 key 恢复为官方渠道，下一个请求会自动恢复。

**Q：为什么选了某个渠道会报 `invalid_request_error`？**
部分渠道被单独钉住时会因模型 ID 映射失败，还有渠道处于共享池限流（429）状态。点该模型行的「校验」，
把所有渠道实测一遍，下拉框会标注 ✔可用 / ⏳限流 / ✘不可钉。钉住失败的渠道会被自动学习标记。

**Q：限流的渠道还能用吗？**
能。限流是共享池的临时状态，过段时间重新「校验」即可；或改用「优先+回退」模式，限流时自动跳到其他渠道。

**Q：钉住单个渠道，它限流了就直接报错，能重试吗？**
能。模型行里把「每渠道尝试」设成 2/3/5 次，失败会先原地重试（递增退避 0.4s / 0.8s / 1.2s，上限 1.5s），用完次数才报错；
选了多个渠道时是「渠道 1 试完 3 次 → 渠道 2 试完 3 次 → …」，页面尝试序列按 `fireworks×3(✗429) → alibaba(✔)` 展示。
不可钉、key 失效这类重试也没用的确定性错误不消耗重试次数，直接跳下一个渠道。注意重试会成倍放大额度消耗与等待时长。

**Q：渠道列表里的 ms 是什么延迟？**
「校验」时给该渠道发一条 16 token 最小请求的端到端耗时（含排队、首字与生成），单次采样、并发 5 条一批，只适合横向对比谁快谁慢，不是严格 benchmark。想要更准就多点几次「校验」。渠道列表同状态内已按快慢排序，「全选」也会按这个顺序生成尝试序列，所以最快的渠道天然排在第一个。

**Q：直接用官方 API 写 `provider.only` 为什么不生效？**
对规划器管道（走 Vercel AI Gateway 的模型）会被 Cline 网关丢弃，请改用 `providerOptions.gateway`，见上文。

**Q：两条管道的渠道清单为什么不一样？**
钉住发生在不同后端（OpenRouter vs Vercel AI Gateway），各自支持的渠道池不同，要以对应清单为准。

**Q：订阅额度怎么计？**
经代理的请求与直连官方 API 计费一致；「探测/测试/校验」会产生极小额的真实请求（每次约 0.0002 美元级）。

**Q：控制台能看到账号剩余额度吗？**
可以。「账号管理」表格中的「额度（5h / 周 / 月）」列仿 AxonHub 用量条展示：每个账号三个窗口横排，绿条长度代表已用比例（`percentUsed`），下方小三角标记代表重置时间（`resetsAt`）在窗口内的进度位置；悬停自绘 tooltip 查看金额与重置时间（窗口上限按官方套餐写死：5h=US$10、周=US$25、月=US$50，已用/剩余金额由比例换算）。数据来自 Cline 官方接口 `GET /users/me/plan/usage-limits`，服务端默认每 10 分钟自动刷新一次（可用环境变量 `QUOTA_REFRESH_MINUTES` 调整，设为 0 关闭），也可点击「刷新额度」立即拉取。额度缓存以 key 的 SHA-256 指纹为键存入 `metadata.json`，不落明文 key。

---

## 安全提醒

- `config.json` / `data/` 含明文密钥，已在 `.gitignore` 排除，**不要提交或分享**；
- 对外部署务必设置 `proxyKey`（控制台可随时轮换）；
- 「每渠道尝试」> 1 时会成倍放大请求量，注意额度消耗。

## License

[MIT](LICENSE)
