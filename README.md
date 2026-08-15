# dsh-webui-market-plugin[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

在 dsh web GUI 内部的社区插件市场：浏览 [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com/) 的插件目录，直接在 **设置 → 插件 → 插件市场** 里安装 / 卸载插件到 profile。界面风格与 harness 前端一致（跟随系统深浅色主题），支持中英文（按系统语言自动切换）。

An in-harness community plugin market for the dsh web GUI: browse the awesome-dsh-plugin.com catalog and install/uninstall plugins into a profile from **Settings → Plugins → Plugin Market**.

## 推荐 Recommended

本插件为社区独立实现，**推荐优先使用网站官方实现 [dsh-market](https://github.com/dsh-market/dsh-market)**（由 awesome-dsh-plugin.com 维护者开发，功能一致、维护更活跃）。

A community implementation — **prefer the official [dsh-market](https://github.com/dsh-market/dsh-market)** by the awesome-dsh-plugin.com maintainer (same functionality, more actively maintained).

## 效果展示 Screenshot

![插件市场效果](img/7f0810a3710382f3810e9aa42f160cc1.png)

## 安装 Install

方式一：从 **npm registry** 安装（推荐，无 git 克隆 / prepare 脚本步骤）：

```sh
dsh plugin --profile web add @sanqi-normal/dsh-webui-market-plugin
```

方式二：从 GitHub 源码安装：

```sh
dsh plugin --profile web add github:Sanqi-normal/dsh-webui-market-plugin
```

安装后**重启 web 服务**生效：

```sh
pnpm dsh web
```

GitHub 源安装会执行包内 prepare 脚本，如被 pnpm 拦截，把提示的包名加入 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 后重试。

## 使用 Usage

打开 **设置（Settings）→ 插件（Plugins）→ 插件市场（Plugin Market）**：

- 目录按分类分组，支持搜索与"已安装"过滤；每个卡片显示 GitHub Star 数（无数据不显示），可一键按 **最热（Star 降序，无 Star 的排最后）/ 最新（收录日期）** 排序，或恢复官网默认顺序；大目录分批渐进渲染，避免打开瞬间一次性插入数百卡片造成卡顿
- 点 **详情** 查看该插件的官方安装命令（含目标 profile）
- **安装 / 更新 / 卸载** 组成 FIFO 任务队列：多个插件可以连续排队提交，任务面板固定在右下角、不随页面滚动隐藏，实时显示「排队中 / 校验中 / 执行中 / 完成 / 失败 / 已终止 / 超时」，可取消排队项、终止执行项、查看每个任务的 pnpm 日志；每个任务超过 120 秒自动超时；**一键更新全部**会把所有可更新插件依次加入队列；清除已完成/失败任务会同步到服务端，刷新或重新打开面板后不会再次出现
- **停用 / 启用**：停用保留依赖与磁盘文件，只把插件移出激活的 bundle 层（重启后仍保持停用）；启用按原顺序恢复，免删装；卡片操作区横向排列在卡片底部，避免右侧按钮拥挤
- **本机插件**：列出所有由依赖管理的插件（含在市场之外安装的），标注目录内/目录外、已停用、来源类型，可直接停用、启用或卸载（内置 bundle 与本地 link/file 源不会提供删除）
- 每个插件卡片显示真实的已安装状态（与 profile 的 `package.json` 同步）
- 顶部显示插件目录来源官网链接，可直接打开



## 工作原理 How it works

持久化 bundle（`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml`），由 `dsh plugin add` 的 reconcile 自动加入 profile 的 `dsh.profile.bundles` 层：

- **Host 半**（`lib/host.js`）：注册 `/api/dsh-market` 路由，提供 `list`（读取官网 JSON API `plugins.json`，失败回退静态页解析 / 离线快照，含 stars/added）、`probe`（环境探测）、`installed` / `installedAll`（读取 profile package.json 与已装包 manifest）、`install` / `update` / `updateAll` / `uninstall`（FIFO 队列 + 后台 spawn `dsh plugin` CLI，白名单与试装验证在队列头执行）、`disable` / `enable`（停用/启用并持久化到 `dsh.market.disabled`）、`op`（队列快照）、`kill`（终止/取消任务）
- **Client 半**（`lib/client.js`）：通过 `exports["./client"]` + `dsh.client` 声明被 web 前端加载，注册到 `settings.plugins.tab` 槽位

## 安全与限制 Safety and limitations

- **来源白名单**：安装只接受精选目录（awesome-dsh-plugin.com curated registry）收录的 `github:` 源，目录外的一律拒绝，与 [dsh-market](https://github.com/dsh-market/dsh-market) 的白名单策略一致（目录抓取失败或 registry/link 源不做此限制）
- **试装验证（trial boot）**：白名单通过后，若插件未声明 web client 半端（`dsh.client.platform === 'web'`），会先做**试装验证**：在临时 DSH_HOME 里按 web profile 模板重建组合，用同一套 `dsh plugin add` 装入候选插件，再以 `--port 0`（系统空闲端口）实际启动一次，只有出现 `dsh web:` 就绪行（Loader 树成功结算后才打印）才判定可装。验证失败会给出**真实的启动错误**（如重复 api-gateway / webserver 等）并拒绝安装，此时真实 profile 从未被写入、试装目录自动清理，无需任何回退操作
- **同源校验**：`install` / `uninstall` / `update` / `kill` 写操作只接受同源 POST（Origin 头与 Host 一致），跨源请求一律 403
- **热挂载（免重启）**：安装成功后，若新插件的 `cordis.patch.yml` 是纯 `id`/`name` 插入行，会尝试挂入运行中的组合并**自动刷新页面生效**（无需手动操作）；patch 复杂或环境不支持时回退"重启生效"。热挂载输入存于 `<profile>/.dsh-market/`，每次启动自动清理
- **更新检测与更新**：已安装插件卡片自动显示"更新"按钮（github 源对比 lockfile 锁定 commit 与 GitHub HEAD；registry 源对比 npm latest 与已装版本；本地 link/file 源不检测），点击即重新解析最新版本并作为后台任务执行，完成后下次重启生效；检测失败静默降级为"无更新"，不会阻塞列表
- **离线目录快照**：`data/catalog-snapshot.json` 作为官网抓取失败时的离线兜底，可用 `pnpm run snapshot` 刷新
- **安装前自动快照**：写入真实 profile 前会把 `package.json` 备份为同目录 `.mkts-snapshot-<时间戳>.json`，配合 `dsh plugin --profile web remove <包名>` 可手工回退
- **CI=true**：pnpm 子进程以 CI 模式运行，避免无 TTY 时静默卡在交互提示
- **停用持久化**：停用状态写入 profile `package.json` 的 `dsh.market.disabled`（保留依赖、移出 `dsh.profile.bundles`）；市场在启动时和每次 pnpm 操作后会重新应用该集合。注意：在命令行手工执行 `dsh plugin add/remove/update` 会触发 reconcile 短暂恢复停用项，重启或下一次市场操作会再次停用
- 安装 / 卸载后需重启 web 服务生效（热挂载成功的除外，本插件不做自动重启）
- 目录数据优先来自官网 JSON API（`plugins.json`，与 [dsh-market](https://github.com/dsh-market/dsh-market) 同源，含 Star 数），API 不可用时回退官网静态页解析，再回退内置离线快照；插件数量与分类以官网为准