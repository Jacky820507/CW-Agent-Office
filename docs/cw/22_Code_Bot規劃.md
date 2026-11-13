# 22 Code Bot 規劃：Claude × Codex 多工協作控制台

> 狀態：P1–P5 全部實作完成（2026-11-12），**尚未 commit、尚未在真實 app 驗收，Rust 尚未編譯**
> 基準版本：`origin/main` 8e34c30（v0.7.7 之後）
> 參考：使用者提供的「Code Bot Terminal」儀表板截圖；`docs/cw/03`、`06`、`17`

## 隔天先看：一頁摘要

**做好了什麼**
- **Code Bot 分頁**：一鍵建立 Claude × Codex 協作組，用 `@` 指派工作，agent 會互相轉派，回覆顯示在同一條對話串。
- **儀表板**：顯示執行中的 agent 數、轉派流向，以及 CPU、記憶體、GPU。
- **互派上限**：預設 6 次，可調整，也可以手動暫停。
- **協作前置檢查**：一鍵安裝或更新所需工具。
- 其他：失敗重試、中斷 agent、篩選與搜尋、整串匯出、對話存檔（localStorage 加 SQLite）。

**已驗證**

| 項目 | 結果 |
|---|---|
| 前端 `npm run typecheck`（含 vite build） | 通過 |
| 前端單元測試 | 18／18 |
| ESLint（Code Bot 相關檔案） | 0 問題 |
| `tools/gto` 測試 | 354 通過；5 失敗為既有 roles 問題，非本次造成 |
| `cargo fmt --all -- --check`（全 workspace） | 通過 |
| 瀏覽器實測（假資料預覽頁） | 主要互動正常 |
| 靜態審查 | 五輪：Rust 四輪、前後端整體一輪 |

**尚未驗證（需要你）**
1. **Rust 能否編譯**：本機沒有 MSVC，公司也擋安裝。請在有 Build Tools 的機器上跑 `cargo check --workspace`，或推上 GitHub 讓 CI 跑。
2. **真實 app 完整跑一次**：
   - 打開 Code Bot，前置檢查應全部通過，沒過就照提示按「安裝／更新」。
   - 送出 `@claude 列出頂層目錄`，Claude 應自動啟動，並把回覆貼回對話串。
   - 送出 `@claude 在 README 加一行說明，寫完請 @codex review`，應看到 Claude → Codex 的轉派膠囊與 Codex 的回報。
   - 按暫停後再請 agent 轉派，應被擋下。
3. **commit**：依專案規則要你同意才 commit，所以目前全部改動都還在工作區，沒有 commit。本機 `main` 與 `origin/main` 都在 `9c40266`。更新專案時接上的那筆清理 commit 已經出現在遠端，但不是這個 session 推上去的，推測是其他工具同步的。

## 0. 使用說明（先看這段）

1. 左側導覽列點 **Code Bot**，第一次會看到「建立 Claude × Codex 協作組」，按下去。也可以從 Agent 畫布右上角按。
2. 在底部輸入框打字，用 `@` 指定對象，打 `@` 會跳出選單，方向鍵加 Enter 選取。
   - `@claude 幫我…`：只送給 Claude。
   - `@claude 實作 X，寫完請 @codex review`：送給 Claude，由 Claude 轉派給 Codex。開頭的 @ 是收件者，句中的 @ 是指示。
   - `@all …`：兩個都送。
   - 沒寫 @：送給上一次的對象。
3. Agent 沒開也沒關係，送出時會自動啟動。訊息下方會顯示每位收件者的狀態：啟動中、傳送中、已送達、失敗。失敗時可以按「重試」。
4. Agent 完成後會在對話串回覆。如果超過一分鐘它閒置了卻沒回覆，訊息下方會提示你「開啟終端」去看。
5. **先看頂部的「檢查通過／N 項待處理」**。點開後會列出 4 項：gto 指令已安裝、Claude 與 Codex 各自的 gto 協作技能、協作組成員齊全。沒過的項目旁邊有「安裝」或「補回成員」可以一鍵處理，處理完會自動重新檢查。任何一項沒過，agent 都可能無法轉派或回報。
6. 頂部列，由左到右：
   - 成員卡：點名字可以快速插入 @。工作中會出現 ■ 停止鍵，等同在終端按 Esc；離線時是 ▶ 啟動鍵；在線時可以開終端。
   - ⚡ 圖示：顯示或隱藏儀表板。
   - 複製圖示：把整串對話複製成 Markdown。
   - 「互派 n/6」：點一下可以暫停或恢復 agent 互相轉派。
   - 🗑：清除對話串。
7. 互派滿 6 次會自動暫停並出現橫幅，按「繼續協作」就會繼續。你每送出一則新訊息，計數會歸零。上限可以在儀表板「本輪互派」那格用 −／＋ 調整（1–20）。

## 1. 目標

做一個「Code Bot」控制台，讓使用者在**一個畫面**裡：

1. 看到所有 Claude / Codex agent 的即時狀態（執行中、閒置、等待、卡住），一鍵啟動／停止／重開。
2. 在**一條共用對話串**用 `@claude`、`@codex` 下指令。
3. 讓 Claude 和 Codex **互相 @ 對方**轉派任務、回報結果，使用者全程看得到、隨時能插話或喊停。
4. 看到協作流向（誰派給誰）與本機資源（CPU、記憶體、GPU）。

成功標準：使用者在 Code Bot 畫面輸入「@claude 實作 X，寫完 @codex 幫忙 review」，不必切到終端，就能看到 Claude 做完、自動轉給 Codex、Codex 回報的整段過程。

## 2. 關鍵決策

### 2.1 互相 @ 的機制：Agent 主動呼叫工具，UI 呈現成 @ 對話

選定：**Agent 透過既有 MCP 工具 `gto_dispatch_task`（或 `gto send`）主動轉派，UI 把它渲染成「Claude @Codex：…」的對話泡泡**。不採用「app 用正則掃 agent 輸出裡的 `@codex` 自動派工」。

理由（以使用體驗為準）：

