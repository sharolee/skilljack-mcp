# 技能与领域维护指南

> **适用范围**：本 MCP Server 的技能库维护者。
> **环境无关声明**：本文只描述机制与操作流程，不绑定任何特定机器、操作系统用户或客户端。文中所有路径都是占位符，例如 `<SKILLS_DIR>`（技能库根目录）、`<REPO_ROOT>`（本仓库根目录）；示例技能名仅用于演示格式，请替换为你自己的实际值。

---

## 1. 为什么需要「领域」

服务端在 MCP 握手（`initialize`）时，会把一份 `<available_skills>` 目录写进 `instructions` 投递给模型。这份目录是**全量**的：每个技能约 `574 B ≈ 143 tokens`，100 个技能就是约 14K tokens，而且在模型开始干活之前就已经花掉了。

「领域」（domain）提供第二层**按需发现**：

```
连接握手   →  <skill_preflight> 契约 + 全局技能全列 + <skill_domains> 索引（域名/描述/数量/提示词）
                                   │ 任何非平凡任务开工前（无条件）
                                   ▼
find-skills-for-task(task)  →  服务端按触发词打分 → 最佳领域的 <available_skills> 条目
                                   ▼
load-skill("<name>")   →  完整 SKILL.md（和原来完全一样）
```

`<skill_preflight>` 位于 `instructions` 最前面，是一段约 500 B 的固定契约：要求模型在**任何非平凡任务开始前**先调用一次 `find-skills-for-task` 并传入一句话 `task`，由服务端用 `triggers` / `antiTriggers` 选出该展开的领域，再 `load-skill`。这样做的原因是：技能名字被收进领域后，模型看不到它们，就无法判断「是否有技能与任务相关」，条件式提醒（「相关就先加载」）永远不会触发。把触发条件改成「任务开始」、把判断交给代码，模型只需执行一个固定动作。传 `task` 永远安全：没有命中时返回领域目录并提示继续用全局技能。

**核心不变量（务必记住）**：领域路由只改变「模型默认看到的目录」，**不改变技能本身的可达性**。被划入领域的技能依然能被 `load-skill` 按名字加载，也依然出现在 `resources/list`、SEP-2640 的 `skills/list` / `skills/get` 以及 prompts 里。**清单里看不见 ≠ 不能调用。**

没有标记领域的技能自动成为**全局技能**，在主 catalog 中照常全列。因此这项能力是**可选、向后兼容**的：不写任何领域配置，行为就和上游完全一致。

---

## 2. 术语速查

| 概念 | 含义 |
| --- | --- |
| **技能（skill）** | 技能库根目录下的一个子目录，内含 `SKILL.md`（必需）及可选的脚本、参考资料、资产 |
| **全局技能** | 未归属任何领域的技能，直接出现在主 catalog 的 `<available_skills>` 中 |
| **领域（domain）** | 一组相关技能的命名分组；主 catalog 只暴露它的名字/描述/数量，不列出成员 |
| **`find-skills-for-task`** | 服务端提供的只读工具。传 `task` 由服务端打分并返回最佳领域的技能条目；传 `domain` 展开指定领域；无参调用列出所有领域 |
| **`load-skill`** | 既有工具，按技能名返回完整 `SKILL.md`；领域路由不改变它 |
| **`domains.json`** | 领域映射配置文件，集中声明「领域 → 技能名单」 |
| **base name / qualified name** | `name` = SKILL.md frontmatter 里的名字；qualified name = `<来源前缀>__<base name>`，本地技能库的前缀是技能根目录的**文件夹名**（见 §3.3） |

> **工具改名**：本分支早期把发现工具命名为 `route-domain`，现已改为 `find-skills-for-task`（名字里直接体现「技能」与「任务」）。旧名**不注册别名**，已保存的提示词 / 客户端片段需同步更新并重启客户端；启动参数（技能目录路径、`--domain-map`）不受影响。

---

## 3. 技能库目录结构

### 3.1 扫描规则

服务端只扫描你配置的**技能根目录**（启动参数中的路径，或 `SKILLS_DIR` 环境变量），规则如下：

