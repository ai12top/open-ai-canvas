#!/usr/bin/env python3
"""从宿主真实的 Python 能力映射生成 ``capability-directory.generated.json``。

为什么需要它：WebUI 的 ``/v1/models`` 解析器（``capability-catalog.ts``）必须吃得下
宿主**真正产出**的能力 JSON，而不是测试里手写的"理想形状"。这个脚本走的就是生产
链路（不含任何 CLI 调用与网络）：

    providers.base.ModelInfo / spec_resolver 的 spec
        -> yingce_sync.cli_plugin_plan.capability_config(model, spec, conservative=False)
        -> model_catalog.protocol_for(provider, kind)          # 已装插件的真实协议身份
        -> model_directory.DirectoryEntry / DirectorySnapshot
        -> model_api.build_models(...)                          # /v1/models 的 data[]

qcreate 分支另外用主仓库已提交的真实目录快照
（``tests/fixtures/qcreate_catalog/model_list.json``）走
``qcreate_catalog.parse_payload`` -> ``model_catalog.qcreate_discovery``，
因此它连"source fixture 的合成"都不需要。

用法（在主仓库根目录）：

    uv run python vendor/open-ai-canvas/web/test/fixtures/generate-capability-directory.py

脚本会自己向上找到主仓库根（含 ``model_api.py`` 与 ``yingce_sync/``），也接受
``--repo`` / ``YINGCE_REPO`` 显式指定；找不到就报错退出，不写半成品。

生成物**不是**生产快照：只保留 ``/v1/models`` 会暴露给 WebUI 的字段（``model_api``
本身就不输出 sourceSpec / 路径 / 凭据），时间戳与 revision 固定，保证 diff 稳定。
不要在 CI 里依赖 Python——JSON 已提交，Bun 测试只读 JSON。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

FIXTURE_NAME = "capability-directory.generated.json"
# 固定值：让生成物可复现，diff 只反映契约变化。
REVISION = 12
REFRESHED_AT = 1_761_600_000.0
SOURCE_VERSION = "fixture-source:fixture"


def find_repo(explicit: str | None) -> Path:
    for candidate in (explicit, os.environ.get("YINGCE_REPO")):
        if candidate:
            root = Path(candidate).expanduser().resolve()
            if (root / "model_api.py").is_file() and (root / "yingce_sync").is_dir():
                return root
            raise SystemExit(f"--repo/YINGCE_REPO 指向的不是宿主仓库根：{root}")
    for parent in Path(__file__).resolve().parents:
        if (parent / "model_api.py").is_file() and (parent / "yingce_sync").is_dir():
            return parent
    raise SystemExit("找不到宿主仓库根（含 model_api.py 与 yingce_sync/），请用 --repo 指定")


def builder(repo: Path):
    sys.path.insert(0, str(repo))
    from model_api import build_models, legacy_alias_records  # noqa: PLC0415
    from model_catalog import protocol_for, qcreate_discovery  # noqa: PLC0415
    from model_directory import (  # noqa: PLC0415
        FRESH,
        STALE,
        UNAVAILABLE,
        DirectoryEntry,
        DirectorySnapshot,
    )
    from providers.base import (  # noqa: PLC0415
        ImageCapabilitySpec,
        ModelInfo,
        VideoCapabilitySpec,
    )
    from yingce_sync.cli_plugin_plan import capability_config  # noqa: PLC0415

    def entry(model: ModelInfo, config: dict | None, status: str = FRESH) -> DirectoryEntry:
        return DirectoryEntry(
            model=model,
            capability_config=config,
            protocol=protocol_for(model.provider, model.type),
            source_version=SOURCE_VERSION,
            source_key=model.id.split("/", 1)[-1],
            refreshed_at=REFRESHED_AT,
            status=status,  # type: ignore[arg-type]
        )

    def cli_entry(provider: str, key: str, kind: str, status: str = FRESH) -> DirectoryEntry:
        """dreamina / libtv 的真实链路：ModelInfo + spec -> capability_config()。"""
        labels = {"dreamina": "即梦 (Dreamina)", "libtv": "哩布哩布 (LibTV)"}
        model = ModelInfo(
            id=f"{provider}/{key}",
            name=key.replace("-", " ").title(),
            provider=provider,
            group=labels[provider],
            type=kind,  # type: ignore[arg-type]
            aliases=[key],
        )
        spec = (
            ImageCapabilitySpec(ratios=["16:9", "1:1", "9:16"], default_ratio="1:1", qualities=["2k", "4k"])
            if kind == "image"
            else VideoCapabilitySpec(
                ratios=["16:9", "9:16"],
                resolutions=["720p", "1080p"],
                operations=["text_to_video", "image_to_video", "reference_to_video"],
            )
        )
        config = capability_config(model, spec, conservative=False)
        return entry(model, config, status)

    return {
        "ModelInfo": ModelInfo,
        "build_models": build_models,
        "legacy_alias_records": legacy_alias_records,
        "qcreate_discovery": qcreate_discovery,
        "DirectorySnapshot": DirectorySnapshot,
        "cli_entry": cli_entry,
        "entry": entry,
        "UNAVAILABLE": UNAVAILABLE,
        "STALE": STALE,
        "FRESH": FRESH,
        "repo": repo,
    }


def generate(repo: Path) -> dict:
    build = builder(repo)

    entries = [
        # 三家 × 两种能力的 canonical 条目（fresh，带真实 capabilityConfig）。
        build["cli_entry"]("dreamina", "5.0", "image"),
        build["cli_entry"]("dreamina", "3.0-pro", "video"),
        build["cli_entry"]("libtv", "seedream-4", "image"),
        build["cli_entry"]("libtv", "kling-2.1", "video"),
    ]

    # qcreate：真实已提交目录快照 -> parse_payload -> qcreate_discovery。
    import qcreate_catalog  # noqa: PLC0415

    catalog_fixture = repo / "tests" / "fixtures" / "qcreate_catalog" / "model_list.json"
    snapshot_payload = json.loads(catalog_fixture.read_text(encoding="utf-8"))
    discovery = build["qcreate_discovery"](qcreate_catalog.parse_payload(snapshot_payload))
    seen_kinds: set[str] = set()
    for item in discovery.models:
        # 每种能力取一条真实的即可，保留原始能力 JSON。
        if item.model.type in seen_kinds or item.capability_config is None:
            continue
        seen_kinds.add(item.model.type)
        entries.append(build["entry"](item.model, item.capability_config))

    # stale：能返回「最后成功配置」但不可自动应用。
    entries.append(build["cli_entry"]("dreamina", "4.0", "image", status=build["STALE"]))
    # unavailable：从未取到能力，capabilityConfig 必须不存在。
    entries.append(build["cli_entry"]("libtv", "wan-2.2", "video", status=build["UNAVAILABLE"]))

    directory = build["DirectorySnapshot"](REVISION, tuple(entries), refreshed_at=REFRESHED_AT)
    # 目录里还没有条目的模型：model_api 走 entry=None 分支，meta 是
    # {status: "unavailable", sourceVersion: "", refreshedAt: null}，protocol 为空。
    # WebUI 必须把它认成「声明了能力但暂不可用」，不能当成旧目录条目去推断协议。
    unknown_model = build["ModelInfo"](
        id="dreamina/seedance-2.0",
        name="Seedance 2.0",
        provider="dreamina",
        group="即梦 (Dreamina)",
        type="video",
    )
    records = build["build_models"](
        [*(item.model for item in entries), unknown_model],
        directory,
        is_enabled=lambda _model: True,
    )
    records.extend(build["legacy_alias_records"](["3.0"], ["3.0"]))

    return {
        "object": "list",
        "data": records,
        "_generated": {
            "script": "web/test/fixtures/generate-capability-directory.py",
            "note": (
                "由宿主真实 Python 能力映射离线生成（model_catalog -> model_directory -> "
                "model_api），不含 CLI 调用、网络或凭据；不要手改，改契约请重跑脚本。"
            ),
            "revision": REVISION,
            "refreshedAt": int(REFRESHED_AT),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", help="宿主仓库根（含 model_api.py）")
    parser.add_argument("--out", help="输出路径，默认与本脚本同目录")
    args = parser.parse_args()
    repo = find_repo(args.repo)
    payload = generate(repo)
    out = Path(args.out).expanduser().resolve() if args.out else Path(__file__).parent / FIXTURE_NAME
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    print(f"wrote {out} ({len(payload['data'])} records)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