- **不會誤觸**：agent 在說明裡隨口提到「@codex」不會被當成指令；只有真的呼叫工具才算轉派。
- **使用者看起來一樣直觀**：對話串裡就是 `@Codex` 泡泡，跟聊天軟體一樣。
- **結果有結構**：工具呼叫帶 task_id、thread，回報能精準掛回原任務，不靠猜。
- 與 `docs/cw/17` §6.3「不由 app 自動派工、由 agent 主動呼叫」的既有方向一致。

補上兩個讓它「順手」的設計：

- **協作提示自動注入**：啟動 Code Bot 組的 agent 時，注入「你的夥伴是 Codex（`@codex`），需要 review／第二意見／平行實作時用 `gto_dispatch_task` 交給它；完成時用 `gto_report_status` 回報」。沿用 `crates/gt-agent/src/collaboration.rs` 的 `build_collaboration_context`，加上 Code Bot 專用段落。
- **防無限乒乓**：每條任務串記錄轉派次數，超過上限（預設 6 次）自動暫停，並在 UI 顯示「已暫停自動協作，繼續？」。另有全域「暫停協作」開關。

### 2.2 使用者的 @：共用對話串的輸入框

- 輸入框支援 `@claude`、`@codex`、`@all`，打 `@` 跳出補全清單（沿用 `useShellTaskMentionController.ts` 的補全 UI 模式，但候選從檔案換成 agent）。
- 沒有 @ 時，預設送給上次對話的 agent。
- 使用者訊息走「人類發送者」路徑，不受 agent-to-agent 的 edge 檢查限制（`authorize_agent_communication` 的註解已寫明人類訊息在進 gate 前處理）。

### 2.3 預建雙向連線

建立 Code Bot 組時，自動：

1. 在目前 workspace 建立（或沿用）一個 Claude agent、一個 Codex agent。
2. 用既有 `agent_canvas_create_authored_link` 建立兩者之間的 authored 連線。依 `docs/cw/06`，authored 連線不分方向，一條就涵蓋雙向；實作時要用測試確認 `has_edge(A,B)` 與 `has_edge(B,A)` 都成立。
3. 把兩者的 policy `allow_gto_send` 設為 true。

做成冪等：重複按「建立協作組」不會產生重複 agent 或重複連線。

## 3. 現有可重用元件

| 需求 | 既有實作 |
|---|---|
| 啟動 Claude/Codex PTY | `commands/tool_adapter/tool_profiles.rs` 的 `tool_launch`、`task_service.register_runtime` |
| 注入輸入 | `write_terminal_with_submit`（`commands/task_center/mod.rs`） |
| 派工與權限 | `local_bridge.rs` 的 `dispatch_batch`、`crates/gt-agent/src/communication.rs` 的 `authorize_agent_communication` |
| 轉派 MCP 工具 | `tools/gto-agent-mcp-sidecar`：`gto_dispatch_task`、`gto_report_status`、`gto_handover`、`gto_list_messages` |
| 協作提示 | `crates/gt-agent/src/collaboration.rs` 的 `build_collaboration_context` |
| 即時狀態 | `crates/gt-task/src/runtime_activity.rs` 的 `agent_runtime_status`（v0.7.7 新增）、前端 `features/terminal/agent-execution-state.ts` |
| 擷取 agent 回覆文字 | `crates/gt-session-log`（讀 Claude/Codex 的 JSONL） |
| 對話泡泡 UI | `features/tool-adapter` 的 `ChannelMessageList`、`ChannelMessageBubble` |
| 協作流向圖 | `components/graph-canvas/GraphCanvas.tsx`、agent-canvas 的 derived 連線 |
| 事件 | `task/dispatch_progress`、`channel/message`、`channel/ack`、`terminal/state_changed` |

## 4. 新增模組與檔案歸屬

依專案規則，前後端 feature 對齊：

- 前端：`apps/desktop-web/src/features/code-bot/`
  - `CodeBotPane.tsx`（主畫面）、`components/`（狀態卡、對話串、流向圖、資源卡）、`controllers/`、`model/`、`styles/`（SCSS）
  - 文字放進 `shell/i18n/messages.ts`
  - `shell/layout/navigation-model.ts` 新增 `'code-bot'` 分頁
- 後端：`apps/desktop-tauri/src-tauri/src/commands/code_bot/`（只做入口綁定）
  - 業務邏輯放 `crates/gt-task`（對話串、轉派次數）或新 crate `gt-codebot`（若超過一個檔案的量再拆）
- 資源監控：放在既有 infra 模組 `commands/system.rs` 旁的 `system/` 子模組，業務邏輯可 mock。

## 5. 分階段實作

每階段都是可單獨驗收的最小閉環。

### P1 協作組與雙向連線（後端為主）

- 新增 command `code_bot_ensure_team(workspace_id)`：冪等建立 Claude、Codex agent，建立 authored 連線，開啟 `allow_gto_send`，回傳兩個 agent id。
- 協作提示：在 `build_collaboration_context` 加入 Code Bot 段落（夥伴名稱、何時轉派、怎麼回報）。
- 驗證：
  - `cargo test -p gt-agent`、`-p gt-storage`：連線雙向成立、重複呼叫不重複建立。
  - 手動：在 Agent Canvas 看得到兩個 agent 與連線，在 Claude 終端執行 `gto send` 給 Codex 成功。

#### P1 實作紀錄（2026-11-12）

- 狀態：程式已寫完，前端已驗證，Rust 尚未編譯驗證（本機沒有 MSVC Build Tools，`cargo` 找不到 `link.exe`）。
- 後端：
  - `crates/gt-agent/src/code_bot.rs` 的 `ensure_code_bot_team`：固定 id `codebot-claude`、`codebot-codex`，工作目錄是 workspace 根目錄（`.`）。只有新建立的 agent 才會設定初始畫布座標。若 `allow_gto_send` 被關掉會補回開啟。授權用的 authored 連線只建一條，因為它本身不分方向；另把 bidirectional 設為 true，讓畫布顯示雙箭頭。
  - `apps/desktop-tauri/src-tauri/src/commands/code_bot/mod.rs` 的 `code_bot_ensure_team`：有新建 agent 時，會刷新 gto directory 快照。
  - `crates/gt-agent/src/collaboration.rs`：協作提示加了一段，說明使用者在指令裡寫 `@<name>` 或 `@<tool>`，代表明確要求把那部分轉派給該夥伴。