- 只认根目录下的**直接子目录**，不递归寻找更深层级的技能。
- 每个技能子目录必须含有 `SKILL.md`（小写 `skill.md` 也可）。
- **符号链接 / Windows junction 会被跳过**。目录判定基于 `Dirent.isDirectory()`，链接返回 false。请使用真实目录；如果技能来自别处，直接复制或由你的同步工具落地为实体目录。
- 隐藏目录（以 `.` 开头）与 `node_modules` 不参与资源枚举。

典型结构：

```
<SKILLS_DIR>/
├── design-system-kit/          ← 一个技能 = 一个目录
│   ├── SKILL.md                ← 必需
│   ├── references/             ← 任意子目录名都可以
│   │   └── tokens.md
│   ├── scripts/
│   │   └── check.mjs
│   └── assets/                 ← 大体积资产，默认不进自动清单
│       └── preview.webp
├── e2e-browser-test/
│   └── SKILL.md
└── <REPO_ROOT>/                ← 仓库自带的 bundled 技能（如有）
```

### 3.2 `SKILL.md` 的 frontmatter

文件必须以 `---` 开头的 YAML frontmatter 开始，并以 `---` 闭合；frontmatter 必须是 mapping。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | ✅ | 技能名，即 base name。缺失或为空 → 该技能被跳过 |
| `description` | string | ✅ | 一句话说明用途，会出现在 catalog 里供模型判断。缺失或为空 → 被跳过 |
| `domain` / `domains` | string / string[] | 否 | 领域标记，作为 `domains.json` 的可移植兜底（见 §5.3） |
| `disable-model-invocation` | boolean | 否 | `true` 时该技能不进入模型可见的 catalog，也不进入 `find-skills-for-task` 结果；适合只供用户手动调用的技能 |
| `user-invocable` | boolean | 否 | `false` 时不出现在 prompts 菜单，默认 `true` |

最小示例：

```markdown
---
name: design-system-kit
description: 构建与评审设计系统、组件规范、配色与排版，适用于页面改版与界面美化任务。
---

# Design System Kit

（正文：给模型的指令。可写相对路径，例如 `scripts/check.mjs`；
   服务端投递的 <location> 是绝对路径，agent 可直接据此执行磁盘上的脚本。）
```

### 3.3 命名规则：`base name` 与 `qualified name`

- **base name** = frontmatter 的 `name`，例如 `design-system-kit`。
- **qualified name** = `<来源前缀>__<base name>`。本地技能库的前缀是**技能根目录的文件夹名**：若根目录叫 `skills`，则 qualified name 是 `skills__design-system-kit`。GitHub / 远程来源使用各自的来源名作前缀。
- `domains.json` 的 `skills[]` **两种写法都接受**（忽略大小写）。**推荐写 base name**——它不随技能库目录改名而失效。

`load-skill` / `skill-resource` 通常需要 qualified name；领域映射里写 base name 即可，服务端会自己解析。

---

## 4. 新增一个技能：标准流程

1. **建目录**：在 `<SKILLS_DIR>` 下新建实体子目录（不要用符号链接），例如 `design-system-kit/`。
2. **写 `SKILL.md`**：按 §3.2 填好 `name` 与 `description`，正文写清模型该怎么用这个技能；如有脚本或参考资料，在正文里写明相对路径或目录。
3. **放附属文件**：`scripts/`、`references/`、`styling/`、`assets/` 等目录名任意。大体积图片、字体、压缩包放 `assets/`（默认不进自动清单，但仍可按需读取）。
4. **决定是否标记领域**：
   - 想让它**始终可见**（如代码风格指南、README 写作助手这类跨任务通用工具）→ 什么都不用做，它自动成为全局技能。
   - 想让它**按需加载** → 按 §5 把它加进 `domains.json`，或在 SKILL.md frontmatter 写 `domain:`。
5. **验证**（见 §8）：确认技能被发现、能 `load-skill`、领域路由按预期工作。

