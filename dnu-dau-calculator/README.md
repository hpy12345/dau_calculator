# 📊 DNU-DAU 数据看板

> 基于 Flask + NumPy + Chart.js 的 DAU（日活跃用户）预测与可视化分析工具

## 项目简介

DNU-DAU 数据看板是一个面向产品运营与数据分析场景的轻量级 Web 应用。用户输入 **DNU（日新增用户）** 和 **留存率** 数据，系统通过离散卷积运算自动计算并可视化 **DAU（日活跃用户）** 趋势曲线。

项目采用前后端一体化架构（Flask 服务端渲染 + 原生 JS 前端），无需 Node.js 构建工具链，开箱即用。支持多标签页（按地区/渠道分组）数据管理与全局汇总分析，同时提供 Excel 批量导入能力。

### 核心算法

```
DAU(t) = Σ DNU(i) × Retention(t - i)    其中 i 从第 1 天到第 t 天
```

即第 *t* 天的日活 = 历史每一天的新增用户数 × 对应天数后的留存率之和。这在数学上等价于 DNU 序列与留存率序列的**离散卷积**（Convolution），后端使用 NumPy `np.convolve` 高效实现。

## 功能特性

- **项目管理** — 创建、保存、删除项目，数据持久化到 JSON 文件
- **多标签页** — 按地区/渠道（如北美、欧洲、日韩）分组管理数据，支持动态增删
- **DAU 卷积计算** — 基于 NumPy 向量化卷积，秒级完成百天级数据预测
- **全局汇总** — 自动累加所有标签页的 DNU/DAU，生成总览曲线
- **Excel 批量导入** — 前端 SheetJS 解析 `.xlsx` / `.xls` / `.csv`，无需后端参与
- **交互式图表** — Chart.js 4.x 折线图，支持悬停 Tooltip、缩放、自适应
- **原子写入** — 存储层采用「临时文件 + rename」原子操作，防止数据损坏
- **响应式布局** — 蓝白商务风格，适配桌面与移动端

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| **后端框架** | Flask 3.1 | 应用工厂模式 + Blueprint 路由 |
| **计算引擎** | NumPy 2.2 | 离散卷积 `np.convolve` 向量化运算 |
| **数据对齐** | Pandas 2.2 | 多标签页 DNU/DAU 按天数自动对齐求和 |
| **前端渲染** | 原生 JS (ES5) | IIFE 模块化，零框架依赖 |
| **图表库** | Chart.js 4.4 (CDN) | 折线图可视化 |
| **Excel 解析** | SheetJS / xlsx 0.18 (CDN) | 纯前端文件解析 |
| **模板引擎** | Jinja2 | 服务端直出页面 |
| **存储** | JSON 文件系统 | 原子写入，无需数据库 |
| **WSGI 服务器** | Gunicorn 23 | 生产环境部署 |

## 环境依赖

- **Python** ≥ 3.9
- **操作系统** — Windows / macOS / Linux 均可
- **现代浏览器** — Chrome / Edge / Firefox / Safari（需支持 ES5 + Fetch API）

## 安装与运行步骤

### 1. 克隆项目

```bash
git clone <repository-url>
cd dnu-dau-calculator
```

### 2. 创建虚拟环境（推荐）

```bash
# Windows
python -m venv venv
venv\Scripts\activate

# macOS / Linux
python3 -m venv venv
source venv/bin/activate
```

### 3. 安装依赖

```bash
pip install -r requirements.txt
```

### 4. 启动开发服务器

```bash
python run.py
```