- 前端：
  - Agent Canvas 右上角新增「建立 Claude × Codex 協作組」按鈕。畫布還沒有任何 agent 時，空白畫面也會顯示同一個大按鈕。
  - 建立完成後，兩個 agent 直接放上畫布，Station 清單同步重新載入，按鈕旁顯示 4 秒的結果提示。
- 測試：`crates/gt-storage/tests/code_bot_team_tests.rs` 有 4 個測試：雙向授權、重複呼叫不重複建立、改名保留且權限與連線會被修復、不同 workspace 各自一組。
- 驗證結果：
  - `npm run typecheck`（含 vite build）：通過。
  - `rustfmt --check`：通過。
  - `cargo test -p gt-agent -p gt-storage`：無法執行，原因是缺 MSVC linker，需要先安裝 Visual Studio Build Tools（勾選「使用 C++ 的桌面開發」）。
  - 前端 `test:unit` 套件本身就編譯不過：舊測試仍引用已移除的 roles 子系統（`roleId`、`AgentRole`），跟這次改動無關。
- 待人工驗收：在 app 裡按下按鈕後，畫布要出現兩個 agent 和雙箭頭連線。分別啟動兩個 agent 後，在 Claude 輸入「請 @codex 列出頂層目錄」，確認 Codex 終端有收到派工。另外要確認 Codex 有掛上 `gto-agent-bridge` MCP。

#### P2–P4 實作紀錄（2026-11-12 晚間）

做法調整（跟原規劃不同處）：

- **agent 回覆怎麼進對話串**：後端原本只為 agent 對 agent 的派工擷取回覆，人類派工完全沒有。我沒有改後端擷取，而是在每則 Code Bot 訊息末尾附一段指示，請 agent 完成後執行 `gto agent reply-status --target-agent-id <自己>` 回報。
  - 這樣可行的原因：發給自己的 status 不需要畫布連線，只會被儲存並推送事件，不會打進終端。
  - 唯一需要的後端改動：`local_bridge.rs` 的 `record_derived_links` 略過自己發給自己的訊息，避免畫布出現自己連到自己的線。
- **收件者規則**：開頭的 @ 決定收件者，句中的 @ 只是指示。例如「@claude 實作 X，寫完 @codex review」只送給 Claude，再由 Claude 轉派。沒有開頭 @ 時，句中所有 @ 都算收件者。都沒有就沿用上次的收件者，再不行就送給 Claude。
- **人類訊息存放位置**：存在 localStorage，每個 workspace 最多 200 則。後端的 channel 存放區只在記憶體、最多 512 筆，而且本來就不含人類輸入的內文。
- **資源監控沒有新增依賴**：依 `docs/DEPENDENCIES.md` 的核准規定，不加 `sysinfo`。
  - Windows 用 kernel32 的 `GetSystemTimes`／`GlobalMemoryStatusEx`（FFI，不需套件）。
  - Linux 讀 `/proc/stat`、`/proc/meminfo`。
  - GPU 用 `nvidia-smi`，失敗一次後就不再嘗試，結果快取 2 秒。
  - macOS 原本不支援，同晚稍後已補上記憶體與 CPU，見下方 P5 段落。

新增與修改：

- 前端 `features/code-bot/`：
  - `CodeBotPane`：主畫面，包含成員狀態、對話串、可用 @ 補全的輸入框。
  - `components/CodeBotDashboard`：可收合的儀表板，有 KPI、協作流向動畫、CPU／記憶體／GPU／顯示記憶體卡片。
  - `controllers/useCodeBot`。
  - `model/`：mentions、thread、dashboard。
  - 新增導覽分頁 `code-bot`，涉及 navigation-model、ShellRootView、ActivityRail、icons、i18n。
  - 對話串顯示四類內容：你的訊息（含每位收件者的送達狀態）、agent 互相轉派（虛線膠囊）、agent 回覆（Markdown）、交接。
  - 離線的 agent 會先自動啟動 CLI，等它上線、再等 4 秒才送出。
- P3 迴圈防護：
  - `crates/gt-task/src/collaboration_guard.rs`，含 4 個單元測試。
  - 每次你送出訊息，agent 互派計數歸零。互派超過 6 次，或你手動暫停時，bridge 會拒絕 agent 的派工，回傳 `AGENT_COLLAB_HOP_LIMIT`／`AGENT_COLLAB_PAUSED`，訊息裡直接告訴 agent 停止轉派、改為回報。
  - UI 有「互派 n/6」開關可暫停或恢復；達到上限時顯示橫幅，按「繼續協作」可重置計數。
- 後端新增 command：`code_bot_collaboration_state`、`code_bot_set_collaboration_paused`、`system_metrics_snapshot`。新增事件：`code_bot/collaboration_guard`。都已補進 `docs/API_CONTRACTS.md`。

驗證：

- `npm run typecheck`（含 vite build）：通過。
- 前端單元測試 `tests/code-bot-mentions.test.ts`、`tests/code-bot-thread.test.ts`：8/8 通過。因為整個測試套件本來就編譯不過，這兩檔是單獨挑出來跑的。
- 新寫或修改的 Rust 檔都通過 `rustfmt --check`。
- **Rust 尚未編譯驗證**：本機沒有 MSVC，公司也擋安裝，所以 `collaboration_guard`、`system_metrics` 的單元測試還沒跑過。
- **尚未在真實 app 內手動測試**，待驗收項目：
  1. Code Bot 分頁按「建立協作組」。
  2. 輸入「@claude 列出頂層目錄」，確認 Claude 自動啟動並收到訊息，完成後回覆出現在對話串。
  3. 試「@claude …寫完 @codex review」，確認對話串出現轉派膠囊與 Codex 的回報。
  4. 按暫停後再請 agent 轉派，確認被拒。
  5. 儀表板的 CPU／記憶體數字與工作管理員接近。

已知限制：