> **重启提醒**：stdio 模式下 `instructions` 在启动时就冻结了。新增技能后，主 catalog 的变化需要**重启客户端 / 重连 MCP** 才会体现；但 `find-skills-for-task` 工具每次调用都会重新读取映射和技能状态，所以领域展开是准实时的。为避免「主目录和路由结果短暂不一致」，改完配置后建议重启一次。

---

## 5. 维护领域映射（`domains.json`）

### 5.1 配置位置与优先级

| 优先级 | 方式 | 说明 |
| --- | --- | --- |
| 1 | 启动参数 `--domain-map=<path>` | 推荐。example: `--domain-map=<REPO_ROOT>/domains.json` |
| 2 | 环境变量 `SKILLJACK_DOMAIN_MAP=<path>` | 适合不便于改启动参数的场景 |
| 3 | 服务端工作目录下的 `./domains.json` | 存在即自动启用 |

- 相对路径按**进程工作目录**解析（`path.resolve`），不是按配置文件自身位置解析。**生产配置建议写绝对路径。**
- 传 `off` / `0` / `false` / `none` 可一键禁用路由，回到上游的平铺 catalog，**不需要删文件**。
- **必须带等号**：`--domain-map ./x.json` 会把 `./x.json` 误当成技能目录。
- 领域路由只对默认的 `--catalog=instructions` 生效；legacy 的 `--catalog=tool-description` 模式保持平铺 catalog。

### 5.2 文件结构