启动后访问 [http://localhost:5000](http://localhost:5000) 即可使用。

### 5. 生产环境部署（Gunicorn）

```bash
# 设置环境变量
export FLASK_ENV=production
export SECRET_KEY="your-strong-secret-key-here"

# 启动 Gunicorn
gunicorn -w 4 -b 0.0.0.0:5000 "app:create_app('production')"
```

## 项目目录结构

```
dnu-dau-calculator/
├── app/                          # 应用主包
│   ├── __init__.py               # Flask 应用工厂
│   ├── config.py                 # 分层配置（开发/生产）
│   ├── routes.py                 # 路由与 API 接口
│   ├── core/                     # 核心业务逻辑
│   │   ├── __init__.py           # 包初始化
│   │   ├── calculator.py         # DAU 卷积计算引擎
│   │   └── storage.py            # JSON 文件存储引擎
│   ├── static/                   # 静态资源
│   │   ├── css/style.css         # 全局样式表
│   │   └── js/
│   │       ├── main.js           # 工具函数与全局命名空间
│   │       ├── excel_parser.js   # SheetJS Excel 解析模块
│   │       ├── chart_render.js   # Chart.js 图表渲染模块
│   │       └── workspace.js      # 工作区交互逻辑
│   └── templates/                # Jinja2 模板
│       ├── base.html             # 基础布局模板
│       ├── index.html            # 首页（项目管理）
│       └── workspace.html        # 工作区（数据输入与图表）
├── data/                         # 运行时数据目录（自动生成）
│   └── projects/                 # 项目 JSON 文件
├── requirements.txt              # Python 依赖清单
├── run.py                        # 开发环境启动入口
├── .gitignore
└── README.md
```

## 使用说明

### 创建项目

1. 打开首页，在输入框中输入项目名称
2. 点击「➕ 新建项目」或按回车键，自动跳转到工作区

### 数据输入

工作区默认提供「北美」标签页，每个标签页包含两组数据表格：

| 数据类型 | 格式要求 | 示例 |
|----------|----------|------|
| **DNU 数据** | 天数 → 新增用户数 | 第 1 天 → 1500 |
| **留存率数据** | 天数 → 留存率（小数） | 第 1 天 → 0.45（即 45%） |

**三种输入方式：**

1. **手动输入** — 直接在表格中填写天数和数值，点击「➕ 添加行」可增加行
2. **Excel 导入** — 点击「📁 上传 Excel」，选择 `.xlsx` / `.xls` / `.csv` 文件
   - 文件格式：第一列为天数，第二列为数值，第一行为表头（自动跳过）
   - 留存率数据若值 > 1 会自动转换为小数（如 45 → 0.45）
3. **多标签页** — 点击标签栏「+」按钮添加新标签（如欧洲、日韩），按渠道分组管理

### 计算与可视化

1. 点击底部「🚀 开始计算」按钮
2. 系统自动执行卷积运算，渲染当前标签页的 **DNU 与 DAU 对比曲线**
3. 同时计算所有标签页的全局汇总，渲染 **DNU/DAU 累加总和曲线**
4. 图表支持悬停查看精确数值，Y 轴自动进行 K/M 单位缩写

### 保存项目

点击顶部「💾 保存项目」按钮，所有标签页数据将持久化到 JSON 文件，下次打开项目时自动恢复。

### Excel 文件格式示例

```
| Day | Value  |
|-----|--------|
|  1  | 1500   |
|  2  | 1800   |
|  3  | 2100   |
| ... | ...    |
```

## API 接口文档

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 首页（项目列表） |
| `GET` | `/workspace/<project_id>` | 工作区页面 |
| `POST` | `/api/project/create` | 创建项目，Body: `{"project_name": "..."}` |
| `GET` | `/api/project/<id>` | 获取项目完整数据 |
| `POST` | `/api/project/save` | 保存项目数据 |
| `DELETE` | `/api/project/<id>` | 删除项目 |
| `POST` | `/api/calculate/dau` | 计算单标签 DAU，Body: `{"dnu_data": [...], "retention_data": [...]}` |
| `POST` | `/api/calculate/total` | 计算全局汇总，Body: `{"tabs": [...]}` |

所有 API 响应均为 JSON 格式，包含 `success` 布尔字段和 `message` 提示信息。

## 贡献指南

欢迎提交 Issue 和 Pull Request！请遵循以下规范：

1. **Fork** 本仓库并创建特性分支
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **代码规范**
   - Python 遵循 [PEP 8](https://peps.python.org/pep-0008/) 风格
   - JavaScript 保持 ES5 IIFE 模块化风格，所有业务逻辑挂载在 `window.IAA` 命名空间下
   - 新增函数需添加 JSDoc / docstring 注释

3. **提交规范** — 使用语义化提交信息
   ```
   feat: 新增功能描述
   fix: 修复问题描述
   refactor: 重构说明
   docs: 文档更新
   chore: 构建/依赖维护
   ```

4. **测试** — 确保改动后应用可正常启动且核心计算逻辑无误

5. **提交 PR** — 描述清楚改动内容与动机，关联相关 Issue

---

<p align="center">DNU-DAU Calculator &copy; 2025 | Powered by Flask + NumPy + Chart.js</p>