- 自動啟動依賴 `launchStationCliAgent`，等待上線最多 30 秒，之後固定再等 4 秒。CLI 啟動特別慢時，訊息可能在提示列出現前就送出。
- agent 會不會乖乖回報，取決於 agent 有沒有照附加的指示做，需要實測後調整措辭。
- Code Bot 派工沿用 shell 的 `dispatchTaskBatch`，所以會繼承任務中心「不附加輸出收集指示」開關的狀態。協作組的 agent 預設沒開輸出收集，因此目前沒有實際影響。
- 派工後的 `submitStationTerminal` 用的是 shell 的 active workspace，Code Bot 用的是 presented workspace。兩者只在切換 workspace 的過渡瞬間可能不同，極少碰到，目前不處理。
- 迴圈防護依據呼叫端自己帶的 `sender.type` 判斷。`gto` CLI 只要知道自己的 agent id，就會標示為 agent，所以正常情況下有效。但 bridge 不會再依 token 驗證發送者身分，這是既有的信任模型。若要把這道防護當成安全閘門，需要在 bridge 端依連線來源強制判定身分。

P5 部分完成：

- **回覆通知**：Code Bot 分頁不在畫面上時，agent 回覆到對話串會跳出 8 秒的 app 內通知。實作在 `features/code-bot/controllers/useCodeBotReplyNotifier.ts`，掛在 shell 層。agent 之間的互派不會通知。
- **macOS 記憶體卡片**：用 `sysctl hw.memsize` 加 `vm_stat` 計算，不需新增依賴，已補單元測試。
- **macOS CPU 卡片**（同晚稍後補上）：
  - 算法：把 `ps -A -o %cpu=` 的各行程使用率加總，除以 `sysctl -n hw.ncpu` 取得核心數，上限 100%。`ps` 給的是衰減平均值，屬於近似值。
  - 實作：抽成跨平台可測的 `cpu_percent_from_ps`，並在 `MetricsSource` 加了 `cpu_percent_direct()`，只有沒有累計計數器可比對時才使用。
  - 測試：新增 2 個單元測試。
  - 尚未驗證：還沒在 macOS 實機跑過，macOS 的 release 建置會編譯到這段。
- **失敗一鍵重試**：送達失敗的收件者旁會出現「重試」按鈕。重送時沿用同一個 conversation id，agent 的回覆仍會對到原本那則訊息。
- **中斷**：agent 顯示「工作中」時，名字旁會出現停止鍵，按下去會送 Esc 到它的終端；Claude Code 與 Codex 都用 Esc 中斷。
- **篩選與搜尋**：可以只看某個 agent 的相關訊息，或用關鍵字搜尋對話串，並顯示「顯示 n/總數」。
- **agent 回覆與轉派也存在本機**：後端在 agent 下線時會清掉它的 channel 訊息，app 重啟也會全部清空。原本 agent 一重啟，它先前的回覆就會從對話串消失，所以這兩類訊息也改存 localStorage。
  - 順手修正一個 bug：切換 workspace 的那一次 render 裡，state 還是上一個 workspace 的資料，可能被寫進新 workspace 的位置。現在用 `hydratedWorkspaceId` 擋住，資料載入完才開始存。
- **中斷的送出改為可重試**：app 在送出途中被關掉，重新載入後那則訊息會停在「傳送中」。現在會自動標成失敗（`INTERRUPTED`），並出現「重試」按鈕。
- **安靜 agent 提示**：送達超過 60 秒、agent 已經閒置，卻還沒在對話串回報時，訊息下方會出現「{name} 已閒置，但還沒在這裡回報」，並附一個「開啟終端」連結。這是為了接住 agent 沒照指示回報的情況，結果只在它的終端裡。
- **從 Code Bot 分頁建立協作組時，agent 也會直接出現在畫布上**：透過 `placeAgentsOnStoredCanvas` 寫進畫布的 instance 紀錄，不會掉到待命欄。如果這個 workspace 從沒開過畫布就不處理，因為第一次載入時本來就會把所有 agent 放上去。
- **gto 技能檔加入 Code Bot 段落**：`resources/gto-agent-communication/SKILL.md` 說明兩件事。第一，任務末尾的 `cb-…` id 是系統提供給 agent 用的，不算自行捏造 task id，這是為了避免和原本「不要自創 taskId」的規則互相矛盾。第二，遇到 `AGENT_COLLAB_HOP_LIMIT`／`AGENT_COLLAB_PAUSED` 時，不要重試轉派，改成自己收尾並回報。
- **大列表**：依專案規則，對話串只顯示最近 100 則，較早的訊息按「顯示較早的訊息（還有 n 則）」逐頁載入。換 workspace 或改篩選條件時，會重新從最近 100 則開始。
- **複製**：每則 agent 回覆右上角有複製鍵。頂部列有「整串複製成 Markdown」，依時間排序，方便存檔或分享，並有單元測試。
- **對話串存進 SQLite**：寫在 app 原本的 `gtoffice.db`，新增表 `code_bot_threads`，每個 workspace 一列。
  - 存放內容：人類訊息、agent 回覆與轉派紀錄，各以 JSON 陣列存放，另存清除時間點。
  - 後端：`crates/gt-storage/src/code_bot_thread_repository.rs`，含 3 個單元測試。新增 command `code_bot_thread_load` 與 `code_bot_thread_save`。
  - 前端運作方式：localStorage 當即時快取。開啟時先讀快取，再從資料庫載入，兩邊依 id 合併，衝突時以本機為準；合併完成之後才開始寫回資料庫，避免較新但不完整的快取蓋掉資料庫裡較完整的紀錄。寫回資料庫有 1 秒防抖動，每類最多存 200 則。
  - 審查後的調整：
    - 第三輪靜態審查只針對這段 Rust，沒有發現會造成編譯、clippy 或測試失敗的問題。
    - 錯誤型別改用新增的 `StorageError::InvalidInput`。原本借用 `InvalidPath`，錯誤訊息會變成「storage path invalid」，容易誤導。
    - 兩個 command 改成 async 加上 `spawn_blocking`，大型 JSON 或 SQLite 等鎖時不會卡住 UI。
    - schema 檢查每個程序只執行一次。
    - 資料庫裡損毀的 JSON 被丟棄時，會記一筆 `tracing::warn!`。
  - 尚未驗證：Rust 未編譯，也還沒在 app 實測。快捷鍵不做，因為專案目前沒有任何導覽快捷鍵的慣例，不另外發明一套。

靜態審查後的修正（同晚由獨立審查代理逐行比對型別與簽章）：