```json
{
  "version": 1,
  "domains": [
    {
      "name": "design",
      "description": "UI/UX、界面与视觉设计：页面构建、组件与设计系统、排版配色、动效打磨。",
      "triggers": ["设计", "UI", "UX", "界面", "前端", "页面", "配色", "design", "UI polish"],
      "antiTriggers": ["纯后端逻辑", "数据库查询", "命令行工具开发"],
      "skills": ["design-system-kit", "ui-reviewer", "mobile-app-designer"]
    },
    {
      "name": "test",
      "description": "Web 应用测试：浏览器自动化、功能验证、UI 调试与截图。",
      "triggers": ["测试", "test", "Playwright", "浏览器", "E2E", "截图", "UI 验证"],
      "antiTriggers": ["编写单元测试代码", "CI 流水线配置"],
      "skills": ["e2e-browser-test"]
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `version` | number | 否 | 建议填 `1`，便于将来演进 |
| `domains` | array | ✅ | 领域列表；缺失或不是数组 → 映射无效 |
| `domains[].name` | string | ✅ | 领域名，唯一（忽略大小写）；`find-skills-for-task` 用它作参数 |
| `domains[].description` | string | 否 | 写进领域索引，帮助模型判断该不该展开 |
| `domains[].triggers` | string[] | 否 | 命中提示词，中英文都写用户会说的话；**传 `task` 时是服务端打分依据**（中文 +3 / 英文 +2），不是纯注释 |
| `domains[].antiTriggers` | string[] | 否 | 排除信号；传 `task` 时任一命中直接**否决该领域** |
| `domains[].skills` | string[] | ✅ | 成员技能名（base name 或 qualified name） |

### 5.3 三种标记方式（任选，推荐第一种）

| 方式 | 做法 | 优点 | 代价 |
| --- | --- | --- | --- |
| **配置映射（推荐）** | 在 `domains.json` 的 `skills[]` 列出技能名 | 集中管理、不改第三方技能文件；技能更新/重装不会覆盖标记 | 需要维护一份清单 |
| **SKILL.md frontmatter** | 写 `domain: design` 或 `domains: [design, test]` | 技能自描述，跨仓库搬运不丢标记 | 会修改技能文件；技能由包管理器更新时可能被覆盖 |
| **两者都用** | 同时配置 | 冗余最稳 | 要维护两处，且规则以映射为准 |

### 5.4 归属判定规则

1. 先按 `domains.json` 的 `skills[]` 认领（大小写不敏感；base / qualified 名均可）。
2. 再用 SKILL.md 的 `domain` / `domains` 兜底：只有匹配到**已声明**的域名才会生效。
3. **一个技能最终只属于一个领域**（第一个匹配到的域）。在多个域里重复列出，后续项会被警告并忽略。
4. `skills[]` 里写了不存在的技能名 → stderr 打印 warning 并忽略，**不会隐藏任何真实技能**。
5. 未被任何领域认领的技能 = 全局技能，照常全列。
6. 映射文件缺失、JSON 非法或结构错误 → **fail-open**：所有技能退回全局 + stderr 警告，**服务不会崩**。

### 5.5 领域划分建议

- **按「用户任务」划分，不按目录名划分**。目录名（`scripts/`、`styling/`）是内部结构，不是领域。
- **粒度**：一个域约 3–15 个技能；域总数尽量控制在 10 个以内——领域索引本身也占 token。
- **`triggers`**：写用户真实会说的词（「落地页」「配色」「E2E」「截图」），中英文都写；不要写文件名。
- **`antiTriggers`**：写最容易误命中的反面场景。
- **`description`**：一句话回答「什么任务该展开这个域」。
- `triggers` / `antiTriggers` **同时**是索引里的提示信号和 `find-skills-for-task(task)` 的服务端打分规则：中文按子串（+3）、英文按词边界（+2）、`description` 词提供弱证据（+1）、`antiTriggers` 命中即否决、次名需达首名 70% 才一并返回。每次打分都会在 stderr 打印 `Task skill routing: …`，可据此长期调词表。
- ⚠️ 打分是**字面匹配**，不是语义检索。避免把过泛的单词（「设计」「测试」「文档」）单独当 trigger，改用复合词（「界面设计」「E2E 用例」「README 润色」），否则容易误召回；领域总数少时无需引入 BM25 / embedding。
- 技能超过 100 个时：先分成 8–15 个域、每域 5–15 个技能；再往后才需要考虑域内检索（BM25 / top-N 中文分词）。

---

## 6. 常见维护任务

| 想做的事 | 怎么操作 |
| --- | --- |
| 新增一个全局技能 | 建目录 + `SKILL.md`，**不要**在任何领域里登记；重启客户端 |
| 新增一个领域 | 在 `domains.json` 的 `domains` 数组里加一项，填好 `name`、`description`、`skills` |
| 把技能划入某领域 | 把它的 base name 加进该域的 `skills[]`；同时从其他域移除（避免重复认领警告） |
| 把技能移回全局 | 从所有 `skills[]` 移除；若 frontmatter 有 `domain`，也要删掉该字段，否则会被兜底规则再次认领 |
| 重命名技能 | 改 frontmatter `name`，并同步更新 `domains.json` 中的名字；用 base name 登记可少改一处 |
| 停用/下线技能 | 从技能库目录移走（或删除）。只是想让它不自动出现，可用 `disable-model-invocation: true` |
| 拆分一个过大的领域 | 在 `domains.json` 里拆成两个 `name`，把 `skills[]` 分配过去；`description` / `triggers` 要随之调整 |
| 临时排查路由问题 | 设 `--domain-map=off`，确认是否回到平铺 catalog |
| 批量调整后验证 | 用 §8 的步骤跑一遍，并看启动日志里的 `domain routing:` 行 |

---

## 7. 资源清单可见性（新增技能时一并考虑）

新增的技能时常带 `scripts/`、`references/`、`assets/`、`styling/` 等任意子目录。服务端会把技能的支持文件自动列进 `resources/list` 和 SEP-2640 的 manifest；如果不加控制，一个大资产库能让清单膨胀到上千条。

这个 fork 提供**只作用于自动清单**的过滤器：

- **`blacklist`（默认）**：列出全部，排除 `assets/` 目录与几十种二进制/设计格式。
- **`whitelist`（推荐，尤其当子目录五花八门时）**：只列出允许的文本/源码/数据格式（`.md`、`.py`、`.mjs`、`.csv`、`.json`、`.html`、`.css`…），**不管它在哪个目录**；隐藏测试目录、构建产物、缓存、资产与未知格式。

两种模式都**不改变可读性**：`resources/read`、`resources/directory/read`、`skill-resource <path>` 以及 SKILL.md 里写的磁盘路径，都能照常访问被隐藏的文件。**清单里看不见 ≠ agent 用不上**——agent 拿到的是技能的绝对路径 `<location>`，可以直接按路径执行脚本或读取样式。

配置要点：

| CLI flag | 环境变量 | 用途 |
| --- | --- | --- |
| `--list-mode=whitelist` | `SKILLJACK_LIST_MODE=whitelist` | 切换到白名单模式 |
| `--allow-extensions=.md,.py,.foo` | `SKILLJACK_ALLOW_EXTENSIONS` | 白名单允许的格式 |
| `--ignore-dirs=tests,assets` | `SKILLJACK_IGNORE_DIRS` | 白名单下即使后缀合法也隐藏的目录 |
| `--exclude-dirs=assets` | `SKILLJACK_EXCLUDE_DIRS` | 黑名单模式下排除的目录 |
| `--exclude-extensions=.png,.svg` | `SKILLJACK_EXCLUDE_EXTENSIONS` | 黑名单模式下排除的后缀 |
| `--resource-filter=off` | `SKILLJACK_RESOURCE_FILTER=off` | 完全关闭过滤（上游行为，列出全部文件） |

⚠️ `--allow-extensions` / `--ignore-dirs` / `--exclude-*` 都是**替换**默认值，不是追加。自定义时请把仍需保留的项一并写全。无扩展名文件在白名单模式下会被隐藏。

---

## 8. 验证与排错

### 8.1 启动日志应该看到什么

```
Discovered <N> skill(s)
resource filter: WHITELIST — allowed extensions: 36 (.md .mdx .txt .rst ...) …
domain routing: ON — 2 domain(s) [design=4, test=2], 11 global skill(s); map: <绝对路径>
```

最后一行是领域路由的权威摘要：`ON/OFF`、各域技能数、全局技能数、实际读取的映射路径（数字仅作示例，取决于你自己的技能库）。若看到 `domain routing: OFF` 或 `... not found`，说明映射没被读到，按 §5.1 检查路径。

### 8.2 端到端验证清单

用任意 MCP 客户端或一段 JSON-RPC 脚本依次确认：

1. `initialize` → `instructions` **以 `<skill_preflight>` 开头**，含全部全局技能 + `<skill_domains>` 索引；**领域技能不出现**在 `<available_skills>` 里。
2. `tools/call find-skills-for-task {"task":"<一句真实任务>"}` → 返回 `<task_routing>`（域名/得分/命中词）+ 该领域技能条目；stderr 有 `Task skill routing: …` 记录。
3. `tools/call find-skills-for-task {"task":"<无关任务>"}` → 提示未命中并返回 `<domains>` 目录（fail-open）。
4. `tools/call find-skills-for-task`（不传参数）→ 返回所有领域及其描述；传 `domain` → 展开指定领域；未知域名应报错。
5. `tools/call load-skill {"name":"<qualified name>"}` → 领域技能仍能正常加载全文（**可达性不变量**）。
6. `resources/list` → 数量合理；`assets/` 等资产默认不在清单里，但 `resources/read` 能读到。
7. stderr 无 `SEP-2640` 超限警告、无 `skill "<x>" not found` 警告；stdout 全部是合法 JSON-RPC（stdio 模式下不能混入日志）。

### 8.3 常见问题

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 新技能完全没出现 | 不是根目录的直接子目录 / 缺 `SKILL.md` / frontmatter 缺 `name` 或 `description` / 是符号链接 | 按 §3.1–3.2 逐项检查 |
| 技能一直显示为全局 | 没进任何 `skills[]`，frontmatter 也没有 `domain` | 按 §5 补标记 |
| 改了 `domains.json` 但主 catalog 没变 | stdio 下 `instructions` 启动时冻结 | 重启客户端 / 重连 MCP（§4） |
| `find-skills-for-task` 返回 “not active” | 映射缺失/非法触发了 fail-open，或设了 `off` | 看 stderr 警告，修正 JSON 或路径 |
| 传 `task` 总是未命中 | 触发词太泛或太窄、任务说法与词表不一致 | 看 stderr 的 `Task skill routing:` 打分明细，按 §5.5 调整 `triggers`；临时可改传 `domain` |
| 模型仍然不主动调用工具 | 客户端把 MCP `instructions` 放在低权重区，或完全不展示 | 确认 `tools/list` 中 `find-skills-for-task` 的描述含 `<skill_domains>` 与全部域名；握手文本含 `<skill_preflight>`；必要时在宿主常驻规则里重申同一句契约，或换用支持 MCP Skills Extension 的宿主 |
| 日志出现 `skill "X" not found (ignored)` | `skills[]` 里名字写错，或该技能未被发现 | 用 base name 核对拼写 |
| 日志出现 `already assigned to another domain` | 同一技能被多个域认领 | 只保留一个域的登记 |
| 某个 `.md` 没出现在资源清单 | 它在 `assets/` 或其他被忽略的目录里 | 白名单下调整 `--ignore-dirs`；或用 `resources/directory/read` 直接浏览（清单隐藏不影响读取） |
| 技能数上百后 token 仍然很高 | 全局技能太多 | 把更多技能划入领域；全局只留真正通用的 |

---

## 9. 配置参考

所有 `=<value>` 形式的参数**必须带等号**，否则值会被当成技能目录。

| CLI flag | 环境变量 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `--domain-map=<path>` | `SKILLJACK_DOMAIN_MAP` | 工作目录下的 `domains.json`（存在时） | 领域映射文件 |
| `--domain-map=off` | `SKILLJACK_DOMAIN_MAP=off` | — | 关闭路由，回到平铺 catalog |
| `--catalog=instructions` | `SKILLJACK_CATALOG` | `instructions` | 领域路由需要此模式（默认即是） |
| `--list-mode=whitelist` | `SKILLJACK_LIST_MODE` | `blacklist` | 自动清单过滤模式 |
| `--allow-extensions=...` | `SKILLJACK_ALLOW_EXTENSIONS` | 文本/源码/数据格式 | 白名单允许的后缀（替换） |
| `--ignore-dirs=...` | `SKILLJACK_IGNORE_DIRS` | 测试/构建/缓存/资产目录 | 白名单忽略的目录（替换） |
| `--exclude-dirs=...` | `SKILLJACK_EXCLUDE_DIRS` | `assets` | 黑名单排除的目录（替换） |
| `--exclude-extensions=...` | `SKILLJACK_EXCLUDE_EXTENSIONS` | 56 种二进制类型 | 黑名单排除的后缀（替换） |
| `--resource-filter=off` | `SKILLJACK_RESOURCE_FILTER=off` | on | 完全关闭清单过滤 |
| `--tools=<auto\|always\|never>` | `SKILLJACK_TOOLS` | `auto` | 控制 `load-skill` / `skill-resource` 的可见性 |
| `--ui-tools=<on\|off>` | `SKILLJACK_UI_TOOLS` | `off` | 恢复已弃用的上游 `skill-config-*` / `skill-display-*` 工具、UI prompts 与 `ui://` 资源（默认全部不注册） |

