# CSV Equalizer（中文说明）

一个基于 `React + TypeScript + Vite` 的参数均衡（Parametric EQ）曲线编辑器。  
你可以导入基线 EQ CSV，在图表中以 Q3 风格编辑频段，并实时监听音频效果，然后导出结果曲线或保存工程。

## 主要功能

- 导入基线曲线：支持导入 `CSV`（频率/增益曲线）。
- 图表交互编辑：在图表中创建、选择、拖拽、修改、删除频段。
- 频段类型支持：峰值、低架、高架等常见参数均衡类型。
- 频段旁路：可对单个 Band 进行 bypass。
- 监听面板（Monitor）：
  - 上传本地音频并播放；
  - `Baseline monitor` / `Monitor bypass` 开关；
  - 监听状态与错误提示。
- Pre-Gain：支持自动/手动预增益，降低削波风险。
- 导出与保存：
  - 导出输出曲线 CSV；
  - 保存工程预设为 `.heq.json`。

## 技术栈

- `React 19`
- `TypeScript`
- `Vite`
- `Vitest` + `Testing Library`
- `ESLint`

## 环境要求

- `Node.js 18+`（建议使用 LTS）
- `npm 9+`

## 快速开始

```bash
npm install
npm run dev
```

开发服务器默认地址通常为：`http://localhost:5173`

## 常用命令

```bash
# 启动开发环境
npm run dev

# 生产构建
npm run build

# 本地预览构建结果
npm run preview

# 运行测试
npm run test

# 代码检查
npm run lint
```

## 基本使用流程

1. 点击 `Import EQ CSV` 导入基线曲线。
2. 在中间图表区域进行 Band 编辑（增删改、拖拽、旁路等）。
3. 在左侧 `Monitor` 上传音频并试听。
4. 根据峰值与 Pre-Gain 状态调整参数，避免输出削波。
5. 点击 `Export output` 导出结果曲线 CSV，或点击 `Save preset` 保存工程。

## 快捷键

- `Ctrl/Cmd + S`：保存 preset
- `Delete/Backspace`：删除当前选中的 Band（输入框聚焦时不会触发）

## 项目结构（简要）

```text
src/
  components/      # 图表与 UI 组件
  lib/             # EQ 计算、CSV 解析、音频监听等核心逻辑
  state.tsx        # 全局编辑状态与 reducer
  App.tsx          # 主界面入口
```

## 测试

```bash
npm run test -- --run
```

## 说明

- 监听功能依赖浏览器 `Web Audio` 能力，不同浏览器表现可能略有差异。
- 文件保存会优先使用浏览器文件系统 API（若可用）。