- **會編譯失敗**：`AppState` 有 derive `Clone`，但 `CollaborationGuard` 不能 Clone。改成 `Arc<CollaborationGuard>`，同時確保所有複本共用同一份計數。
- **派工失敗也會扣額度**：原本 hop 在可能失敗的檢查之前就計數。現在改到所有檢查之後、真正派工之前才計數。
- **主執行緒可能被卡住**：`system_metrics_snapshot` 改為 async 加 `spawn_blocking`，`nvidia-smi` 不再卡住主執行緒。
- **GPU 失敗就永久停用**：改為失敗後 5 分鐘再重試。
- **CPU 使用率略偏低**：`/proc/stat` 改為只加總前 8 欄，避免把 guest 時間重複計算。
- **並發建立協作組會報錯**：兩個 `ensure_code_bot_team` 同時執行時，輸的一方遇到主鍵衝突，現在會改用已存在的 agent。
- **第二輪靜態審查**（針對修正後的版本）：沒有發現會讓編譯或 clippy 失敗的問題。依建議在 `ensure_member` 被吞掉的錯誤處補了 `tracing::warn!`。
- **前端邏輯審查後的修正**（審查代理專看 React 狀態與競態）：
  - Code Bot 分頁改為常駐掛載。切到其他分頁時只是隱藏，不卸載，所以正在送出的訊息（啟動 agent 最多約 30 秒）和離開期間收到的回覆都不會遺失。之前這種情況會被誤標成失敗，按重試就造成重複投遞。
  - 每個 agent 的「啟動並等待就緒」只會同時跑一份。連續送出、重試、標頭的啟動按鈕都等同一個 promise，不會重複啟動 CLI，也不會在 4 秒寬限期內把字打進還沒就緒的 CLI。
  - 所有非同步結果在寫入 state 前，都會檢查 workspace 是否還是同一個，舊 workspace 的 agent 清單、狀態、回覆不會寫進新 workspace。
  - 「清除對話串」會記住清除的時間點，後端記憶體裡較舊的訊息不會在下次載入時又冒回來。
  - @ 補全：按 Esc 改為正確關閉選單。原本會把游標設成 -1，再按 Enter 會切壞草稿。
  - 輸入法：確認選字的 Enter（`keyCode 229`）不再誤送出，處理的是 macOS WebKit 的行為。
  - @ 解析：句尾標點不再讓 mention 失效，例如「@codex.」。
  - 效能：對話列使用 `memo`，打字時不會重繪所有 Markdown 回覆。「安靜 agent」的判斷改為先建好查表，從 O(n²) 降到 O(n)。只有在本來就捲到底部時才自動跟著捲動。
  - 從 localStorage 讀回的資料會驗證欄位型別，壞掉的資料直接丟棄，不會讓畫面崩潰。
  - 回覆通知只針對 Code Bot 對話（`cb-` 開頭），不會誤報其他流程的回報。
  - Agent 畫布建立協作組時，若中途切換了 workspace 就放棄擺放；`saveInstances` 也移出 setState updater。
  - 前端單元測試增加到 12 個，全數通過；已用瀏覽器確認切換分頁時 Code Bot 隱藏但保持掛載，主控台沒有錯誤。
- **端到端一致性審查後的修正**（審查結論：前後端契約逐欄對齊；「送出 → agent 回報 → 顯示」流程每一步都走得通）：
  - **互派上限只管 Code Bot**：原本是整個 workspace 都算，會讓 Agent 畫布上既有的多 agent 流程在第 7 次轉派時被擋下，「暫停協作」也會停掉所有 agent。現在只有寄件者或收件者是 `codebot-claude`／`codebot-codex` 的派工才會計數或被暫停。人類訊息也只在送給 Code Bot 成員時才把計數歸零。
  - **切換 workspace 不再弄丟結果**：
    - 送出中途切到別的 workspace，送達結果會直接寫進原 workspace 的儲存資料。
    - 等待 agent 上線時改成輪詢原 workspace，不會因為換了畫面而判定失敗。
    - 別的 workspace 收到的 agent 回覆，也會存進那個 workspace。
    - 新增「送出中」登記表，回到原 workspace 時，還在送的訊息不會被誤標成中斷。
  - **成員被刪時**：
    - 寫 `@claude`、但 Claude 已不在協作組時，會阻擋送出並提示，不會默默改送給 Codex。
    - 成員少於兩位時，頂部出現「補回成員」橫幅。這裡只檢查 Code Bot 自己的 handle，其他 `@名字` 不受影響。
  - **輸出收集設定不再外溢**：Code Bot 派工固定傳 `suppressOutputCollectionInstructions: false`，不受任務中心那個勾選框影響。
  - **交接改為結構化欄位**：交接的「卡關／下一步」改存成清單欄位，由畫面依語系顯示標籤，原本寫死英文字。
  - **回報指示補充**：回報時要依所用的 shell 正確處理多行文字與引號的跳脫。
  - **清除與資料庫的合併**：資料庫載入的人類訊息也會套用清除時間點。
  - 前端單元測試 14 個，全數通過。
- **審查建議中刻意不改的項目**（附理由）：
  - **`zh-CN` 欄位寫繁體**：使用者以繁體中文使用，這個 fork 自己新增的字串（例如 `agentCanvas.help.*`）本來就用繁體，所以維持一致。若要改回上游的簡體慣例，需要使用者決定。
- **之後補上**：
  - 通知改用 agent 的實際名稱，改過名也會正確顯示。
  - 「是不是 Code Bot 的派工」這條判斷，抽成純函式 `gt_agent::is_code_bot_traffic`，附 2 個單元測試（其中一個確認 `codebot-claudette` 這類相似名稱不會誤判）。bridge 與 task_center 都改用這個函式，CI 能直接測到。
- **已知限制（新增）**：
  - Claude 把工作轉給 Codex 後，Codex 回報給 Claude 的訊息只會出現在對話串，不會自動打進 Claude 的終端。這是既有 gto 設計，Code Bot 沒有改變它。
    - 緩解：協作提示已加入一句「需要對方的結果才能繼續時，用 `gto wait <taskId> --json` 等待，或看 `gto inbox`」。`--from` 預設是 agent 自己，啟動時注入的 `GTO_AGENT_ID` 會提供，所以不必另外指定。實際效果要等 agent 實測才知道。
  - 刪除 workspace 時，不會清除 `code_bot_threads` 裡對應的那一列。
  - 同一個 workspace 開在兩個視窗時，資料庫以後存的為準。