> **上游 UI 工具已弃用**：默认的 `tools/list` 只有 `load-skill`、`skill-resource`、`find-skills-for-task` 三个。若某个宿主确实能渲染 MCP Apps，用 `--ui-tools=on` 一次性恢复整套界面；不要在 `domains.json` 或技能 frontmatter 里引用 `skill-display-update-invocation`，它默认不存在。配置文件读取（`~/.skilljack/config.json`）不受影响。

标准 MCP 客户端配置示例（以 stdio 传输为例，路径换成你自己的）：

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

> 如果你用某个配置管理器统一分发 MCP 配置到多个客户端，请通过**该管理器自己的命令**修改并同步配置，不要长期手改单一客户端的配置文件——否则下次同步会被覆盖。

---

## 10. 不变量速查

- 路由只重塑「模型看到的目录」，**不移除任何技能的可达性**。
- 没有领域的技能 = 全局技能，按上游方式全列。
- 一个技能只归一个领域；重复登记以第一个为准。
- 清单过滤（白名单/黑名单）只影响自动枚举，**显式读取与磁盘路径执行始终可用**。
- 领域映射失效时 **fail-open**：全部技能退回全局，服务照常运行。
- 领域索引的 token 成本是 **O(领域数)**，不是 O(技能数)——这是它能扩展到 100+ 技能的关键。
- `triggers` / `antiTriggers` 既是索引里的提示，也是 `find-skills-for-task(task)` 的**服务端打分规则**；打分只影响「推荐展开哪个域」，**不移除任何技能的可达性**，未命中时 fail-open。
- `<skill_preflight>` 只在领域路由生效时注入；路由关闭后 `instructions` 与上游一致。
- stdio 下 `instructions` 启动时冻结；改配置后**重启客户端**才能看到一致的主 catalog。

