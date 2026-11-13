# Skilljack MCP — 大规模技能库分支（中文说明）

[English](./README.md) · [简体中文](./README-ZH.md)

一个把 [Agent Skills](https://agentskills.io) 直接接入大模型的 MCP 服务器。

> **本项目是 [`olaservo/skilljack-mcp`](https://github.com/olaservo/skilljack-mcp) v0.15.2（MIT）的分支**。上游行为完整保留，另加三项可选能力，使技能库扩展到 100+ 技能时依然可控：**仅影响清单的资源过滤**、**按领域按需展开的技能目录路由**、以及用于维护领域映射的**本地 Web 控制台**。文中路径均为占位符（`<SKILLS_DIR>` 技能库根目录、`<REPO_ROOT>` 本仓库根目录、`<path-to-domains.json>` 领域映射文件），不绑定任何机器、客户端或具体技能。

> **关于工具搜索 / 延迟加载**：默认通过 MCP 的 `instructions`（`initialize` 握手）投递技能目录，即使客户端启用工具搜索 / 工具描述延迟加载，模型也能看到目录，技能自动激活开箱可用。旧的 `--catalog=tool-description` 模式把目录塞进 `load-skill` 工具描述里，在这类客户端中不可见，因此不推荐使用。

---

## 1. 这个分支解决什么问题

上游 skilljack 在技能数量不多时表现很好，但有两处会随规模线性（甚至超线性）膨胀：

| 问题 | 表现 | 分支的对策 |
| --- | --- | --- |
| 单个技能附带成千上万个设计资产 / 二进制文件 | `resources/list` 与 SEP-2640 `skills/list` 清单被 URI 淹没，上下文在开工前就被吃掉，甚至突破单技能 512 文件 / 16 MiB 的互操作上限 | **仅影响清单的资源过滤**（第 4 节）：把重资产从**自动枚举**中隐藏，显式读取照常可用 |
| 扁平的 `<available_skills>` 目录把每个技能都写进每次连接的 `instructions` | 每个技能约 574 B ≈ 143 tokens，100+ 技能即 14K+ tokens，且与当前任务是否相关无关 | **领域路由**（第 5 节）：主目录只列全局技能 + 精简领域索引，模型按需展开某一个领域 |
| 上百个技能靠手改 JSON 打标签 | 易错、难审阅、难评估上下文成本 | **Web 控制台**（第 6 节）：搜索、批量分配、校验、成本预览、自动备份 |
| 把技能藏起来，也一并藏掉了「它们存在」这件事；模型不会主动想到先找技能，只能每个任务显式提醒 | 每个任务 | **发现前置契约**（第 5 节）：`instructions` 开头的 `<skill_preflight>` + 服务端「任务 → 领域」自动打分 |

由此形成五层渐进披露，模型只在真正需要时才为下一层付费：

```
initialize instructions             →  <skill_preflight> 契约 + 全局技能 + <skill_domains> 精简索引
find-skills-for-task(task)          →  服务端按触发词打分 → 最佳领域的 <available_skills> 条目
find-skills-for-task(domain)        →  （可选）再展开一个明确指定的领域
load-skill("<技能名>")               →  完整 SKILL.md（与上游完全一致）
resources/read / skill-resource <路径> →  单个配套文件：脚本、样式、资产
```

**兼容性**：两项服务端能力都可回退。资源过滤默认开启，但 `--resource-filter=off` 可恢复上游枚举行为；领域路由仅在配置了 `domains.json` 时启用，`--domain-map=off` 立即回到扁平目录。没有任何领域映射时，主 catalog 与上游一致。

---

## 2. 安装与快速开始

### 2.1 上游包（不含本分支改动）

```bash
npm install -g @skilljack/mcp
# 或直接运行
npx @skilljack/mcp <SKILLS_DIR>
```

### 2.2 本分支（从源码）

```bash
cd <REPO_ROOT>
npm install
npm run build

# 推荐用于「子目录五花八门 + 技能数量多」的库：
node dist/index.js \
  --list-mode=whitelist \
  --domain-map=<REPO_ROOT>/domains.json \
  <SKILLS_DIR>
```

要求 Node.js **>= 22**。标准 MCP 客户端配置示例（stdio 传输，替换占位符）：

```json
{
  "mcpServers": {
    "skilljack": {
      "type": "stdio",
      "command": "node",
      "args": [
        "<REPO_ROOT>/dist/index.js",
        "--list-mode=whitelist",
        "--domain-map=<REPO_ROOT>/domains.json",
        "<SKILLS_DIR>"
      ]
    }
  }
}
```

所有分支参数**必须用 `=<值>` 形式**：写成 `--domain-map ./x.json` 会被解析成一个技能目录。如果你用某个配置管理器把 MCP 配置分发到多个客户端，请通过**该管理器自身的命令**修改并同步，否则下次同步会覆盖手工改动。

---

## 3. 基本用法（上游能力）

```bash
# 单个 / 多个技能目录
skilljack-mcp <SKILLS_DIR>
skilljack-mcp <SKILLS_DIR> <MORE_SKILLS_DIR>

# GitHub 仓库（用 GITHUB_ALLOWED_ORGS / GITHUB_ALLOWED_USERS 设白名单）
GITHUB_ALLOWED_ORGS=acme skilljack-mcp github.com/acme/skills

# well-known 发布源（WELL_KNOWN_ALLOWED_ORIGINS 白名单 + SHA-256 摘要校验）
# 索引、每个制品以及任何重定向目标都必须命中白名单 origin；
# 若制品放在独立 CDN 域名，也要把该域名加入白名单（逗号分隔）
WELL_KNOWN_ALLOWED_ORIGINS=https://example.com \
  skilljack-mcp https://example.com/.well-known/agent-skills/

# 环境变量指定目录 / 静态模式 / HTTP 模式
SKILLS_DIR=<SKILLS_DIR> skilljack-mcp
skilljack-mcp --static <SKILLS_DIR>
skilljack-mcp --http=3000 <SKILLS_DIR>
# 或：SKILLJACK_HTTP_PORT=3000 skilljack-mcp <SKILLS_DIR>
```

**传输方式**：默认 stdio；`--http[=port]` 为无状态 Streamable HTTP（`POST /mcp`，默认端口 3000），暴露核心技能能力（`load-skill`、`skill-resource`、`skill://` 资源、`skills/list` / `skills/get`、`/skill` 与各技能 prompts）。必须写成 `--http=<端口>`，否则 `--http 3000` 会把 `3000` 当作技能目录。HTTP 监听所有网卡且**无鉴权**，仅适合可信网络；已弃用的 MCP Apps 配置界面默认不注册（见第 8 节）。由于是无状态传输，服务端不会主动推送 `listChanged` / `resources/updated`，已连接的客户端在下次请求或重连时看到变化；stdio 下则与上游一致，由文件监听与远端轮询保持状态新鲜。

**技能扩展（SEP-2640）**：声明 `io.modelcontextprotocol/skills`（含 `directoryRead`），实现 `skills/list`、`skills/get`、`resources/directory/read`。每个条目携带原样 frontmatter 以及 `SKILL.md` 与全部配套文件的 `{uri, digest, size}` 清单，供宿主校验；文件通过 `resources/read` 以 `skill://<技能路径>/<文件>` 逐个读取。在 2026-07-28 版连接上，结果还带扩展要求的 `ttlMs` / `cacheScope` 缓存属性。超过 `MAX_FILE_SIZE_MB`（默认 1）的文件既不服务也不列出；预 v1 的 `skill://index.json` 仍然兼容。

**工具可见性**：`--tools=<auto|always|never>`（或 `SKILLJACK_TOOLS`）控制 `load-skill` / `skill-resource`。`auto`（默认）在客户端声明技能扩展时禁用这两个工具，因为宿主会自行通过 `skills/list`、`skills/get`、`resources/read` 加载技能。无状态 HTTP 下握手与后续请求落在不同实例，`auto` 等同于 `always`，宿主支持扩展时可显式用 `never`。使用 `--catalog=tool-description` 时 `auto` 会被忽略。

**目录通道**：`--catalog=<instructions|tool-description>`（或 `SKILLJACK_CATALOG`）二选一投递 `<available_skills>`，绝不会同时走两条通道。默认 `instructions` 在握手阶段送达，能躲过工具搜索延迟；stdio 下它在启动时冻结，技能变动需要重启客户端（HTTP 下新连接总是拿到最新目录）。`tool-description` 仅为兼容保留且**不推荐**：工具描述会被延迟加载的客户端移出上下文，且 `tools/listChanged` 刷新会让整个提示词缓存前缀失效。领域路由只作用于默认的 `instructions` 通道。

---

## 4. Fork：仅影响清单的资源过滤

技能自带的运行时资产库（设计套件、图片、字体、压缩包）会把 `resources/list` 和 SEP-2640 `skills/list` 清单撑到成千上万条 URI，既挤占上下文，也可能突破单技能 512 文件 / 16 MiB 的互操作上限。

**过滤只作用于自动清单**：`resources/read`、`resources/directory/read`、`skill-resource <路径>` 依旧能按需读取任意符合条件的文件。也就是说 `assets/...` 引用照常可用，模型只在任务真正需要某资产时才为它付费。被隐藏的文件仍可按名字加载：`SKILL.md`（`load-skill` 的结果）带有绝对 `<location>` 以及脚本 / 样式的显式路径，智能体也可以从磁盘路径执行脚本，或用 `resources/directory/read` 浏览目录。

### 两种清单模式

`--list-mode`（环境变量 `SKILLJACK_LIST_MODE`）决定保留规则，两者都遵守「显式读取始终可用」的保证。

**`blacklist`（默认）** —— 除被排除的目录与扩展名外全部列出，适用于以说明文档为主的技能库。默认排除：

- 任意层级名为 `assets/` 的目录；
- 二进制 / 设计资产扩展名（`.svg`、`.png`、`.jpg`、`.webp`、`.pdf`、`.zip`、字体、音视频、编译产物等，共 56 种）。

**`whitelist`** —— 只列出「扩展名被允许且不在忽略目录内」的文件，适用于子目录五花八门（`scripts/`、`references/`、`styling/`、`data/`、`templates/` 等）的技能库：**不管目录叫什么名字**，文本 / 源码 / 数据格式一律保留，二进制、未知格式与运行时 / 测试产物一律隐藏。默认允许：

- 扩展名：`.md`、`.mdx`、`.txt`、`.rst`、`.adoc`、`.json`、`.jsonc`、`.yaml`、`.yml`、`.toml`、`.csv`、`.tsv`、`.xml`、`.py`、`.js`、`.mjs`、`.cjs`、`.ts`、`.mts`、`.cts`、`.jsx`、`.tsx`、`.sh`、`.bash`、`.zsh`、`.ps1`、`.bat`、`.cmd`、`.html`、`.htm`、`.css`、`.scss`、`.sass`、`.less`、`.sql`、`.graphql`；
- 忽略目录（即使其中文件后缀被允许）：`assets`、`tests`、`test`、`__tests__`、`__pycache__`、`fixtures`、`node_modules`、`dist`、`build`、`out`、`target`、`coverage`、`.git`、`vendor`、`.venv`、`venv`、`site-packages`。

白名单模式下**无扩展名的文件不会被列出**（无法判定为安全文本）；`SKILL.md` 本身在两种模式下都不进清单，它由 `load-skill` 投递。

配置优先级：CLI 参数 > 环境变量 > 默认值。

| CLI 参数 | 环境变量 | 默认值 |
| --- | --- | --- |
| `--resource-filter=off` | `SKILLJACK_RESOURCE_FILTER=off` | 开启 |
| `--list-mode=whitelist` | `SKILLJACK_LIST_MODE=whitelist` | `blacklist` |
| `--exclude-dirs=assets,media` | `SKILLJACK_EXCLUDE_DIRS=...` | `assets`（黑名单） |
| `--exclude-extensions=.png,.svg` | `SKILLJACK_EXCLUDE_EXTENSIONS=...` | 56 种二进制类型（黑名单） |
| `--allow-extensions=.md,.py` | `SKILLJACK_ALLOW_EXTENSIONS=...` | 文本 / 源码 / 数据格式（白名单） |
| `--ignore-dirs=tests,assets` | `SKILLJACK_IGNORE_DIRS=...` | 测试 / 构建 / 缓存目录（白名单） |

显式传**空值**表示停用该维度：例如 `SKILLJACK_ALLOW_EXTENSIONS=` 会让白名单模式一个文件都不列，`SKILLJACK_EXCLUDE_DIRS=` 会让黑名单模式保留所有目录。当前策略会在启动时打印到 stderr。

---

## 5. Fork：领域路由（按需发现技能）

扁平目录把每个技能都写进 `instructions`，成本随技能数线性增长。分支增加**可选的第三层发现机制**：给技能打领域标签，主 catalog 只保留未标记的「全局技能」+ 精简领域索引，模型通过 `find-skills-for-task` 工具按需展开某个领域。

渐进披露有个代价：模型看不到技能名字，就无法判断「有没有技能与任务相关」，于是「相关就先加载」这类条件式指令永远不会触发。分支用**发现前置契约**补上这一环：把契约放在 `instructions` 最前面，让「开工前调用一次」成为无条件动作，并把相关性判断移进服务端。

```
主 catalog（instructions）  →  <skill_preflight> + 全局技能 + <skill_domains> 索引
        │ 任何非平凡任务开始（无条件）
        ▼
find-skills-for-task(task)  →  服务端按触发词打分 → 最佳领域的 <available_skills> 条目
        ▼
load-skill("<技能名>")       →  完整 SKILL.md（未改动）
```

因此 `triggers` / `antiTriggers` 已是**可执行的路由规则**，不只是提示：中文词按子串命中（+3）、英文词按词边界（+2）、领域描述提供弱证据（+1）、任一 `antiTriggers` 命中直接否决该域，次名需达到首名 70% 才会一并返回。每次决策都会在 stderr 打印 `Task skill routing: …`，便于长期维护词表。

**路由只改变发现方式，不改变可达性**：技能不会被移出服务端的技能表，`load-skill`、`skill-resource`、`resources/list`、SEP-2640 的 `skills/list` / `skills/get` 以及 `/skill` prompts 仍能看到全部技能。模型已知技能名可直接加载，支持技能扩展的宿主看到的仍是全量列表。**没有领域的技能自动成为全局技能**，按上游方式全列，因此该功能可选且向后兼容。

### 领域映射文件

领域在 JSON 文件中声明（参见 [`domains.json`](./domains.json)）：

```json
{
  "version": 1,
  "domains": [
    {
      "name": "design",
      "description": "UI/UX、界面与视觉设计",
      "triggers": ["设计", "UI", "前端", "落地页"],
      "antiTriggers": ["纯后端逻辑"],
      "skills": ["mobile-ui-kit", "design-system-kit"]
    }
  ]
}
```

`skills[]` 既可以写 frontmatter 里的 base name，也可以写 `prefix__name` 形式的 qualified name。技能也可以在 `SKILL.md` frontmatter 中用 `domain: design` 或 `domains: [design, test]` 自标记，适合技能跨仓库迁移的场景。**映射文件优先于 frontmatter**；一个技能出现在两个领域时归第一个。映射里的未知技能名会在 stderr 告警并被忽略，因此过期的映射绝不会藏起真实技能。

配置优先级：CLI > 环境变量 > 当前工作目录下的 `domains.json`。

| CLI 参数 | 环境变量 | 默认值 |
| --- | --- | --- |
| `--domain-map=<path-to-domains.json>` | `SKILLJACK_DOMAIN_MAP=...` | 工作目录下存在 `domains.json` 时启用 |
| `--domain-map=off` | `SKILLJACK_DOMAIN_MAP=off` | 关闭路由 → 扁平目录 |

映射缺失或非法时**fail-open**：全部技能退回全局，服务端照常运行并在 stderr 告警；随时可用 `--domain-map=off` 回到上游行为，无需删除任何文件。启动时 stderr 会打印生效策略（领域数、各领域技能数、全局技能数、映射路径）。

### `find-skills-for-task` 工具

| 调用 | 返回 |
| --- | --- |
| `find-skills-for-task({ "task": "把表格做得更紧凑" })` | **推荐的第一步动作**：`<task_routing>`（最佳领域、得分、命中的触发词）+ 该领域的 `<available_skills>` 条目；一次调用即可，无需自己猜领域 |
| `find-skills-for-task()` | `<domains>` 目录：每个领域的名字、描述、技能数量、触发词 |
| `find-skills-for-task({ "domain": "design" })` | 该领域的 `<available_skills>` 条目（name / description / uri / location），随后用 `load-skill` 加载选中的技能 |
| `find-skills-for-task({ "domain": "nope" })` | 报错并列出有效领域名 |

显式传 `domain` 时**优先于** `task`；`task` 为空等同于不传参数。没有领域达到打分阈值时，返回领域目录并提示按全局技能继续——所以传 `task` 永远安全（fail-open）。只展开**得分最高的一个**领域，接近的次名放在 `<also_relevant>` 里，需要时再传 `domain` 二次调用，避免一次塞进两个领域的 token。

领域名匹配**不区分大小写**。该工具只读、幂等，且**独立于 `--tools` 注册**（它正是为没有技能扩展的客户端提供的发现层，不能被 `--tools=auto` 顺带禁用）；每次调用都重新读取实时技能状态，因此文件监听新发现的技能无需重启即可见。路由关闭时工具仍然存在，只是回答「所有技能都是全局」。

> **不展示 `instructions` 的宿主**：有些客户端不会把 MCP 握手里的 `instructions` 交给模型，`<skill_preflight>` 与 `<skill_domains>` 因此不可见。本分支在 `find-skills-for-task` 的**工具描述**里附带一份精简域清单（域名 + 一行描述，不含触发词）作为兜底：只要工具被声明给模型，域信息就一定可见。触发词仍只留在服务端用于打分，不占用每次请求的上下文。若宿主连固定契约都不进系统提示，还需在宿主的常驻规则里重申同一句话。

> **改名说明**：本分支早期把该工具叫作 `route-domain`，因名字里看不出与技能有关而改为 `find-skills-for-task`。**旧名没有注册别名**，请更新已保存的提示词与客户端片段并重启 MCP 客户端（启动参数不变）。

### 必须记住的不变量

- 清单过滤只影响**自动枚举**，显式读取与磁盘路径执行始终可用；
- 领域路由只重塑「模型默认看到的目录」，**不移除任何技能的可达性**；
- 一个技能只归一个领域；重复登记以第一个为准；`triggers` / `antiTriggers` 是**服务端打分规则**（传 `task` 时生效），同时仍写进领域索引供模型参考；
- 映射失效时 fail-open，服务不中断；
- 领域索引的成本是 **O(领域数)** 而非 O(技能数)，这是能扩展到 100+ 技能的关键；
- stdio 下 `instructions` 在启动时冻结，改完配置要**重启客户端**才能看到一致的主 catalog。

---

## 6. Fork：领域管理控制台（Web 界面）

`npm run domains-ui` 启动一个**独立的本地 Web 控制台**，用于浏览技能库、批量维护 `domains.json`。前后端均为 TypeScript（Node 内置 `http` + 原生 DOM），**不新增运行时依赖**，与 MCP 服务器是不同进程，默认只监听 `127.0.0.1`。

```bash
npm run domains-ui
# 或显式指定路径与端口：
npm run domains-ui -- --skills-dir=<SKILLS_DIR> --domain-map=<path-to-domains.json> --port=5178
```

打开 `http://127.0.0.1:5178`。路径解析顺序：

- 技能目录：`--skills-dir` > `SKILLS_DIR` > 配置文件中的 `skilljackAdmin.skillsDir`（无此键时取第一个本地 `skillDirectories` 项）> 未配置（界面会提示）；
- 映射文件：`--domain-map` > `SKILLJACK_DOMAIN_MAP` > 配置文件中的 `skilljackAdmin.domainMap` > `<REPO_ROOT>/domains.json`；
- 监听地址 / 端口：`--host` > `SKILLJACK_ADMIN_HOST` > `127.0.0.1`；`--port` > `SKILLJACK_ADMIN_PORT` > `5178`；
- 配置文件位置：`--admin-config` > `SKILLJACK_ADMIN_CONFIG` > `~/.skilljack/config.json`。

界面「路径设置」里点「保存并应用」会把两个路径**写入该配置文件**：目录 / 文件不存在时自动创建，写入前做时间戳备份并原子替换，下次启动自动读取，无需重新设置。该文件与上游 MCP server 共用 —— `skillDirectories[0]` 是技能库根目录，fork 私有键 `skilljackAdmin` 记录映射路径与「用户主动清空」状态，上游加载器会忽略它。启动参数 / 环境变量的优先级仍高于已保存路径，界面会提示当前生效来源。

**按钮职责要分清**：顶栏「保存更改」把领域分配草稿校验后写入 `domains.json`（带备份），「重置」丢弃未保存的草稿 —— 两者都不管路径；路径由「路径设置」弹窗的「保存并应用」单独保存。启动时会自动执行 `npm run build:admin`，也可单独运行。HTTP 接口为 `GET /api/state`、`POST /api/config`、`PUT /api/domains`、`GET /api/health`。

界面能力：

- **紧凑仪表盘布局**：5 个 KPI 收进吸顶顶栏（不再占用独立卡片行），首个指标带「已归入领域比例」进度条，关键数值用强调色；左右面板等高，表格与领域列表各自内部滚动。顶栏可切换深色（默认）/ 浅色主题，选择保存在 `localStorage`。
- **浏览 / 搜索**：查看每个技能的名字、描述、frontmatter、完整 `SKILL.md`、资源数量与绝对路径；符号链接、缺少 `SKILL.md`、frontmatter 非法的条目会明确标红，而不是静默消失。
- **批量分配**：多选技能后移入某个领域、移入新建领域，或退回全局。分配是**移动**语义：技能会从上一个领域移除，与服务端「一技能一领域」规则一致。
- **编辑领域**：新增 / 删除领域，编辑 `name`、`description`、`triggers`、`antiTriggers`，或移除单个成员。
- **成本预览**：实时估算主 catalog 的字节 / token 及相对扁平目录的节省量，包含尚未保存的改动。
- **暴露 frontmatter 陷阱**：若技能自身在 `SKILL.md` 里声明了 `domain`，把它从映射中移除并不会让它变成全局，界面会显式提示。
- **效率细节**：`Ctrl+S` 保存、`Ctrl+F` 聚焦搜索、未保存离开提示、操作结果 toast。

写入安全：`PUT /api/domains` 先校验（拒绝重名领域、`skills` 非数组、同一技能归属多领域），再生成带时间戳的备份，最后以 `tmp` + `rename` **原子写入**；仅保留最近 5 份备份。未知技能名是告警而非错误，因此一份可移植的映射可以引用本机尚未安装的技能。**技能库本身永远不会被写入**。

控制台只扫描配置的技能目录；服务端自带的 bundled 技能位于别处，不会出现在列表中。底层规则见 [SKILLS-AND-DOMAINS.md](./SKILLS-AND-DOMAINS.md)。

---

## 7. 配置总表与项目结构

所有分支参数都用 `--参数=<值>` 形式，优先级为 CLI > 环境变量 > 内置默认值；显式空值停用该维度。生效的过滤与路由策略会在启动时打印到 stderr。

| CLI 参数 | 环境变量 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `--resource-filter=off` | `SKILLJACK_RESOURCE_FILTER` | 开启 | 恢复上游清单行为 |
| `--list-mode=blacklist\|whitelist` | `SKILLJACK_LIST_MODE` | `blacklist` | 自动清单的保留规则 |
| `--exclude-dirs=...` | `SKILLJACK_EXCLUDE_DIRS` | `assets` | 黑名单：隐藏的目录名 |
| `--exclude-extensions=...` | `SKILLJACK_EXCLUDE_EXTENSIONS` | 56 种二进制类型 | 黑名单：隐藏的后缀 |
| `--allow-extensions=...` | `SKILLJACK_ALLOW_EXTENSIONS` | 文本 / 源码 / 数据格式 | 白名单：允许的后缀 |
| `--ignore-dirs=...` | `SKILLJACK_IGNORE_DIRS` | 测试 / 构建 / 缓存目录 | 白名单：忽略的目录 |
| `--domain-map=<路径>\|off` | `SKILLJACK_DOMAIN_MAP` | 存在 `./domains.json` 时启用 | 领域路由开关 |
| `--catalog=<instructions\|tool-description>` | `SKILLJACK_CATALOG` | `instructions` | 目录投递通道（上游） |
| `--tools=<auto\|always\|never>` | `SKILLJACK_TOOLS` | `auto` | `load-skill` / `skill-resource` 可见性（上游） |
| `--ui-tools=<on\|off>` | `SKILLJACK_UI_TOOLS` | `off` | 恢复已弃用的上游 MCP Apps 工具、UI prompts 与 `ui://` 资源 |

完整的上游参数（`--static`、`--http`、`SKILLS_DIR`、GitHub / well-known 白名单等）见维护指南第 9 节。

### 分支新增的文件

| 路径 | 职责 |
| --- | --- |
| `src/resource-filter.ts` | 过滤策略、默认值、黑名单 / 白名单判定、启动日志 |
| `src/skill-tool.ts` | 仅在 `listSkillFiles()` 应用过滤；拆分主 catalog；输出 `<skill_preflight>`；定义 `find-skills-for-task`（task / domain / 无参）并记录 stderr 决策日志 |
| `src/domain-router.ts` | 解析映射、frontmatter 兜底、名称匹配、告警与 fail-open，以及纯函数式「任务 → 领域」打分 |
| `src/index.ts` | CLI 说明与两项策略的 stderr 摘要 |
| `domains.json` | 可移植的领域映射示例 |
| `admin/core.ts` | 技能扫描、映射校验、原子写入、备份、catalog 成本估算 |
| `admin/server.ts`、`admin/web/*` | 独立 TypeScript HTTP 服务 + 零依赖原生 DOM 前端 |
| `src/*.test.ts`、`admin/core.test.ts` | 过滤、路由、catalog、工具调用与后台写入的测试 |
| `SKILLS-AND-DOMAINS.md` | 维护指南：新增技能、标记领域、验证与排错（中文） |

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 构建 MCP Apps UI 并编译服务端到 `dist/` |
| `npm run build:admin` | 编译控制台 TypeScript |
| `npm run typecheck` | 服务端与 UI 类型检查 |
| `npm test` / `npm run test:watch` | 运行 / 监听 Vitest 测试 |
| `npm run domains-ui` | 构建并启动领域管理控制台 |
| `npm run dev` | `tsx watch src/index.ts` |
| `npm run inspector` | 用 MCP Inspector 检查 `dist/index.js` |

测试锁定的关键不变量：**仅影响清单**（被隐藏的资产仍可按 URI 读取、按磁盘路径执行）、**仅影响发现**（路由不移除技能，`load-skill` / `resources/list` / `skills/list` 仍见全部）、**fail-open**（映射缺失 / 非法退回扁平目录）、**一技能一领域**（未知名字告警而非隐藏）、**stdio 纯净**（即使 `env: {}` 启动，stdout 也只有 JSON-RPC）、**后台写入安全**（校验 → 时间戳备份 → 原子 rename，且从不写技能库）。

---

## 8. 已弃用：上游 MCP Apps 配置 / 展示界面

上游原本附带 11 个 `skill-config-*` / `skill-display-*` 工具、`/skills` 与 `/skill-config` 两个 prompts，以及两个 `ui://` 资源，用于能渲染 [MCP Apps](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/) 的客户端。**本分支默认不注册这一整套界面**：多数客户端（pi、WorkBuddy、opencode）打不开它，它写入的配置又被命令行传入的技能目录覆盖，留在 `tools/list` 里只会白占 11 条工具描述的上下文。默认工具面只有 `load-skill`、`skill-resource`、`find-skills-for-task` 三个。

需要恢复时加 `--ui-tools=on`（或 `SKILLJACK_UI_TOOLS=on`）；工具、prompts、`ui://` 资源由同一个开关统一控制，不会出现「prompt 让模型调用不存在的工具」。`--static` 与 `--http` 下依旧不可用。配置文件**读取**（`~/.skilljack/config.json`）仍然生效，去掉的只是聊天窗口里的编辑器；领域维护请改用本分支的独立 Web 控制台（第 7 节）。

源码文件保留并标注 `@deprecated`，方便日后同步上游；它们不再出现在 `instructions`、工具描述、prompts、`manifest.json` 等任何模型可见的注册描述中。

---

## 9. 文档索引

| 文档 | 语言 | 内容 |
| --- | --- | --- |
| [README.md](./README.md) | English | 英文主说明：安装、用法、分支能力、配置与开发 |
| [README-ZH.md](./README-ZH.md) | 简体中文 | 本文，与英文 README 对照 |
| [SKILLS-AND-DOMAINS.md](./SKILLS-AND-DOMAINS.md) | 简体中文 | 维护指南：新增技能、领域标记与维护、路由契约、清单可见性、验证排错 |
| [上游完整参考](https://github.com/olaservo/skilljack-mcp/blob/main/skills/skilljack-docs/SKILL.md) | English | 工具、prompts、资源、配置、架构，由 bundled 技能按需加载 |

询问智能体「how do I use skilljack?」即可按需加载上游完整参考。凡是涉及**本分支新增技能或维护领域**的问题，请从 `SKILLS-AND-DOMAINS.md` 开始——该文档刻意与具体环境解耦，可以随仓库一起迁移。

## 10. 相关链接与许可

- [Agent Skills 规范](https://agentskills.io)
- [Skills over MCP 兴趣组仓库](https://github.com/modelcontextprotocol/experimental-ext-skills)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP 客户端示例](https://modelcontextprotocol.io/clients)

基于 Ola Hungerford 的 [`olaservo/skilljack-mcp`](https://github.com/olaservo/skilljack-mcp) v0.15.2，沿用 MIT [LICENSE](./LICENSE)。分支改动集中在 `src/`、`admin/` 与 `domains.json`，三项能力均可独立关闭，服务端随时可退回上游行为。