- **互派上限可調**：
  - 儀表板「本輪互派」那格有 −／＋，每個 workspace 可設 1–20 次，預設 6。
  - 後端新增 `CollaborationGuard::set_hop_limit`（附 2 個單元測試）與 command `code_bot_set_hop_limit`。
  - 上限只存在記憶體，所以前端把你的選擇存在 localStorage，app 重開後自動套回。
  - 調高上限可以讓已經停下來的協作接著跑。
  - 儀表板「需注意」除了送達失敗之外，協作被暫停或已達上限時也會 +1，因為這兩種情況都需要你處理。
- **ESLint**：
  - 所有 Code Bot 相關檔案已通過 0 錯誤 0 警告，包含 `features/code-bot/`、Agent 畫布兩個改動檔、兩個測試檔。
  - 修正 3 處 `react-hooks/refs` 錯誤（在 render 期間寫入 `ref.current`）。lint 沒報到、但同樣寫法的 8 處，也一併改成在 `useLayoutEffect` 同步。
  - shell 檔案裡剩下的 lint 錯誤都不在這次改動的行內，屬於既有問題，沒有處理：`useShellRootController.tsx` 第 104、153 行，以及多個檔案裡對 `@features/terminal/*` 的深層 import。
- **既有測試沒有被改壞**：先用 `git stash` 暫存這次的改動跑一次基準，再還原改動跑一次，對照前端測試套件的編譯錯誤。結果改動前後都是同樣 9 個錯誤，全是既有的 roles 相關問題，這次沒有新增任何錯誤。
- **解決多行／引號回覆的跳脫問題**（每輪審查都提到的風險）：
  - `gto agent reply-status` 新增 `--detail-file <path>` 選項，回覆內容改從檔案讀取，完全不經過 shell 的引號處理。讀取時會去掉 BOM 和結尾空行；檔案讀不到或內容是空的，會回 `INVALID_ARGUMENT`。
  - Code Bot 附在訊息後的回報指示，以及 `gto-agent-communication` 技能檔，都改為建議多行或含引號的回覆使用這個選項。
  - `tools/gto` 新增 3 個測試（含下面的 `--summary-file`），其中一個用帶 BOM、雙引號、單引號、反引號和換行的中文內容，驗證寫入後原樣保留。
  - `gto agent handover` 也比照新增 `--summary-file`，並補 1 個測試。
  - 後端在 agent 對 agent 派工時，會自動附上一段「GT Office Reply」回覆指示（`gt-task` 的 `build_managed_agent_reply_instruction`）。這段也補了一句：多行或含引號的內容請改用 `--detail-file`／`--summary-file`。既有測試只檢查 `GT Office Reply` 這個標題，全 repo 也沒有其他地方比對整段文字，所以這次修改不會讓任何測試失敗。
  - 測試結果：354 通過、5 失敗。這 5 個失敗是既有的 roles（`roleId`）問題，改動前就是同樣 5 個，沒有新增。
  - `gto` 是由 `bin/gto.mjs` 搭配一個轉出 `.ts` 的 `.js` 執行，Node 直接執行 TypeScript，所以不需要建置步驟。
  - 型別檢查：`tools/gto` 的 tsc 原本就有 59 個型別錯誤，這次新增或修改的行都不在其中。
- **協作前置檢查**：對應截圖裡的「重新檢查」。
  - 在 Code Bot 頂部顯示「檢查通過／N 項待處理」，點開是 4 項檢查清單。
  - 「安裝」按鈕使用 app 原本就有的 `system_gto_cli_install`、`system_gto_skill_install`；「補回成員」使用 `code_bot_ensure_team`。
  - 分頁一打開就會自動檢查一次，也可以按「重新檢查」手動再跑。
  - 判斷邏輯是純函式 `model/code-bot-preflight.ts`，附 3 個單元測試，其中一個確認「讀不到狀態」會算失敗、不會誤判為通過。
  - **偵測舊版技能**：這次改了內建的 `SKILL.md`（加入 Code Bot 回報說明），但之前安裝過的人手上仍是舊版，只檢查「有沒有安裝」會誤判為通過。
    - 後端：`system_gto_skill_status` 新增 `outdated` 欄位，只有由 GT Office 安裝、且 `SKILL.md` 內容與內建版不同時才會是 true。使用者自己另外安裝的技能不會被標記。
    - 前端：技能是舊版時，該項檢查顯示未通過，按鈕改成「更新」，按下去會重新安裝，覆蓋舊檔。
  - 前端單元測試總數變成 18 個，全數通過。
- **第二輪前端邏輯審查後的修正**：
  - **資料庫載入失敗時不開放寫回**：原本載入失敗後，1 秒後仍會把只有快取的內容寫進資料庫，可能蓋掉資料庫裡較完整的紀錄。現在只有成功合併後才開放寫回；失敗的那次 session 只寫 localStorage。
  - **切換 workspace 那一瞬間的空窗**：`isCurrent` 改成「是畫面上的 workspace」且「state 已經載入這個 workspace」才成立。空窗期間完成的送達結果、收到的回覆，會改寫到儲存資料，接著重置 effect 就會載入它們。原本這種情況會被丟掉，後來誤判成「中斷」，按重試就造成重複投遞。
  - **切走後不再送出**：shell 是在「畫面上那個 workspace」的同名 agent 終端按 Enter。如果你在 agent 啟動期間切走了，現在會停下並標記 `WORKSPACE_SWITCHED`，讓你回到原 workspace 再按重試，避免 Enter 送進別的 workspace。
  - **前置檢查不再亂序**：state 只存三個查到的狀態，檢查清單在 render 時用最新的成員數算出來。另加序號，只採用最後一次查詢的結果。協作組變動時也不必再重查。
  - **不再閃假警告**：agent 清單還沒載入時，「補回成員」橫幅、前置檢查的成員項目、送出時的缺成員判斷都先不觸發。`agentList` 讀取失敗時也不會被當成「沒有協作組」。
  - **複製內容完整**：每則回覆的複製按鈕，改用和整串匯出相同的格式，會包含卡關與下一步清單；沒有內容時不顯示按鈕。剪貼簿 API 不可用時也不會丟例外。
  - **捲動**：
    - 送出訊息後一定捲到底。
    - 回到分頁或換 workspace 時，重新貼齊底部。
    - 載入較早訊息時保持原本閱讀位置；WebKit 沒有 scroll anchoring，所以自己補。
    - 超過一頁之後新訊息仍會自動捲到底：改用最新一則訊息的 id 判斷，因為此時清單長度固定是 100。
  - **效能**：執行狀態每 3 秒輪詢一次，結果沒變就不更新 state；`members` 依內容判斷是否相同，重新抓到內容一樣的 agent 清單時不會讓所有對話列重新渲染。
  - **小修**：
    - 匯出改用本地時間，與畫面一致；轉派標題換行會壓成單行。
    - 搜尋也會比對卡關與下一步的內容。
    - 讀回儲存資料時，會驗證卡關／下一步是否為字串陣列。
    - 互派上限的 −／＋ 在請求完成前停用，並處理錯誤。