---

## 附：Web 控制台（可视化维护）

手改 `domains.json` 容易出错，仓库附一个独立的本地 Web 控制台，覆盖本文 §4–§6 的全部日常操作：

```bash
npm run domains-ui
# 或显式指定路径：
npm run domains-ui -- --skills-dir=<SKILLS_DIR> --domain-map=<REPO_ROOT>/domains.json --port=5178
```

启动后打开 `http://127.0.0.1:5178`。路径也可在界面「路径设置」里修改，点「保存并应用」会写入 `~/.skilljack/config.json`（目录 / 文件不存在时自动创建，带时间戳备份与原子写），下次启动自动读取；可用 `--admin-config=` / `SKILLJACK_ADMIN_CONFIG` 改存储位置，启动参数与环境变量仍优先。该文件与 MCP server 共用 `skillDirectories[0]`，控制台另用私有键 `skilljackAdmin` 记录映射路径。注意顶栏「保存更改 / 重置」只作用于领域分配草稿（`domains.json`），不负责保存路径。

- **查看 / 搜索**：技能表实时过滤名称、描述、路径、领域；点「详情」看 frontmatter、SKILL.md 全文、资源统计。符号链接、缺 `SKILL.md`、frontmatter 不合法的技能会标红提示，不会被悄悄忽略。
- **三类技能一目了然**：每一行按「当前分类」着色区分——**全局**（主 catalog 全量列出）、**领域**（按需展开）、**用户命令**（SKILL.md 标了 `disable-model-invocation: true`，只能由用户手动 `/命令` 触发，模型不自动发现，也不参与领域路由）。顶栏 KPI 分别给出三类数量。**用户命令这一类不可分配领域**：复选框被禁用，批量操作也不会选中它；若 `domains.json` 里误写了这类技能，校验与扫描会给出专门的提示（区别于「目录不存在」），建议直接从映射移除。
- **批量配置领域**：多选技能 → 一键移入某领域 / 新建领域 / 移回全局。分配是「移动」语义，自动从原领域移除，符合服务端一技能只归一域的规则。
- **领域维护**：增删改领域，编辑 `description` / `triggers` / `antiTriggers`，移除单个成员。
- **成本预览**：实时估算主 catalog 的字节数 / tokens 及相对全平铺的节省比例，包含未保存改动。
- **frontmatter 陷阱提示**：技能若仍在 SKILL.md 里写了 `domain`，仅从映射移除并不会让它变全局，界面会明确标注来源。

写入前做结构校验（域名重复、`skills` 非数组、同一技能跨多域一律拒绝），然后**原子写**并自动留时间戳备份（保留最近 5 份）；未安装的技能名只报警告不阻断，便于维护跨机器通用的映射。服务默认只监听 `127.0.0.1`，且**只写领域映射文件，不改技能库**。

注意：界面扫描的是你配置的技能库目录，服务端自带的 bundled 技能不在其中；保存映射后，运行中的 MCP 客户端仍需**重启 / 重连**才能看到新 catalog（stdio 下 `instructions` 启动时冻结）。
