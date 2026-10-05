# dsh-proxy-zero

让 DeepSeek Harness 走 HTTP(S) 代理，且**卸载后不留任何痕迹**的插件。

- 加载时用 DSH 自己的 `@deepseek-ai/dsh-http-proxy` 装上进程级代理策略；
- 卸载时由 Cordis 自动调用 disposer，把 dispatcher、代理环境变量、路由判定**逐字节还原**；
- 插件自身**不写任何文件、注册表、系统设置或进程外状态**。

---

## 一、调研：已有的 DSH 代理插件

本插件是在调研 GitHub 上现有实现之后设计的。已有方案（按相关度）：

| 仓库 | 做法 | 与本插件的关系 |
| --- | --- | --- |
| [copylee711/dsh-proxy](https://github.com/copylee711/dsh-proxy)（npm `@copylee/dsh-proxy`） | 全局代理 + 按 provider 分流；全局层通过 `installProxyFromEnvironment` 安装；设置页为 React 客户端 | **主要参考**。它的"全局层"思路与本插件一致（复用 DSH 自己的包，从而 loopback 绕过 / `NO_PROXY` / `web_fetch` 路由 / 子进程环境全部与上游一致） |
| [WoodSettler/dsh-local-proxy](https://github.com/WoodSettler/dsh-local-proxy)（npm `dsh-local-proxy`） | 从环境变量或 Windows 系统代理**自动发现**代理并装上 dispatcher，全程"失败即不做" | **主要参考**。本插件沿用了它的发现顺序设计与 fail-safe 哲学，但**去掉了它的日志文件**（`~/.dsh/dsh-local-proxy.log`）——那正是"残留" |
| [BuLongY/dsh-proxy](https://github.com/BuLongY/dsh-proxy) | 包裹 host `fetch` + 设置页；配置存 `settings.yaml` | 参考其设置持久化位置 |
| [elizax/dsh-http-proxy](https://github.com/elizax/dsh-http-proxy) | 只代理模型 API 域名，支持 SOCKS；README 明确承诺"卸载后完全恢复原状" | 参考其"按域名路由"与可还原性主张 |
| [wjt0321/dsh-git-proxy](https://github.com/wjt0321/dsh-git-proxy) | 只管 `github.com` 的 git/SSH 代理，写 `git config` 与 `~/.ssh/config` | 反向参考：它**必须显式做逆操作**才能还原（`git config --unset` + 移除自己写的 `ProxyCommand` 行），说明"改动外部状态"会显著抬高还原成本 |

### 调研结论：空白在哪

已有方案都能让 DSH 用上代理，但**没有一个把"卸载可完全还原"做成可复现的保证**：

- `dsh-local-proxy` 在 `~/.dsh/` 留一个日志文件，卸载不删；
- `dsh-git-proxy` 写 `git config --global` 与 `~/.ssh/config`，还原依赖它自己的逆操作逻辑，且 README 自陈有边界情况（用户自写的、恰好匹配插件格式的 `ProxyCommand` 行会被误当作插件行），并会**把 CRLF 的 ssh config 统一成 LF**——这是不可逆的改动；
- 设置页类插件多把配置写进 profile 的 `cordis.patch.yml`，卸载后该行仍在（属 DSH 的"用户行"，DSH 的卸载不会回收）。

**本插件的取舍：宁可少一个设置页，也不产生任何需要归还的状态。** 配置来源改为"插件自己的包内 patch 行"——它由 `dsh plugin remove` 连带删除，因此天然可还原。

---

## 二、整体方案：三层零残留

### 第 1 层：进程内改动，由 Cordis 负责还原（核心机制）

```js
const dispose = await installProxy(url, noProxy);
ctx.effect(() => dispose, "dsh-proxy-zero: global proxy dispatcher");
```

`ctx.effect(callback, label?)` 的契约是：插件卸载/重载时，Cordis 调用 `callback`，然后调用它**返回的** disposer。所以还原不需要插件做任何额外的事——只要把 disposer 交给 effect 即可。

`@deepseek-ai/dsh-http-proxy` 的 `installGlobalProxy()` **本身就返回这样的 disposer**，它会：

```
setGlobalDispatcher(previousDispatcher)   // 还原 dispatcher
active = previousPolicy                  // 还原策略记录
installed = previousInstalled
restoreEnv()                             // 还原 http_proxy/HTTP_PROXY/... 全部环境变量
await agent.close()                      // 关闭自己创建的 agent
```

并且该包的安装是**可叠加（LIFO）**的：本插件叠加在启动器那一层之上，dispose 后回到的是**启动器的策略**，而不是"没有策略"。这正是"不影响未装插件时的行为"的技术依据。

### 第 2 层：无持久化，故无残留

插件**不写任何文件**：

| 常见做法 | 本插件的选择 |
| --- | --- |
| 写日志到 `~/.dsh/xxx.log` | ❌ 不写。只走 `ctx.logger`，随进程消失 |
| 设置写进 profile 的 `cordis.patch.yml` | ❌ 不写。配置默认值放在**包内** `cordis.patch.yml` |
| 缓存文件 / 状态文件 | ❌ 不写 |

包内的 `cordis.patch.yml` 是被 DSH **在加载时读取**的（`bundlePatchPaths(...)` + `loadOverlayPatches`），不是被复制进 profile。实测证据见第四节：安装后 `cordis.patch.yml` 的 SHA256 **完全没变**。

### 第 3 层：唯一的外部改动交给 DSH 自己的管理器撤销

安装时 DSH 只改三处，全部由 `dsh plugin remove` 逆向：

| 改动 | 安装 | 卸载 |
| --- | --- | --- |
| `profiles/<p>/package.json` → `dependencies` | `+ "dsh-proxy-zero": "link:…"` | `-` 该条 |
| `profiles/<p>/package.json` → `dsh.profile.bundles` | `+ "dsh-proxy-zero"` | `-` 该条 |
| `profiles/<p>/pnpm-lock.yaml` | 加 importers 条目 | 移除 |

外加一个 pnpm 的副产物：`node_modules/dsh-proxy-zero`（**junction**，`link:` 安装特有）。**DSH 的 `remove` 不回收它**，所以由 `tools/uninstall.ps1` 补删——只删联接，不碰它指向的源码目录。

---

## 三、对 DSH 的具体改动点

运行时（进程内，可还原）：

1. `undici` 全局 dispatcher → 换成按策略路由的 `Agent`（由 `dsh-http-proxy` 创建）。
2. `process.env` 的 `http_proxy` / `HTTP_PROXY` / `https_proxy` / `HTTPS_PROXY` / `no_proxy` / `NO_PROXY` → 发布为本插件解析出的策略值（含强制 loopback 绕过，并**保留机器原有的 `NO_PROXY` 条目**，见第六节）。
3. `dsh-http-proxy` 模块级的 `active` / `installed` 记录 → 压入本插件这一层。

对磁盘（profile，由 DSH 管理器撤销）：见第二节第 3 层的三处。

**不改**：Harness 安装目录、`app.asar`、`$DSH_HOME/.env`、Windows 注册表、系统代理设置、`~/.ssh/config`、`git config`、任何子进程的持久环境。

> 一个副作用需要知情：第 2 点会把代理变量发布给**之后**由 agent 派生的子进程（`curl` / `git` / `pnpm` 会因此也走代理）。这是 `dsh-http-proxy` 的既有设计，不是本插件新增的行为；卸载后随之消失。

---

## 四、安装 / 卸载步骤

### 安装

从 GitHub 安装（推荐，来源可追溯；`dsh` 会把它自动登记进 `dsh.profile.bundles`）：

```powershell
dsh plugin --profile desktop add github:cacads/dsh-proxy-zero
```

从本地源码安装（改代码即时生效，`link:` 形态）：

```powershell
dsh plugin --profile desktop add "C:\Users\admin\OneDrive - cacads\Code\DSHCustom\plugin\dsh-proxy-zero"
```

`--profile` 换成目标 profile（本机唯一活 profile 是 `desktop`）。

> ⚠️ `github:` spec 锁 commit：改了源码必须 `git push` 后重新 `add`，`dsh plugin update` 不会拉新提交（与本工作区其余 `github:` 插件同一口径）。

**重启 DSH 桌面应用**后生效。原因是代理策略在启动期安装，插件在 profile 装载阶段挂载；重启后进程内才会出现本插件那一层。

重启后确认加载：

- 设置 → 插件：出现 `dsh-proxy-zero`；
- 宿主日志出现 `[dsh-proxy-zero] proxy installed from …`。

### 卸载

```powershell
pwsh -File "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-proxy-zero\tools\uninstall.ps1"
```

（从本地源码安装时，脚本在工作区那份源码的 `tools\` 里。目标 profile 可用 `-Profile` / `-ProfileDir` 覆盖。）

它等价于：

```powershell
dsh plugin --profile desktop remove dsh-proxy-zero
# 再删掉安装留下的 node_modules 联接/目录
[System.IO.Directory]::Delete("$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-proxy-zero", $false)
```

先 `-DryRun` 可以只看它要做什么。

卸载后**同样需要重启 DSH 应用**：进程内的那一层要等 profile 重新装载才会真正 dispose（Cordis 在插件被移除并 reload 时调用 disposer）。**如果只想立刻还原进程内状态而不重启**，把 `cordis.patch.yml` 里那一行临时 `disabled: true` 亦可，但那样 profile 里会留下一行——与零残留目标相悖，故不推荐。

---

## 五、如何验证卸载后完全恢复原状

三套验证，都随插件提供。

### 验证 A：纯逻辑单测（`tools/unit.test.mjs`）

不需要 Harness 运行时、不联网、不起子进程，任何 Node 20+ 直接跑：

```powershell
node --test tools/unit.test.mjs     # 或 npm test
```

它覆盖"解析规则"这一层——也就是最容易悄悄错掉的地方：URL 归一化、`ProxyServer` 两种写法、`ProxyOverride` 的前缀通配与 `<local>`、`NO_PROXY` 的多分隔符合并与大小写去重、环境变量发现顺序、以及 `launchEnvironment` 快照取值。

### 验证 B：进程内改动确实被还原（`tools/verify.mjs`）

拿一个**桩代理服务器**当真实目标，证明"代理真的被用上了"，然后执行 Cordis 会执行的 disposer，逐项比对。**必须带上第二个参数**（DSH 目录），否则 `@deepseek-ai/dsh-http-proxy` 解析不到：

```powershell
$env:ELECTRON_RUN_AS_NODE="1"
& "C:\Users\admin\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" `
  "<插件目录>\tools\verify.mjs" `
  "C:\Users\admin\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh"
Remove-Item Env:\ELECTRON_RUN_AS_NODE
```

实测输出（23/23 通过）：

```
[1] loading the plugin installs the policy
  PASS  recorded exactly one Cordis effect  dsh-proxy-zero: global proxy dispatcher
  PASS  global dispatcher replaced
  PASS  HTTPS_PROXY published  http://127.0.0.1:58098
  PASS  lowercase http_proxy published too  http://127.0.0.1:58098
  PASS  NO_PROXY carries loopback  *.corp.example,10.0.0.0/8,localhost,127.0.0.1,::1,[::1]
  PASS  NO_PROXY keeps the operator's own entries  *.corp.example,10.0.0.0/8,localhost,127.0.0.1,::1,[::1]
  PASS  proxyRouteFor(api.github.com).proxied === true
  PASS  loopback stays direct
  PASS  proxyRouteFor(example.com).proxied === true

[2] the proxy is genuinely used by fetch
  PASS  fetch reached the stub proxy  urls=["http://probe.invalid/hello"]
  PASS  stub answered  stub-proxy-ok
  PASS  spawned children inherit a usable proxy

[3] unloading the plugin restores everything
  PASS  dispatcher restored to the previous instance
  PASS  proxy environment restored byte-for-byte  [false,false,false]|{…}|dispatcher:Agent
  PASS  route decisions restored
  PASS  no new Cordis effect left behind

[4] nothing was written to disk
  PASS  plugin tree is byte-identical

[5] failing-safe paths
  PASS  no proxy anywhere: installs nothing, registers no effect
  PASS  SOCKS value is refused, nothing installed
  PASS  SOCKS refusal says why, in the log
  PASS  dispatcher untouched by refused value
  PASS  falls back to HTTPS_PROXY when config is empty
  PASS  env-discovered install also unwinds cleanly
```

要点：第 [3] 段的"byte-for-byte"是拿 `undici.getGlobalDispatcher()` 的**对象同一性**加全部 8 个代理环境变量的原值快照比对，"restored to the previous instance"证明拿回的是**原来那个实例**而不是等价的新的。第 [1] 段特意预置了 `NO_PROXY=*.corp.example,10.0.0.0/8`，用来锁住"合并而不是覆盖"这条回归。

### 验证 C：profile 文件逐字节还原（`tools/fingerprint.ps1`）

```powershell
$fp = "<插件目录>\tools\fingerprint.ps1"
& $fp -Mode capture -Name baseline     # 安装前
dsh plugin --profile desktop add "<插件目录>"
& $fp -Mode capture -Name installed
& $fp -Mode compare -A baseline -B installed   # 确认"改动确实发生了"
dsh plugin --profile desktop remove dsh-proxy-zero
& $fp -Mode capture -Name removed
& $fp -Mode compare -A baseline -B removed     # 关键判定
```

目标 profile 可用 `-Profile`（默认 `desktop`）或 `-ProfileDir` 覆盖。

实测结果：

```
# 安装后（改动符合预期，且 cordis.patch.yml 未被触碰）
  相同  cordis.patch.yml  9F2F82D7EE8C...
  package.json  不同: 7AF4F18B3785... -> BFCFCB815BC2... (643 -> 769 B)
  pnpm-lock.yaml 不同: A222E3543BEF... -> 29051A42A596... (2090 -> 2292 B)
  仅 installed 有: dsh-proxy-zero@link:… / bundles + dsh-proxy-zero
  仅 installed 有: .\node_modules\dsh-proxy-zero

# 卸载并清掉联接后（关键判定）
  相同  package.json     7AF4F18B3785...    ← 与基线同一个哈希
  相同  cordis.patch.yml 9F2F82D7EE8C...
  相同  pnpm-lock.yaml   A222E3543BEF...
  相同  topLevelEntries
  相同  dependencies
  相同  bundles
  相同  residue

== 完全一致：removed2 与 baseline 逐字节/逐项相同，零残留 ==   [exit code: 0]
```

指纹覆盖 7 类判据：三个文件的 SHA256+字节数、profile 顶层条目清单、依赖清单、bundle 清单、残留物扫描（`.bak` / `.pre` / `.orig` / `.lock` / 含 `proxy-zero`、`dsh-proxy` 的路径）、以及 `node_modules` 联接。

### 验证 D：卸载后进程行为回到基线

重启应用后，以下三者应与"从未装过插件"完全一致：

- `proxyRouteFor` 对任意 URL 的判定回到启动器的策略（没设环境变量时即"全 direct"）；
- `web_fetch` 的 `WEB_BLOCKED_URL` 行为回到原样（这正是当初装它的原因，回来了说明还原成功）；
- agent 派生的子进程环境里不再有本插件发布的代理变量。

---

## 六、配置

包内 `cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-proxy-zero
      name: dsh-proxy-zero
      config:
        proxyUrl: ''   # 留空 = 自动发现
        noProxy: ''    # 逗号/换行/空格/分号分隔；与其他来源合并，不覆盖
```

两个字段都由**插件自己导出的 `Config` standard-schema 校验**：类型不对（比如把 `proxyUrl` 写成数字）会由 Cordis 记成一条 `ValidationError` 并点名出错字段，而不是像 0.1.0 那样只在日志里留一句话。该校验只影响本插件这一根 fiber。

`NO_PROXY` 的最终值是**三层合并**的结果，先到先得、按大小写去重：

1. 本插件的 `noProxy`；
2. 所选代理来源自带的绕过清单（目前只有 Windows 系统代理的 `ProxyOverride`）；
3. 进程原本就有的 `no_proxy` / `NO_PROXY`；
4. 最后强制追加 loopback 四项（`localhost` / `127.0.0.1` / `::1` / `[::1]`）。

> ⚠️ 0.1.0 只取第 1、4 层，会把机器原有的 `NO_PROXY`（企业在用的 `*.corp.example`、内网段之类）**整条丢掉**——那条清单同时是 `curl` / `git` / `pnpm` 这些子进程读的。0.2.0 起改为合并。

发现顺序（`proxyUrl` 留空时）：

1. `proxyUrl`（显式，最高优先，便于覆盖过期的环境变量）；
2. 启动环境里的 `HTTPS_PROXY` → `HTTP_PROXY` → `ALL_PROXY`（含大小写两种写法）。这一层包含**用户自己的 `$DSH_HOME/.env`**——DSH 的 `HOME_LAYER_PROXY_NAMES` 专门允许 harness home 的 `.env` 设置这四个名字，而项目目录的 `.env` 会被拒绝（防止随仓库传播的代理劫持）；
3. Windows 系统代理（`HKCU\...\Internet Settings` 的 `ProxyEnable=1` + `ProxyServer`），支持 `host:port` 与 `http=host:port;https=host:port` 两种写法。

要固定代理，可覆盖这一行：

```yaml
# profiles/desktop/cordis.patch.yml
- id: dsh-proxy-zero
  config:
    proxyUrl: http://127.0.0.1:7897
```

⚠️ 这样会在 profile 里**留下一行属于你的配置**，DSH 的卸载不会回收它。要回到绝对零残留，删掉这一行即可（本插件的零残留承诺只覆盖插件自己写入的东西）。

---

## 七、已知限制（如实说明）

1. **只支持 HTTP(S) 代理，不支持 SOCKS。** `dsh-http-proxy` 只接受 `http:` / `https:`；插件对 `socks5://` 之类取值是**拒绝并保持直连**，并在日志里说清原因（验证 B 的第 [5] 段覆盖了这条）。Windows 系统代理只配了 `socks=` 时同样如此，且单独报 `windows-system-proxy-socks`，不与"这台机器没有代理"混为一谈。Clash / v2rayN 的 mixed port 本身讲 HTTP，用那个端口即可。
2. **代理可用性不做检测。** 不探测端口、不测连通性、不解析 PAC。代理坏了请修代理；插件的失败语义是"什么都不做"，绝不破坏已经可用的直连。
3. **不覆盖 Telemetry。** `dsh-session-telemetry-otel` 走 Node 的 `http`，与上游行为一致，本插件不改变它。
4. **凭据明文。** 代理 URL 里的用户名密码会同时进入 `process.env`（因而也进入之后派生的子进程）。
5. **`--profile` 名要与实际一致。** 本机唯一活 profile 是 `desktop`（由 Electron 独占管理，`dsh --profile desktop --dump-config` 会被拒，但 `dsh plugin --profile desktop …` 正常）。
6. **代理来源必须先存在，插件才会激活。** 发现顺序是"显式 `proxyUrl` → 启动环境（优先启动器的 `launchEnvironment` 快照，因此也含 `$DSH_HOME/.env`）→ Windows 系统代理"。三者都为空时插件正确地什么都不做（`no usable proxy … staying direct`），`web_fetch` 的 `resolves to a non-public IP address` 也就照旧。要激活必须给一个来源——多数人的情况是 Clash 关着系统代理（TUN 模式下常见），那就得显式配 `proxyUrl`。
7. **Windows 系统代理的 `ProxyOverride`：能转的转，转不了的如实报告。** 插件把 `ProxyOverride` 一并读进来当绕过清单：普通主机名原样保留，`127.*` / `10.*` / `192.168.*` 这类前缀通配转成 CIDR，块大小按 Windows 写了几段决定（`10.*` → `10.0.0.0/8`，`192.168.*` → `192.168.0.0/16`）。**但有两处力所不及，必须在日志里点名，而不是假装做到了**：
   - `<local>`（"所有不带点的主机名"）**没有任何绕过清单语法能表达**，只能丢弃并 WARN；
   - 上游 `dsh-http-proxy` 的绕过匹配器**不认 CIDR**——它只把条目当主机名后缀匹配，并在自己文档里写明"操作系统的 `10.0.0.0/8` 必须改写成后缀形式"。因此 CIDR 条目只对读环境变量的消费方（`curl`、以及 22.21+/24+ 上带 `NODE_USE_ENV_PROXY` 的子 Node）有效，**对本进程内 `web_fetch` / `fetch` 的判定无效**。

   两条都会在启动日志里以 `WARN` 列出具体是哪些条目没生效。真要保证某段内网不经过代理，就在本插件的 `noProxy` 里按上游能认的**后缀形式**显式写出来（例如 `corp.example`，它会连带匹配 `api.corp.example`）。
8. **发现代理时优先读启动器的环境快照。** 0.1.0 只读 `process.env`，于是"代理只写在 `$DSH_HOME/.env` 里"的机器会出现：启动器已装好策略、`web_fetch` 正常工作，插件却打印 `no usable proxy … staying direct`。0.2.0 起优先 `ctx.get("launchEnvironment")`（`@deepseek-ai/dsh-launch-environment` 的分层快照），宿主没有该服务时自动回落到 `process.env`。
9. **代理环境变量名按小写优先读取。** `https_proxy` → `HTTPS_PROXY` → `http_proxy` → `HTTP_PROXY` → `all_proxy` → `ALL_PROXY`，与 undici 及 `dsh-http-proxy` 自己的解析顺序一致（0.1.0 从大写读起，选出的那个值会与真正生效的不一致）。Windows 的环境查找本身不分大小写，该平台上这一点不可观测。
10. **`@deepseek-ai/dsh-http-proxy` 解析不到时不降级。** 0.1.0 会退回 `undici` 的 `EnvHttpProxyAgent`；那条路**换不到 `proxyRouteFor()` 读的策略记录**，等于让 `web_fetch` 停留在直连分支——正是本插件要修的那个故障——却在日志里报成功。0.2.0 起只报告失败并保持直连。
11. **系统代理的绕过判定只作用于环境变量。** 本进程内 `web_fetch` 的"是否走代理"由上游策略决定，而那份策略只认启动器环境解析出的 `no_proxy`；`ProxyOverride` 与 `noProxy` 的合并结果落在 `process.env` 上（子进程会读到）。所以第 7 条那些"内网段"若要让 `web_fetch` 也直连，必须写进 `noProxy` 且用后缀形式。

---

## 八、Harness 包解析（实现要点）

`@deepseek-ai/dsh-http-proxy` 只存在于安装目录的 `app.asar` 内，**不在 profile 的 `node_modules` 里**；而 asar 归档对 ESM 解析器不透明。实测结论：

- `import "@deepseek-ai/dsh-http-proxy"`（裸名）→ 失败；
- `createRequire(<目录路径>)` → 失败；
- `createRequire(<目录>/probe.js)`（**指向文件**）→ 成功；
- 锚点若被 `dirname()` 截断（例如 `…\app.asar\dsh` → `…\app.asar`）→ 失败。

因此 `index.js` 的 `importHarnessPackage()` 按"插件自身目录 → 宿主 `process.argv` 的各项及其 `dirname` → `process.execPath`"依次尝试，且每个候选都**拼一个 `probe.js` 文件名**再交给 `createRequire`。

在真实桌面宿主里，`process.argv[2]` 就是 `…\resources\app.asar\dsh`（实测宿主命令行），所以**首候选即命中上游实现**，走的是原生语义。0.2.0 起这条是**唯一**路径：找不到包就报告失败并保持直连，不再退回 `undici`（理由见第七节第 10 条）。

实测（0.2.0）：插件目录树里 `undici` 其实**解析得到**——`profile\node_modules\undici`（v7.30.0，由 `dsh-github-connect` 的依赖带进来），所以 0.1.0 那条"降级分支"并非死代码，而是**真的会被走到**：它装上的是 v7 的 `EnvHttpProxyAgent`，而 Harness 自己用 asar 内的 v8，两者只共享 `Symbol.for('undici.globalDispatcher.1')` 这一个隐式槽位。

> 验证 B/D 的"未在真实应用里目视确认"一项已补：重启应用后确认插件已随 profile 加载（`dependencies` + `dsh.profile.bundles` 各多一行，安装体与仓库逐字节一致），且用宿主真实 argv 复现了解析路径。

---

## 九、真机实测记录（2026-10-03）

在装好插件、并在 profile 里配 `proxyUrl: http://127.0.0.1:7897` 后重启应用，实测：

| 观测 | 结果 |
| --- | --- |
| `web_fetch` 取 `https://raw.githubusercontent.com/cacads/dsh-proxy-zero/main/README.md` | **HTTP 200**，返回仓库 README 正文 |
| `web_fetch` 取 `https://api.github.com/repos/cacads/dsh-proxy-zero` | HTTP **403**，响应体为 `API rate limit exceeded for 134.195.101.74` |

**为什么这是"插件确实生效"的决定性证据**，而不是"网络恰好通了"：

`dsh-web-fetch-http` 的取数路径只有两条分支（`lib/index.js:495-509`）：

```js
const route = proxyRouteFor(url);
if (route.proxied && !isNonPublicIpLiteral(url.hostname))
  return await publicHttpNetwork.requestVia(route.dispatcher, url, headers, signal);  // 分支A：不解析地址
const addresses = await this.resolveAddresses(url.hostname, signal);                   // 分支B：解析地址
return await publicHttpNetwork.request(url, addresses, headers, signal);
```

本机 DNS 处于 Clash 的 `fake-ip` 模式，任何域名都解析成 `198.18.x.x`，分支 B 必然抛 `WEB_BLOCKED_URL`（`resolves to a non-public IP address`）。所以拿到 200 **只能是分支 A**，即 `route.proxied === true` —— 而启动器没有设置任何代理环境变量，`proxyRouteFor` 在插件装入策略前恒返回 `direct`。同一调用在配置前后分别是：

```
13:59  未配 proxyUrl → Error: URL hostname "raw.githubusercontent.com" resolves to a non-public IP address
14:03  配好并重启后 → HTTP 200（README 正文）
```

> ⚠️ **一个容易误判的点**：本机 TUN 模式下，"直连"流量同样被 Clash 接管，因此**出口 IP 与走代理时相同**（实测两者都是 `134.195.101.74`）。所以 **出口 IP 不能用来判断插件是否生效** —— 上表中的 `134.195.101.74` 只是顺带说明请求确实从代理节点出去了，判据本身是"分支 A 可达"。

> ⚠️ **出口质量**：该共享节点存在约 20–40% 的 TLS 握手抖动（`curl -x` 直接复测亦同），表现为偶发失败、重试即通；另有 GitHub 未认证 API 的共享 IP 限额（上表 403 即此）。二者都与插件无关。

---

## 十、文件清单

```
index.js                插件本体（无依赖、纯 ESM）
package.json            version 0.2.0；dsh.bundle.patch 指向包内 patch；npm test 跑单测
cordis.patch.yml        包内 patch：一行 insert，默认全为"不改变行为"
tools/unit.test.mjs     验证 A：纯逻辑单测（node --test，无需 Harness 运行时）
tools/verify.mjs        验证 B：进程内装卸 + 桩代理 + 逐项还原断言
tools/fingerprint.ps1   验证 C：profile 文件 SHA256 指纹与残留扫描
tools/uninstall.ps1     卸载：DSH 管理器 + 清理 link: 联接
fingerprints/           基线/已装/已卸 三份指纹留档（.gitignore，含本机路径）
```

---

## 十一、变更记录

### 0.2.0（2026-10-05）

一轮以"错误不能再是静默的"为主题的修订，四条实测出来的缺陷 + 三项工程化补课：

| # | 问题（0.1.0） | 处置 |
| --- | --- | --- |
| 1 | `NO_PROXY` 只由配置构造，**把机器原有的绕过清单整条覆盖掉**（实测：`*.corp.example,10.0.0.0/8` → `localhost,127.0.0.1,::1,[::1]`），子进程因此被塞进代理 | `composeNoProxy(...layers)` 改为多层合并，`noProxy` → 系统代理 `ProxyOverride` → 继承的 `NO_PROXY` → loopback，先到先得、按大小写去重 |
| 2 | 只按 `/[\n,]/` 切分，`NO_PROXY="a.com b.com"`（curl/Node 的空格写法）被当成**一个**主机名丢掉 | 改按 `/[,\s;]+/` 切分，逗号/空格/分号都认 |
| 3 | 环境变量按**大写优先**查找（`HTTPS_PROXY` 先于 `https_proxy`），与 undici 和 `dsh-http-proxy` 自己的顺序相反，日志里的来源名会和真正生效的值不一致 | 改为小写优先，与上游一致 |
| 4 | 发现代理只读 `process.env`；代理只写在 `$DSH_HOME/.env` 时，启动器已装策略、插件却报 `no usable proxy` | 优先读 `ctx.get("launchEnvironment")`（启动器的分层快照），回落 `process.env` |
| 5 | Windows 系统代理只读了 `ProxyServer`，**完全没读 `ProxyOverride`** —— 一旦用户拨开系统代理开关，`192.168.*` / `10.*` / `<local>` 这些内网直连约定全部失效 | 一次 `reg query` 读整键；前缀通配转 CIDR、`<local>` 丢弃并 WARN；系统代理只讲 SOCKS 时单独报 `windows-system-proxy-socks` |
| 6 | `installProxyFromEnvironment` 的诊断回调是空函数，**上游的拒绝理由全被吞掉** | 诊断转成 `WARN` 日志；无效 `proxyUrl` 的日志直接点名该值与修法 |
| 7 | 没有配置校验，`proxyUrl: 123` 之类的错误只在日志里留一句话 | 导出 `Config`（standard-schema），由 Cordis 校验并报错点名字段 |
| 8 | `undici` 降级分支不是死代码，且会**静默削弱 `web_fetch`**（换不到 `proxyRouteFor()` 的策略记录） | 删除降级；包解析不到就报告失败并保持直连 |
| 9 | 导出函数零单测（`verify.mjs` 只做集成，且要绝对路径 + 手动传参） | 新增 `tools/unit.test.mjs`（8 个用例，`node --test` 直接跑） |
| 10 | `fingerprint.ps1` 硬编码 `desktop`；`verify.mjs` 的用法注释漏了必需的 argv 参数；README 里的卸载命令写死了用户名 | 三个工具都加了 `-Profile` / `-ProfileDir` 或修正示例 |
| 11 | `index.js` 里 `dshHome()` 全仓库无人调用 | 删除 |

同轮还修掉了两处**本插件自己的**新代码缺陷（由新单测当场抓出，未进入任何已发布版本）：`10.*` 被转成不可解析的 `10.0/16`（补零段数与 CIDR 位宽都算错）。

验证：`node --test` **8/8**；`verify.mjs` **23/23**（含第 1 条的合并回归断言）；`fingerprint.ps1` 复核 window 与基线逐字节一致。

### 0.1.0（2026-10-03）

初版：零残留的进程内 HTTP(S) 代理策略，复用 `@deepseek-ai/dsh-http-proxy`，装卸双向可逆（19 项验证）。