- **第二次瀏覽器回歸測試**（150 則假訊息；暫時預覽頁測完已刪除）：
  - 開啟時位於底部；第一頁顯示 100 則；按「顯示較早的訊息」後變成 151 則，正在看的那則位移 0 px。
  - 沒有閃出假的「缺成員」橫幅；只有卡關清單的交接也有複製鈕。
  - **實測抓到並已修正一個問題**：原本每則超過 60 秒、還沒有正式回報的舊訊息，都會掛上「已閒置、未回報」提示（實測 40 則）。現在只有送給該 agent 的最新一則訊息會顯示提示，舊訊息已經被後來的訊息取代，不再提示。
- **送出流程實測**：審查指出 `useCodeBot` 這個 hook 沒有任何測試，所以我用可控的假資料，在瀏覽器裡實際跑真正的 hook 程式。測完已刪除暫時檔。
  - **離線時連續送兩則給 Claude**：兩則都先顯示「啟動中」，接著都變成「已送達」。Claude 只被啟動 1 次，不會重複啟動；實際送出 2 次。
  - **送出內容**：附加在訊息後的回報說明有包含 `--detail-file` 的用法。
  - **送出失敗再重試**：失敗時顯示「失敗」，按「重試」後變成「已送達」。總送出次數為 4 次（兩則加上失敗與重試各一次），沒有重複送出。
  - **切換 workspace 的情境**（預覽頁加入兩個 workspace 後補測）：
    - 在 A 送訊息給離線的 Claude，趁它啟動時切到 B。B 的對話串不會出現 A 的訊息，B 的儲存資料也是空的。
    - 切走期間完全沒有送出，所以不會有 Enter 打進 B 的終端。
    - A 的儲存資料記為 `failed:WORKSPACE_SWITCHED`，結果沒有遺失。
    - 回到 A 後顯示「失敗」並出現「重試」；按下重試後變成「已送達」。整個過程只送出 1 次（送往 A），Claude 也只啟動 1 次。
  - **接收端**：
    - 後端記憶體裡原有的回覆，在初次載入時就會顯示；之後即時推送進來的回覆會立即出現。兩者都會寫進 localStorage。
    - 清除對話串後重新整理頁面：後端記憶體裡仍保有的舊回覆不會再冒出來，清除之後才收到的新回覆則會正常顯示。
  - **迴圈防護介面**：
    - 已正常運作的部分：
      - 互派達上限時會出現橫幅，按「繼續協作」後橫幅消失、計數歸零。
      - 暫停／恢復開關切換正常。
      - 上限偏好會存在 localStorage。
      - 模擬 app 重開（後端回到預設 6）時，會自動把之前設的 7 套回去。
    - **前置檢查、匯出、篩選**：
      - 前置檢查一開始顯示「2 項待處理」：gto 指令未安裝，以及 Codex 技能是舊版（按鈕顯示「更新」）。依序按「安裝」和「更新」後，每次處理完都會自動重新檢查，最後顯示「檢查通過」，4 項全部正常。
      - 整串匯出：訊息依時間排序，時間用本地時間，交接內容包含卡關與下一步清單。
      - 篩選「Codex」會留下 2 則（送給 Codex 的訊息和 Codex 的回覆）。搜尋「npm ci」能透過下一步清單找到那則回覆，顯示「顯示 1/3」。
    - **回覆通知**：
      - Code Bot 分頁不在畫面上時，收到回覆會跳出通知，且使用 agent 改名後的名稱（例如「Claude（改名）」）。
      - 以下情況都不會通知：agent 之間的互派、其他流程的自我回報（task id 不是 `cb-` 開頭）、其他 workspace 的訊息。
      - Code Bot 分頁在畫面上時也不會通知。
    - **主題與窄視窗**（專案規則要求支援深淺主題）：
      - 在 `graphite-light`、`graphite-dark`、`sakura-night` 三種主題下讀取實際計算出的顏色，`--vb-*` tokens 都會隨主題切換。
      - 以深色主題的輸入框為例：文字是 `#f5f5f7`，底色合成後約 `rgb(38,20,34)`，對比約 15:1。
      - 一開始用程式計算的對比數字不可靠，因為主題切換時顏色有過渡動畫，抽樣抓到的是中間值。
      - 視窗在背景，無法截圖，所以沒有做肉眼檢查。
      - 480 px 寬時沒有任何元素超出畫面、沒有水平捲軸；儀表板收成 1 欄，資源卡收成 2 欄。
    - **輸入框**：
      - 打 `@` 會列出 `@claude`、`@codex`、`@all`。
      - ↓ 移動選取；↑ 連按兩下會繞回清單底部的 `@all`；按 Tab 插入 `@all `。
      - 點成員名稱「Codex」會插入 `@codex `；按 Enter 只送給 Codex，送出後提示變成「未指定 @ 時送給：Codex」。
    - **Agent 畫布的協作組按鈕**（P1 入口；用真正的 `AgentCanvasPane` 搭配替身 API 測試）：
      - 畫布是空的時，會顯示大按鈕和說明文字。
      - 按下後，`code_bot_ensure_team` 只被呼叫 1 次，而且是對正確的 workspace；也有通知 shell 一次，讓它重新載入 Station 清單。
      - Claude 和 Codex 兩個節點都直接放上畫布，並存進畫布的 instance 紀錄，不會掉到待命欄。
      - 畫面顯示「協作組已建立：Claude 與 Codex 已互相連線。」，工具列也出現協作組按鈕。
    - **實測抓到並已修正一個問題**：快速連點「＋」會送出兩次 `limit=7`。原因是「處理中」狀態用 React state 判斷，同一個 tick 內的第二次點擊還讀到舊值。改成用 ref 判斷後，連點三下也只會送出一次。
