## Context

`api-capability-expansion` đã đạt freeze `bacd213` (321 registered / 154 qualified / 68 portfolio qualified, smoke 10/10 ngày 2026-09-21). Owner quyết định release Creator 3.7 trước; phần còn lại chuyển thành pending inventory cho release sau, chủ yếu khi Creator 3.8 hoặc fixture mới sẵn sàng. Không để pending API breadth chặn build/security/publish/release của artifact 3.7.

**Goals:**

- Đóng băng bối cảnh đủ để quay lại sau release 3.7 vẫn hiểu vì sao mỗi row pending/rejected.
- Phân lane để resume sau 3.7 từng phần, không mở lại toàn bộ.
- Giữ ngưỡng gate minh bạch — không hạ lén để cho "pass".

**Non-Goals:**

- Implement bất kỳ tool nào trong change pending này.
- Sửa `source/*` hay `docs/tool-portfolio-candidates.json` — change này là documentation-only.
- Dùng Creator 3.8 evidence làm điều kiện hoặc credit cho Creator 3.7 release.
- Thay thế `docs/next-update-3x8-capability-backlog.json` — backlog đó vẫn là source of truth cho 3.8.

## Decisions

1. **Một change pending duy nhất** chứa 11 pending trực tiếp + 23 rejected revisit + backlog 3.8, thay vì rải nhiều TODO/comment. Dễ thấy, dễ archive khi resume xong.
2. **5 lane API R1–R5** theo `prerequisites/witnessContractIds`, cộng **R6 popup** theo plan riêng — vì điều kiện resume là theo IPC/fixture, không phải theo folder.
3. **Freeze commit `bacd213`** (không phải `61bd383`) làm mốc — vì `bacd213` đã fix `sp` + `getComponent(string)` và smoke 10/10 sau khi mở `db://assets/scene.scene`.
4. **Status `pending` trong `.openspec.yaml`** — tooling hiện tại không có state pending, nên dùng trường `status: pending` tự định nghĩa và `.gitignore` không ảnh hưởng; khi resume sẽ đổi thành spec-driven và tạo proposal con.
5. **R6 implementation versus qualification** — detection implementation closed by owner decision on 2026-10-04 in `notes/plans/cc-code-mode-cst/4-done-260922__261004-creator-popup-detection/plan.md`; canonical live acceptance is separately queued in `2-todo-261004__tbd-creator-popup-live-qualification/plan.md`. Detection read-only belongs to P1 editor observability; popup action remains a separate contract. No qualification or portfolio promotion is inferred from plan closure.

## Risks / Trade-offs

- Pending change có thể bị quên nếu không có reminder — mitigation: ghi rõ trong proposal Goal và tasks.md re-entry checklist, và giữ trong `openspec/changes/` (không phải branch đã xóa).
- Tween/prefabVariant/tilemapCreate là `replace` (không đếm pool) nên khi resume có thể quyết định không làm nữa — mitigation: lane R4 ghi rõ "thiết kế mới trước khi code", không bắt buộc.
- `localizationValidate` và `assetBundleValidate` là low-hanging (chỉ cần witness) nhưng vẫn để pending để không lẫn với publish lane — mitigation: lane R3 đánh dấu "không cần 3.8".