- **架構文件同步**：`docs/cw/01` 的 feature 表加入 `code-bot`。`docs/cw/02` 的殼層表加入 `system_metrics.rs`，commands 清單補上 `code_bot/`。`docs/cw/03` 新增一節，說明 Code Bot 如何建在 `gto` 協議之上。
- **第五輪靜態審查**：範圍是最後一批 Rust 改動，包括互派上限、`is_code_bot_traffic`、macOS CPU。審查代理逐一手算所有測試數值，判定通過，沒有找到會造成編譯、clippy 或測試失敗的問題。
- **`cargo fmt --all -- --check` 全 workspace 通過**：這一步只用 rustfmt、不需要 linker，所以本機可以跑。結果 0 處差異，CI 的格式檢查這一關會過。
- **Rust 型別檢查的其他途徑也都不可行**：`rust-analyzer` 只有啟動殼，元件本身沒有安裝，執行時會自動下載，這等同安裝，所以不使用。`cargo check` 則需要 linker 才能建置 proc-macro 與 build script。
- **瀏覽器實測**（用假資料的暫時預覽頁，測完已刪除；改用 DOM 檢查，因為視窗在背景無法截圖）：
  - 互派 6/6 的上限橫幅、篩選鈕「全部／Claude／Codex」、交接的「卡關／下一步」清單（已依語系顯示）、兩則回覆的複製鍵、失敗訊息的「重試」，都正確顯示。
  - 少了 Claude 時，畫面出現「補回成員」橫幅；送出 `@claude …` 會被擋下並顯示錯誤，草稿保留不清空。
  - 輸入 `@co` 出現 1 筆建議，按 Esc 後建議關閉，草稿不變。
- **待 CI 確認**：有 1 項 clippy 規則（`needless_borrows_for_generic_args`，針對 `emit(.., &x)`）可能觸發。既有程式碼有相同寫法且 CI 是綠燈，判斷多半不會觸發。

### P2 共用對話串（使用者 @ agent）

- 後端：`code_bot_send(workspace_id, targets, text)` 以人類身分呼叫 `dispatch_batch`；`code_bot_thread(workspace_id)` 合併人類訊息、dispatch、status、handover，以及 `gt-session-log` 擷取的 agent 回覆。
- 注意：`channel` 訊息目前只存在記憶體、上限 512 筆，重開 app 就消失。這階段先沿用；持久化列為 P5。
- 前端：對話串 + `@` 補全輸入框；訊息依發送者顯示頭像與顏色（人、Claude、Codex）。
- 驗證：輸入「@codex 列出這個 repo 的頂層目錄」，Codex 終端收到指令，對話串出現回覆。`npm run typecheck`。

### P3 Agent 互相 @

- 對話串渲染 agent 間的 dispatch 為「Claude @Codex：…」泡泡，status/handover 掛在對應任務下。
- 轉派次數計數與上限暫停；全域「暫停協作」開關（暫停時 bridge 拒絕 agent 發起的 dispatch，回傳明確錯誤碼）。
- 驗證：「@claude 寫一個 hello.ts，寫完 @codex review」，看到 Claude→Codex→回報完整串；把上限設 1，確認第二次轉派被暫停並出現提示。

### P4 儀表板（對應截圖）

- 頂部：Code Bot 標題、運行時間、執行中數／總數、需注意數、「重新檢查」「新增 agent」「全部停止」。
- 左欄：分組卡（Claude 組、Codex 組…），顯示狀態燈、session、需注意原因；點擊篩選。
- 中央：即時流向圖。節點＝agent，線＝連線；有任務進行中的連線顯示流動虛線動畫（資料來自 `task/dispatch_progress`）。
- 底部：CPU、記憶體、GPU、顯示記憶體卡片。
  - 需要新依賴 `sysinfo`（CPU/記憶體），**新增前先在 `docs/DEPENDENCIES.md` 記錄用途、備選與影響**。
  - GPU 先用 `nvidia-smi --query-gpu` 取值，沒有 NVIDIA 時卡片顯示「不支援」，不加 nvml 依賴。
  - 每 2 秒取樣，取樣器做成 trait 以便 mock。
- 視覺：深色、單色等寬字體點綴、狀態色（綠＝執行中、黃＝等待、紅＝需注意），同時支援淺色主題；沿用 `--vb-*` tokens，不用 px；大列表虛擬化。依專案規則，UI 設計用 `ui-ux-pro-max` skill。
- 驗證：`npm run typecheck`、`npm run build:tauri`、`cargo check --workspace`；實際開 app 截圖比對截圖版面，深淺兩種主題各看一次。

### P5 收尾與加強（可延後）

- 對話串持久化（存 SQLite，`gt-storage` 加 migration）。
- 桌面通知：agent 進入 blocked／需要確認時通知。
- 快捷鍵：`Ctrl+K` 聚焦輸入框、`Ctrl+.` 暫停協作。
- 補上 `docs/cw/06` 記錄的漏洞：`channel.publish` 的 edge 檢查（v0.7.7 的 `communication.rs` 可能已涵蓋，實作前先確認）。

## 6. 風險與待確認

- **authored 連線是否真的雙向**：文件寫「不分方向」，但要以 `has_edge` 的測試為準。
- **agent 是否會主動轉派**：取決於注入提示的寫法，P3 要實測幾輪調整措辭；這是 `docs/cw/17` 指出的核心問題。
- **Codex 轉派能力**：Codex 必須掛上 `gto-agent-bridge` MCP（`[mcp_servers]`），P1 驗收時一併確認。
- **既有 Rust 測試編譯失敗**：`docs/cw/06` 記錄有一批測試引用已移除的子系統，P1 開工前先跑 `cargo test` 確認現況，避免把舊問題算到新改動頭上。
